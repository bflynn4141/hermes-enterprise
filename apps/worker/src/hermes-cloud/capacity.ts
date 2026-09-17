import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { RouteError } from '../routes/tenant.js';
import type { Job } from '../jobs.js';
import { enqueueJob, withWorkspaceTransaction } from '../jobs.js';
import { openSecret, sealSecret, type StoredEnvelope } from '../keys/envelope.js';
import { provisioningBridgeToken } from '../runtime/config.js';
import { HermesClient } from '../runtime/client.js';
import { HermesCloudClient, HermesCloudError } from './client.js';

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

function randomControlSecret(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function publicOrigin(env: Env): string {
  const url = new URL(env.HERMES_ENTERPRISE_PUBLIC_URL?.trim() || '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new HermesCloudError('Enterprise public URL is not configured', 'enterprise_public_url_missing');
  }
  return url.origin;
}

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

export async function consumeReservedCapacity(
  env: Env,
  tx: Tx,
  workspaceId: string,
  invitationId: string,
  agentId: string,
): Promise<CapacityRow> {
  const result = await tx.query<CapacityRow>(
    `SELECT id, cloud_agent_id, instance_name, dashboard_url, connector_url, state,
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
        ciphertext, iv, wrapped_dek, wrap_iv, kek_version)
     VALUES ($1,$2,$3,$4,'dashboard_connector','invitee_pool',true,$5,$6,$7,$8,$9)
     ON CONFLICT (agent_id) DO NOTHING`,
    [workspaceId, agentId, `agent-${agentId}`, row.connector_url,
     Buffer.from(binding.ciphertext), Buffer.from(binding.iv), Buffer.from(binding.wrappedDek),
     Buffer.from(binding.wrapIv), binding.kekVersion],
  );
  await tx.query(
    `UPDATE hermes_cloud_capacity SET state='assigning', assigned_agent_id=$3
      WHERE workspace_id=$1 AND id=$2 AND state='reserved'`,
    [workspaceId, row.id, agentId],
  );
  await tx.query(
    `INSERT INTO agent_provisioning
       (workspace_id, agent_id, status, cloud_agent_id, instance_name, dashboard_url,
        requested_at, cloud_created_at)
     VALUES ($1,$2,'verifying',$3,$4,$5,now(),now())
     ON CONFLICT (agent_id) DO UPDATE SET
       status='verifying', cloud_agent_id=EXCLUDED.cloud_agent_id,
       instance_name=EXCLUDED.instance_name, dashboard_url=EXCLUDED.dashboard_url,
       error_code=NULL, error_detail=NULL`,
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

async function quarantine(env: Env, workspaceId: string, agentId: string, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  await withWorkspaceTransaction(env, workspaceId, async (tx) => {
    await tx.query(
      `UPDATE hermes_cloud_capacity
          SET state='quarantined', quarantined_at=now(), quarantine_reason=$3,
              last_health_checked_at=now()
        WHERE workspace_id=$1 AND assigned_agent_id=$2 AND state='assigning'`,
      [workspaceId, agentId, detail.slice(0, 500)],
    );
    await tx.query(
      `UPDATE agent_provisioning
          SET status='failed', error_code='pool_assignment_failed', error_detail=$3, attempts=attempts+1
        WHERE workspace_id=$1 AND agent_id=$2`,
      [workspaceId, agentId, detail.slice(0, 500)],
    );
    await enqueueJob(
      tx,
      workspaceId,
      'hermes_capacity_alert',
      `hermes-capacity-quarantined:${agentId}`,
      { kind: 'quarantined', agent_id: agentId },
    );
  });
}

async function markAssignmentRetry(env: Env, workspaceId: string, agentId: string, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  await withWorkspaceTransaction(env, workspaceId, (tx) => tx.query(
    `UPDATE agent_provisioning
        SET status='failed', error_code='pool_assignment_retrying', error_detail=$3, attempts=attempts+1
      WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, agentId, detail.slice(0, 500)],
  ));
}

async function persistAssignedControlSecret(
  env: Env,
  workspaceId: string,
  capacityId: string,
  agentId: string,
  controlSecret: string,
): Promise<void> {
  const [poolSecret, bindingSecret] = await Promise.all([
    sealSecret(env, { workspaceId, keyId: capacityId, namespace: POOL_CONTROL_NAMESPACE }, controlSecret),
    sealSecret(env, { workspaceId, keyId: agentId, namespace: RUNTIME_CONTROL_NAMESPACE }, controlSecret),
  ]);
  await withWorkspaceTransaction(env, workspaceId, async (tx) => {
    await tx.query(
      `UPDATE hermes_cloud_capacity SET ciphertext=$3, iv=$4, wrapped_dek=$5, wrap_iv=$6, kek_version=$7
        WHERE workspace_id=$1 AND id=$2 AND state='assigning'`,
      [workspaceId, capacityId, Buffer.from(poolSecret.ciphertext), Buffer.from(poolSecret.iv),
       Buffer.from(poolSecret.wrappedDek), Buffer.from(poolSecret.wrapIv), poolSecret.kekVersion],
    );
    await tx.query(
      `UPDATE agent_runtime_bindings SET ciphertext=$3, iv=$4, wrapped_dek=$5, wrap_iv=$6, kek_version=$7
        WHERE workspace_id=$1 AND agent_id=$2 AND ready_at IS NULL`,
      [workspaceId, agentId, Buffer.from(bindingSecret.ciphertext), Buffer.from(bindingSecret.iv),
       Buffer.from(bindingSecret.wrappedDek), Buffer.from(bindingSecret.wrapIv), bindingSecret.kekVersion],
    );
  });
}

export async function runHermesPoolAssignmentJob(env: Env, job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as { agent_id?: unknown };
  const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : '';
  if (!/^[0-9a-f-]{36}$/i.test(agentId)) throw new Error('hermes_pool_assign_payload_invalid');

  try {
    const prepared = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
      const result = await tx.query<CapacityRow>(
        `SELECT id, cloud_agent_id, instance_name, dashboard_url, connector_url, state,
                reserved_invitation_id, assigned_agent_id, plugin_version,
                ciphertext, iv, wrapped_dek, wrap_iv, kek_version
           FROM hermes_cloud_capacity
          WHERE workspace_id=$1 AND assigned_agent_id=$2 FOR UPDATE`,
        [job.workspace_id, agentId],
      );
      const row = result.rows[0];
      if (!row) throw new Error('assigned_pool_capacity_missing');
      if (row.state === 'assigned' || row.state === 'quarantined') return null;
      if (row.state !== 'assigning') throw new Error('assigned_pool_capacity_unavailable');
      return row;
    });
    if (!prepared) return;

    const controlSecret = randomControlSecret();
    const cloud = new HermesCloudClient(env);
    await cloud.updateAgentEnvironment(prepared.cloud_agent_id, {
      ENTERPRISE_URL: publicOrigin(env),
      ENTERPRISE_WORKSPACE_ID: job.workspace_id,
      ENTERPRISE_AGENT_ID: agentId,
      ENTERPRISE_RUNTIME_TOKEN: await provisioningBridgeToken(env, job.workspace_id, agentId),
      HERMES_ENTERPRISE_CONTROL_SECRET: controlSecret,
      HERMES_NATIVE_CRON_ENABLED: '0',
      HERMES_AGENTCASH_MCP_ENABLED: '1',
      AGENTCASH_HOME: '/opt/data/agentcash',
    });
    // From this point forward the Cloud profile expects the new secret. Store
    // it before restart/readiness so a crash or quarantine never loses the
    // credential an operator needs to verify the assigned instance.
    await persistAssignedControlSecret(env, job.workspace_id, prepared.id, agentId, controlSecret);
    const restarted = await cloud.restartAgent(prepared.cloud_agent_id);
    if (restarted.health !== 'HEALTHY') {
      throw new HermesCloudError('Hermes Cloud instance is restarting', 'cloud_instance_pending', 30);
    }

    const runtime = new HermesClient(prepared.connector_url, controlSecret, undefined, 'dashboard_connector');
    const [capabilities, readiness] = await Promise.all([runtime.capabilities(), runtime.enterpriseReadiness()]);
    if (!capabilities.durableIdempotency || readiness.workspaceId !== job.workspace_id || readiness.agentId !== agentId ||
        !readiness.agentCashEnabled || !readiness.agentCashWalletPresent || !readiness.nativeCronDisabled) {
      throw new Error('enterprise_profile_readiness_incomplete');
    }

    await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
      await tx.query(
        `UPDATE hermes_cloud_capacity SET state='assigned', plugin_version=$3,
            readiness_checked_at=now(), last_health_checked_at=now(), assigned_at=now(),
            quarantine_reason=NULL, quarantined_at=NULL
          WHERE workspace_id=$1 AND id=$2 AND state='assigning'`,
        [job.workspace_id, prepared.id, readiness.version],
      );
      await tx.query(
        `UPDATE agent_runtime_bindings SET ready_at=now()
          WHERE workspace_id=$1 AND agent_id=$2`,
        [job.workspace_id, agentId],
      );
      await tx.query(
        `UPDATE agent_provisioning SET status='ready', ready_at=now(), error_code=NULL,
            error_detail=NULL, attempts=attempts+1 WHERE workspace_id=$1 AND agent_id=$2`,
        [job.workspace_id, agentId],
      );
      await tx.query(
        `UPDATE agents SET status='started', started_at=COALESCE(started_at, now())
          WHERE workspace_id=$1 AND id=$2 AND setup_step IS NULL`,
        [job.workspace_id, agentId],
      );
    });
  } catch (error) {
    if (job.attempts < 3) {
      await markAssignmentRetry(env, job.workspace_id, agentId, error);
      throw error;
    }
    // Quarantine is terminal for this assignment job. Returning lets the
    // durable job finish; throwing would requeue a quarantined profile forever.
    await quarantine(env, job.workspace_id, agentId, error);
  }
}

export async function runInvitationExpirationJob(env: Env, job: Job): Promise<void> {
  await withWorkspaceTransaction(env, job.workspace_id, (tx) => expireInvitationReservations(tx, job.workspace_id));
}

export function runCapacityAlertJob(job: Job): void {
  console.warn(JSON.stringify({ at: 'hermes.capacity', workspace_id: job.workspace_id, ...((job.payload ?? {}) as object) }));
}
