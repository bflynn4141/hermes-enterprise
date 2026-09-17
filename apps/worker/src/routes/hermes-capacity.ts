import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { sealSecret } from '../keys/envelope.js';
import { HermesClient } from '../runtime/client.js';
import { POOL_CONTROL_NAMESPACE } from '../hermes-cloud/capacity.js';
import { inWorkspace, jsonBody, RouteError } from './tenant.js';

const inputSchema = z.object({
  cloud_agent_id: z.string().trim().min(1).max(200),
  instance_name: z.string().trim().min(1).max(120),
  connector_url: z.url().max(2048),
  control_secret: z.string().min(24).max(500),
  preflight_agent_id: z.uuid(),
}).strict();

/**
 * Register existing, already-paid capacity only after the authenticated
 * Enterprise connector proves the real native runtime, permanent identity,
 * plugin and wallet are ready. The interactive Hermes Cloud management API is
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
    return { workspaceId: work.workspaceId };
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
  if (!capabilities.durableIdempotency || readiness.workspaceId !== verified.workspaceId ||
      readiness.agentId !== input.preflight_agent_id || !readiness.agentCashEnabled ||
      !readiness.agentCashWalletPresent || !readiness.nativeCronDisabled) {
    throw new RouteError('The instance did not pass the Cloud and Enterprise readiness checks.', 'capacity_not_ready', 409);
  }

  const capacityId = crypto.randomUUID();
  const envelope = await sealSecret(
    c.env,
    { workspaceId: verified.workspaceId, keyId: capacityId, namespace: POOL_CONTROL_NAMESPACE },
    input.control_secret,
  );
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('Registering Hermes capacity');
    requireStepUp(work.session);
    const inserted = await work.tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO hermes_cloud_capacity
         (id, workspace_id, cloud_agent_id, instance_name, preflight_agent_id, dashboard_url, connector_url, state,
          ciphertext, iv, wrapped_dek, wrap_iv, kek_version, plugin_version,
          agentcash_enabled, agentcash_wallet_present, native_cron_disabled,
          readiness_checked_at, last_health_checked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'available',$8,$9,$10,$11,$12,$13,true,true,true,now(),now())
       ON CONFLICT DO NOTHING
       RETURNING id, created_at`,
      [capacityId, work.workspaceId, input.cloud_agent_id, input.instance_name, input.preflight_agent_id,
       url.origin, url.toString(), Buffer.from(envelope.ciphertext), Buffer.from(envelope.iv),
       Buffer.from(envelope.wrappedDek), Buffer.from(envelope.wrapIv), envelope.kekVersion, readiness.version],
    );
    const row = inserted.rows[0];
    if (!row) throw new RouteError('that Cloud instance is already registered', 'capacity_exists', 409);
    return {
      id: row.id,
      cloud_agent_id: input.cloud_agent_id,
      instance_name: input.instance_name,
      preflight_agent_id: input.preflight_agent_id,
      state: 'available' as const,
      plugin_version: readiness.version,
      agentcash_enabled: true,
      agentcash_wallet_present: true,
      native_cron_disabled: true,
      verified_at: row.created_at.toISOString(),
    };
  });
  return c.json(result, 201);
}
