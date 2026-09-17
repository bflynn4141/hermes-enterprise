import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';
import type { Job } from '../jobs.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { openSecret, sealSecret, type StoredEnvelope } from '../keys/envelope.js';
import { provisioningBridgeToken } from '../runtime/config.js';
import { HermesCloudClient, HermesCloudError } from './client.js';

const CONTROL_NAMESPACE = 'hermes/runtime-control/v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProvisioningRow {
  agent_id: string;
  status: string;
  cloud_agent_id: string | null;
  instance_name: string;
  dashboard_url: string | null;
  region: string;
  model: string;
  size: string;
}

interface BindingSecretRow {
  ciphertext: Uint8Array;
  iv: Uint8Array;
  wrapped_dek: Uint8Array;
  wrap_iv: Uint8Array;
  kek_version: number;
}

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  throw new Error('expected runtime credential envelope bytes');
};

function maxPerWorkspace(env: Env): number {
  const parsed = Number(env.HERMES_CLOUD_MAX_AGENTS_PER_WORKSPACE ?? '5');
  return Number.isInteger(parsed) ? Math.min(25, Math.max(1, parsed)) : 5;
}

function maxForOrganization(env: Env): number {
  const parsed = Number(env.HERMES_CLOUD_MAX_AGENTS ?? '10');
  return Number.isInteger(parsed) ? Math.min(100, Math.max(1, parsed)) : 10;
}

function publicOrigin(env: Env): string {
  const url = new URL(env.HERMES_ENTERPRISE_PUBLIC_URL?.trim() || '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new HermesCloudError('Enterprise public URL is not configured', 'enterprise_public_url_missing');
  }
  return url.origin;
}

function controlSecret(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function ensureBindingSecret(env: Env, tx: Tx, workspaceId: string, agentId: string): Promise<string> {
  const existing = await tx.query<BindingSecretRow>(
    `SELECT ciphertext, iv, wrapped_dek, wrap_iv, kek_version
       FROM agent_runtime_bindings WHERE workspace_id=$1 AND agent_id=$2 FOR UPDATE`,
    [workspaceId, agentId],
  );
  let row = existing.rows[0];
  if (!row) {
    const secret = controlSecret();
    const sealed = await sealSecret(env, { workspaceId, keyId: agentId, namespace: CONTROL_NAMESPACE }, secret);
    const inserted = await tx.query<BindingSecretRow>(
      `INSERT INTO agent_runtime_bindings
         (workspace_id, agent_id, profile, assignment, agentcash, ciphertext, iv, wrapped_dek, wrap_iv, kek_version)
       VALUES ($1,$2,$3,'provisioned',true,$4,$5,$6,$7,$8)
       RETURNING ciphertext, iv, wrapped_dek, wrap_iv, kek_version`,
      [workspaceId, agentId, `agent-${agentId}`, Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv),
       Buffer.from(sealed.wrappedDek), Buffer.from(sealed.wrapIv), sealed.kekVersion],
    );
    row = inserted.rows[0];
    if (!row) throw new Error('runtime binding credential was not stored');
  }
  const stored: StoredEnvelope = {
    ciphertext: bytes(row.ciphertext), iv: bytes(row.iv), wrappedDek: bytes(row.wrapped_dek),
    wrapIv: bytes(row.wrap_iv), kekVersion: row.kek_version,
  };
  return openSecret(env, { workspaceId, keyId: agentId, namespace: CONTROL_NAMESPACE }, stored);
}

async function markFailure(env: Env, workspaceId: string, agentId: string, error: unknown): Promise<void> {
  const code = error instanceof HermesCloudError ? error.code : 'cloud_provisioning_failed';
  const detail = error instanceof Error ? error.message : 'Hermes Cloud provisioning failed';
  await withWorkspaceTransaction(env, workspaceId, (tx) => tx.query(
    `UPDATE agent_provisioning
        SET status='failed', error_code=$3, error_detail=$4, attempts=attempts+1
      WHERE workspace_id=$1 AND agent_id=$2`,
    [workspaceId, agentId, code, detail.slice(0, 500)],
  ));
}

export async function runHermesCloudProvisioningJob(env: Env, job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as { agent_id?: unknown };
  const agentId = typeof payload.agent_id === 'string' ? payload.agent_id : '';
  if (!UUID.test(agentId)) throw new Error('hermes_cloud_provision payload is invalid');
  if (env.HERMES_CLOUD_AUTOPROVISION_ENABLED !== '1') {
    // The switch pauses paid provisioning; it is not an agent failure. Keep
    // the durable job and provisioning state retryable so enabling the switch
    // resumes the same request without a manual database repair.
    throw new HermesCloudError('Hermes Cloud auto-provisioning is disabled', 'cloud_provisioning_disabled');
  }

  try {
    const prepared = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
      const provisioning = await tx.query<ProvisioningRow>(
        `SELECT agent_id, status, cloud_agent_id, instance_name, dashboard_url, region, model, size
           FROM agent_provisioning WHERE workspace_id=$1 AND agent_id=$2 FOR UPDATE`,
        [job.workspace_id, agentId],
      );
      const row = provisioning.rows[0];
      if (!row) throw new HermesCloudError('Provisioning record was not found', 'cloud_provisioning_missing');
      if (row.status === 'ready' || row.status === 'awaiting_bootstrap') return { row, controlSecret: null };
      const count = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM agent_provisioning
          WHERE workspace_id=$1 AND status IN ('queued','creating','awaiting_bootstrap','verifying','ready')`,
        [job.workspace_id],
      );
      if ((count.rows[0]?.count ?? 0) > maxPerWorkspace(env)) {
        throw new HermesCloudError('Workspace Hermes Cloud agent cap reached', 'cloud_workspace_cap_reached');
      }
      const secret = await ensureBindingSecret(env, tx, job.workspace_id, agentId);
      await tx.query(
        `UPDATE agent_provisioning SET status='creating', error_code=NULL, error_detail=NULL,
            requested_at=COALESCE(requested_at, now()) WHERE workspace_id=$1 AND agent_id=$2`,
        [job.workspace_id, agentId],
      );
      return { row, controlSecret: secret };
    });
    if (!prepared.controlSecret) return;

    const enterpriseUrl = publicOrigin(env);
    const client = new HermesCloudClient(env);
    const agents = await client.listAgents();
    let cloud = agents.find((candidate) => candidate.id === prepared.row.cloud_agent_id)
      ?? agents.find((candidate) => candidate.name === prepared.row.instance_name)
      ?? null;
    if (!cloud) {
      if (agents.length >= maxForOrganization(env)) {
        throw new HermesCloudError('Organization Hermes Cloud agent cap reached', 'cloud_organization_cap_reached');
      }
      cloud = await client.createAgent({
        name: prepared.row.instance_name,
        region: prepared.row.region,
        model: prepared.row.model,
        size: prepared.row.size,
        env: {
          ENTERPRISE_URL: enterpriseUrl,
          ENTERPRISE_WORKSPACE_ID: job.workspace_id,
          ENTERPRISE_AGENT_ID: agentId,
          ENTERPRISE_RUNTIME_TOKEN: await provisioningBridgeToken(env, job.workspace_id, agentId),
          HERMES_ENTERPRISE_CONTROL_SECRET: prepared.controlSecret,
          HERMES_NATIVE_CRON_ENABLED: '0',
          HERMES_AGENTCASH_MCP_ENABLED: '1',
          AGENTCASH_HOME: '/opt/data/agentcash',
        },
      });
    }
    if (cloud.health !== 'HEALTHY' || !cloud.dashboardUrl) {
      await withWorkspaceTransaction(env, job.workspace_id, (tx) => tx.query(
        `UPDATE agent_provisioning
            SET cloud_agent_id=$3, dashboard_url=$4, cloud_created_at=COALESCE(cloud_created_at, now()),
                status='creating', error_code=NULL, error_detail=NULL
          WHERE workspace_id=$1 AND agent_id=$2`,
        [job.workspace_id, agentId, cloud.id, cloud.dashboardUrl],
      ));
      throw new HermesCloudError('Hermes Cloud instance is still provisioning', 'cloud_instance_pending', 60);
    }
    const connectorUrl = `${cloud.dashboardUrl.replace(/\/$/, '')}/api/plugins/enterprise_bridge/control`;
    await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
      await tx.query(
        `UPDATE agent_provisioning
            SET cloud_agent_id=$3, dashboard_url=$4, cloud_created_at=COALESCE(cloud_created_at, now()),
                status='awaiting_bootstrap', error_code=NULL, error_detail=NULL
          WHERE workspace_id=$1 AND agent_id=$2`,
        [job.workspace_id, agentId, cloud.id, cloud.dashboardUrl],
      );
      await tx.query(
        `UPDATE agent_runtime_bindings SET base_url=$3 WHERE workspace_id=$1 AND agent_id=$2`,
        [job.workspace_id, agentId, connectorUrl],
      );
    });
  } catch (error) {
    if (!(error instanceof HermesCloudError && error.code === 'cloud_instance_pending')) {
      await markFailure(env, job.workspace_id, agentId, error);
    }
    throw error;
  }
}
