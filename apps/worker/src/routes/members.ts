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
import {
  invitationEntitySchema,
  memberEntitySchema,
  paginatedSchema,
  type MemberProvisioningOperation,
} from '@hermes/shared';
import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { enqueueJob, publishEvents } from '../jobs.js';
import { consumeRate, LIMITS } from '../auth/rate-limit.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { inWorkspace, jsonBody, pathUuid, RouteError, type TenantWork } from './tenant.js';
import {
  enqueueCapacityWarning,
  expireInvitationReservations,
  releaseInvitationCapacity,
  reserveCapacityForInvitation,
  transferInvitationCapacity,
  withCapacityGrantQuarantine,
} from '../hermes-cloud/capacity.js';
import { PARTNERSHIPS_CAPACITY_ROLE } from '../runtime/discovery-grants.js';
import {
  invitationCorrelationId,
  logInvitationDiagnostic,
  trackInvitationRequestFailure,
} from '../ops/invitation-diagnostics.js';
import {
  createMemberProvisioningOperation,
  memberProvisioningEnabled,
  memberSetupRoleExecutable,
  projectMemberProvisioning,
  rebindMemberProvisioningOperation,
  requestMemberProvisioningCancellation,
} from '../member-provisioning/service.js';
import type { MemberRoleTemplate } from '@hermes/shared';

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
  readonly acceptedInvitation: { readonly id: string } | null;
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
    const accepted = await tx.query<{ id: string }>(
      `UPDATE invitations SET status = 'accepted', accepted_by = $3
        WHERE workspace_id = $1 AND email = lower($2) AND status = 'pending'
        RETURNING id`,
      [membership.workspaceId, membership.email, membership.userId],
    );
    const invitation = accepted.rows[0];
    if (invitation) acceptedInvitation = { id: invitation.id };
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
    await expireInvitationReservations(work.tx, work.workspaceId);
    const { rows } = await work.tx.query(
      `SELECT i.id, i.email, i.role, i.status, i.expires_at, i.created_at, i.delivery_status,
              i.workos_invitation_id,
              op.id AS operation_id, op.workspace_id AS operation_workspace_id,
              op.revision AS operation_revision, op.preparation,
              op.cancellation, op.issue, op.role_template_key,
              EXISTS (
                SELECT 1
                  FROM hermes_cloud_capacity capacity
                  JOIN runtime_discovery_grants grant_row
                    ON grant_row.workspace_id=capacity.workspace_id
                   AND grant_row.id=capacity.discovery_grant_id
                   AND grant_row.linked_capacity_id=capacity.id
                   AND grant_row.agent_id=capacity.preflight_agent_id
                 WHERE capacity.workspace_id=i.workspace_id
                   AND capacity.reserved_invitation_id=i.id
                   AND capacity.state='reserved'
                   AND grant_row.revoked_at IS NULL
                   AND grant_row.consumed_at IS NULL
                   AND grant_row.expires_at IS NULL
                   AND grant_row.role_template_key=op.role_template_key
              ) AS ready_reservation_current,
              CASE
                WHEN i.delivery_error IS NULL THEN NULL
                WHEN i.delivery_error IN (
                  'workos_invitation_delivery_not_configured',
                  'workos_invitation_payload_invalid',
                  'iris_capacity_reservation_missing',
                  'workos_invitation_delivery_rejected',
                  'workos_invitation_delivery_unavailable',
                  'workos_invitation_delivery_outcome_unknown',
                  'workos_invitation_local_commit_failed'
                ) THEN i.delivery_error
                ELSE 'invitation_delivery_failed'
              END AS delivery_reason,
              sync.correlation_id AS delivery_trace_id
         FROM invitations i
         LEFT JOIN member_provisioning_operations op
           ON op.workspace_id=i.workspace_id AND op.invitation_id=i.id
         LEFT JOIN LATERAL (
           SELECT CASE
                    WHEN payload->>'correlation_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                    THEN payload->>'correlation_id'
                    ELSE NULL
                  END AS correlation_id
             FROM workos_sync
            WHERE workspace_id=i.workspace_id AND resource_type='invitation' AND resource_id=i.id
            ORDER BY created_at DESC
            LIMIT 1
         ) sync ON true
        WHERE i.workspace_id = $1 ORDER BY i.created_at DESC LIMIT 100`,
      [work.workspaceId],
    );
    return paginatedSchema(invitationEntitySchema).parse({
      items: rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        status: row.status === 'pending'
          && (row.expires_at as Date).getTime() < Date.now()
          && !(row.operation_id && row.cancellation !== 'complete' && row.workos_invitation_id === null)
          ? 'expired'
          : row.status,
        invited_at: (row.created_at as Date).toISOString(),
        ...(work.role === 'admin' ? {
          delivery_status: row.delivery_status,
          delivery_reason: row.delivery_reason,
          delivery_trace_id: row.delivery_trace_id,
        } : {}),
        ...(row.operation_id ? {
          role_template_key: row.role_template_key,
          provisioning: projectMemberProvisioning({
            id: row.operation_id, workspace_id: row.operation_workspace_id,
            invitation_id: row.id,
            revision: row.operation_revision, preparation: row.preparation,
            cancellation: row.cancellation, issue: row.issue,
            role_template_key: row.role_template_key,
            ready_reservation_current: row.ready_reservation_current,
            invitation_status: row.status, delivery_status: row.delivery_status,
            delivery_error: row.delivery_reason,
          }),
        } : {}),
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
  const correlationId = invitationCorrelationId();
  const workspaceId = c.req.param('ws') ?? 'unknown';
  let checkpoint = 'request_received';
  let trackedInvitationId: string | null = null;
  try {
    requireOrigin(c, { required: false });
    requireCsrf(c);
    const input = await jsonBody<{ email?: string; role?: string; role_template_key?: string }>(c);
    const email = (input.email ?? '').trim().toLowerCase();
    const role: MemberRole = input.role === 'admin' ? 'admin' : 'member';
    if (input.role_template_key !== undefined && input.role_template_key !== 'partnerships-agent' && input.role_template_key !== 'finance-agent') {
      throw new RouteError('choose a supported job role', 'bad_role_template', 422);
    }
    const preparing = memberProvisioningEnabled(c.env);
    // `role_template_key` opts into the setup-only contract. Reject it before
    // tenant admission or rate limiting when that contract is disabled, so a
    // rolling or stale client cannot silently fall through to legacy delivery.
    if (!preparing && input.role_template_key !== undefined) {
      checkpoint = 'setup_mode_rejected';
      throw new RouteError(
        'Background member setup is not available in this deployment.',
        'member_setup_unavailable',
        409,
      );
    }
    const roleTemplateKey: MemberRoleTemplate = input.role_template_key === 'finance-agent' ? 'finance-agent' : 'partnerships-agent';
    // Advertising and admission share the same executable boundary. Keep the
    // Finance schema value readable for persisted history, but never create a
    // known-doomed operation until compatible capacity execution exists.
    if (preparing && !memberSetupRoleExecutable(roleTemplateKey)) {
      checkpoint = 'setup_role_rejected';
      throw new RouteError(
        'Finance agent setup is not available yet. Choose an available job role.',
        'member_setup_role_unavailable',
        409,
      );
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new RouteError('an invitation needs an email address', 'bad_email', 422);
    }

    const result = await withCapacityGrantQuarantine(c.env, () => inWorkspace(c, async (work) => {
      work.requireAdmin('inviting someone');
      await consumeRate(work.tx, work.userId, work.workspaceId, LIMITS.invite);
      checkpoint = 'admin_and_rate_admitted';

      const existing = await work.tx.query<{ user_id: string }>(
        `SELECT m.user_id FROM members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 AND u.email = $2 AND m.status = 'active'`,
        [work.workspaceId, email],
      );
      const alreadyMember = existing.rows[0];

      const organizationId = preparing ? null : await workosOrganizationId(work);
      if (!preparing && !alreadyMember && c.env.AUTH_MODE === 'workos' && !organizationId) {
        throw new RouteError('this workspace is not linked to a WorkOS organization', 'not_configured', 503);
      }
      checkpoint = 'organization_binding_checked';

      const { rows } = await work.tx.query<{
        id: string; status: string; created_at: Date; delivery_status: string; delivery_error: string | null;
      }>(
        `INSERT INTO invitations (workspace_id, email, role, expires_at, invited_by,
                                  status, accepted_by, delivery_status)
         VALUES ($1, $2, $3, now() + interval '7 days', $4, $5, $6, $7)
         ON CONFLICT (workspace_id, email) WHERE status = 'pending' DO NOTHING
         RETURNING id, status, created_at, delivery_status, delivery_error`,
        [
          work.workspaceId,
          email,
          role,
          work.userId,
          alreadyMember ? 'accepted' : 'pending',
          alreadyMember?.user_id ?? null,
          alreadyMember || preparing ? 'not_required' : c.env.AUTH_MODE === 'workos' ? 'queued' : 'not_required',
        ],
      );
      let row = rows[0];
      let duplicate = false;
      if (!row) {
        const prior = await work.tx.query<{
          id: string; status: string; created_at: Date; delivery_status: string; delivery_error: string | null;
        }>(
          `SELECT id, status, created_at, delivery_status, delivery_error FROM invitations
            WHERE workspace_id=$1 AND email=$2 AND status='pending' FOR UPDATE`,
          [work.workspaceId, email],
        );
        row = prior.rows[0];
        duplicate = true;
      }
      if (!row) throw new RouteError('the invitation could not be stored', 'invite_failed', 409);
      trackedInvitationId = row.id;
      checkpoint = duplicate ? 'duplicate_resolved' : 'invitation_stored';

      const operation = duplicate ? await work.tx.query<{
        id: string; workspace_id: string; revision: number;
        preparation: MemberProvisioningOperation['preparation'];
        cancellation: MemberProvisioningOperation['cancellation'];
        issue: MemberProvisioningOperation['issue'];
        role_template_key: MemberRoleTemplate;
        role_template_version: string;
      }>(
        `SELECT id, workspace_id, revision, preparation, cancellation, issue,
                role_template_key,role_template_version
           FROM member_provisioning_operations
          WHERE workspace_id=$1 AND invitation_id=$2 FOR UPDATE`,
        [work.workspaceId, row.id],
      ) : null;
      const existingOperation = operation?.rows[0] ?? null;
      if (duplicate && !alreadyMember && preparing !== Boolean(existingOperation)) {
        throw new RouteError(
          preparing
            ? 'This address already has a legacy invitation in progress.'
            : 'This address already has background member setup in progress.',
          'invitation_mode_conflict',
          409,
        );
      }
      if (existingOperation && existingOperation.role_template_key !== roleTemplateKey) {
        throw new RouteError(
          'This address already has setup in progress for a different job role.',
          'invitation_role_conflict',
          409,
        );
      }

      let provisioning = existingOperation ? projectMemberProvisioning({
        ...existingOperation,
        invitation_id: row.id,
        invitation_status: row.status,
        delivery_status: row.delivery_status,
        delivery_error: row.delivery_error,
      }) : null;
      if (!alreadyMember && preparing) {
        if (!duplicate) {
          const created = await createMemberProvisioningOperation(work.tx, {
            workspaceId: work.workspaceId, invitationId: row.id, requestedBy: work.userId, roleTemplateKey,
          });
          provisioning = created.operation;
          if (created.jobId) work.jobs.push(created.jobId);
          checkpoint = 'member_setup_queued';
        }
      } else if (!alreadyMember && c.env.AGENT_RUNTIME === 'hermes') {
        const reservation = await reserveCapacityForInvitation(
          c.env, work.tx, work.workspaceId, row.id, PARTNERSHIPS_CAPACITY_ROLE,
        );
        if (!reservation) {
          throw new RouteError(
            'No verified Partner Program Iris capacity is available. Add a ready pool instance before inviting another member.',
            'iris_capacity_unavailable',
            409,
          );
        }
        checkpoint = 'capacity_reserved';
        const threshold = Math.max(0, Number.parseInt(c.env.HERMES_POOL_LOW_CAPACITY_THRESHOLD ?? '1', 10) || 1);
        await enqueueCapacityWarning(work.tx, work.workspaceId, reservation.remaining, threshold);
      }

      if (!preparing && !alreadyMember && !duplicate && c.env.AUTH_MODE === 'workos' && organizationId) {
        const key = `workos:invitation:${row.id}:send`;
        await work.tx.query(
          `INSERT INTO workos_sync (workspace_id, resource_type, resource_id, direction, payload)
           VALUES ($1,'invitation',$2,'outbound',$3::jsonb)`,
          [work.workspaceId, row.id, JSON.stringify({ job_key: key, correlation_id: correlationId })],
        );
        const jobId = await enqueueJob(work.tx, work.workspaceId, 'workos_sync', key, {
          action: 'send_invitation', invitation_id: row.id, organization_id: organizationId,
          email, role, inviter_user_id: work.userId, correlation_id: correlationId,
        });
        if (jobId) work.jobs.push(jobId);
      }
      // Setup-backed invitations do not start their seven-day clock until the
      // provider accepts delivery. Queuing expiry here would make a slow Cloud
      // preparation silently consume the recipient's response window.
      if (!preparing && !alreadyMember && !duplicate) {
        const expiryJob = await enqueueJob(
          work.tx, work.workspaceId, 'hermes_invitation_expire', `invitation-expire:${row.id}`, { invitation_id: row.id },
        );
        if (expiryJob) {
          await work.tx.query(`UPDATE jobs SET next_at=now()+interval '7 days' WHERE id=$1`, [expiryJob]);
          await work.tx.query(`UPDATE job_ready SET next_at=now()+interval '7 days' WHERE job_id=$1`, [expiryJob]);
        }
      }

      if (!duplicate) await work.tx.query(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, invitation_id)
         VALUES ($1, 'user', $2, 'member.invited', $3)`,
        [work.workspaceId, work.userId, row.id],
      );
      checkpoint = 'sync_and_expiry_jobs_prepared';

      return { duplicate, alreadyMember: Boolean(alreadyMember), entity: invitationEntitySchema.parse({
        id: row.id,
        email,
        role,
        status: row.status,
        invited_at: row.created_at.toISOString(),
        ...(provisioning ? { provisioning, role_template_key: existingOperation?.role_template_key ?? roleTemplateKey } : {}),
        version: 0,
      }) };
    }));

    checkpoint = 'committed';
    logInvitationDiagnostic({
      action: 'create', checkpoint, correlationId, workspaceId,
      invitationId: result.entity.id, ok: true,
      reason: result.alreadyMember ? 'already_member' : result.duplicate ? 'duplicate'
        : result.entity.provisioning ? 'setup_queued' : 'delivery_queued',
      status: result.duplicate ? 200 : 201,
    });
    return c.json(result.entity, result.duplicate ? 200 : 201);
  } catch (error) {
    throw trackInvitationRequestFailure({
      action: 'create', checkpoint, correlationId, workspaceId,
      invitationId: trackedInvitationId, error,
    });
  }
}

/**
 * POST /w/:ws/invitations/:id/resend
 *
 * A resend is a new row, not a mutation: the old one becomes `resent` and
 * points at its successor, so the history of who was invited and when survives.
 * The plan calls the old status `superseded`; the schema spells it `resent`.
 */
export async function resendInvitation(c: Context<{ Bindings: Env }>): Promise<Response> {
  const correlationId = invitationCorrelationId();
  const workspaceId = c.req.param('ws') ?? 'unknown';
  let checkpoint = 'request_received';
  let trackedInvitationId: string | null = null;
  try {
    requireOrigin(c, { required: false });
    requireCsrf(c);
    const invitationId = pathUuid(c, 'id');
    trackedInvitationId = invitationId;
    const body = await withCapacityGrantQuarantine(c.env, () => inWorkspace(c, async (work) => {
      work.requireAdmin('resending an invitation');
      const { rows } = await work.tx.query<{
        id: string;
        email: string;
        role: string;
        status: string;
        workos_invitation_id: string | null;
        role_template_key: MemberRoleTemplate | null;
        role_template_version: string | null;
      }>(
        `SELECT i.id, i.email, i.role, i.status, i.workos_invitation_id,
                op.role_template_key,op.role_template_version
           FROM invitations i
           LEFT JOIN member_provisioning_operations op
             ON op.workspace_id=i.workspace_id AND op.invitation_id=i.id
          WHERE i.workspace_id = $1 AND i.id = $2
          FOR UPDATE OF i`,
        [work.workspaceId, invitationId],
      );
      const invitation = rows[0];
      if (!invitation) throw new RouteError('no such invitation', 'unknown_invitation', 404);
      if (invitation.status !== 'pending' && invitation.status !== 'expired') {
        throw new RouteError(`an invitation that is ${invitation.status} cannot be resent`, 'not_resendable', 409);
      }
      checkpoint = 'invitation_locked';

      const setupBacked = invitation.role_template_key !== null;
      if (setupBacked && !memberProvisioningEnabled(c.env)) {
        throw new RouteError(
          'Background member setup is paused in this deployment. The existing setup was not changed.',
          'member_setup_unavailable',
          409,
        );
      }
      if (setupBacked && !memberSetupRoleExecutable(invitation.role_template_key!)) {
        throw new RouteError(
          'Finance agent setup is not available yet. The existing setup was not changed.',
          'member_setup_role_unavailable',
          409,
        );
      }
      const organizationId = setupBacked ? null : await workosOrganizationId(work);
      if (!setupBacked && c.env.AUTH_MODE === 'workos' && !organizationId) {
        throw new RouteError('this workspace is not linked to a WorkOS organization', 'not_configured', 503);
      }
      checkpoint = 'organization_binding_checked';
      await expireInvitationReservations(work.tx, work.workspaceId);
      await work.tx.query(`UPDATE invitations SET status = 'resent' WHERE id = $1`, [invitation.id]);
      const created = await work.tx.query<{ id: string; created_at: Date }>(
        `INSERT INTO invitations (workspace_id, email, role, expires_at, invited_by, delivery_status)
         VALUES ($1, $2, $3, now() + interval '7 days', $4, $5)
         RETURNING id, created_at`,
        [
          work.workspaceId,
          invitation.email,
          invitation.role,
          work.userId,
          setupBacked ? 'not_required' : c.env.AUTH_MODE === 'workos' ? 'queued' : 'not_required',
        ],
      );
      const row = created.rows[0];
      if (!row) throw new RouteError('the resend did not write a row', 'resend_failed', 409);
      trackedInvitationId = row.id;
      await work.tx.query(`UPDATE invitations SET superseded_by = $2 WHERE id = $1`, [invitation.id, row.id]);
      checkpoint = 'successor_stored';

      if (!setupBacked && c.env.AGENT_RUNTIME === 'hermes') {
        const transferred = await transferInvitationCapacity(
          c.env, work.tx, work.workspaceId, invitation.id, row.id, PARTNERSHIPS_CAPACITY_ROLE,
        );
        if (!transferred) {
          const reservation = await reserveCapacityForInvitation(
            c.env, work.tx, work.workspaceId, row.id, PARTNERSHIPS_CAPACITY_ROLE,
          );
          if (!reservation) throw new RouteError(
            'No verified Partner Program Iris capacity is available. Add a ready pool instance before resending.',
            'iris_capacity_unavailable',
            409,
          );
        }
        checkpoint = 'capacity_transferred_or_reserved';
      }
      let provisioning = null;
      if (setupBacked) {
        const capacityTransferred = await transferInvitationCapacity(
          c.env, work.tx, work.workspaceId, invitation.id, row.id,
          {
            roleTemplateKey: invitation.role_template_key!,
            roleTemplateVersion: invitation.role_template_version as '1.0.0',
          },
        );
        const transferredOperation = await rebindMemberProvisioningOperation(
          work.tx, work.workspaceId, invitation.id, row.id, work.userId, capacityTransferred,
        );
        if (!transferredOperation) throw new RouteError(
          'This setup can no longer be resent. Start a new invitation after reviewing its state.',
          'not_resendable',
          409,
        );
        provisioning = transferredOperation.operation;
        if (transferredOperation.jobId) work.jobs.push(transferredOperation.jobId);
      }
      if (!setupBacked && c.env.AUTH_MODE === 'workos' && organizationId) {
        const key = `workos:invitation:${row.id}:send`;
        await work.tx.query(
          `INSERT INTO workos_sync (workspace_id, resource_type, resource_id, direction, payload)
           VALUES ($1,'invitation',$2,'outbound',$3::jsonb)`,
          [work.workspaceId, row.id, JSON.stringify({ job_key: key, correlation_id: correlationId })],
        );
        const jobId = await enqueueJob(work.tx, work.workspaceId, 'workos_sync', key, {
          action: invitation.workos_invitation_id ? 'resend_invitation' : 'send_invitation',
          invitation_id: row.id, previous_workos_invitation_id: invitation.workos_invitation_id,
          organization_id: organizationId, email: invitation.email,
          role: invitation.role === 'admin' ? 'admin' : 'member', inviter_user_id: work.userId,
          correlation_id: correlationId,
        });
        if (jobId) work.jobs.push(jobId);
      }
      if (!setupBacked) {
        const expiryJob = await enqueueJob(
          work.tx, work.workspaceId, 'hermes_invitation_expire', `invitation-expire:${row.id}`, { invitation_id: row.id },
        );
        if (expiryJob) {
          await work.tx.query(`UPDATE jobs SET next_at=now()+interval '7 days' WHERE id=$1`, [expiryJob]);
          await work.tx.query(`UPDATE job_ready SET next_at=now()+interval '7 days' WHERE job_id=$1`, [expiryJob]);
        }
      }
      checkpoint = 'sync_and_expiry_jobs_prepared';

      return invitationEntitySchema.parse({
        id: row.id,
        email: invitation.email,
        role: invitation.role,
        status: 'pending',
        invited_at: row.created_at.toISOString(),
        ...(provisioning ? { provisioning, role_template_key: invitation.role_template_key! } : {}),
        version: 0,
      });
    }));
    checkpoint = 'committed';
    logInvitationDiagnostic({
      action: 'resend', checkpoint, correlationId, workspaceId,
      invitationId: body.id, ok: true, reason: body.provisioning ? 'setup_queued' : 'delivery_queued', status: 201,
    });
    return c.json(body, 201);
  } catch (error) {
    throw trackInvitationRequestFailure({
      action: 'resend', checkpoint, correlationId, workspaceId,
      invitationId: trackedInvitationId, error,
    });
  }
}

/** POST /w/:ws/invitations/:id/withdraw */
export async function withdrawInvitation(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const invitationId = pathUuid(c, 'id');

  await inWorkspace(c, async (work) => {
    work.requireAdmin('withdrawing an invitation');
    const { rows } = await work.tx.query<{ id: string; status: string; workos_invitation_id: string | null }>(
      `SELECT id, status, workos_invitation_id FROM invitations
        WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
      [work.workspaceId, invitationId],
    );
    const invitation = rows[0];
    if (!invitation) throw new RouteError('no such invitation', 'unknown_invitation', 404);
    if (invitation.status === 'accepted') {
      throw new RouteError('that invitation was already accepted', 'already_accepted', 409);
    }
    await work.tx.query(`UPDATE invitations SET status = 'withdrawn' WHERE id = $1`, [invitation.id]);
    const cancellationJob = await requestMemberProvisioningCancellation(work.tx, work.workspaceId, invitation.id);
    if (cancellationJob) work.jobs.push(cancellationJob);
    await releaseInvitationCapacity(work.tx, work.workspaceId, invitation.id);

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
