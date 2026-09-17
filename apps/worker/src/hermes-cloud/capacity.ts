import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { RouteError } from '../routes/tenant.js';
import type { Job } from '../jobs.js';
import { enqueueJob, withWorkspaceTransaction } from '../jobs.js';
import { openSecret, sealSecret, type StoredEnvelope } from '../keys/envelope.js';

export const POOL_CONTROL_NAMESPACE = 'hermes/pool-control/v1';
export const RUNTIME_CONTROL_NAMESPACE = 'hermes/runtime-control/v1';

interface EnvelopeRow {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  wrapped_dek: Uint8Array;
  wrap_iv: Uint8Array;
  kek_version: number;
}

export interface CapacityRow extends EnvelopeRow {
  id: string;
  cloud_agent_id: string;
  instance_name: string;
  preflight_agent_id: string;
  dashboard_url: string | null;
  connector_url: string;
  state: 'available' | 'reserved' | 'assigning' | 'assigned' | 'quarantined';
  reserved_invitation_id: string | null;
  assigned_agent_id: string | null;
  plugin_version: string;
}

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  throw new Error('expected Hermes capacity credential envelope bytes');
};

const stored = (row: EnvelopeRow): StoredEnvelope => ({
  ciphertext: bytes(row.ciphertext),
  iv: bytes(row.iv),
  wrappedDek: bytes(row.wrapped_dek),
  wrapIv: bytes(row.wrap_iv),
  kekVersion: row.kek_version,
});

export async function expireInvitationReservations(tx: Tx, workspaceId: string): Promise<number> {
  const expired = await tx.query<{ id: string }>(
    `UPDATE invitations
        SET status='expired', delivery_status=CASE WHEN delivery_status='delivered' THEN delivery_status ELSE 'failed' END
      WHERE workspace_id=$1 AND status='pending' AND expires_at <= now()
      RETURNING id`,
    [workspaceId],
  );
  if (expired.rows.length === 0) return 0;
  await tx.query(
    `UPDATE hermes_cloud_capacity
        SET state='available', reserved_invitation_id=NULL
      WHERE workspace_id=$1 AND state='reserved' AND reserved_invitation_id=ANY($2::uuid[])`,
    [workspaceId, expired.rows.map((row) => row.id)],
  );
  return expired.rows.length;
}

export async function reserveCapacityForInvitation(
  tx: Tx,
  workspaceId: string,
  invitationId: string,
): Promise<{ id: string; remaining: number } | null> {
  await expireInvitationReservations(tx, workspaceId);
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM hermes_cloud_capacity
      WHERE workspace_id=$1 AND reserved_invitation_id=$2
      LIMIT 1`,
    [workspaceId, invitationId],
  );
  let id = existing.rows[0]?.id ?? null;
  if (!id) {
    const claimed = await tx.query<{ id: string }>(
      `UPDATE hermes_cloud_capacity
          SET state='reserved', reserved_invitation_id=$2
        WHERE id = (
          SELECT id FROM hermes_cloud_capacity
           WHERE workspace_id=$1 AND state='available'
             AND agentcash_enabled AND agentcash_wallet_present AND native_cron_disabled
           ORDER BY readiness_checked_at, created_at
           FOR UPDATE SKIP LOCKED LIMIT 1
        )
        RETURNING id`,
      [workspaceId, invitationId],
    );
    id = claimed.rows[0]?.id ?? null;
  }
  if (!id) return null;
  const remaining = await tx.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM hermes_cloud_capacity
      WHERE workspace_id=$1 AND state='available'
        AND agentcash_enabled AND agentcash_wallet_present AND native_cron_disabled`,
    [workspaceId],
  );
  return { id, remaining: remaining.rows[0]?.count ?? 0 };
}

export async function releaseInvitationCapacity(tx: Tx, workspaceId: string, invitationId: string): Promise<void> {
  await tx.query(
    `UPDATE hermes_cloud_capacity
        SET state='available', reserved_invitation_id=NULL
      WHERE workspace_id=$1 AND reserved_invitation_id=$2 AND state='reserved'`,
    [workspaceId, invitationId],
  );
}

export async function transferInvitationCapacity(
  tx: Tx,
  workspaceId: string,
  fromInvitationId: string,
  toInvitationId: string,
): Promise<boolean> {
  const moved = await tx.query(
    `UPDATE hermes_cloud_capacity SET reserved_invitation_id=$3
      WHERE workspace_id=$1 AND reserved_invitation_id=$2 AND state='reserved'`,
    [workspaceId, fromInvitationId, toInvitationId],
  );
  return moved.rowCount === 1;
}

/** The Cloud profile is permanently bound to this identity before invitation. */
export async function reservedCapacityAgentId(
  tx: Tx,
  workspaceId: string,
  invitationId: string,
): Promise<string> {
  const result = await tx.query<{ preflight_agent_id: string }>(
    `SELECT preflight_agent_id FROM hermes_cloud_capacity
      WHERE workspace_id=$1 AND reserved_invitation_id=$2 AND state='reserved'
      FOR UPDATE`,
    [workspaceId, invitationId],
  );
  const agentId = result.rows[0]?.preflight_agent_id;
  if (!agentId) {
    throw new RouteError(
      'This invitation no longer has an Iris reserved for it. Ask an organization admin to send a new invitation.',
      'invitation_capacity_unavailable',
      409,
    );
  }
  return agentId;
}

export async function consumeReservedCapacity(
  env: Env,
  tx: Tx,
  workspaceId: string,
  invitationId: string,
  agentId: string,
): Promise<CapacityRow> {
  const result = await tx.query<CapacityRow>(
    `SELECT id, cloud_agent_id, instance_name, preflight_agent_id, dashboard_url, connector_url, state,
            reserved_invitation_id, assigned_agent_id, plugin_version,
            ciphertext, iv, wrapped_dek, wrap_iv, kek_version
       FROM hermes_cloud_capacity
      WHERE workspace_id=$1 AND reserved_invitation_id=$2 AND state='reserved'
      FOR UPDATE`,
    [workspaceId, invitationId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new RouteError(
      'This invitation no longer has an Iris reserved for it. Ask an organization admin to send a new invitation.',
      'invitation_capacity_unavailable',
      409,
    );
  }
  if (row.preflight_agent_id !== agentId) {
    throw new RouteError(
      'The reserved Iris identity does not match this invitation.',
      'invitation_capacity_mismatch',
      409,
    );
  }
  const secret = await openSecret(
    env,
    { workspaceId, keyId: row.id, namespace: POOL_CONTROL_NAMESPACE },
    stored(row),
  );
  const binding = await sealSecret(
    env,
    { workspaceId, keyId: agentId, namespace: RUNTIME_CONTROL_NAMESPACE },
    secret,
  );
  await tx.query(
    `INSERT INTO agent_runtime_bindings
       (workspace_id, agent_id, profile, base_url, transport, assignment, agentcash,
        ciphertext, iv, wrapped_dek, wrap_iv, kek_version, ready_at)
     VALUES ($1,$2,$3,$4,'dashboard_connector','invitee_pool',true,$5,$6,$7,$8,$9,now())
     ON CONFLICT (agent_id) DO UPDATE SET
       base_url=EXCLUDED.base_url, transport=EXCLUDED.transport,
       assignment=EXCLUDED.assignment, agentcash=EXCLUDED.agentcash,
       ciphertext=EXCLUDED.ciphertext, iv=EXCLUDED.iv,
       wrapped_dek=EXCLUDED.wrapped_dek, wrap_iv=EXCLUDED.wrap_iv,
       kek_version=EXCLUDED.kek_version, ready_at=now()`,
    [workspaceId, agentId, `agent-${agentId}`, row.connector_url,
     Buffer.from(binding.ciphertext), Buffer.from(binding.iv), Buffer.from(binding.wrappedDek),
     Buffer.from(binding.wrapIv), binding.kekVersion],
  );
  await tx.query(
    `UPDATE hermes_cloud_capacity SET state='assigned', assigned_agent_id=$3, assigned_at=now(),
        last_health_checked_at=now()
      WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,
    [workspaceId, row.id, agentId],
  );
  await tx.query(
    `INSERT INTO agent_provisioning
       (workspace_id, agent_id, status, cloud_agent_id, instance_name, dashboard_url,
        requested_at, cloud_created_at, ready_at)
     VALUES ($1,$2,'ready',$3,$4,$5,now(),now(),now())
     ON CONFLICT (agent_id) DO UPDATE SET
       status='ready', cloud_agent_id=EXCLUDED.cloud_agent_id,
       instance_name=EXCLUDED.instance_name, dashboard_url=EXCLUDED.dashboard_url,
       ready_at=now(), error_code=NULL, error_detail=NULL`,
    [workspaceId, agentId, row.cloud_agent_id, row.instance_name, row.dashboard_url],
  );
  return row;
}

export async function enqueueCapacityWarning(
  tx: Tx,
  workspaceId: string,
  remaining: number,
  threshold: number,
): Promise<void> {
  if (remaining > threshold) return;
  await enqueueJob(
    tx,
    workspaceId,
    'hermes_capacity_alert',
    `hermes-capacity-low:${workspaceId}:${remaining}:${new Date().toISOString().slice(0, 10)}`,
    { kind: 'low_capacity', remaining, threshold },
  );
}

export async function runInvitationExpirationJob(env: Env, job: Job): Promise<void> {
  await withWorkspaceTransaction(env, job.workspace_id, (tx) => expireInvitationReservations(tx, job.workspace_id));
}

export function runCapacityAlertJob(job: Job): void {
  console.warn(JSON.stringify({ at: 'hermes.capacity', workspace_id: job.workspace_id, ...((job.payload ?? {}) as object) }));
}
