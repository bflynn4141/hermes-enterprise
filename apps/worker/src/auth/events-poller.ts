// The WorkOS Events API poller, on the minute Cron.
//
// Why a poller and not a webhook: WorkOS documents the Events API as ordered
// and replayable, and it needs no public endpoint whose signature we have to
// check. A missed minute is caught up from the cursor rather than lost, and
// there is no window in which an unauthenticated request can reach us.
//
// What it is for: our code must run on *every* membership change, including the
// ones made in the WorkOS dashboard by someone who has never seen this product.
// A deactivation there and a `DELETE /w/:ws/members/:id` here run the same
// transaction — shares revoked, sessions read-only, effects unassigned, stop
// requested, evict job — because they call the same function. A test drives one
// event through this poller and one request through the route and compares the
// rows they leave behind.
//
// The one rule with teeth: a WorkOS-side demotion that would leave a workspace
// with no Admin is undone. Not refused — we are downstream of a change that has
// already happened — but corrected, with an `events` row saying we did it, so
// nobody can lock a workspace out of its own decisions from a dashboard.
import type { Env } from '../env.js';
import { connect } from '../db/client.js';
import { enqueueJob, runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import { optionalWorkosPort, type WorkOSEvent } from './workos.js';
import { mirrorMembership, revokeAccess, type MemberRow } from '../routes/members.js';
import { coordinateAcceptedMember } from '../domain/member-agent-coordination.js';

interface MembershipEventData {
  id?: string;
  user_id?: string;
  organization_id?: string;
  status?: string;
  role?: { slug?: string };
}

export interface PollResult {
  readonly polled: number;
  readonly applied: number;
  readonly cursor: string | null;
}

export async function pollWorkOSEvents(env: Env, limit = 50): Promise<PollResult> {
  const port = optionalWorkosPort(env);
  if (!port) return { polled: 0, applied: 0, cursor: null };

  const client = await connect(env, 'app');
  let after: string | null;
  try {
    const { rows } = await client.query<{ after_id: string | null }>(
      `SELECT after_id FROM workos_events_cursor WHERE id = 1`,
    );
    after = rows[0]?.after_id ?? null;
  } finally {
    await client.end();
  }

  const events = await port.listEvents({ after, limit });
  let applied = 0;
  let cursor = after;

  for (const event of events) {
    try {
      if (await applyEvent(env, event)) applied += 1;
    } catch (error) {
      // The cursor does not advance past an event we could not apply: the next
      // minute tries again from here. An event we skipped silently would be a
      // membership change that never reached this product.
      console.log(JSON.stringify({ at: 'workos.poll', id: event.id, ok: false, error: String(error) }));
      break;
    }
    cursor = event.id;
  }

  if (cursor !== after) {
    const writer = await connect(env, 'app');
    try {
      await writer.query(
        `UPDATE workos_events_cursor
            SET after_id = $1, polled_at = now(), events_seen = events_seen + $2
          WHERE id = 1`,
        [cursor, applied],
      );
    } finally {
      await writer.end();
    }
  }

  return { polled: events.length, applied, cursor };
}

/** Returns true when the event changed something here. */
async function applyEvent(env: Env, event: WorkOSEvent): Promise<boolean> {
  if (event.event === 'user.deleted') return applyUserDeleted(env, event);
  if (!event.event.startsWith('organization_membership.')) return false;

  const data = event.data as MembershipEventData;
  const organizationId = data.organization_id;
  const workosUserId = data.user_id;
  if (!organizationId || !workosUserId) return false;

  const client = await connect(env, 'app');
  let workspaceId: string | null;
  let userId: string | null;
  try {
    const workspace = await client.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_directory WHERE workos_organization_id = $1`,
      [organizationId],
    );
    workspaceId = workspace.rows[0]?.workspace_id ?? null;
    const user = await client.query<{ id: string }>(`SELECT id FROM users WHERE workos_user_id = $1`, [
      workosUserId,
    ]);
    userId = user.rows[0]?.id ?? null;
  } finally {
    await client.end();
  }
  // An organization we do not mirror, or a person who has never signed in here:
  // nothing to change, and nothing lost. Their first sign-in mirrors them.
  if (!workspaceId || !userId) return false;

  const role = data.role?.slug === 'admin' ? 'admin' : 'member';
  const deleted = event.event === 'organization_membership.deleted';
  const inactive = deleted || data.status === 'inactive';

  const jobs = await withWorkspaceTransaction(env, workspaceId, async (tx) => {
    const existing = await tx.query<MemberRow>(
      `SELECT id, user_id, role, status, workos_membership_id
         FROM members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    const member = existing.rows[0];

    if (inactive) {
      if (!member || member.status !== 'active') return [];
      // The same transaction the route runs. The trigger still applies: a
      // WorkOS-side removal of the last Admin raises, the event is not applied,
      // and the next poll tries again — which is the correct loud failure.
      return revokeAccess(tx, {
        workspaceId: workspaceId as string,
        actorId: null,
        member,
        action: 'remove',
      });
    }

    const wasAdmin = member?.role === 'admin' && member.status === 'active';
    if (wasAdmin && role === 'member') {
      const admins = await tx.query<{ count: string }>(
        `SELECT count(*) AS count FROM members
          WHERE workspace_id = $1 AND role = 'admin' AND status = 'active' AND id <> $2`,
        [workspaceId, member.id],
      );
      if (Number(admins.rows[0]?.count ?? '0') === 0) {
        // Re-promote. WorkOS is upstream of who this person is, but it is not
        // upstream of "a workspace must be able to decide": the mirror keeps
        // the Admin and a job pushes the role back.
        await tx.query(
          `INSERT INTO events (workspace_id, actor_type, kind, member_id)
           VALUES ($1, 'system', 'member.role_changed', $2)`,
          [workspaceId, member.id],
        );
        const jobId = await enqueueJob(
          tx,
          workspaceId as string,
          'workos_sync',
          `workos:${member.id}:repromote:${event.id}`,
          {
            action: 'update_membership_role',
            workos_membership_id: data.id ?? member.workos_membership_id,
            role: 'admin',
          },
        );
        return jobId ? [jobId] : [];
      }
    }

    const joiningUser = await tx.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [userId]);
    const mirrored = await mirrorMembership(tx, {
      workspaceId: workspaceId as string,
      userId: userId as string,
      role,
      workosMembershipId: data.id ?? null,
      status: 'active',
      email: joiningUser.rows[0]?.email,
    });
    const coordinationJobs: string[] = [];
    if (mirrored.acceptedInvitation) {
      await coordinateAcceptedMember({
        tx,
        workspaceId: workspaceId as string,
        joiningUserId: userId as string,
        joiningMemberId: mirrored.memberId,
        invitationId: mirrored.acceptedInvitation.id,
        invitedByUserId: mirrored.acceptedInvitation.invitedByUserId,
        jobs: coordinationJobs,
        provisionHermesCloud: env.AGENT_RUNTIME === 'hermes',
        cloudRegion: env.HERMES_CLOUD_REGION,
        cloudModel: env.HERMES_CLOUD_MODEL,
        cloudSize: env.HERMES_CLOUD_SIZE,
      });
    }
    return coordinationJobs;
  });

  if (jobs.length > 0) await runJobsAfterCommit(env, workspaceId, jobs);
  return true;
}

/**
 * `user.deleted` reaches every workspace that person belonged to.
 *
 * It is the one event that is not scoped to an organization, so it fans out
 * over the mirror rows rather than over the directory: each workspace runs the
 * same revocation transaction as a removal, one at a time, so a failure in one
 * workspace does not silently skip the rest.
 */
async function applyUserDeleted(env: Env, event: WorkOSEvent): Promise<boolean> {
  const workosUserId = (event.data as { id?: string }).id;
  if (!workosUserId) return false;

  const client = await connect(env, 'app');
  let memberships: { workspace_id: string }[];
  let userId: string | null;
  try {
    const user = await client.query<{ id: string }>(`SELECT id FROM users WHERE workos_user_id = $1`, [
      workosUserId,
    ]);
    userId = user.rows[0]?.id ?? null;
    if (!userId) return false;
    // `members` is a tenant table: a query for "every workspace this person is
    // in" has no tenant key and so returns nothing, by design. The fan-out
    // therefore walks the platform directory and asks each workspace under its
    // own key, which is slower and is the price of never having a connection
    // that can read every tenant at once.
    const directory = await client.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_directory`,
    );
    memberships = directory.rows;
  } finally {
    await client.end();
  }

  for (const { workspace_id: workspaceId } of memberships) {
    const jobs = await withWorkspaceTransaction(env, workspaceId, async (tx) => {
      const { rows } = await tx.query<MemberRow>(
        `SELECT id, user_id, role, status, workos_membership_id
           FROM members WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
        [workspaceId, userId],
      );
      const member = rows[0];
      if (!member) return [];
      return revokeAccess(tx, { workspaceId, actorId: null, member, action: 'remove' });
    });
    if (jobs.length > 0) await runJobsAfterCommit(env, workspaceId, jobs);
  }

  await withDeletedUser(env, userId);
  return true;
}

async function withDeletedUser(env: Env, userId: string): Promise<void> {
  const client = await connect(env, 'app');
  try {
    await client.query(`UPDATE users SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [userId]);
    await client.query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [
      userId,
    ]);
  } finally {
    await client.end();
  }
}
