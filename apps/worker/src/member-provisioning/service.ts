import { memberProvisioningOperationSchema, type MemberProvisioningOperation, type MemberRoleTemplate } from '@hermes/shared';
import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { enqueueJob, type Job, type JobDisposition, runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import {
  hasCurrentReservedCapacityForInvitation,
  releaseInvitationCapacity,
  reserveCapacityForInvitation,
  withCapacityGrantQuarantine,
  hasVerifiedCapacityForRole,
} from '../hermes-cloud/capacity.js';
import { FINANCE_CAPACITY_ROLE } from '../runtime/discovery-grants.js';
import { RouteError } from '../routes/tenant.js';
import { invitationCorrelationId } from '../ops/invitation-diagnostics.js';

interface OperationRow {
  id: string; workspace_id: string; invitation_id: string; revision: number;
  requested_by?: string | null; requester_authorized?: boolean;
  role_template_key: MemberRoleTemplate; role_template_version: string;
  preparation: MemberProvisioningOperation['preparation'];
  cancellation: MemberProvisioningOperation['cancellation']; issue: MemberProvisioningOperation['issue'];
  invitation_status?: string; delivery_status?: string; delivery_error?: string | null; cloud_status?: string | null;
  /** Present on read-model projections that checked the exact reservation in SQL. */
  ready_reservation_current?: boolean;
}

/**
 * Roles every deployment can prepare without a provider lifecycle adapter.
 * Partnerships reuses the legacy warm pool. Finance is added per workspace
 * only while verified Finance capacity exists there (`executableMemberSetupRoles`),
 * so the Admin is never offered a job role whose setup is known to fail.
 */
export const ALWAYS_EXECUTABLE_MEMBER_SETUP_ROLES = ['partnerships-agent'] as const satisfies readonly MemberRoleTemplate[];

/** The job roles an Admin may choose for a new invitation in this workspace right now. */
export async function executableMemberSetupRoles(
  tx: Pick<Tx, 'query'>,
  workspaceId: string,
  invitationId?: string,
): Promise<MemberRoleTemplate[]> {
  const roles: MemberRoleTemplate[] = [...ALWAYS_EXECUTABLE_MEMBER_SETUP_ROLES];
  if (await hasVerifiedCapacityForRole(tx, workspaceId, FINANCE_CAPACITY_ROLE, invitationId)) {
    roles.push('finance-agent');
  }
  return roles;
}

/**
 * Advertising and admission share this boundary. `invitationId` lets a resend
 * of an existing Finance setup keep the capacity it already reserves.
 */
export async function memberSetupRoleExecutable(
  tx: Pick<Tx, 'query'>,
  workspaceId: string,
  role: MemberRoleTemplate,
  invitationId?: string,
): Promise<boolean> {
  return (await executableMemberSetupRoles(tx, workspaceId, invitationId)).includes(role);
}

export function memberProvisioningEnabled(env: Env): boolean {
  return env.HERMES_MEMBER_PROVISIONING_ENABLED === '1';
}

/**
 * The delivery half of the projection comes from the invitation row the
 * `workos_sync` job writes, never from the operation: setup completion is a
 * reservation, and only the provider's answer is "sent". A failed delivery
 * names its cause as an issue so the Members card can offer the right action
 * (resend for a rejected address or a lost reservation; reconciliation for an
 * unknown outcome) instead of a generic "needs attention".
 */
export function projectMemberProvisioning(row: OperationRow): MemberProvisioningOperation {
  const lostReadyReservation = row.preparation === 'ready'
    && row.ready_reservation_current === false
    && (row.delivery_status === undefined || row.delivery_status === 'not_required')
    && row.invitation_status !== 'accepted';
  const unknownOutcome = ['workos_invitation_delivery_outcome_unknown', 'workos_invitation_local_commit_failed']
    .includes(row.delivery_error ?? '');
  const delivery = row.invitation_status === 'accepted' ? 'sent' : row.delivery_status === 'queued' ? 'queued'
    : row.delivery_status === 'sending' ? 'sending'
      : row.delivery_status === 'delivered' ? 'sent'
        : row.delivery_status === 'failed' && unknownOutcome
          ? 'reconciliation_required'
          : row.delivery_status === 'failed' ? 'failed' : 'not_queued';
  const deliveryIssue: MemberProvisioningOperation['issue'] = row.delivery_status !== 'failed' || row.invitation_status === 'accepted'
    ? null
    : unknownOutcome ? 'delivery_outcome_unknown'
      : row.delivery_error === 'workos_invitation_delivery_rejected' ? 'delivery_rejected'
        : row.delivery_error === 'iris_capacity_reservation_missing' ? 'readiness_failed'
          : 'temporary_failure';
  return memberProvisioningOperationSchema.parse({
    id: row.id, workspace_id: row.workspace_id, revision: row.revision,
    preparation: lostReadyReservation ? 'queued' : row.preparation, delivery,
    membership: row.invitation_status === 'accepted' ? 'joined' : 'not_joined',
    cancellation: row.cancellation,
    issue: lostReadyReservation ? 'readiness_failed' : row.issue ?? deliveryIssue,
  });
}

/**
 * The handoff from "capacity reserved and current" to "WorkOS is asked to
 * send the email" — the step docs/CLOUD-MANAGEMENT.md item 5 kept separate.
 *
 * It runs inside the setup job's transaction, after the operation has been
 * written as `ready`, because the `jobs` trigger from 0061 refuses a
 * `send_invitation` job for any operation that is not. The invitation's
 * seven-day clock starts here, not at creation: a slow Cloud preparation must
 * not eat the recipient's response window, so the expiry job is queued now
 * and the row's `expires_at` is moved to match. WorkOS's own expiry replaces
 * both once it accepts the send.
 *
 * Returns the delivery job id, or null when nothing was queued: `AUTH_MODE=fake`
 * keeps `not_required` (the invitation id is the join token), and a row that
 * has already been queued, sent or failed is never re-queued by readiness —
 * a resend creates a fresh row for that.
 */
export async function queueSetupInvitationDelivery(env: Env, tx: Tx, input: {
  workspaceId: string; invitationId: string; inviterUserId: string | null;
}): Promise<string | null> {
  const invitation = await tx.query<{
    email: string; role: string; status: string; delivery_status: string; previous_workos_invitation_id: string | null;
  }>(
    `SELECT i.email, i.role, i.status, i.delivery_status,
            (SELECT p.workos_invitation_id FROM invitations p
              WHERE p.workspace_id=i.workspace_id AND p.superseded_by=i.id
              ORDER BY p.created_at DESC LIMIT 1) AS previous_workos_invitation_id
       FROM invitations i WHERE i.workspace_id=$1 AND i.id=$2 FOR UPDATE`,
    [input.workspaceId, input.invitationId],
  );
  const row = invitation.rows[0];
  if (!row || row.status !== 'pending' || row.delivery_status !== 'not_required') return null;
  if (env.AUTH_MODE !== 'workos') return null;

  const directory = await tx.query<{ workos_organization_id: string | null }>(
    `SELECT workos_organization_id FROM workspace_directory WHERE workspace_id=$1`,
    [input.workspaceId],
  );
  const organizationId = directory.rows[0]?.workos_organization_id ?? null;
  if (!organizationId) {
    // Deployed auth with no organization cannot deliver. Say so on the row
    // rather than leaving `not_required`, which the card would read as "not
    // queued yet" forever.
    await tx.query(
      `UPDATE invitations SET delivery_status='failed', delivery_error='workos_invitation_delivery_not_configured'
        WHERE workspace_id=$1 AND id=$2`,
      [input.workspaceId, input.invitationId],
    );
    return null;
  }

  const correlationId = invitationCorrelationId();
  const key = `workos:invitation:${input.invitationId}:send`;
  await tx.query(
    `UPDATE invitations
        SET delivery_status='queued', delivery_error=NULL, expires_at=now()+interval '7 days'
      WHERE workspace_id=$1 AND id=$2`,
    [input.workspaceId, input.invitationId],
  );
  await tx.query(
    `INSERT INTO workos_sync (workspace_id, resource_type, resource_id, direction, payload)
     VALUES ($1,'invitation',$2,'outbound',$3::jsonb)`,
    [input.workspaceId, input.invitationId, JSON.stringify({ job_key: key, correlation_id: correlationId })],
  );
  const jobId = await enqueueJob(tx, input.workspaceId, 'workos_sync', key, {
    action: row.previous_workos_invitation_id ? 'resend_invitation' : 'send_invitation',
    invitation_id: input.invitationId,
    previous_workos_invitation_id: row.previous_workos_invitation_id,
    organization_id: organizationId,
    email: row.email,
    role: row.role === 'admin' ? 'admin' : 'member',
    inviter_user_id: input.inviterUserId,
    correlation_id: correlationId,
  });
  const expiryJob = await enqueueJob(
    tx, input.workspaceId, 'hermes_invitation_expire', `invitation-expire:${input.invitationId}`, { invitation_id: input.invitationId },
  );
  if (expiryJob) {
    await tx.query(`UPDATE jobs SET next_at=now()+interval '7 days' WHERE id=$1`, [expiryJob]);
    await tx.query(`UPDATE job_ready SET next_at=now()+interval '7 days' WHERE job_id=$1`, [expiryJob]);
  }
  return jobId;
}

async function enqueueRevision(tx: Tx, workspaceId: string, id: string, revision: number): Promise<string | null> {
  return enqueueJob(tx, workspaceId, 'member_provision', `member-provision:${id}:${revision}`, { operation_id: id, revision });
}

/** Persist one idempotent operation in the same transaction as its invitation. */
export async function createMemberProvisioningOperation(tx: Tx, input: {
  workspaceId: string; invitationId: string; requestedBy: string; roleTemplateKey: MemberRoleTemplate;
}): Promise<{ operation: MemberProvisioningOperation; jobId: string | null }> {
  // The Cloud callback takes the same workspace lock before it marks a
  // connection usable and wakes waiting operations. Sharing that lock closes
  // the only race where setup could observe "disconnected" immediately before
  // the callback wakes an older snapshot that did not include this row.
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId]);
  const connection = await tx.query<{ status: string }>(
    'SELECT status FROM cloud_connections WHERE workspace_id=$1', [input.workspaceId]);
  const cloudStatus = connection.rows[0]?.status ?? null;
  const preparation = cloudStatus === 'connected' ? 'queued' : 'awaiting_connection';
  const issue = cloudStatus === 'reconnect_required' ? 'cloud_reconnect_required' : cloudStatus === 'connected' ? null : 'cloud_not_connected';
  const { rows } = await tx.query<OperationRow>(
    `INSERT INTO member_provisioning_operations
       (workspace_id,invitation_id,requested_by,role_template_key,preparation,issue)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (workspace_id,invitation_id) DO UPDATE
       SET role_template_key=member_provisioning_operations.role_template_key
     RETURNING *`,
    [input.workspaceId, input.invitationId, input.requestedBy, input.roleTemplateKey, preparation, issue],
  );
  const row = rows[0];
  if (!row) throw new RouteError('Member setup could not be recorded.', 'member_setup_failed', 409);
  return { operation: projectMemberProvisioning(row), jobId: await enqueueRevision(tx, input.workspaceId, row.id, row.revision) };
}

/** Called after a verified Cloud organization connection commits. */
export async function wakeMemberProvisioningForCloudConnection(env: Env, tx: Tx, workspaceId: string): Promise<string[]> {
  const { rows } = await tx.query<OperationRow>(
    `UPDATE member_provisioning_operations
        SET preparation='queued', issue=NULL, revision=revision+1
      WHERE workspace_id=$1 AND preparation='awaiting_connection' AND cancellation='none'
      RETURNING *`, [workspaceId]);
  const jobs: string[] = [];
  for (const row of rows) {
    const id = await enqueueRevision(tx, workspaceId, row.id, row.revision);
    if (id) jobs.push(id);
  }
  return jobs;
}

export async function requestMemberProvisioningCancellation(tx: Tx, workspaceId: string, invitationId: string): Promise<string | null> {
  const { rows } = await tx.query<OperationRow>(
    `UPDATE member_provisioning_operations
        SET cancellation='requested', revision=revision+1
      WHERE workspace_id=$1 AND invitation_id=$2 AND cancellation='none'
        AND EXISTS (SELECT 1 FROM invitations i WHERE i.workspace_id=$1 AND i.id=$2 AND i.status<>'accepted')
      RETURNING *`, [workspaceId, invitationId]);
  const row = rows[0];
  return row ? enqueueRevision(tx, workspaceId, row.id, row.revision) : null;
}

export async function rebindMemberProvisioningOperation(tx: Tx, workspaceId: string,
  previousInvitationId: string, nextInvitationId: string, requestedBy: string,
  reservationTransferred: boolean,
): Promise<{ operation: MemberProvisioningOperation; jobId: string | null } | null> {
  const { rows } = await tx.query<OperationRow>(
    `UPDATE member_provisioning_operations
        SET invitation_id=$3, requested_by=$4,
            preparation=CASE WHEN preparation='ready' AND NOT $5 THEN 'queued' ELSE preparation END,
            issue=CASE WHEN preparation='ready' AND NOT $5 THEN 'readiness_failed' ELSE issue END,
            revision=revision+1
      WHERE workspace_id=$1 AND invitation_id=$2 AND cancellation='none'
      RETURNING *`, [workspaceId, previousInvitationId, nextInvitationId, requestedBy, reservationTransferred]);
  const row = rows[0];
  if (!row) return null;
  row.invitation_status = 'pending'; row.delivery_status = 'not_required'; row.delivery_error = null;
  return { operation: projectMemberProvisioning(row), jobId: await enqueueRevision(tx, workspaceId, row.id, row.revision) };
}

/**
 * This runner performs only local, already-proven work. It may reserve a
 * pre-existing verified profile, and once that reservation is verified current
 * it hands the invitation to the existing `workos_sync` delivery job. It never
 * calls Cloud lifecycle tools, creates paid capacity, configures a profile, or
 * talks to WorkOS itself: the send is a separate durable job that re-checks
 * the reservation before it calls the provider.
 */
export async function runMemberProvisioningJob(env: Env, job: Job): Promise<JobDisposition> {
  const payload = (job.payload ?? {}) as { operation_id?: string; revision?: number };
  if (!payload.operation_id || !Number.isInteger(payload.revision) || (payload.revision ?? -1) < 0) return;
  const outcome = await withCapacityGrantQuarantine(env, () => runMemberProvisioningStep(env, job, payload));
  if (outcome?.disposition === 'paused') return 'paused';
  // Delivery runs after the readiness commit, the way a route runs the jobs
  // it queued: immediately when it can, by the Cron when it cannot.
  if (outcome?.deliveryJobId) await runJobsAfterCommit(env, job.workspace_id, [outcome.deliveryJobId]);
  return;
}

interface ProvisioningStepOutcome {
  readonly disposition?: 'paused';
  readonly deliveryJobId?: string | null;
}

async function runMemberProvisioningStep(
  env: Env,
  job: Job,
  payload: { operation_id?: string; revision?: number },
): Promise<ProvisioningStepOutcome | void> {
  return withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const reference = await tx.query<{ invitation_id: string }>(
      `SELECT invitation_id FROM member_provisioning_operations
        WHERE workspace_id=$1 AND id=$2`,
      [job.workspace_id, payload.operation_id],
    );
    const invitationId = reference.rows[0]?.invitation_id;
    if (!invitationId) return;
    // Invitation state transitions take this lock first. Re-reading the
    // operation afterward makes a concurrent resend wholly before or after
    // this execution; a stale invitation id cannot be acted on.
    const invitation = await tx.query<{
      status: string; delivery_status: string; delivery_error: string | null;
    }>(
      `SELECT status, delivery_status, delivery_error FROM invitations
        WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [job.workspace_id, invitationId],
    );
    const lockedInvitation = invitation.rows[0];
    if (!lockedInvitation) return;
    const { rows } = await tx.query<OperationRow>(
      `SELECT op.*, cc.status AS cloud_status
         FROM member_provisioning_operations op
         LEFT JOIN cloud_connections cc ON cc.workspace_id=op.workspace_id
        WHERE op.workspace_id=$1 AND op.id=$2 AND op.invitation_id=$3
        FOR UPDATE OF op`,
      [job.workspace_id, payload.operation_id, invitationId],
    );
    const row = rows[0];
    if (!row || row.revision !== payload.revision) return;
    row.invitation_status = lockedInvitation.status;
    row.delivery_status = lockedInvitation.delivery_status;
    row.delivery_error = lockedInvitation.delivery_error;
    const requester = row.requested_by ? await tx.query<{ authorized: boolean }>(
      `SELECT (status='active' AND role='admin') AS authorized FROM members
        WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE`,
      [job.workspace_id, row.requested_by],
    ) : null;
    row.requester_authorized = requester?.rows[0]?.authorized ?? false;

    if (row.cancellation === 'requested' || ['withdrawn', 'expired', 'resent'].includes(row.invitation_status ?? '')) {
      await releaseInvitationCapacity(tx, job.workspace_id, row.invitation_id);
      await tx.query(
        `UPDATE member_provisioning_operations
            SET cancellation='complete', completed_at=now(), revision=revision+1
          WHERE workspace_id=$1 AND id=$2 AND revision=$3`,
        [job.workspace_id, row.id, row.revision],
      );
      return;
    }
    if (row.invitation_status === 'accepted') return;

    // The release flag is checked again by the claimed job. Turning the feature
    // off stops forward progress immediately, while the cancellation branch
    // above remains available to release an existing local reservation.
    if (!memberProvisioningEnabled(env)) return { disposition: 'paused' };

    // Authorization is not inherited from enqueue time. A removed or demoted
    // Admin cannot leave a delayed job that continues reserving workspace
    // capacity after their authority has ended.
    if (!row.requester_authorized) {
      await releaseInvitationCapacity(tx, job.workspace_id, row.invitation_id);
      await tx.query(
        `UPDATE member_provisioning_operations
            SET preparation='failed', issue='authorization_revoked', revision=revision+1
          WHERE workspace_id=$1 AND id=$2 AND revision=$3`,
        [job.workspace_id, row.id, row.revision],
      );
      return;
    }

    // `ready` is a projection of a current exact reservation, not a terminal
    // bit. Only return while this invitation still owns verified capacity.
    const expectedRole = {
      roleTemplateKey: row.role_template_key,
      roleTemplateVersion: row.role_template_version as '1.0.0',
    };
    if (row.preparation === 'ready'
        && await hasCurrentReservedCapacityForInvitation(
          env, tx, job.workspace_id, row.invitation_id, expectedRole,
        )) {
      // A resend rebinds the operation to a fresh row whose delivery is
      // `not_required`; the transferred reservation is still current, so the
      // successor is delivered from here without another reservation pass.
      return { deliveryJobId: await queueSetupInvitationDelivery(env, tx, {
        workspaceId: job.workspace_id, invitationId: row.invitation_id, inviterUserId: row.requested_by ?? null,
      }) };
    }

    // Existing capacity is safe to use because reserveCapacityForInvitation
    // revalidates the exact reviewed discovery grant under the row lock.
    const reservation = await reserveCapacityForInvitation(
      env, tx, job.workspace_id, row.invitation_id, expectedRole,
    );
    if (reservation) {
      await tx.query(
        `UPDATE member_provisioning_operations
            SET preparation='ready', issue=NULL, revision=revision+1
          WHERE workspace_id=$1 AND id=$2 AND revision=$3`,
        [job.workspace_id, row.id, row.revision],
      );
      return { deliveryJobId: await queueSetupInvitationDelivery(env, tx, {
        workspaceId: job.workspace_id, invitationId: row.invitation_id, inviterUserId: row.requested_by ?? null,
      }) };
    }

    if (!row.cloud_status || row.cloud_status === 'reconnect_required') {
      await tx.query(
        `UPDATE member_provisioning_operations
            SET preparation='awaiting_connection', issue=$4, revision=revision+1
          WHERE workspace_id=$1 AND id=$2 AND revision=$3`,
        [job.workspace_id, row.id, row.revision,
          row.cloud_status === 'reconnect_required' ? 'cloud_reconnect_required' : 'cloud_not_connected'],
      );
      return;
    }

    // A connected grant proves identity and read-only schema access, not a
    // lifecycle adapter or governed role bootstrap. Stay explicit and terminal
    // until those external contracts are verified and integrated.
    await tx.query(
      `UPDATE member_provisioning_operations
          SET preparation='failed', issue='cloud_contract_unverified', revision=revision+1
        WHERE workspace_id=$1 AND id=$2 AND revision=$3`,
      [job.workspace_id, row.id, row.revision],
    );
    return;
  });
}
