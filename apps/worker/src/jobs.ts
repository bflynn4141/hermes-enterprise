// The jobs table: every cross-system side effect after a commit.
//
// A job row is written in the same transaction as the change that implies it,
// so the effect cannot exist without the change or the change without the
// effect. The committing request tries the job immediately; the minute Cron
// retries whatever is still undone. That is what makes a dropped post-commit
// RPC cost a minute of lag rather than a lost receipt.
//
// M2 adds the other half: the runners. `publish` fans committed outbox rows to
// the hubs and is marked done only when a hub acknowledges; `evict` closes the
// sockets of someone whose access was removed; `workos_sync` performs the
// WorkOS-side write after our transaction has already committed ours, so a
// WorkOS outage can never leave a member active here and deactivated there.
import { approvalFinalizedHookSchema } from '@hermes/shared';
import type { Env } from './env.js';
import { connect, type Role, type Tx } from './db/client.js';
import { optionalWorkosPort } from './auth/workos.js';
import { loadApprovalView } from './domain/approvals.js';
import { runReceiptJob } from './runs/receipt.js';
import { runAttemptInstanceId } from './runs/instance-id.js';
import { admitApprovalContinuation } from './runtime/continuation.js';
import { runBackupUploads } from './storage/backup.js';
import { runCapWarningJob } from './ops/cap-warning.js';
import { runEventsExport } from './ops/events-export.js';
import { runReverifyJob, type ReverifyPayload } from './keys/reverify.js';
import { logError } from './keys/redact.js';
import type { AdapterOptions } from './model/types.js';
import type { HubEvent } from './hubs.js';
import { scopeWorkspaceHubEvents } from './domain/audience.js';
import {
  classifyInvitationDeliveryFailure,
  InvitationDeliveryError,
  invitationCorrelationId,
  logInvitationDiagnostic,
  type InvitationDiagnosticAction,
} from './ops/invitation-diagnostics.js';

export interface Job {
  readonly id: string;
  readonly workspace_id: string;
  readonly kind: string;
  readonly key: string;
  readonly payload: unknown;
  readonly attempts: number;
}

/** A successful runner may defer completion without entering retry backoff. */
export type JobDisposition = 'paused' | void;

/** How long a claimer holds a job before another may take it. */
export const CLAIM_SECONDS = 120;

/**
 * The kinds this Worker knows how to dispatch. Keeping the registry explicit
 * makes an unknown kind visible rather than letting a misspelled job retry
 * forever with no owner.
 */
export const JOB_KINDS = [
  'publish',
  'evict',
  'workos_sync',
  'backup_uploads',
  'receipt',
  'render',
  'reverify',
  // M5a: the 80 percent cap warning, and the weekly audit-events export.
  'cap_warning',
  'events_export',
  // A finalized approval may authorize one fresh, revision-bound run. The
  // durable job is the crash-safe seam between the human decision transaction
  // and Workflow instance creation.
  'approval_continue',
  // Slack Events API ingestion and terminal answer delivery stay behind the
  // same durable transaction + retry seam as every other side effect.
  'slack_ingest',
  'slack_deliver',
  'slack_revoke',
  // Cloudflare Cron admits a configured discovery run; this durable job owns
  // the external fetch, evidence commit, and idempotent Iris handoff.
  'partner_screening',
  'partner_invoice_review',
  'partner_acknowledgment',
  'run_recovery',
  'run_launch',
  // Warm-pool invitation expiry and operator capacity alerts. Assignment is
  // synchronous because every slot is already configured and verified.
  'hermes_invitation_expire',
  'hermes_capacity_alert',
  // Local member setup orchestration. It reserves only pre-verified capacity;
  // lifecycle creation and invitation delivery are separate, gated operations.
  'member_provision',
  // Advisory Jev assessment for Inbox ordering. Approval policy remains the authority.
  'request_triage',
  // Exact revision-bound outreach after a human approves and a dedicated
  // sender account is connected.
  'outbound_email_send',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * Claim one job.
 *
 * The whole safety argument is in the WHERE clause: the row is only claimed if
 * it is still undone and either unlocked or expired, and `RETURNING` reports
 * whether this caller won. Two claimers racing on one row means one UPDATE
 * matches and the other matches nothing, so a receipt is sent once even when
 * the committing request and the Cron reach for it in the same millisecond.
 */
export async function claimJob(tx: Tx, jobId: string): Promise<Job | null> {
  const { rows } = await tx.query<Job>(
    `UPDATE jobs
        SET locked_until = now() + ($2 || ' seconds')::interval,
            attempts = attempts + 1,
            last_error = CASE WHEN last_error='member_provisioning_disabled' THEN NULL ELSE last_error END
      WHERE id = $1
        AND done_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM job_ready paused
           WHERE paused.job_id=jobs.id AND paused.pause_reason IS NOT NULL
        )
        AND (locked_until IS NULL OR locked_until < now())
      RETURNING id, workspace_id, kind, key, payload, attempts`,
    [jobId, String(CLAIM_SECONDS)],
  );
  return rows[0] ?? null;
}

/** Claim the next due job for a workspace, if any. Same predicate, no id. */
export async function claimNextJob(tx: Tx): Promise<Job | null> {
  const { rows } = await tx.query<Job>(
    `UPDATE jobs
        SET locked_until = now() + ($1 || ' seconds')::interval,
            attempts = attempts + 1,
            last_error = CASE WHEN last_error='member_provisioning_disabled' THEN NULL ELSE last_error END
      WHERE id = (
        SELECT id FROM jobs
         WHERE done_at IS NULL
           AND next_at <= now()
           AND NOT EXISTS (
             SELECT 1 FROM job_ready paused
              WHERE paused.job_id=jobs.id AND paused.pause_reason IS NOT NULL
           )
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY next_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, workspace_id, kind, key, payload, attempts`,
    [String(CLAIM_SECONDS)],
  );
  return rows[0] ?? null;
}

export async function finishJob(tx: Tx, jobId: string): Promise<void> {
  await tx.query('UPDATE jobs SET done_at = now(), locked_until = NULL WHERE id = $1', [jobId]);
  // The pointer the Cron reads exists only while there is work to point at.
  await tx.query('DELETE FROM job_ready WHERE job_id = $1', [jobId]);
}

/** Pause one known setup job and its platform pointer in the same commit. */
export async function pauseMemberProvisioningJob(tx: Tx, jobId: string): Promise<void> {
  const job = await tx.query(
    `UPDATE jobs
        SET locked_until=NULL, last_error='member_provisioning_disabled'
      WHERE id=$1 AND kind='member_provision' AND done_at IS NULL
      RETURNING id`,
    [jobId],
  );
  const pointer = await tx.query(
    `UPDATE job_ready
        SET pause_reason='member_provisioning_disabled'
      WHERE job_id=$1
      RETURNING job_id`,
    [jobId],
  );
  if (job.rowCount !== 1 || pointer.rowCount !== 1) {
    throw new Error('member provisioning pause lost its durable job pointer');
  }
}

async function finishFailedJob(tx: Tx, jobId: string, error: string): Promise<void> {
  await tx.query(
    `UPDATE jobs SET done_at=now(), locked_until=NULL, last_error=$2 WHERE id=$1`,
    [jobId, error.slice(0, 1000)],
  );
  await tx.query('DELETE FROM job_ready WHERE job_id=$1', [jobId]);
}

/** Release a failed job for a later attempt, with backoff. */
export async function failJob(
  tx: Tx,
  jobId: string,
  error: string,
  attempts: number,
  retryAfterSeconds = 0,
): Promise<void> {
  const backoffSeconds = Math.max(
    Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1)),
    Math.min(3600, Math.max(0, retryAfterSeconds)),
  );
  await tx.query(
    `UPDATE jobs
        SET locked_until = NULL,
            last_error = $2,
            next_at = now() + ($3 || ' seconds')::interval
      WHERE id = $1`,
    [jobId, error.slice(0, 1000), String(backoffSeconds)],
  );
  await tx.query(
    `UPDATE job_ready SET next_at = now() + ($2 || ' seconds')::interval WHERE job_id = $1`,
    [jobId, String(backoffSeconds)],
  );
}

/**
 * Enqueue inside the caller's transaction. `ON CONFLICT DO NOTHING` on
 * UNIQUE(kind, key) is the idempotency: a decision recorded twice by two tabs
 * still produces one receipt row, because both name the same key.
 *
 * The key must contain an id that is unique across workspaces (a decision id, a
 * document id, a stream range), because UNIQUE(kind, key) is global. A key like
 * `receipt:latest` would let one workspace's enqueue silently suppress
 * another's, and the suppressed tenant could not even see the row that blocked
 * it, because row-level security hides it. A test pins this down.
 *
 * Returns the id of the row this call created, or null when an identical key
 * was already queued — which is how a caller knows whether it has a job to run
 * after its own commit.
 */
export async function enqueueJob(
  tx: Tx,
  workspaceId: string,
  kind: string,
  key: string,
  payload: unknown = {},
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO jobs (workspace_id, kind, key, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (kind, key) DO NOTHING
     RETURNING id`,
    [workspaceId, kind, key, JSON.stringify(payload)],
  );
  const id = rows[0]?.id ?? null;
  if (id) {
    // Written in the same transaction as the job, because the Cron's only way
    // to find work across tenants is this table, and a pointer that commits
    // separately is a job nobody runs.
    await tx.query(
      `INSERT INTO job_ready (job_id, workspace_id) VALUES ($1, $2) ON CONFLICT (job_id) DO NOTHING`,
      [id, workspaceId],
    );
  }
  return id;
}

// ---------------------------------------------------------------------------
// Running jobs
// ---------------------------------------------------------------------------

/** The system actor for rows written by the Cron rather than by a person. */
export const SYSTEM_USER_ID = '00000000-0000-4000-8000-000000000000';

/**
 * A tenant transaction with no membership check.
 *
 * `withTenantTransaction` proves that the *caller* belongs to the workspace,
 * which is exactly right for a request and exactly wrong for the Cron: there is
 * no caller, and requiring one would mean inventing a service member with a
 * seat in every workspace. The tenant key is still set, so row-level security
 * still applies to every statement inside; what is missing is only the "and
 * this person may be here" half, and the caller is the Cron.
 */
export async function withWorkspaceTransaction<T>(
  env: Env,
  workspaceId: string,
  fn: (tx: Tx) => Promise<T>,
  role: Role = 'app',
): Promise<T> {
  const client = await connect(env, role);
  try {
    await client.query('BEGIN');
    try {
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', workspaceId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', SYSTEM_USER_ID]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

interface OutboxRow {
  id: string;
  session_id: string | null;
  kind: string;
  payload: unknown;
  schema_version: number;
  trace_id: string | null;
  created_at: Date;
}

/**
 * A committed outbox batch that the request which created it can hand to the
 * hub without re-reading it. The durable publish job remains the recovery
 * path until the hub acknowledges and the job is marked done.
 */
export interface PreparedPublication {
  readonly jobId: string;
  readonly sessionId: string | null;
  readonly events: readonly HubEvent[];
}

/** Deliver an already committed outbox batch without another database read. */
export async function deliverPreparedPublications(
  env: Env,
  workspaceId: string,
  publications: readonly PreparedPublication[],
): Promise<void> {
  for (const publication of publications) {
    if (publication.sessionId) {
      await env.SESSION_HUB.get(env.SESSION_HUB.idFromName(publication.sessionId)).publish(publication.events);
    } else {
      await env.WORKSPACE_HUB.get(env.WORKSPACE_HUB.idFromName(workspaceId)).publish(publication.events);
    }
  }
}

/**
 * Retire jobs whose side effects were acknowledged on the request's fast path.
 * One tenant transaction handles the whole handoff. If this background cleanup
 * fails, Cron safely replays the idempotent publish / Workflow creation later.
 */
export async function finishJobsAfterCommit(
  env: Env,
  workspaceId: string,
  jobIds: readonly string[],
): Promise<void> {
  if (jobIds.length === 0) return;
  await withWorkspaceTransaction(env, workspaceId, async (tx) => {
    for (const jobId of jobIds) await finishJob(tx, jobId);
  });
}

/**
 * `publish`: hand a committed range of outbox rows to the hub that fans them
 * out. The job is marked done only once the hub has acknowledged, so a Worker
 * that died between the commit and the RPC costs a minute of lag, not an event.
 */
async function runPublish(env: Env, job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as { session_id?: string | null; first_id?: string; last_id?: string };
  const events = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const result = await tx.query<OutboxRow>(
      `SELECT id::text AS id, session_id, kind, payload, schema_version, trace_id, created_at
         FROM stream_events
        WHERE workspace_id = $1
          AND id >= $2::bigint AND id <= $3::bigint
          AND session_id IS NOT DISTINCT FROM $4::uuid
        ORDER BY id`,
      [job.workspace_id, payload.first_id ?? '0', payload.last_id ?? '0', payload.session_id ?? null],
    );
    const envelopes: HubEvent[] = result.rows.map((row) => ({
      id: row.id,
      workspace_id: job.workspace_id,
      session_id: row.session_id,
      kind: row.kind,
      payload: row.payload,
      schema_version: row.schema_version,
      trace_id: row.trace_id ?? 'unknown',
      at: row.created_at.toISOString(),
    }));
    return scopeWorkspaceHubEvents(tx, envelopes);
  });
  if (events.length === 0) return;

  if (payload.session_id) {
    const stub = env.SESSION_HUB.get(env.SESSION_HUB.idFromName(payload.session_id));
    await stub.publish(events);
  } else {
    const stub = env.WORKSPACE_HUB.get(env.WORKSPACE_HUB.idFromName(job.workspace_id));
    await stub.publish(events);
  }
}

/**
 * `evict`: close every socket belonging to someone whose access just changed.
 *
 * The fan-out reaches the workspace hub and each session hub the person could
 * see. It is best-effort by design — the ticket window is ten minutes, so an
 * eviction that never arrived still takes effect on its own — but retrying it
 * until a hub acknowledges turns "within ten minutes" into "immediately".
 */
async function runEvict(env: Env, job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as { user_id?: string };
  const userId = payload.user_id;
  if (!userId) return;

  const sessionIds = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const result = await tx.query<{ id: string }>(
      `SELECT id FROM sessions WHERE workspace_id = $1 AND owner_id = $2`,
      [job.workspace_id, userId],
    );
    return result.rows.map((row) => row.id);
  });

  const workspaceHub = env.WORKSPACE_HUB.get(env.WORKSPACE_HUB.idFromName(job.workspace_id));
  await workspaceHub.evict(userId);
  for (const sessionId of sessionIds) {
    const stub = env.SESSION_HUB.get(env.SESSION_HUB.idFromName(sessionId));
    await stub.evict(userId);
  }
}

/**
 * `workos_sync`: the WorkOS-side write, after ours committed.
 *
 * Order matters and is the plan's: our transaction first, WorkOS second. If
 * WorkOS is down, the member is already inactive here — which is the half that
 * governs what they can do in this product — and the job retries until the
 * other half catches up. The reverse order would leave a window where WorkOS
 * says no and we still say yes.
 */
async function runWorkosSync(env: Env, job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as {
    action?: string;
    workos_membership_id?: string | null;
    workos_invitation_id?: string | null;
    role?: string;
    invitation_id?: string;
    previous_workos_invitation_id?: string | null;
    organization_id?: string;
    email?: string;
    inviter_user_id?: string;
    correlation_id?: string;
  };
  const port = optionalWorkosPort(env);
  const mark = async (status: 'done' | 'failed', error?: string): Promise<void> => {
    await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
      await tx.query(
        `UPDATE workos_sync SET status = $2, last_error = $3, attempts = attempts + 1, updated_at = now()
          WHERE workspace_id = $1 AND payload->>'job_key' = $4`,
        [job.workspace_id, status, error ?? null, job.key],
      );
    });
  };

  const invitationAction: InvitationDiagnosticAction | null = payload.action === 'send_invitation'
    ? 'send_delivery'
    : payload.action === 'resend_invitation'
      ? 'resend_delivery'
      : null;
  const correlationId = invitationCorrelationId(payload.correlation_id ?? job.id);
  const invitationLog = (
    checkpoint: string,
    ok: boolean,
    reason?: string,
  ): void => {
    if (!invitationAction) return;
    logInvitationDiagnostic({
      action: invitationAction,
      checkpoint,
      correlationId,
      workspaceId: job.workspace_id,
      invitationId: payload.invitation_id,
      jobId: job.id,
      ok,
      reason,
    });
  };

  invitationLog('job_claimed', true);

  if (!port) {
    if (env.AUTH_MODE === 'workos' || env.ENVIRONMENT === 'staging' || env.ENVIRONMENT === 'production') {
      // A production-mode sync is not complete when the system that owns the
      // organization or invitation was never called. Mark the evidence failed
      // and throw so the durable job keeps retrying instead of erasing the gap.
      if (invitationAction) {
        const reason = 'workos_invitation_delivery_not_configured';
        if (payload.invitation_id) {
          await withWorkspaceTransaction(env, job.workspace_id, (tx) => tx.query(
            `UPDATE invitations SET delivery_status='failed', delivery_error=$3
              WHERE workspace_id=$1 AND id=$2 AND status='pending'
                AND delivery_status IN ('queued', 'sending', 'not_required')`,
            [job.workspace_id, payload.invitation_id, reason],
          ));
        }
        await mark('failed', reason);
        invitationLog('provider_unavailable', false, reason);
        throw new InvitationDeliveryError(reason);
      }
      await mark('failed', 'workos not configured');
      throw new Error('WorkOS is required for this synchronization job');
    }
    // Fake development has deliberately no upstream to mirror to.
    await mark('done', 'workos disabled in development');
    return;
  }

  switch (payload.action) {
    case 'send_invitation':
    case 'resend_invitation': {
      if (!payload.invitation_id || !payload.organization_id || !payload.email || !payload.role) {
        const reason = 'workos_invitation_payload_invalid';
        await mark('failed', reason);
        invitationLog('job_payload_invalid', false, reason);
        throw new InvitationDeliveryError(reason, 0, false);
      }
      const invitationId = payload.invitation_id;
      // A delivery job may have been delayed behind an outage. Reconcile local
      // expiry before making the external call so an invitation cannot be sent
      // after the reservation that guaranteed its Iris should have expired.
      const { expireInvitationReservations } = await import('./hermes-cloud/capacity.js');
      const deliverable = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
        await expireInvitationReservations(tx, job.workspace_id);
        const invitation = await tx.query<{
          status: string;
          workos_invitation_id: string | null;
          delivery_status: string;
          delivery_error: string | null;
        }>(
          `SELECT status, workos_invitation_id, delivery_status, delivery_error FROM invitations
            WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
          [job.workspace_id, payload.invitation_id],
        );
        const row = invitation.rows[0];
        if (!row || row.status !== 'pending') return { deliver: false, done: true, failure: null };
        if (row.workos_invitation_id) {
          await tx.query(
            `UPDATE invitations SET delivery_status='delivered', delivery_error=NULL WHERE id=$1`,
            [payload.invitation_id],
          );
          return { deliver: false, done: true, failure: null };
        }
        if (row.delivery_status === 'sending') {
          return {
            deliver: false,
            done: false,
            failure: 'workos_invitation_delivery_outcome_unknown',
          };
        }
        const persistedTerminalReason = row.delivery_error;
        if (row.delivery_status === 'failed' && persistedTerminalReason && [
          'workos_invitation_delivery_outcome_unknown',
          'workos_invitation_delivery_rejected',
          'workos_invitation_local_commit_failed',
          'iris_capacity_reservation_missing',
        ].includes(persistedTerminalReason)) {
          return { deliver: false, done: false, failure: persistedTerminalReason };
        }
        // A setup-first invitation is delivered only while its operation is
        // still `ready` and the exact reservation behind it is current, on any
        // runtime: the reservation is what the recipient is being promised.
        // Legacy rows check the same thing on the Hermes runtime only.
        const setupBacked = await tx.query<{ id: string }>(
          `SELECT id FROM member_provisioning_operations WHERE workspace_id=$1 AND invitation_id=$2`,
          [job.workspace_id, invitationId],
        );
        if (env.AGENT_RUNTIME === 'hermes' || setupBacked.rows.length > 0) {
          const { capacityRoleForInvitation, hasCurrentReservedCapacityForInvitation } =
            await import('./hermes-cloud/capacity.js');
          let current = false;
          try {
            const role = await capacityRoleForInvitation(
              tx, job.workspace_id, invitationId, { requireReadyOperation: true },
            );
            current = await hasCurrentReservedCapacityForInvitation(
              env, tx, job.workspace_id, invitationId, role,
            );
          } catch (error) {
            // An operation that stopped being ready between queueing and this
            // claim is the same fact as a lost reservation: fail closed, never
            // send an email for capacity nobody holds.
            if ((error as { reason?: string }).reason !== 'invitation_capacity_unavailable') throw error;
          }
          if (!current) {
            return { deliver: false, done: false, failure: 'iris_capacity_reservation_missing' };
          }
        }
        await tx.query(
          `UPDATE invitations SET delivery_status='sending', delivery_error=NULL WHERE id=$1`,
          [payload.invitation_id],
        );
        return { deliver: true, done: false, failure: null };
      });
      if (deliverable.failure) {
        await withWorkspaceTransaction(env, job.workspace_id, (tx) => tx.query(
          `UPDATE invitations SET delivery_status='failed', delivery_error=$3
            WHERE workspace_id=$1 AND id=$2 AND status='pending'`,
          [job.workspace_id, payload.invitation_id, deliverable.failure],
        ));
        try { await mark('failed', deliverable.failure); }
        catch { /* The terminal delivery state remains authoritative. */ }
        const checkpoint = deliverable.failure === 'workos_invitation_delivery_outcome_unknown'
          ? 'ambiguous_delivery_detected'
          : deliverable.failure === 'iris_capacity_reservation_missing'
            ? 'reservation_recheck_failed'
            : 'terminal_delivery_replayed';
        try { invitationLog(checkpoint, false, deliverable.failure); }
        catch { /* Logging cannot make a terminal delivery retryable. */ }
        // These states require Admin reconciliation. The persisted terminal
        // reason also prevents a later claim from re-entering provider send.
        throw new InvitationDeliveryError(deliverable.failure, 0, false);
      }
      invitationLog(deliverable.done ? 'delivery_already_resolved' : 'pending_and_reservation_rechecked', true);
      if (deliverable.deliver) {
        let sent: Awaited<ReturnType<typeof port.sendInvitation>>;
        try {
          invitationLog('provider_attempted', true);
          sent = payload.action === 'resend_invitation' && payload.previous_workos_invitation_id
            ? await port.resendInvitation(payload.previous_workos_invitation_id)
            : await port.sendInvitation({
                email: payload.email,
                organizationId: payload.organization_id,
                roleSlug: payload.role,
                inviterUserId: payload.inviter_user_id,
                expiresInDays: 7,
              });
          invitationLog('provider_accepted', true);
        } catch (error) {
          const failure = classifyInvitationDeliveryFailure(error);
          await withWorkspaceTransaction(env, job.workspace_id, (tx) => tx.query(
            `UPDATE invitations SET delivery_status='failed', delivery_error=$3
              WHERE workspace_id=$1 AND id=$2 AND status='pending'`,
            [job.workspace_id, payload.invitation_id, failure.reason],
          ));
          if (failure.retryable) {
            await mark('failed', failure.reason);
          } else {
            try { await mark('failed', failure.reason); } catch { /* Preserve the terminal provider outcome. */ }
          }
          try { invitationLog('provider_failed', false, failure.reason); }
          catch { /* Logging cannot change provider retry safety. */ }
          throw new InvitationDeliveryError(failure.reason, failure.retryAfterSeconds, failure.retryable);
        }

        try {
          await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
            await tx.query(
              `UPDATE invitations
                  SET workos_invitation_id=$3, expires_at=$4, delivery_status='delivered', delivery_error=NULL
                WHERE workspace_id=$1 AND id=$2 AND status='pending'`,
              [job.workspace_id, payload.invitation_id, sent.id, sent.expiresAt],
            );
            const expiryKey = `invitation-expire:${payload.invitation_id}`;
            await tx.query(
              `UPDATE jobs SET next_at=$3 WHERE workspace_id=$1 AND kind='hermes_invitation_expire' AND key=$2 AND done_at IS NULL`,
              [job.workspace_id, expiryKey, sent.expiresAt],
            );
            await tx.query(
              `UPDATE job_ready r SET next_at=$3
                FROM jobs j
               WHERE r.job_id=j.id AND j.workspace_id=$1 AND j.kind='hermes_invitation_expire' AND j.key=$2`,
              [job.workspace_id, expiryKey, sent.expiresAt],
            );
          });
          invitationLog('local_delivery_committed', true);
        } catch {
          const reason = 'workos_invitation_local_commit_failed';
          try {
            await withWorkspaceTransaction(env, job.workspace_id, (tx) => tx.query(
              `UPDATE invitations
                  SET workos_invitation_id=$3, expires_at=$4, delivery_status='failed', delivery_error=$5
                WHERE workspace_id=$1 AND id=$2 AND status='pending'`,
              [job.workspace_id, payload.invitation_id, sent.id, sent.expiresAt, reason],
            ));
          } catch {
            // The provider response is still never replayed automatically. A
            // later Admin reconciliation can use the shared correlation id.
          }
          try {
            await mark('failed', reason);
          } catch {
            // Do not turn a post-acceptance bookkeeping failure into another
            // provider call. The terminal error below remains authoritative.
          }
          try {
            invitationLog('local_delivery_commit_failed', false, reason);
          } catch {
            // Logging cannot make an accepted provider write retryable.
          }
          // WorkOS already accepted the write. Replaying this job could send a
          // second email because the provider id was the value we failed to
          // persist, so keep the uncertainty visible for manual reconciliation.
          throw new InvitationDeliveryError(reason, 0, false);
        }
      }
      break;
    }
    case 'deactivate_membership':
      if (payload.workos_membership_id) {
        await port.deactivateOrganizationMembership(payload.workos_membership_id);
      }
      break;
    case 'update_membership_role':
      if (payload.workos_membership_id && payload.role) {
        await port.updateOrganizationMembership(payload.workos_membership_id, payload.role);
      }
      break;
    case 'revoke_invitation':
      if (payload.workos_invitation_id) await port.revokeInvitation(payload.workos_invitation_id);
      break;
    default:
      break;
  }
  await mark('done');
}

/**
 * `render`: hand one `(document_id, version)` pair to the renders queue.
 *
 * Two mechanisms rather than one, and they do different jobs. The `jobs` row
 * commits with the document, so the render cannot be forgotten; the queue gives
 * the work retries, a dead-letter queue and a consumer that is not holding a
 * request open. A direct render here would tie a 20-line HTML build to whatever
 * request happened to commit the decision.
 */
async function runRender(env: Env, job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as { document_id?: string; version?: number };
  if (!payload.document_id || typeof payload.version !== 'number') {
    console.log(JSON.stringify({ at: 'job.render', key: job.key, ok: false, note: 'malformed render payload' }));
    return;
  }
  await env.RENDERS_QUEUE.send({
    workspace_id: job.workspace_id,
    document_id: payload.document_id,
    version: payload.version,
  });
}

/**
 * Admit a human-approved continuation under app-role policy, then create the
 * Workflow instance only after that transaction commits. A replay either
 * finds the same admitted run or retries a temporarily blocked admission; it
 * can never mint a second run for the same revision-bound intent.
 */
async function runApprovalContinue(env: Env, job: Job): Promise<void> {
  const hook = approvalFinalizedHookSchema.parse(job.payload);
  if (hook.workspace_id !== job.workspace_id) throw new Error('approval_continue_workspace_mismatch');

  const admission = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const current = await loadApprovalView(tx, hook.request_id, null);
    const result = await admitApprovalContinuation(tx, env, hook, current);
    if (result.status === 'admitted' && result.message) {
      await publishEvents(tx, job.workspace_id, [{
        kind: 'message.appended',
        sessionId: result.instance.sessionId,
        traceId: result.instance.traceId,
        payload: {
          message_id: result.message.id,
          session_id: result.instance.sessionId,
          seq: result.message.seq,
          role: 'system',
          kind: 'approval_continuation',
          text: result.message.text,
          blocks: [],
          status: 'complete',
          run_id: result.runId,
        },
      }]);
    }
    return result;
  });

  if (admission.status === 'blocked') throw new Error(`approval_continue_blocked:${admission.reason}`);
  if (admission.status !== 'admitted' && admission.status !== 'already_admitted') {
    console.log(JSON.stringify({
      at: 'job.approval_continue',
      request_id: hook.request_id,
      status: admission.status,
      reason: 'reason' in admission ? admission.reason : 'admission_not_created',
    }));
    return;
  }

  const instanceId = runAttemptInstanceId(admission.runId, admission.instance.attempt);
  try {
    await env.RUN_ATTEMPT.create({ id: instanceId, params: admission.instance });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists|duplicate|instance.*id/i.test(message)) throw error;
  }
}

/** Dispatch. An unknown kind is done rather than retried forever. */
export async function runJob(env: Env, job: Job, adapterOptions: AdapterOptions = {}): Promise<JobDisposition> {
  switch (job.kind) {
    case 'publish':
      await runPublish(env, job);
      return;
    case 'evict':
      await runEvict(env, job);
      return;
    case 'workos_sync':
      await runWorkosSync(env, job);
      return;
    case 'member_provision':
      return (await import('./member-provisioning/service.js')).runMemberProvisioningJob(env, job);
    case 'backup_uploads':
      // The nightly copy of one workspace's uploads prefix into the backup
      // bucket. A no-op where no backup bucket is bound (storage/backup.ts).
      await runBackupUploads(env, job.workspace_id);
      return;
    case 'receipt':
      // The two lines a decision leaves in the originating session, keyed on
      // `decision_id` so a replay writes nothing. See src/runs/receipt.ts.
      await runReceiptJob(env, job);
      return;
    case 'render':
      // The job row is the durable half and the queue message is the working
      // half. Written in the decision's transaction, so a document cannot exist
      // without a render queued for it; the send happens here, after that
      // commit, and the Cron retries this row until the queue accepted it.
      await runRender(env, job);
      return;
    case 'cap_warning':
      // Spend crossed 80 percent of the workspace's daily token cap. Re-reads
      // the caps rather than trusting the payload: a cap raised in the minute
      // since it was queued means the right answer is to do nothing.
      await runCapWarningJob(env, job);
      return;
    case 'events_export':
      // The weekly CSV of one workspace's audit trail into the backup bucket.
      await runEventsExport(env, job);
      return;
    case 'approval_continue':
      await runApprovalContinue(env, job);
      return;
    case 'slack_ingest':
      await (await import('./integrations/slack/ingest.js')).runSlackIngestJob(env, job);
      return;
    case 'slack_deliver':
      await (await import('./integrations/slack/deliver.js')).runSlackDeliverJob(env, job);
      return;
    case 'slack_revoke':
      await (await import('./integrations/slack/revoke.js')).runSlackRevokeJob(env, job);
      return;
    case 'run_recovery':
      await (await import('./runs/recovery.js')).runRecoveryJob(env, job);
      return;
    case 'run_launch':
      await (await import('./runs/recovery.js')).runLaunchJob(env, job);
      return;
    case 'partner_screening':
      await (await import('./partner-screening/automation.js')).runPartnerScreeningAutomationJob(env, job);
      return;
    case 'partner_invoice_review':
      await (await import('./partner-workflow/job.js')).runPartnerInvoiceReviewJob(env, job);
      return;
    case 'partner_acknowledgment':
      await (await import('./partner-workflow/acknowledgment.js')).runPartnerAcknowledgmentJob(env, job);
      return;
    case 'hermes_invitation_expire':
      await (await import('./hermes-cloud/capacity.js')).runInvitationExpirationJob(env, job);
      return;
    case 'hermes_capacity_alert':
      (await import('./hermes-cloud/capacity.js')).runCapacityAlertJob(job);
      return;
    case 'request_triage':
      await (await import('./inbox-triage/service.js')).runRequestTriageJob(env, job);
      return;
    case 'outbound_email_send':
      await (await import('./outbound-email/send-job.js')).runOutboundEmailSendJob(env, job);
      return;
    case 'reverify':
      {
        const payload = (job.payload ?? {}) as Partial<ReverifyPayload>;
        if (typeof payload.key_id !== 'string' || typeof payload.provider !== 'string') {
          console.log(JSON.stringify({ at: 'job.reverify', key: job.key, ok: false, note: 'malformed payload' }));
          return;
        }
        const result = await runReverifyJob(
          (fn) => withWorkspaceTransaction(env, job.workspace_id, fn),
          env,
          job.workspace_id,
          payload as ReverifyPayload,
          adapterOptions,
        );
        // A 403, 429 or provider outage is not completion. `recordVerification`
        // has preserved the unverified status; throwing here lets the generic
        // wrapper retain this same job and apply its bounded retry backoff.
        if ('status' in result && result.status === 'unverified') {
          throw new Error('provider key re-verification was inconclusive');
        }
      }
      return;
    default:
      console.log(JSON.stringify({ at: 'job', kind: job.kind, note: 'unknown kind' }));
      return;
  }
}

/** Claim, run, finish or fail. Returns true when the job was run to done. */
async function claimRunFinish(
  env: Env,
  workspaceId: string,
  jobId: string,
  adapterOptions: AdapterOptions = {},
): Promise<boolean> {
  const job = await withWorkspaceTransaction(env, workspaceId, (tx) => claimJob(tx, jobId));
  if (!job) return false;
  try {
    const disposition = await runJob(env, job, adapterOptions);
    if (disposition === 'paused') {
      await withWorkspaceTransaction(env, workspaceId, (tx) => pauseMemberProvisioningJob(tx, job.id));
      return false;
    }
    await withWorkspaceTransaction(env, workspaceId, (tx) => finishJob(tx, job.id));
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryAfter = error instanceof Error
      && 'retryAfterSeconds' in error
      && typeof error.retryAfterSeconds === 'number'
      ? error.retryAfterSeconds
      : 0;
    const retryable = !(error instanceof InvitationDeliveryError) || error.retryable;
    await withWorkspaceTransaction(env, workspaceId, (tx) => retryable
      ? failJob(tx, job.id, message, job.attempts, retryAfter)
      : finishFailedJob(tx, job.id, message));
    logError({
      at: 'job.failed',
      kind: job.kind,
      key: job.key,
      attempt: job.attempts,
      error,
    });
    return false;
  }
}

/**
 * The committing request's own jobs, run after its transaction committed.
 *
 * Failures are swallowed on purpose: the change is already durable and the Cron
 * will retry the job. A route that returned 500 because a fan-out was slow
 * would be telling the caller their change did not happen when it did.
 */
export async function runJobsAfterCommit(env: Env, workspaceId: string, jobIds: readonly string[]): Promise<void> {
  for (const jobId of jobIds) {
    try {
      await claimRunFinish(env, workspaceId, jobId);
    } catch (error) {
      console.log(JSON.stringify({ at: 'job', phase: 'after_commit', ok: false, id: jobId, error: String(error) }));
    }
  }
}

/**
 * The minute Cron's drain.
 *
 * `job_ready` is the only place a cross-tenant question can be asked, because
 * no connection in this system can read two workspaces' `jobs` rows (see
 * migration 0008). It holds ids and a due time and nothing else.
 */
export async function drainJobs(
  env: Env,
  limit = 50,
  adapterOptions: AdapterOptions = {},
): Promise<{ claimed: number; done: number; failed: number }> {
  const client = await connect(env, 'app');
  let due: { job_id: string; workspace_id: string }[];
  try {
    if (env.HERMES_MEMBER_PROVISIONING_ENABLED === '1') {
      await client.query(
        `UPDATE job_ready
            SET pause_reason=NULL, next_at=now()
          WHERE pause_reason='member_provisioning_disabled'`,
      );
    }
    const { rows } = await client.query<{ job_id: string; workspace_id: string }>(
      `SELECT job_id, workspace_id FROM job_ready
        WHERE pause_reason IS NULL AND next_at <= now()
        ORDER BY next_at LIMIT $1`,
      [limit],
    );
    due = rows;
  } finally {
    await client.end();
  }

  let done = 0;
  let failed = 0;
  // `failed` counts the rows this pass claimed and could not finish. It is
  // reported rather than inferred from `claimed - done`, because a row that was
  // already claimed by another drainer is neither: a test that drains to a
  // quiet state needs to tell "nothing left" from "nothing I could do".
  for (const row of due) {
    if (await claimRunFinish(env, row.workspace_id, row.job_id, adapterOptions)) done += 1;
    else failed += 1;
  }
  return { claimed: due.length, done, failed };
}

// ---------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------

export interface OutboxEvent {
  readonly kind: string;
  readonly payload: unknown;
  readonly sessionId?: string | null;
  readonly traceId?: string | null;
}

async function preparePublications(
  tx: Tx,
  workspaceId: string,
  events: readonly OutboxEvent[],
): Promise<PreparedPublication[]> {
  const byStream = new Map<string | null, OutboxRow[]>();

  for (const event of events) {
    const { rows } = await tx.query<OutboxRow>(
      `INSERT INTO stream_events (workspace_id, session_id, kind, payload, trace_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING id::text AS id, session_id, kind, payload, schema_version, trace_id, created_at`,
      [workspaceId, event.sessionId ?? null, event.kind, JSON.stringify(event.payload), event.traceId ?? null],
    );
    const row = rows[0];
    if (!row) continue;
    const key = row.session_id ?? null;
    byStream.set(key, [...(byStream.get(key) ?? []), row]);
  }

  const publications: PreparedPublication[] = [];
  for (const [sessionId, rows] of byStream) {
    const first = rows[0]?.id;
    const last = rows[rows.length - 1]?.id;
    if (!first || !last) continue;
    const jobId = await enqueueJob(tx, workspaceId, 'publish', `publish:${sessionId ?? 'workspace'}:${first}-${last}`, {
      session_id: sessionId,
      first_id: first,
      last_id: last,
    });
    if (!jobId) continue;
    const envelopes: HubEvent[] = rows.map((row) => ({
      id: row.id,
      workspace_id: workspaceId,
      session_id: row.session_id,
      kind: row.kind,
      payload: row.payload,
      schema_version: row.schema_version,
      trace_id: row.trace_id ?? 'unknown',
      at: row.created_at.toISOString(),
    }));
    publications.push({
      jobId,
      sessionId,
      events: await scopeWorkspaceHubEvents(tx, envelopes),
    });
  }
  return publications;
}

/**
 * Append to the outbox and queue its delivery, in the caller's transaction.
 *
 * Both halves commit together, which is the property the whole push design
 * rests on: a client cannot miss a committed event, because the row that says
 * "deliver this" is written by the same commit as the event itself.
 */
export async function publishEvents(
  tx: Tx,
  workspaceId: string,
  events: readonly OutboxEvent[],
): Promise<string[]> {
  return (await preparePublications(tx, workspaceId, events)).map((publication) => publication.jobId);
}

/**
 * Append, queue and retain the exact committed envelopes for an ordered direct
 * handoff. Callers must use this only after the surrounding transaction has
 * committed; the durable jobs cover every crash before acknowledgement.
 */
export async function publishEventsForImmediateDelivery(
  tx: Tx,
  workspaceId: string,
  events: readonly OutboxEvent[],
): Promise<PreparedPublication[]> {
  return preparePublications(tx, workspaceId, events);
}
