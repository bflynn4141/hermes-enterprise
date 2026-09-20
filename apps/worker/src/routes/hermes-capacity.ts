import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { sealSecret } from '../keys/envelope.js';
import { HermesClient } from '../runtime/client.js';
import { matchesManagedDiscoveryGrantAttestation } from '../runtime/readiness.js';
import {
  DISCOVERY_GRANT_TTL_MS,
  exactDiscoveryConfig,
  lockCurrentPreparedGrant,
  ROLE_TEMPLATE_VERSION,
} from '../runtime/discovery-grants.js';
import { newRuntimeBearer, runtimeCredentialDigest } from '../runtime/credentials.js';
import { POOL_CONTROL_NAMESPACE } from '../hermes-cloud/capacity.js';
import { inWorkspace, jsonBody, pathUuid, RouteError } from './tenant.js';

const inputSchema = z.object({
  cloud_agent_id: z.string().trim().min(1).max(200),
  instance_name: z.string().trim().min(1).max(120),
  connector_url: z.url().max(2048),
  control_secret: z.string().min(24).max(500),
  preflight_agent_id: z.uuid(),
  discovery_grant_id: z.uuid(),
}).strict();

const grantInputSchema = z.object({
  preflight_agent_id: z.uuid(),
  role_template_key: z.enum(['partnerships-agent', 'finance-agent']).default('partnerships-agent'),
}).strict();

export async function listRuntimeDiscoveryGrants(c: Context<{ Bindings: Env }>): Promise<Response> {
  const grants = await inWorkspace(c, async (work) => {
    work.requireAdmin('Viewing runtime discovery credentials');
    requireStepUp(work.session);
    const { rows } = await work.tx.query<{
      id: string; agent_id: string; role_template_key: 'partnerships-agent' | 'finance-agent';
      role_template_version: string; skill_key: string; skill_version: string;
      assignment_revision: number | null; grant_revision: number;
      linked_capacity_id: string | null; expires_at: Date | null; revoked_at: Date | null;
      consumed_at: Date | null; created_at: Date; capacity_state: string | null;
    }>(
      `SELECT g.id, g.agent_id, g.role_template_key, g.role_template_version,
              g.skill_key, g.skill_version, g.assignment_revision, g.grant_revision,
              g.linked_capacity_id, g.expires_at, g.revoked_at, g.consumed_at,
              g.created_at, c.state AS capacity_state
         FROM runtime_discovery_grants g
         LEFT JOIN hermes_cloud_capacity c
           ON c.workspace_id=g.workspace_id AND c.id=g.linked_capacity_id
        WHERE g.workspace_id=$1 ORDER BY g.created_at DESC`,
      [work.workspaceId],
    );
    return rows.map((row) => ({
      id: row.id,
      preflight_agent_id: row.agent_id,
      role_template_key: row.role_template_key,
      role_template_version: row.role_template_version,
      role: row.role_template_key === 'finance-agent' ? 'Finance' : 'Partnerships P1.7',
      skill_key: row.skill_key,
      skill_version: row.skill_version,
      assignment_revision: row.assignment_revision,
      grant_revision: row.grant_revision,
      linked_capacity_id: row.linked_capacity_id,
      capacity_state: row.capacity_state,
      status: row.consumed_at ? 'consumed' : row.revoked_at ? 'revoked'
        : row.linked_capacity_id ? 'linked'
          : row.expires_at && row.expires_at > new Date() ? 'prepared' : 'expired',
      expires_at: row.expires_at?.toISOString() ?? null,
      created_at: row.created_at.toISOString(),
    }));
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ grants });
}

export async function createRuntimeDiscoveryGrant(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const parsed = grantInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('the discovery profile is invalid', 'bad_discovery_grant', 422);
  const token = newRuntimeBearer();
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('Preparing a runtime discovery credential');
    requireStepUp(work.session);
    const profile = await exactDiscoveryConfig(c.env, work.tx, work.workspaceId, parsed.data.preflight_agent_id, {
      roleTemplateKey: parsed.data.role_template_key,
      roleTemplateVersion: ROLE_TEMPLATE_VERSION,
    });
    const existingIdentity = await work.tx.query(
      `SELECT EXISTS (
         SELECT 1 FROM agents WHERE workspace_id=$1 AND id=$2
         UNION ALL
         SELECT 1 FROM agent_runtime_bindings WHERE workspace_id=$1 AND agent_id=$2
         UNION ALL
         SELECT 1 FROM hermes_cloud_capacity
          WHERE workspace_id=$1 AND (preflight_agent_id=$2 OR assigned_agent_id=$2)
       ) AS exists`,
      [work.workspaceId, parsed.data.preflight_agent_id],
    );
    if ((existingIdentity.rows[0] as { exists?: boolean } | undefined)?.exists) throw new RouteError(
      'Discovery credentials can only be prepared for a new, unused runtime identity.',
      'discovery_profile_assigned',
      409,
    );
    await work.tx.query(
      `UPDATE runtime_discovery_grants SET revoked_at=now()
        WHERE workspace_id=$1 AND agent_id=$2 AND linked_capacity_id IS NULL
          AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at <= now()`,
      [work.workspaceId, parsed.data.preflight_agent_id],
    );
    const digest = await runtimeCredentialDigest(work.workspaceId, parsed.data.preflight_agent_id, token);
    const { rows } = await work.tx.query<{ id: string; expires_at: Date; created_at: Date }>(
      `INSERT INTO runtime_discovery_grants
         (workspace_id, agent_id, created_by, credential_digest,
          role_template_key, role_template_version, skill_key, skill_version, runtime_name, artifact_digest,
          assignment_id, assignment_revision, config_digest, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT DO NOTHING
       RETURNING id, expires_at, created_at`,
      [work.workspaceId, parsed.data.preflight_agent_id, work.userId, Buffer.from(digest),
       profile.descriptor.roleTemplateKey, profile.descriptor.roleTemplateVersion,
       profile.descriptor.definition.key, profile.descriptor.definition.version,
       profile.descriptor.definition.runtimeName, profile.descriptor.definition.artifactDigest,
       profile.assignmentId, profile.assignmentRevision, profile.configDigest,
       new Date(Date.now() + DISCOVERY_GRANT_TTL_MS)],
    );
    const row = rows[0];
    if (!row) throw new RouteError(
      'This profile already has an active discovery credential. Revoke it before rotating.',
      'discovery_grant_exists',
      409,
    );
    return {
      id: row.id,
      preflight_agent_id: parsed.data.preflight_agent_id,
      role_template_key: profile.descriptor.roleTemplateKey,
      role_template_version: profile.descriptor.roleTemplateVersion,
      bearer: token,
      status: 'prepared' as const,
      expires_at: row.expires_at.toISOString(),
      created_at: row.created_at.toISOString(),
    };
  });
  c.header('Cache-Control', 'no-store');
  return c.json(result, 201);
}

export async function revokeRuntimeDiscoveryGrant(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const grantId = pathUuid(c, 'grantId');
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('Revoking a runtime discovery credential');
    requireStepUp(work.session);
    const { rows } = await work.tx.query<{
      id: string; agent_id: string; linked_capacity_id: string | null; capacity_state: string | null;
      revoked_at: Date | null; consumed_at: Date | null;
    }>(
      `SELECT g.id, g.agent_id, g.linked_capacity_id, g.revoked_at, g.consumed_at,
              c.state AS capacity_state
         FROM runtime_discovery_grants g
         LEFT JOIN hermes_cloud_capacity c
           ON c.workspace_id=g.workspace_id AND c.id=g.linked_capacity_id
        WHERE g.workspace_id=$1 AND g.id=$2 FOR UPDATE OF g`,
      [work.workspaceId, grantId],
    );
    const row = rows[0];
    if (!row) throw new RouteError('Discovery credential not found.', 'not_found', 404);
    if (row.consumed_at) throw new RouteError('Assigned runtime credentials are rotated from the agent runtime.', 'discovery_grant_consumed', 409);
    if (row.revoked_at) return { id: row.id, status: 'revoked' as const };
    if (row.capacity_state === 'reserved') throw new RouteError(
      'Withdraw the invitation that reserved this profile before revoking its credential.',
      'discovery_grant_reserved',
      409,
    );
    if (row.linked_capacity_id && row.capacity_state !== 'available') throw new RouteError(
      'This linked profile must be quarantined or retired through its current lifecycle.',
      'discovery_grant_linked',
      409,
    );
    if (row.linked_capacity_id) {
      await work.tx.query(
        `UPDATE hermes_cloud_capacity
            SET state='quarantined', quarantined_at=now(), quarantine_reason='discovery_credential_revoked'
          WHERE workspace_id=$1 AND id=$2 AND state='available'`,
        [work.workspaceId, row.linked_capacity_id],
      );
    }
    await work.tx.query(
      `UPDATE runtime_discovery_grants SET revoked_at=now()
        WHERE workspace_id=$1 AND id=$2 AND revoked_at IS NULL AND consumed_at IS NULL`,
      [work.workspaceId, row.id],
    );
    return { id: row.id, status: 'revoked' as const };
  });
  c.header('Cache-Control', 'no-store');
  return c.json(result);
}

/**
 * Register existing, already-paid capacity only after the authenticated
 * Enterprise connector proves the real native runtime, permanent identity,
 * plugin and role-specific native inventory are ready. The interactive Hermes Cloud management API is
 * deliberately not part of the invitation path. This route never creates or
 * funds an instance.
 */
export async function registerHermesCapacity(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const parsed = inputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('the Hermes capacity record is invalid', 'bad_capacity', 422);
  const input = parsed.data;
  const url = new URL(input.connector_url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new RouteError('the connector URL must be a clean HTTPS URL', 'bad_capacity', 422);
  }

  const verified = await inWorkspace(c, async (work) => {
    work.requireAdmin('Registering Hermes capacity');
    requireStepUp(work.session);
    const prepared = await lockCurrentPreparedGrant(
      c.env, work.tx, work.workspaceId, input.preflight_agent_id, input.discovery_grant_id,
    );
    return { workspaceId: work.workspaceId, grant: prepared.grant };
  });

  let readiness;
  let capabilities;
  try {
    const runtime = new HermesClient(url.toString(), input.control_secret, undefined, 'dashboard_connector');
    [readiness, capabilities] = await Promise.all([
      runtime.enterpriseReadiness(),
      runtime.capabilities(),
    ]);
  } catch {
    throw new RouteError('The instance did not pass the Cloud and Enterprise readiness checks.', 'capacity_not_ready', 409);
  }
  if (!capabilities.durableIdempotency ||
      !matchesManagedDiscoveryGrantAttestation(readiness, verified.grant, {
        workspaceId: verified.workspaceId,
        agentId: input.preflight_agent_id,
        enterpriseUrl: c.env.HERMES_ENTERPRISE_PUBLIC_URL,
        pluginRevision: c.env.HERMES_ENTERPRISE_PLUGIN_REVISION,
        pluginArtifactDigest: c.env.HERMES_ENTERPRISE_PLUGIN_SHA256,
      })) {
    throw new RouteError('The instance did not pass the Cloud and Enterprise readiness checks.', 'capacity_not_ready', 409);
  }

  const capacityId = crypto.randomUUID();
  const readinessCheckedAt = new Date();
  const envelope = await sealSecret(
    c.env,
    { workspaceId: verified.workspaceId, keyId: capacityId, namespace: POOL_CONTROL_NAMESPACE },
    input.control_secret,
  );
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('Registering Hermes capacity');
    requireStepUp(work.session);
    const { grant } = await lockCurrentPreparedGrant(
      c.env, work.tx, work.workspaceId, input.preflight_agent_id, input.discovery_grant_id,
    );
    const inserted = await work.tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO hermes_cloud_capacity
         (id, workspace_id, cloud_agent_id, instance_name, preflight_agent_id, discovery_grant_id, dashboard_url, connector_url, state,
          ciphertext, iv, wrapped_dek, wrap_iv, kek_version, plugin_version,
          agentcash_enabled, agentcash_wallet_present, native_cron_disabled,
          readiness_checked_at, last_health_checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'available',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)
       ON CONFLICT DO NOTHING
       RETURNING id, created_at`,
      [capacityId, work.workspaceId, input.cloud_agent_id, input.instance_name, input.preflight_agent_id,
       grant.id, url.origin, url.toString(), Buffer.from(envelope.ciphertext), Buffer.from(envelope.iv),
       Buffer.from(envelope.wrappedDek), Buffer.from(envelope.wrapIv), envelope.kekVersion, readiness.version,
       readiness.agentCashEnabled, readiness.agentCashWalletPresent, readiness.nativeCronDisabled,
       readinessCheckedAt],
    );
    const row = inserted.rows[0];
    if (!row) throw new RouteError('that Cloud instance is already registered', 'capacity_exists', 409);
    await work.tx.query(
      `UPDATE runtime_discovery_grants
          SET linked_capacity_id=$3, expires_at=NULL
        WHERE workspace_id=$1 AND id=$2 AND linked_capacity_id IS NULL
          AND revoked_at IS NULL AND consumed_at IS NULL`,
      [work.workspaceId, grant.id, row.id],
    );
    const linked = await work.tx.query(
      `SELECT 1 FROM runtime_discovery_grants
        WHERE workspace_id=$1 AND id=$2 AND linked_capacity_id=$3
          AND expires_at IS NULL AND revoked_at IS NULL AND consumed_at IS NULL`,
      [work.workspaceId, grant.id, row.id],
    );
    if (!linked.rowCount) throw new RouteError(
      'The verified capacity could not be linked to its discovery credential.',
      'discovery_grant_unavailable',
      409,
    );
    return {
      id: row.id,
      cloud_agent_id: input.cloud_agent_id,
      instance_name: input.instance_name,
      preflight_agent_id: input.preflight_agent_id,
      state: 'available' as const,
      plugin_version: readiness.version,
      agentcash_enabled: readiness.agentCashEnabled,
      agentcash_wallet_present: readiness.agentCashWalletPresent,
      native_cron_disabled: readiness.nativeCronDisabled,
      verified_at: readinessCheckedAt.toISOString(),
      discovery_grant_id: grant.id,
      role_template_key: grant.role_template_key,
      role_template_version: grant.role_template_version,
    };
  });
  c.header('Cache-Control', 'no-store');
  return c.json(result, 201);
}
