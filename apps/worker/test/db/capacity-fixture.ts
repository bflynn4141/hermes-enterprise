// Verified warm-capacity rows for a workspace, exactly as `POST
// /w/:ws/admin/hermes-capacity` would have written them after a passing live
// probe. Shared by the capacity, provisioning and partner-workflow suites so
// "this workspace holds verified Finance capacity" means one thing everywhere.
import { createHash, randomUUID } from 'node:crypto';
import type { Env } from '../../src/env.js';
import { POOL_CONTROL_NAMESPACE } from '../../src/hermes-cloud/capacity.js';
import { sealSecret } from '../../src/keys/envelope.js';
import {
  discoveryConfigDigest,
  discoveryProfileDescriptor,
  FINANCE_DISCOVERY_CONFIG,
  PARTNERSHIPS_CAPACITY_ROLE,
  type CapacityRoleTemplate,
} from '../../src/runtime/discovery-grants.js';
import { runtimeCredentialDigest } from '../../src/runtime/credentials.js';
import { makeEnv } from './harness.js';
import { setTenant, withClient, type Fixture } from './helpers.js';

export const KEK_V1 = Buffer.alloc(32, 29).toString('base64');
export const PLUGIN_REVISION = 'a'.repeat(40);
export const PLUGIN_DIGEST = `sha256:${'d'.repeat(64)}`;

export const POLICY = {
  source: 'github', program_name: 'Hermes Partner Program',
  source_purpose: 'organization_partner_research', organization_only: true, no_outreach: true,
  role_label: 'Partner Program', search_queries: ['developer infrastructure'], intake_urls: [],
  keywords: ['developer', 'infrastructure'], ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
  minimum_priority: 50, lookback_days: 365, max_candidates: 5, max_api_requests: 12,
  minimum_rate_remaining: 5, max_spend_usd: 0,
};

export function hermesEnv(overrides: Partial<Env> = {}): Env {
  return makeEnv({
    AGENT_RUNTIME: 'hermes', KEK_V1,
    HERMES_ENTERPRISE_PUBLIC_URL: 'https://enterprise.example.test',
    HERMES_ENTERPRISE_PLUGIN_REVISION: PLUGIN_REVISION,
    HERMES_ENTERPRISE_PLUGIN_SHA256: PLUGIN_DIGEST,
    PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(POLICY),
    ...overrides,
  }).env;
}

export const discoveryToken = (agentId: string): string => createHash('sha256').update(agentId).digest('hex');

export async function seedCapacity(
  fixture: Fixture,
  env: Env,
  count = 1,
  role: CapacityRoleTemplate = PARTNERSHIPS_CAPACITY_ROLE,
): Promise<string[]> {
  const descriptor = discoveryProfileDescriptor(role);
  const config = role.roleTemplateKey === 'finance-agent' ? FINANCE_DISCOVERY_CONFIG : POLICY;
  const ids = Array.from({ length: count }, () => randomUUID());
  const envelopes = await Promise.all(ids.map((id) => sealSecret(
    env,
    { workspaceId: fixture.workspaceId, keyId: id, namespace: POOL_CONTROL_NAMESPACE },
    `pool-control-${id}-long-enough`,
  )));
  const configDigest = await discoveryConfigDigest(role.roleTemplateKey === 'partnerships-agent'
    ? { role_template_key: role.roleTemplateKey, config }
    : {
        role_template_key: role.roleTemplateKey,
        role_template_version: role.roleTemplateVersion,
        config,
      });
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fixture.workspaceId, fixture.adminId);
    for (const [index, id] of ids.entries()) {
      const envelope = envelopes[index]!;
      const grantId = randomUUID();
      const digest = await runtimeCredentialDigest(fixture.workspaceId, id, discoveryToken(id));
      await client.query(
        `INSERT INTO runtime_discovery_grants
           (id, workspace_id, agent_id, created_by, credential_digest,
            role_template_key, role_template_version, skill_key, skill_version, runtime_name, artifact_digest,
            config_digest, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now()+interval '24 hours')`,
        [grantId, fixture.workspaceId, id, fixture.adminId, Buffer.from(digest),
          role.roleTemplateKey, role.roleTemplateVersion,
          descriptor.definition.key, descriptor.definition.version,
          descriptor.definition.runtimeName, descriptor.definition.artifactDigest,
          configDigest],
      );
      await client.query(
        `INSERT INTO hermes_cloud_capacity
           (id, workspace_id, cloud_agent_id, instance_name, preflight_agent_id, discovery_grant_id, connector_url,
            ciphertext, iv, wrapped_dek, wrap_iv, kek_version, plugin_version,
            agentcash_enabled, agentcash_wallet_present, native_cron_disabled,
            readiness_checked_at, last_health_checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'1.7.0',$13,$13,true,now(),now())`,
        [id, fixture.workspaceId, `cloud-${id}`, `pool-${id.slice(0, 8)}`,
         id, grantId, `https://pool-${id}.example.test/api/plugins/enterprise_bridge/control`,
         Buffer.from(envelope.ciphertext), Buffer.from(envelope.iv), Buffer.from(envelope.wrappedDek),
         Buffer.from(envelope.wrapIv), envelope.kekVersion, descriptor.expectsAgentCash],
      );
      await client.query(
        `UPDATE runtime_discovery_grants SET linked_capacity_id=$3, expires_at=NULL
          WHERE workspace_id=$1 AND id=$2`,
        [fixture.workspaceId, grantId, id],
      );
    }
    await client.query('COMMIT');
  });
  return ids;
}
