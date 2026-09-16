// Members and invitations.
//
// WorkOS owns sign-in, the organization and the invitation email. `members` is
// the mirror, and the mirror is what every authorization check in this product
// reads — not the token, not an organization lookup, not a permission claim.
// That split is what keeps a WorkOS outage from becoming an authorization
// outage, and what keeps "who may decide here" answerable in one SQL query
// under row-level security.
//
// The centre of this file is `revokeAccess`. Removing someone, demoting them,
// or receiving a WorkOS event that says either happened all run the *same*
// transaction: shares revoked, their sessions read-only, their effects
// unassigned, a stop asked of their working runs, then the mirror row, then the
// jobs that tell WorkOS and the hubs. One path, so the two ways in cannot drift
// apart — and a test drives the WorkOS path and the route and compares the rows.
import type { Context } from 'hono';
import { invitationEntitySchema, memberEntitySchema, paginatedSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { enqueueJob, publishEvents } from '../jobs.js';
import { optionalWorkosPort, workosPort } from '../auth/workos.js';
import { consumeRate, LIMITS } from '../auth/rate-limit.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { inWorkspace, jsonBody, pathUuid, RouteError, type TenantWork } from './tenant.js';

export type MemberRole = 'admin' | 'member';

export interface MirrorMembership {
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: MemberRole;
  readonly workosMembershipId: string | null;
  readonly status: 'active' | 'inactive';
  readonly email?: string;
}

/**
 * Write the mirror row for one membership.
 *
 * Used by `/auth/callback` (so a person who just accepted an invitation can see
 * the workspace immediately, without waiting for the poller) and by the poller
 * itself. `ON CONFLICT` on the pair, because the same membership can arrive
 * twice within a second from those two paths and a second row would mean two
 * answers to "what is this person's role?".
 */
export interface MirroredMembership {
  readonly memberId: string;
  readonly acceptedInvitation: { readonly id: string; readonly invitedByUserId: string | null } | null;
}

export async function mirrorMembership(tx: Tx, membership: MirrorMembership): Promise<MirroredMembership> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO members (workspace_id, user_id, role, workos_membership_id, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, user_id) DO UPDATE
       SET role = EXCLUDED.role,
           status = EXCLUDED.status,
           workos_membership_id = COALESCE(EXCLUDED.workos_membership_id, members.workos_membership_id)
     RETURNING id`,
    [membership.workspaceId, membership.userId, membership.role, membership.workosMembershipId, membership.status],
  );
  const id = rows[0]?.id;
  if (!id) throw new RouteError('the membership mirror did not write', 'mirror_failed', 409);

  let acceptedInvitation: MirroredMembership['acceptedInvitation'] = null;
  if (membership.email && membership.status === 'active') {
    const accepted = await tx.query<{ id: string; invited_by: string | null }>(
      `UPDATE invitations SET status = 'accepted', accepted_by = $3
        WHERE workspace_id = $1 AND email = lower($2) AND status = 'pending'
        RETURNING id, invited_by`,
      [membership.workspaceId, membership.email, membership.userId],
    );
    const invitation = accepted.rows[0];
    if (invitation) acceptedInvitation = { id: invitation.id, invitedByUserId: invitation.invited_by };
  }
  return { memberId: id, acceptedInvitation };
}

export interface MemberRow {
  id: string;
  user_id: string;
  role: string;
  status: string;
  workos_membership_id: string | null;
}

/**
 * The transaction removal and demotion share.
 *
 * Read it as a list of things that must not survive a change of access, in the
 * order that makes each one safe:
 *
 *   1. shares they created, because a link they handed out outlives them;
 *   2. their sessions become read-only, because history has to keep rendering
 *      but nothing new may be written into it;
 *   3. effects assigned to them are unassigned, because a pending payment with
 *      an assignee who no longer works here is a payment nobody will notice;
 *   4. `stop_requested` on their working runs, because a run started by someone
 *      who has just been removed should not keep spending the workspace's
 *      tokens;
 *   5. the mirror row itself, which the last-Admin trigger may refuse;
 *   6. the jobs: `workos_sync` to tell WorkOS, `evict` to close their sockets.
 *
 * Steps 1 to 5 commit together. If step 6 never runs, the ten-minute hub ticket
 * closes the sockets anyway — the fan-out makes it immediate, it does not make
 * it correct.
 */
export async function revokeAccess(
  tx: Tx,
  options: {
    workspaceId: string;
    actorId: string | null;
    member: MemberRow;
    action: 'remove' | 'demote';
    newRole?: MemberRole;
  },
): Promise<string[]> {
  const { workspaceId, member, action } = options;
  const jobs: string[] = [];

  if (action === 'remove') {
    await tx.query(
      `UPDATE session_shares SET revoked_at = now()
        WHERE workspace_id = $1 AND created_by = $2 AND revoked_at IS NULL`,
      [workspaceId, member.user_id],
    );
    await tx.query(
      `UPDATE sessions SET read_only = true WHERE workspace_id = $1 AND owner_id = $2`,
      [workspaceId, member.user_id],
    );
  }

  await tx.query(
    `UPDATE effects SET assignee_id = NULL, updated_at = now()
      WHERE workspace_id = $1 AND assignee_id = $2 AND status IN ('pending', 'assigned')`,
    [workspaceId, member.user_id],
  );

  await tx.query(
    `UPDATE runs SET stop_requested = true, updated_at = now()
      WHERE workspace_id = $1
        AND status IN ('working', 'waiting')
        AND session_id IN (SELECT id FROM sessions WHERE workspace_id = $1 AND owner_id = $2)`,
    [workspaceId, member.user_id],
  );

  if (action === 'remove') {
    await tx.query(`UPDATE members SET status = 'inactive' WHERE id = $1`, [member.id]);
  } else {
    await tx.query(`UPDATE members SET role = $2 WHERE id = $1`, [member.id, options.newRole ?? 'member']);
  }

  await tx.query(
    `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, member_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      workspaceId,
      options.actorId ? 'user' : 'system',
      options.actorId,
      action === 'remove' ? 'member.removed' : 'member.role_changed',
      member.id,
    ],
  );

  // The WorkOS-side write is a job so that our transaction is not waiting on a
  // third party, and so that a WorkOS outage retries rather than rolls us back.
  await tx.query(
    `INSERT INTO workos_sync (workspace_id, resource_type, resource_id, workos_id, direction, payload)
     VALUES ($1, 'membership', $2, $3, 'outbound', $4::jsonb)`,
    [
      workspaceId,
      member.id,
      member.workos_membership_id,
      JSON.stringify({ job_key: `workos:${member.id}:${action}` }),
    ],
  );
  const syncJob = await enqueueJob(tx, workspaceId, 'workos_sync', `workos:${member.id}:${action}`, {
    action: action === 'remove' ? 'deactivate_membership' : 'update_membership_role',
    workos_membership_id: member.workos_membership_id,
    role: options.newRole ?? 'member',
  });
  if (syncJob) jobs.push(syncJob);

  const evictJob = await enqueueJob(
    tx,
    workspaceId,
    'evict',
    `evict:${member.id}:${crypto.randomUUID()}`,
    { user_id: member.user_id },
  );
  if (evictJob) jobs.push(evictJob);

  const published = await publishEvents(tx, workspaceId, [
    {
      kind: 'entity.updated',
      payload: { entity: 'member', id: member.id, change: action },
    },
  ]);
  jobs.push(...published);

  return jobs;
}

async function loadMember(work: TenantWork, memberId: string): Promise<MemberRow> {
  const { rows } = await work.tx.query<MemberRow>(
    `SELECT id, user_id, role, status, workos_membership_id
       FROM members WHERE workspace_id = $1 AND id = $2`,
    [work.workspaceId, memberId],
  );
  const member = rows[0];
  if (!member) throw new RouteError('no such member', 'unknown_member', 404);
  return member;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /w/:ws/members */
export async function listMembers(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await inWorkspace(c, async (work) => {
    const { rows } = await work.tx.query(
      `SELECT m.id, m.user_id, u.email, u.name, m.role, m.reviewer_roles, m.status, m.joined_at
         FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1
        ORDER BY m.joined_at`,
      [work.workspaceId],
    );
    return paginatedSchema(memberEntitySchema).parse({
      items: rows.map((row) => ({
        id: row.id,
        user_id: row.user_id,
        name: row.name ?? row.email,
        email: row.email,
        role: row.role,
        status: row.status,
        reviewer_roles: row.reviewer_roles,
        joined_at: (row.joined_at as Date).toISOString(),
        version: 0,
      })),
      cursor: null,
      total: rows.length,
    });
  });
  return c.json(body);
}

/**
 * GET /w/:ws/invitations
 *
 * A pending invitation past its expiry is reported as expired rather than shown
 * as actionable, while the row keeps its own status: a later WorkOS event can
 * still move a row we have already stopped offering, and a status we overwrote
 * on read would make that event look like a contradiction.
 */
export async function listInvitations(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await inWorkspace(c, async (work) => {
    const { rows } = await work.tx.query(
      `SELECT id, email, role, status, expires_at, created_at
         FROM invitations WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [work.workspaceId],
    );
    return paginatedSchema(invitationEntitySchema).parse({
      items: rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        status:
          row.status === 'pending' && (row.expires_at as Date).getTime() < Date.now() ? 'expired' : row.status,
        invited_at: (row.created_at as Date).toISOString(),
        version: 0,
      })),
      cursor: null,
      total: rows.length,
    });
  });
  return c.json(body);
}

/**
 * POST /w/:ws/invitations
 *
 * Inviting someone who is already a member is a no-op with a row rather than an
 * error: the intent is obvious, a second email would only confuse them, and a
 * silent 200 with nothing behind it would leave an Admin wondering whether it
 * worked. The row records that we were asked, marked accepted.
 */
export async function createInvitation(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const input = await jsonBody<{ email?: string; role?: string }>(c);
  const email = (input.email ?? '').trim().toLowerCase();
  const role: MemberRole = input.role === 'admin' ? 'admin' : 'member';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new RouteError('an invitation needs an email address', 'bad_email', 422);
  }

  const port = c.env.AUTH_MODE === 'workos' ? workosPort(c.env) : optionalWorkosPort(c.env);
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('inviting someone');
    await consumeRate(work.tx, work.userId, work.workspaceId, LIMITS.invite);

    const existing = await work.tx.query<{ user_id: string }>(
      `SELECT m.user_id FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1 AND u.email = $2 AND m.status = 'active'`,
      [work.workspaceId, email],
    );
    const alreadyMember = existing.rows[0];

    let workosInvitation: { id: string; expiresAt: string } | null = null;
    const organizationId = await workosOrganizationId(work);
    if (!alreadyMember && c.env.AUTH_MODE === 'workos' && !organizationId) {
      throw new RouteError('this workspace is not linked to a WorkOS organization', 'not_configured', 503);
    }
    if (!alreadyMember && port && organizationId) {
      // WorkOS sends the email. This product contains no mail code, and this
      // is the one call that causes a message to be sent to a human.
      const sent = await port.sendInvitation({ email, organizationId, roleSlug: role, expiresInDays: 7 });
      workosInvitation = { id: sent.id, expiresAt: sent.expiresAt };
    }

    const { rows } = await work.tx.query<{ id: string; status: string; created_at: Date }>(
      `INSERT INTO invitations (workspace_id, email, role, workos_invitation_id, expires_at, invited_by,
                                status, accepted_by)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now() + interval '7 days'), $6,
               $7, $8)
       ON CONFLICT (workspace_id, email) WHERE status = 'pending' DO NOTHING
       RETURNING id, status, created_at`,
      [
        work.workspaceId,
        email,
        role,
        workosInvitation?.id ?? null,
        workosInvitation?.expiresAt ?? null,
        work.userId,
        alreadyMember ? 'accepted' : 'pending',
        alreadyMember?.user_id ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new RouteError('an invitation to that address is already pending', 'already_invited', 409);

    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, invitation_id)
       VALUES ($1, 'user', $2, 'member.invited', $3)`,
      [work.workspaceId, work.userId, row.id],
    );

    return invitationEntitySchema.parse({
      id: row.id,
      email,
      role,
      status: row.status,
      invited_at: row.created_at.toISOString(),
      version: 0,
    });
  });

  return c.json(result, 201);
}

/**
 * POST /w/:ws/invitations/:id/resend
 *
 * A resend is a new row, not a mutation: the old one becomes `resent` and
 * points at its successor, so the history of who was invited and when survives.
 * The plan calls the old status `superseded`; the schema spells it `resent`.
 */
export async function resendInvitation(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const invitationId = pathUuid(c, 'id');
  const port = c.env.AUTH_MODE === 'workos' ? workosPort(c.env) : optionalWorkosPort(c.env);

  const body = await inWorkspace(c, async (work) => {
    work.requireAdmin('resending an invitation');
    const { rows } = await work.tx.query<{
      id: string;
      email: string;
      role: string;
      status: string;
      workos_invitation_id: string | null;
    }>(
      `SELECT id, email, role, status, workos_invitation_id
         FROM invitations WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, invitationId],
    );
    const invitation = rows[0];
    if (!invitation) throw new RouteError('no such invitation', 'unknown_invitation', 404);
    if (invitation.status !== 'pending' && invitation.status !== 'expired') {
      throw new RouteError(`an invitation that is ${invitation.status} cannot be resent`, 'not_resendable', 409);
    }

    let workosInvitation: { id: string; acceptInvitationUrl: string | null; expiresAt: string } | null = null;
    const organizationId = await workosOrganizationId(work);
    if (c.env.AUTH_MODE === 'workos' && !organizationId) {
      throw new RouteError('this workspace is not linked to a WorkOS organization', 'not_configured', 503);
    }
    if (port && organizationId) {
      const sent = invitation.workos_invitation_id
        ? await port.resendInvitation(invitation.workos_invitation_id)
        : await port.sendInvitation({
            email: invitation.email,
            organizationId,
            roleSlug: invitation.role === 'admin' ? 'admin' : 'member',
            expiresInDays: 7,
          });
      workosInvitation = { id: sent.id, acceptInvitationUrl: sent.acceptInvitationUrl, expiresAt: sent.expiresAt };
    }

    await work.tx.query(`UPDATE invitations SET status = 'resent' WHERE id = $1`, [invitation.id]);
    const created = await work.tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO invitations (workspace_id, email, role, workos_invitation_id, expires_at, invited_by)
       VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now() + interval '7 days'), $6)
       RETURNING id, created_at`,
      [
        work.workspaceId,
        invitation.email,
        invitation.role,
        workosInvitation?.id ?? null,
        workosInvitation?.expiresAt ?? null,
        work.userId,
      ],
    );
    const row = created.rows[0];
    if (!row) throw new RouteError('the resend did not write a row', 'resend_failed', 409);
    await work.tx.query(`UPDATE invitations SET superseded_by = $2 WHERE id = $1`, [invitation.id, row.id]);

    return invitationEntitySchema.parse({
      id: row.id,
      email: invitation.email,
      role: invitation.role,
      status: 'pending',
      invited_at: row.created_at.toISOString(),
      version: 0,
    });
  });
  return c.json(body, 201);
}

/** POST /w/:ws/invitations/:id/withdraw */
export async function withdrawInvitation(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const invitationId = pathUuid(c, 'id');

  await inWorkspace(c, async (work) => {
    work.requireAdmin('withdrawing an invitation');
    const { rows } = await work.tx.query<{ id: string; status: string; workos_invitation_id: string | null }>(
      `SELECT id, status, workos_invitation_id FROM invitations WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, invitationId],
    );
    const invitation = rows[0];
    if (!invitation) throw new RouteError('no such invitation', 'unknown_invitation', 404);
    if (invitation.status === 'accepted') {
      throw new RouteError('that invitation was already accepted', 'already_accepted', 409);
    }
    await work.tx.query(`UPDATE invitations SET status = 'withdrawn' WHERE id = $1`, [invitation.id]);

    if (invitation.workos_invitation_id) {
      const jobId = await enqueueJob(
        work.tx,
        work.workspaceId,
        'workos_sync',
        `workos:invitation:${invitation.id}:withdraw`,
        { action: 'revoke_invitation', workos_invitation_id: invitation.workos_invitation_id },
      );
      if (jobId) work.jobs.push(jobId);
      await work.tx.query(
        `INSERT INTO workos_sync (workspace_id, resource_type, resource_id, workos_id, direction, payload)
         VALUES ($1, 'invitation', $2, $3, 'outbound', $4::jsonb)`,
        [
          work.workspaceId,
          invitation.id,
          invitation.workos_invitation_id,
          JSON.stringify({ job_key: `workos:invitation:${invitation.id}:withdraw` }),
        ],
      );
    }
  });
  return new Response(null, { status: 204 });
}

/**
 * PATCH /w/:ws/members/:id
 *
 * Nobody changes their own role. Not because the database would refuse it — the
 * last-Admin trigger only catches the case where the change would leave nobody
 * — but because a self-demotion and a self-promotion are the two shapes of
 * "the audit trail says I did this to myself", and neither has a legitimate
 * use here.
 */
export async function patchMember(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const memberId = pathUuid(c, 'id');
  const input = await jsonBody<{ role?: string; reviewer_roles?: string[] }>(c);

  const body = await inWorkspace(c, async (work) => {
    work.requireAdmin('changing a role');
    requireStepUp(work.session);
    const member = await loadMember(work, memberId);
    if (member.user_id === work.userId) {
      throw new RouteError('nobody changes their own role', 'self_change', 409);
    }

    if (Array.isArray(input.reviewer_roles)) {
      await work.tx.query(`UPDATE members SET reviewer_roles = $2 WHERE id = $1`, [
        member.id,
        input.reviewer_roles.filter((role) => typeof role === 'string').slice(0, 10),
      ]);
    }

    if ((input.role === 'admin' || input.role === 'member') && input.role !== member.role) {
      if (input.role === 'member') {
        // A demotion changes what they may do, so it runs the same revocation
        // transaction a removal does; the last-Admin trigger refuses it if this
        // was the only Admin left.
        work.jobs.push(
          ...(await revokeAccess(work.tx, {
            workspaceId: work.workspaceId,
            actorId: work.userId,
            member,
            action: 'demote',
            newRole: 'member',
          })),
        );
      } else {
        // A promotion adds authority rather than removing it, so there is
        // nothing to revoke: the mirror row moves and WorkOS is told.
        await work.tx.query(`UPDATE members SET role = 'admin' WHERE id = $1`, [member.id]);
        await work.tx.query(
          `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, member_id)
           VALUES ($1, 'user', $2, 'member.role_changed', $3)`,
          [work.workspaceId, work.userId, member.id],
        );
        const jobId = await enqueueJob(
          work.tx,
          work.workspaceId,
          'workos_sync',
          `workos:${member.id}:promote:${crypto.randomUUID()}`,
          {
            action: 'update_membership_role',
            workos_membership_id: member.workos_membership_id,
            role: 'admin',
          },
        );
        if (jobId) work.jobs.push(jobId);
      }
    }

    return memberEntity(work, member.id);
  });
  return c.json(body);
}

/** The member as the client's contract spells it, read back after the change. */
async function memberEntity(work: TenantWork, memberId: string): Promise<unknown> {
  const { rows } = await work.tx.query(
    `SELECT m.id, m.user_id, u.email, u.name, m.role, m.reviewer_roles, m.status, m.joined_at
       FROM members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.id = $2`,
    [work.workspaceId, memberId],
  );
  const row = rows[0];
  if (!row) throw new RouteError('no such member', 'unknown_member', 404);
  return memberEntitySchema.parse({
    id: row.id,
    user_id: row.user_id,
    name: (row.name as string | null) ?? row.email,
    email: row.email,
    role: row.role,
    status: row.status,
    reviewer_roles: row.reviewer_roles,
    joined_at: (row.joined_at as Date).toISOString(),
    version: 0,
  });
}

/** DELETE /w/:ws/members/:id */
export async function removeMember(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const memberId = pathUuid(c, 'id');

  await inWorkspace(c, async (work) => {
    work.requireAdmin('removing a member');
    requireStepUp(work.session);
    const member = await loadMember(work, memberId);
    if (member.user_id === work.userId) {
      throw new RouteError('nobody removes themselves', 'self_change', 409);
    }
    if (member.status !== 'active') return;

    work.jobs.push(
      ...(await revokeAccess(work.tx, {
        workspaceId: work.workspaceId,
        actorId: work.userId,
        member,
        action: 'remove',
      })),
    );
  });
  return new Response(null, { status: 204 });
}

/** The WorkOS organization behind this workspace, from the directory. */
async function workosOrganizationId(work: TenantWork): Promise<string | null> {
  const { rows } = await work.tx.query<{ workos_organization_id: string | null }>(
    `SELECT workos_organization_id FROM workspace_directory WHERE workspace_id = $1`,
    [work.workspaceId],
  );
  return rows[0]?.workos_organization_id ?? null;
}
