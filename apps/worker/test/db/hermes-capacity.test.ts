import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import {
  POOL_CONTROL_NAMESPACE,
  reserveCapacityForInvitation,
  verifyReservedCapacityForInvitation,
} from '../../src/hermes-cloud/capacity.js';
import { sealSecret } from '../../src/keys/envelope.js';
import {
  discoveryConfigDigest,
  discoveryProfileDescriptor,
  FINANCE_CAPACITY_ROLE,
  FINANCE_DISCOVERY_CONFIG,
  PARTNERSHIPS_CAPACITY_ROLE,
  type CapacityRoleTemplate,
} from '../../src/runtime/discovery-grants.js';
import { runtimeCredentialDigest } from '../../src/runtime/credentials.js';
import {
  PARTNER_PROGRAM_DEFINITION,
  toolsForSkillVersion,
} from '../../src/enterprise-skills/registry.js';
import {
  AGENTCASH_MCP_TOOL,
  ENTERPRISE_BRIDGE_VERSION,
  HERMES_NATIVE_REVISION,
  LEGACY_PARTNER_CONTENT_DIGEST,
} from '../../src/runtime/readiness.js';
import { bridgeToken } from '../../src/runtime/config.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../../src/auth/cookies.js';
import { runJobsAfterCommit } from '../../src/jobs.js';
import { FakeWorkOS, FakeWorkOSError, seal, signAccessToken } from '../stubs/fake-workos.js';
import {
  asUser, call, clearFakeWorkOS, makeEnv, readTenant, useFakeWorkOS, workosEnv,
} from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const KEK_V1 = Buffer.alloc(32, 29).toString('base64');
const PLUGIN_REVISION = 'a'.repeat(40);
const PLUGIN_DIGEST = `sha256:${'d'.repeat(64)}`;
const POLICY = {
  source: 'github', program_name: 'Hermes Partner Program',
  source_purpose: 'organization_partner_research', organization_only: true, no_outreach: true,
  role_label: 'Partner Program', search_queries: ['developer infrastructure'], intake_urls: [],
  keywords: ['developer', 'infrastructure'], ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
  minimum_priority: 50, lookback_days: 365, max_candidates: 5, max_api_requests: 12,
  minimum_rate_remaining: 5, max_spend_usd: 0,
};

function hermesEnv(overrides: Partial<Env> = {}): Env {
  return makeEnv({
    AGENT_RUNTIME: 'hermes', KEK_V1,
    HERMES_ENTERPRISE_PUBLIC_URL: 'https://enterprise.example.test',
    HERMES_ENTERPRISE_PLUGIN_REVISION: PLUGIN_REVISION,
    HERMES_ENTERPRISE_PLUGIN_SHA256: PLUGIN_DIGEST,
    PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(POLICY),
    ...overrides,
  }).env;
}

const discoveryToken = (agentId: string): string => createHash('sha256').update(agentId).digest('hex');

function readinessBody(
  workspaceId: string,
  agentId: string,
  role: CapacityRoleTemplate = PARTNERSHIPS_CAPACITY_ROLE,
): Record<string, unknown> {
  const descriptor = discoveryProfileDescriptor(role);
  const definition = descriptor.definition;
  return {
    object: 'hermes.enterprise_bridge.readiness', version: ENTERPRISE_BRIDGE_VERSION,
    runtime_revision: HERMES_NATIVE_REVISION,
    plugin: {
      name: 'enterprise_bridge', version: ENTERPRISE_BRIDGE_VERSION,
      revision: PLUGIN_REVISION, artifact_digest: PLUGIN_DIGEST,
    },
    workspace_id: workspaceId, agent_id: agentId,
    enterprise_url: 'https://enterprise.example.test',
    skills: [{
      name: definition.runtimeName,
      version: definition.version,
      artifact_digest: definition.artifactDigest,
      content_digest: role.roleTemplateKey === 'partnerships-agent'
        ? LEGACY_PARTNER_CONTENT_DIGEST : definition.artifactDigest,
    }],
    tools: [
      ...toolsForSkillVersion(definition.key, definition.version, definition.defaultCapabilityGrants),
      'skill_view', ...(descriptor.expectsAgentCash ? [AGENTCASH_MCP_TOOL] : []),
    ],
    agentcash_enabled: descriptor.expectsAgentCash,
    agentcash_wallet_present: descriptor.expectsAgentCash,
    native_cron_disabled: true,
  };
}

function capabilitiesBody(): Record<string, unknown> {
  return {
    object: 'hermes.api_server.capabilities', platform: 'hermes-agent',
    auth: { type: 'bearer', required: true },
    runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
    features: {
      run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_steer: true,
      runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 },
    },
    endpoints: {
      runs: { method: 'POST', path: '/v1/runs' }, run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
      run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' }, run_steer: { method: 'POST', path: '/v1/runs/{run_id}/steer' },
      run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
    },
    enterprise_contract: {
      schema_version: 1, source_revision: '345cd2b057a452236de401d3534b8502a7465e8d',
      release_ring: 'stable', terminal_errors: { supported: true, schema_version: 1 },
    },
  };
}

async function seedCapacity(
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

async function capacityRows(fixture: Fixture): Promise<Array<{
  id: string; state: string; reserved_invitation_id: string | null; assigned_agent_id: string | null;
}>> {
  return readTenant(fixture.workspaceId, fixture.adminId, async (client) => (
    await client.query(
      `SELECT id, state, reserved_invitation_id, assigned_agent_id
         FROM hermes_cloud_capacity WHERE workspace_id=$1 ORDER BY created_at, id`,
      [fixture.workspaceId],
    )
  ).rows);
}

async function asWorkOSAdmin(fixture: Fixture, env: Env, path: string, body: unknown): Promise<Response> {
  const email = await withClient('owner', async (client) => (
    await client.query<{ email: string }>('SELECT email FROM users WHERE id=$1', [fixture.adminId])
  ).rows[0]!.email);
  const workosUserId = `user_${fixture.adminId.replaceAll('-', '').slice(0, 12)}`;
  const token = await signAccessToken({ sub: workosUserId, sid: `session_${fixture.adminId}` });
  const session = seal({ accessToken: token, user: { id: workosUserId, email, emailVerified: true } });
  const csrf = 'capacity-test-csrf';
  return call(env, path, {
    method: 'POST', body,
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}; ${CSRF_COOKIE}=${csrf}`, [CSRF_HEADER]: csrf },
  });
}

describe('Hermes Cloud invitation capacity', () => {
  let fake: FakeWorkOS;
  beforeEach(async () => { fake = await useFakeWorkOS(new FakeWorkOS()); });
  afterEach(() => {
    clearFakeWorkOS();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('lets only one of two racing invitations reserve the single available instance', async () => {
    const fixture = await seedWorkspace();
    const env = hermesEnv();
    const [capacityId] = await seedCapacity(fixture, env);
    const emails = [`race-a-${randomUUID()}@example.test`, `race-b-${randomUUID()}@example.test`];

    const responses = await Promise.all(emails.map((email) => asUser(
      env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`,
      { method: 'POST', body: { email } },
    )));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    await expect(responses.find((response) => response.status === 409)!.json()).resolves.toMatchObject({
      reason: 'iris_capacity_unavailable',
    });

    const state = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const invitations = await client.query<{ email: string }>(
        `SELECT email FROM invitations WHERE workspace_id=$1 AND email=ANY($2::text[])`,
        [fixture.workspaceId, emails],
      );
      return { invitations: invitations.rows, capacity: await capacityRows(fixture) };
    });
    expect(state.invitations).toHaveLength(1);
    expect(state.capacity).toEqual([expect.objectContaining({
      id: capacityId, state: 'reserved', assigned_agent_id: null,
    })]);
    expect(state.capacity[0]?.reserved_invitation_id).not.toBeNull();
  });

  it('reserves coexisting Partnerships and Finance capacity only for the matching role', async () => {
    const fixture = await seedWorkspace();
    const env = hermesEnv();
    const partnershipsCapacityId = (await seedCapacity(
      fixture, env, 1, PARTNERSHIPS_CAPACITY_ROLE,
    ))[0]!;
    const financeCapacityId = (await seedCapacity(
      fixture, env, 1, FINANCE_CAPACITY_ROLE,
    ))[0]!;
    const invitationIds = await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fixture.workspaceId, fixture.adminId);
      const inserted = await client.query<{ id: string; email: string }>(
        `INSERT INTO invitations
           (workspace_id,email,role,expires_at,invited_by,status,delivery_status)
         VALUES
           ($1,$2,'member',now()+interval '7 days',$4,'pending','not_required'),
           ($1,$3,'member',now()+interval '7 days',$4,'pending','not_required')
         RETURNING id,email`,
        [fixture.workspaceId, `a-partner-${randomUUID()}@example.test`,
          `b-finance-${randomUUID()}@example.test`, fixture.adminId],
      );
      await client.query('COMMIT');
      return inserted.rows.sort((left, right) => left.email.localeCompare(right.email)).map((row) => row.id);
    });

    const [partnerships, finance] = await Promise.all([
      [invitationIds[0]!, PARTNERSHIPS_CAPACITY_ROLE] as const,
      [invitationIds[1]!, FINANCE_CAPACITY_ROLE] as const,
    ].map(([invitationId, role]) => withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fixture.workspaceId, fixture.adminId);
      const reserved = await reserveCapacityForInvitation(
        env, client as never, fixture.workspaceId, invitationId, role,
      );
      await client.query('COMMIT');
      return reserved;
    })));

    expect(partnerships?.id).toBe(partnershipsCapacityId);
    expect(finance?.id).toBe(financeCapacityId);
    expect(await capacityRows(fixture)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: partnershipsCapacityId, state: 'reserved', reserved_invitation_id: invitationIds[0],
      }),
      expect.objectContaining({
        id: financeCapacityId, state: 'reserved', reserved_invitation_id: invitationIds[1],
      }),
    ]));
  });

  it('fails capacity exhaustion before committing or delivering an invitation', async () => {
    const fixture = await seedWorkspace();
    const organizationId = `org_${randomUUID().slice(0, 12)}`;
    await withClient('owner', (client) => client.query(
      `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1,$2)
       ON CONFLICT (workspace_id) DO UPDATE SET workos_organization_id=EXCLUDED.workos_organization_id`,
      [fixture.workspaceId, organizationId],
    ));
    const env = workosEnv({
      AGENT_RUNTIME: 'hermes', KEK_V1,
      PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(POLICY),
    }).env;
    const email = `exhausted-${randomUUID()}@example.test`;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const response = await asWorkOSAdmin(
      fixture, env, `/w/${fixture.workspaceId}/invitations`, { email },
    );
    expect(response.status).toBe(409);
    const failure = await response.json() as { reason: string; trace_id: string };
    expect(failure).toMatchObject({ reason: 'iris_capacity_unavailable' });
    expect(failure.trace_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.calls.filter((call) => call.method.includes('Invitation'))).toHaveLength(0);

    const diagnostic = log.mock.calls.flatMap((call) => call.map(String))
      .find((line) => line.includes('"at":"invitation.lifecycle"') && line.includes('"ok":false'));
    expect(diagnostic).toBeTruthy();
    expect(JSON.parse(diagnostic!) as unknown).toMatchObject({
      action: 'create', checkpoint: 'invitation_stored', correlation_id: failure.trace_id,
      workspace_id: fixture.workspaceId, ok: false, reason: 'iris_capacity_unavailable', status: 409,
    });
    expect(diagnostic).not.toContain(email);

    const state = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const invitations = await client.query(`SELECT id FROM invitations WHERE workspace_id=$1 AND email=$2`, [fixture.workspaceId, email]);
      const sync = await client.query(`SELECT id FROM workos_sync WHERE workspace_id=$1 AND resource_type='invitation'`, [fixture.workspaceId]);
      const jobs = await client.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND kind='workos_sync'`, [fixture.workspaceId]);
      return { invitations: invitations.rowCount, sync: sync.rowCount, jobs: jobs.rowCount };
    });
    expect(state).toEqual({ invitations: 0, sync: 0, jobs: 0 });
  });

  it('does not claim a legacy-looking capacity row without a linked discovery grant', async () => {
    const fixture = await seedWorkspace();
    const env = hermesEnv();
    const capacityId = randomUUID();
    const envelope = await sealSecret(
      env,
      { workspaceId: fixture.workspaceId, keyId: capacityId, namespace: POOL_CONTROL_NAMESPACE },
      'unlinked-control-secret-longer-than-twenty-four',
    );
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fixture.workspaceId, fixture.adminId);
      await client.query(
        `INSERT INTO hermes_cloud_capacity
           (id, workspace_id, cloud_agent_id, instance_name, preflight_agent_id, connector_url,
            ciphertext, iv, wrapped_dek, wrap_iv, kek_version, plugin_version,
            agentcash_enabled, agentcash_wallet_present, native_cron_disabled,
            readiness_checked_at, last_health_checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'1.7.0',true,true,true,now(),now())`,
        [capacityId, fixture.workspaceId, `cloud-${capacityId}`, `unlinked-${capacityId}`,
          randomUUID(), `https://unlinked-${capacityId}.example.test/control`,
          Buffer.from(envelope.ciphertext), Buffer.from(envelope.iv), Buffer.from(envelope.wrappedDek),
          Buffer.from(envelope.wrapIv), envelope.kekVersion],
      );
      await client.query('COMMIT');
    });
    const response = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST', body: { email: `unclaimable-${randomUUID()}@example.test` },
    });
    expect(response.status).toBe(409);
    expect(await capacityRows(fixture)).toEqual([expect.objectContaining({ id: capacityId, state: 'available' })]);
  });

  it('quarantines linked capacity when its reviewed bootstrap configuration drifts', async () => {
    const fixture = await seedWorkspace();
    const env = hermesEnv();
    const capacityId = (await seedCapacity(fixture, env))[0]!;
    const email = `drift-${randomUUID()}@example.test`;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const driftedEnv = hermesEnv({
      PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify({ ...POLICY, max_candidates: 4 }),
    });
    const response = await asUser(
      driftedEnv,
      fixture.adminId,
      `/w/${fixture.workspaceId}/invitations`,
      { method: 'POST', body: { email } },
    );
    expect(response.status).toBe(409);
    const failure = await response.json() as { reason: string; trace_id: string };
    expect(failure).toMatchObject({ reason: 'iris_capacity_unavailable' });
    expect(failure.trace_id).toMatch(/^[0-9a-f-]{36}$/);
    const diagnostic = log.mock.calls.flatMap((call) => call.map(String))
      .find((line) => line.includes('"at":"invitation.lifecycle"') && line.includes('"ok":false'));
    expect(JSON.parse(diagnostic!) as unknown).toMatchObject({
      action: 'create', checkpoint: 'invitation_stored', correlation_id: failure.trace_id,
      workspace_id: fixture.workspaceId, ok: false, reason: 'iris_capacity_unavailable', status: 409,
    });
    expect(diagnostic).not.toContain(email);
    const state = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const capacity = await client.query<{ state: string; quarantine_reason: string }>(
        `SELECT state, quarantine_reason FROM hermes_cloud_capacity WHERE id=$1`, [capacityId],
      );
      const grant = await client.query<{ revoked: boolean }>(
        `SELECT revoked_at IS NOT NULL AS revoked FROM runtime_discovery_grants WHERE linked_capacity_id=$1`,
        [capacityId],
      );
      return { capacity: capacity.rows[0]!, grant: grant.rows[0]! };
    });
    expect(state).toEqual({
      capacity: { state: 'quarantined', quarantine_reason: 'discovery_profile_changed' },
      grant: { revoked: true },
    });
  });

  it('stops projecting ready after a finished setup loses its reservation to normal drift quarantine', async () => {
    const fixture = await seedWorkspace();
    const env = hermesEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1' });
    const [capacityId] = await seedCapacity(fixture, env);
    const created = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST',
      body: {
        email: `ready-drift-${randomUUID()}@example.test`,
        role: 'member',
        role_template_key: 'partnerships-agent',
      },
    });
    expect(created.status).toBe(201);
    const invitation = await created.json() as { id: string };
    const before = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => ({
      operation: (await client.query(
        `SELECT preparation,issue FROM member_provisioning_operations WHERE invitation_id=$1`,
        [invitation.id],
      )).rows[0],
      jobs: (await client.query(
        `SELECT done_at IS NOT NULL AS done FROM jobs WHERE kind='member_provision' AND payload->>'operation_id'=(
           SELECT id::text FROM member_provisioning_operations WHERE invitation_id=$1
         )`,
        [invitation.id],
      )).rows,
    }));
    expect(before.operation).toEqual({ preparation: 'ready', issue: null });
    expect(before.jobs).toEqual([{ done: true }]);

    const driftedEnv = hermesEnv({
      HERMES_MEMBER_PROVISIONING_ENABLED: '1',
      PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify({ ...POLICY, max_candidates: 4 }),
    });
    await expect(verifyReservedCapacityForInvitation(driftedEnv, fixture.workspaceId, invitation.id))
      .rejects.toMatchObject({ reason: 'iris_capacity_unavailable' });
    expect(await capacityRows(fixture)).toEqual([expect.objectContaining({
      id: capacityId, state: 'quarantined', reserved_invitation_id: null,
    })]);

    const listed = await asUser(driftedEnv, fixture.adminId, `/w/${fixture.workspaceId}/invitations`);
    const items = (await listed.json() as { items: Array<Record<string, unknown>> }).items;
    expect(items.find((row) => row.id === invitation.id)).toMatchObject({
      provisioning: { preparation: 'queued', issue: 'readiness_failed' },
    });
  });

  it('preserves the Admin boundary and reports only a correlated auth reason', async () => {
    const fixture = await seedWorkspace();
    const env = hermesEnv();
    const email = `forbidden-${randomUUID()}@example.test`;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST', body: { email },
    });
    expect(response.status).toBe(403);
    const failure = await response.json() as { reason: string; trace_id: string };
    expect(failure).toMatchObject({ reason: 'admin_required' });
    expect(failure.trace_id).toMatch(/^[0-9a-f-]{36}$/);
    const diagnostic = log.mock.calls.flatMap((call) => call.map(String))
      .find((line) => line.includes('"at":"invitation.lifecycle"'));
    expect(JSON.parse(diagnostic!) as unknown).toMatchObject({
      checkpoint: 'request_received', correlation_id: failure.trace_id,
      reason: 'admin_required', status: 403,
    });
    expect(diagnostic).not.toContain(email);
    const rows = await readTenant(fixture.workspaceId, fixture.adminId, (client) => client.query(
      `SELECT id FROM invitations WHERE workspace_id=$1 AND email=$2`, [fixture.workspaceId, email],
    ));
    expect(rows.rowCount).toBe(0);
  });

  it('preserves stable malformed request reasons while adding a correlation id', async () => {
    const fixture = await seedWorkspace();
    const env = hermesEnv();
    const malformedBody = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
    });
    expect(malformedBody.status).toBe(400);
    await expect(malformedBody.json()).resolves.toMatchObject({
      reason: 'bad_body', trace_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });

    const malformedId = await asUser(
      env, fixture.adminId, `/w/${fixture.workspaceId}/invitations/not-a-uuid/resend`, { method: 'POST' },
    );
    expect(malformedId.status).toBe(400);
    await expect(malformedId.json()).resolves.toMatchObject({
      reason: 'bad_id', trace_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('sanitizes an asynchronous WorkOS delivery failure and retains the retry', async () => {
    const fixture = await seedWorkspace();
    const organizationId = `org_${randomUUID().slice(0, 12)}`;
    await withClient('owner', (client) => client.query(
      `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1,$2)
       ON CONFLICT (workspace_id) DO UPDATE SET workos_organization_id=EXCLUDED.workos_organization_id`,
      [fixture.workspaceId, organizationId],
    ));
    const env = workosEnv({
      AGENT_RUNTIME: 'hermes', KEK_V1,
      PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(POLICY),
    }).env;
    await seedCapacity(fixture, env);
    const email = `private-${randomUUID()}@example.test`;
    const upstream = `WorkOS rejected ${email}; bearer top-secret; {"recipient":"${email}"}`;
    fake.invitationFailure = new FakeWorkOSError(upstream, 503);
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { output.push(values.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...values: unknown[]) => { output.push(values.map(String).join(' ')); });

    const response = await asWorkOSAdmin(
      fixture, env, `/w/${fixture.workspaceId}/invitations`, { email },
    );
    expect(response.status).toBe(201);
    const invitation = await response.json() as { id: string };

    const state = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const delivery = await client.query<{ delivery_status: string; delivery_error: string | null }>(
        `SELECT delivery_status,delivery_error FROM invitations WHERE workspace_id=$1 AND id=$2`,
        [fixture.workspaceId, invitation.id],
      );
      const sync = await client.query<{ status: string; last_error: string | null }>(
        `SELECT status,last_error FROM workos_sync WHERE workspace_id=$1 AND resource_id=$2`,
        [fixture.workspaceId, invitation.id],
      );
      const job = await client.query<{
        last_error: string | null; done: boolean; unlocked: boolean; retry_scheduled: boolean;
      }>(
        `SELECT last_error,done_at IS NOT NULL AS done,locked_until IS NULL AS unlocked,
                next_at > created_at AS retry_scheduled
           FROM jobs WHERE workspace_id=$1 AND kind='workos_sync' AND payload->>'invitation_id'=$2`,
        [fixture.workspaceId, invitation.id],
      );
      const ready = await client.query(
        `SELECT 1 FROM job_ready r JOIN jobs j ON j.id=r.job_id
          WHERE j.workspace_id=$1 AND j.kind='workos_sync' AND j.payload->>'invitation_id'=$2`,
        [fixture.workspaceId, invitation.id],
      );
      return { delivery: delivery.rows[0]!, sync: sync.rows[0]!, job: job.rows[0]!, ready: ready.rowCount };
    });
    expect(state).toEqual({
      delivery: { delivery_status: 'failed', delivery_error: 'workos_invitation_delivery_unavailable' },
      sync: { status: 'failed', last_error: 'workos_invitation_delivery_unavailable' },
      job: {
        last_error: 'workos_invitation_delivery_unavailable', done: false,
        unlocked: true, retry_scheduled: true,
      },
      ready: 1,
    });
    expect(output.join('\n')).not.toContain(email);
    expect(output.join('\n')).not.toContain('top-secret');
    expect(output.join('\n')).not.toContain('recipient');
    const lifecycle = output.filter((line) => line.includes('"at":"invitation.lifecycle"'))
      .map((line) => JSON.parse(line) as { correlation_id: string; checkpoint: string });
    expect(lifecycle.map((row) => row.checkpoint)).toEqual(expect.arrayContaining([
      'job_claimed', 'pending_and_reservation_rechecked', 'provider_attempted', 'provider_failed', 'committed',
    ]));
    expect(new Set(lifecycle.map((row) => row.correlation_id)).size).toBe(1);

    const adminList = await asUser(hermesEnv(), fixture.adminId, `/w/${fixture.workspaceId}/invitations`);
    const adminItems = (await adminList.json() as { items: Array<Record<string, unknown>> }).items;
    expect(adminItems.find((row) => row.id === invitation.id)).toMatchObject({
      delivery_status: 'failed',
      delivery_reason: 'workos_invitation_delivery_unavailable',
      delivery_trace_id: lifecycle[0]?.correlation_id,
    });
    const memberList = await asUser(hermesEnv(), fixture.memberId, `/w/${fixture.workspaceId}/invitations`);
    expect(memberList.status).toBe(403);
    expect(await memberList.json()).toMatchObject({ reason: 'admin_required' });
  });

  it('records a terminal provider rejection once without retrying it', async () => {
    const fixture = await seedWorkspace();
    const organizationId = `org_${randomUUID().slice(0, 12)}`;
    await withClient('owner', (client) => client.query(
      `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1,$2)
       ON CONFLICT (workspace_id) DO UPDATE SET workos_organization_id=EXCLUDED.workos_organization_id`,
      [fixture.workspaceId, organizationId],
    ));
    const env = workosEnv({
      AGENT_RUNTIME: 'hermes', KEK_V1,
      PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(POLICY),
    }).env;
    await seedCapacity(fixture, env);
    fake.invitationFailure = new FakeWorkOSError('private provider rejection', 400);

    const response = await asWorkOSAdmin(
      fixture, env, `/w/${fixture.workspaceId}/invitations`, { email: `rejected-${randomUUID()}@example.test` },
    );
    expect(response.status).toBe(201);
    const invitation = await response.json() as { id: string };
    const state = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const delivery = await client.query<{ delivery_status: string; delivery_error: string | null }>(
        `SELECT delivery_status,delivery_error FROM invitations WHERE id=$1`, [invitation.id],
      );
      const job = await client.query<{ done: boolean; last_error: string | null }>(
        `SELECT done_at IS NOT NULL AS done,last_error FROM jobs
          WHERE workspace_id=$1 AND kind='workos_sync' AND payload->>'invitation_id'=$2`,
        [fixture.workspaceId, invitation.id],
      );
      const ready = await client.query(
        `SELECT 1 FROM job_ready r JOIN jobs j ON j.id=r.job_id
          WHERE j.workspace_id=$1 AND j.kind='workos_sync' AND j.payload->>'invitation_id'=$2`,
        [fixture.workspaceId, invitation.id],
      );
      return { delivery: delivery.rows[0]!, job: job.rows[0]!, ready: ready.rowCount };
    });
    expect(state).toEqual({
      delivery: { delivery_status: 'failed', delivery_error: 'workos_invitation_delivery_rejected' },
      job: { done: true, last_error: 'workos_invitation_delivery_rejected' },
      ready: 0,
    });
    expect(fake.calls.filter((call) => call.method === 'sendInvitation')).toHaveLength(1);
  });

  it('does not repeat a provider write after WorkOS accepts but local confirmation fails', async () => {
    const fixture = await seedWorkspace();
    const organizationId = `org_${randomUUID().slice(0, 12)}`;
    await withClient('owner', (client) => client.query(
      `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1,$2)
       ON CONFLICT (workspace_id) DO UPDATE SET workos_organization_id=EXCLUDED.workos_organization_id`,
      [fixture.workspaceId, organizationId],
    ));
    const env = workosEnv({
      AGENT_RUNTIME: 'hermes', KEK_V1,
      PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(POLICY),
    }).env;
    await seedCapacity(fixture, env);
    const email = `accepted-unpersisted-${randomUUID()}@example.test`;
    const suffix = randomUUID().replaceAll('-', '');
    const functionName = `test_invitation_commit_failure_${suffix}`;
    const triggerName = `test_invitation_commit_failure_${suffix}`;
    const safeEmail = email.replaceAll("'", "''");
    await withClient('owner', async (client) => {
      await client.query(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN
             IF NEW.email='${safeEmail}' AND NEW.delivery_status='delivered' THEN
               RAISE EXCEPTION 'forced local invitation confirmation failure';
             END IF;
             RETURN NEW;
           END
         $$`,
      );
      await client.query(
        `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON invitations
           FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      );
    });

    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const response = await asWorkOSAdmin(
        fixture, env, `/w/${fixture.workspaceId}/invitations`, { email },
      );
      expect(response.status).toBe(201);
      const invitation = await response.json() as { id: string };
      const state = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
        const delivery = await client.query<{
          workos_invitation_id: string | null; delivery_status: string; delivery_error: string | null;
        }>(
          `SELECT workos_invitation_id,delivery_status,delivery_error FROM invitations WHERE id=$1`,
          [invitation.id],
        );
        const job = await client.query<{ id: string; done: boolean; last_error: string | null }>(
          `SELECT id,done_at IS NOT NULL AS done,last_error FROM jobs
            WHERE workspace_id=$1 AND kind='workos_sync' AND payload->>'invitation_id'=$2`,
          [fixture.workspaceId, invitation.id],
        );
        const ready = await client.query(
          `SELECT 1 FROM job_ready r JOIN jobs j ON j.id=r.job_id
            WHERE j.workspace_id=$1 AND j.kind='workos_sync' AND j.payload->>'invitation_id'=$2`,
          [fixture.workspaceId, invitation.id],
        );
        return { delivery: delivery.rows[0]!, job: job.rows[0]!, ready: ready.rowCount };
      });
      expect(state.delivery).toMatchObject({
        delivery_status: 'failed',
        delivery_error: 'workos_invitation_local_commit_failed',
      });
      expect(state.delivery.workos_invitation_id).toBe(fake.invitations[0]?.id);
      expect(state.job).toMatchObject({ done: true, last_error: 'workos_invitation_local_commit_failed' });
      expect(state.ready).toBe(0);
      expect(fake.calls.filter((call) => call.method === 'sendInvitation')).toHaveLength(1);

      await runJobsAfterCommit(env, fixture.workspaceId, [state.job.id]);
      expect(fake.calls.filter((call) => call.method === 'sendInvitation')).toHaveLength(1);

      for (const replayCase of [
        {
          deliveryStatus: 'sending',
          seededReason: null,
          expectedReason: 'workos_invitation_delivery_outcome_unknown',
        },
        {
          deliveryStatus: 'failed',
          seededReason: 'workos_invitation_delivery_outcome_unknown',
          expectedReason: 'workos_invitation_delivery_outcome_unknown',
        },
        {
          deliveryStatus: 'failed',
          seededReason: 'workos_invitation_delivery_rejected',
          expectedReason: 'workos_invitation_delivery_rejected',
        },
      ]) {
        await withClient('owner', async (client) => {
          await client.query('BEGIN');
          await setTenant(client, fixture.workspaceId, fixture.adminId);
          await client.query(
            `UPDATE invitations
                SET workos_invitation_id=NULL,delivery_status=$2,delivery_error=$3
              WHERE id=$1`,
            [invitation.id, replayCase.deliveryStatus, replayCase.seededReason],
          );
          await client.query(
            `UPDATE jobs SET done_at=NULL,locked_until=NULL,last_error=NULL WHERE id=$1`,
            [state.job.id],
          );
          await client.query(
            `INSERT INTO job_ready (job_id,workspace_id) VALUES ($1,$2)
             ON CONFLICT (job_id) DO NOTHING`,
            [state.job.id, fixture.workspaceId],
          );
          await client.query('COMMIT');
        });

        await runJobsAfterCommit(env, fixture.workspaceId, [state.job.id]);
        expect(fake.calls.filter((call) => call.method === 'sendInvitation')).toHaveLength(1);
        const replay = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
          const invitationState = await client.query<{ delivery_error: string | null }>(
            `SELECT delivery_error FROM invitations WHERE id=$1`, [invitation.id],
          );
          const jobState = await client.query<{ done: boolean }>(
            `SELECT done_at IS NOT NULL AS done FROM jobs WHERE id=$1`, [state.job.id],
          );
          const ready = await client.query(`SELECT 1 FROM job_ready WHERE job_id=$1`, [state.job.id]);
          return {
            reason: invitationState.rows[0]!.delivery_error,
            done: jobState.rows[0]!.done,
            ready: ready.rowCount,
          };
        });
        expect(replay).toEqual({ reason: replayCase.expectedReason, done: true, ready: 0 });
      }
    } finally {
      await withClient('owner', async (client) => {
        await client.query(`DROP TRIGGER IF EXISTS ${triggerName} ON invitations`);
        await client.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      });
    }
  });

  it('delivers through WorkOS only after the exact invitation has reserved capacity', async () => {
    const fixture = await seedWorkspace();
    const organizationId = `org_${randomUUID().slice(0, 12)}`;
    await withClient('owner', (client) => client.query(
      `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1,$2)
       ON CONFLICT (workspace_id) DO UPDATE SET workos_organization_id=EXCLUDED.workos_organization_id`,
      [fixture.workspaceId, organizationId],
    ));
    const env = workosEnv({
      AGENT_RUNTIME: 'hermes', KEK_V1,
      PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(POLICY),
    }).env;
    const [capacityId] = await seedCapacity(fixture, env);
    const email = `deliverable-${randomUUID()}@example.test`;
    const output: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { output.push(values.map(String).join(' ')); });

    const response = await asWorkOSAdmin(
      fixture, env, `/w/${fixture.workspaceId}/invitations`, { email },
    );
    expect(response.status).toBe(201);
    const invitation = await response.json() as { id: string };
    expect(fake.calls.filter((call) => call.method === 'sendInvitation')).toHaveLength(1);

    const state = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const delivery = await client.query<{ delivery_status: string; workos_invitation_id: string | null }>(
        `SELECT delivery_status, workos_invitation_id FROM invitations WHERE id=$1`, [invitation.id],
      );
      const capacity = await capacityRows(fixture);
      return { delivery: delivery.rows[0]!, capacity };
    });
    expect(state.delivery.delivery_status).toBe('delivered');
    expect(state.delivery.workos_invitation_id).not.toBeNull();
    expect(state.capacity).toEqual([expect.objectContaining({
      id: capacityId, state: 'reserved', reserved_invitation_id: invitation.id,
    })]);
    const lifecycle = output.filter((line) => line.includes('"at":"invitation.lifecycle"'))
      .map((line) => JSON.parse(line) as { correlation_id: string; checkpoint: string });
    expect(lifecycle.map((row) => row.checkpoint)).toEqual(expect.arrayContaining([
      'job_claimed', 'provider_attempted', 'provider_accepted', 'local_delivery_committed', 'committed',
    ]));
    expect(new Set(lifecycle.map((row) => row.correlation_id)).size).toBe(1);
    expect(output.join('\n')).not.toContain(email);
  });

  it('makes duplicate requests idempotent without consuming another instance', async () => {
    const fixture = await seedWorkspace();
    const env = hermesEnv();
    await seedCapacity(fixture, env, 2);
    const email = `duplicate-${randomUUID()}@example.test`;
    const first = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST', body: { email },
    });
    const duplicate = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST', body: { email },
    });
    const firstBody = await first.json() as { id: string };
    const duplicateBody = await duplicate.json() as { id: string };

    expect([first.status, duplicate.status]).toEqual([201, 200]);
    expect(duplicateBody.id).toBe(firstBody.id);
    const rows = await capacityRows(fixture);
    expect(rows.filter((row) => row.state === 'reserved')).toHaveLength(1);
    expect(rows.filter((row) => row.state === 'available')).toHaveLength(1);
  });

  it('transfers on resend, releases on withdrawal, and releases authoritative expiration', async () => {
    const fixture = await seedWorkspace();
    const env = hermesEnv();
    const [capacityId] = await seedCapacity(fixture, env);
    const create = async (email: string): Promise<{ id: string }> => {
      const response = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
        method: 'POST', body: { email },
      });
      expect(response.status).toBe(201);
      return response.json() as Promise<{ id: string }>;
    };

    const original = await create(`lifecycle-${randomUUID()}@example.test`);
    const resentResponse = await asUser(
      env, fixture.adminId, `/w/${fixture.workspaceId}/invitations/${original.id}/resend`, { method: 'POST' },
    );
    expect(resentResponse.status).toBe(201);
    const successor = await resentResponse.json() as { id: string };
    expect(await capacityRows(fixture)).toEqual([expect.objectContaining({
      id: capacityId, state: 'reserved', reserved_invitation_id: successor.id,
    })]);

    const withdrawn = await asUser(
      env, fixture.adminId, `/w/${fixture.workspaceId}/invitations/${successor.id}/withdraw`, { method: 'POST' },
    );
    expect(withdrawn.status).toBe(204);
    expect(await capacityRows(fixture)).toEqual([expect.objectContaining({
      id: capacityId, state: 'available', reserved_invitation_id: null,
    })]);

    const expiring = await create(`expiring-${randomUUID()}@example.test`);
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fixture.workspaceId, fixture.adminId);
      await client.query(`UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1`, [expiring.id]);
      await client.query('COMMIT');
    });
    const list = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`);
    expect(list.status).toBe(200);
    expect(await capacityRows(fixture)).toEqual([expect.objectContaining({
      id: capacityId, state: 'available', reserved_invitation_id: null,
    })]);
  });

  it('allows only a stepped-up Admin to register an already verified instance', async () => {
    const fixture = await seedWorkspace();
    const cloudAgentId = `cloud-register-${randomUUID()}`;
    const preflightAgentId = randomUUID();
    const connectorUrl = `https://register-${randomUUID()}.example.test/control`;
    let enterpriseUrl = 'https://wrong-enterprise.example.test';
    let pluginRevision = PLUGIN_REVISION;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const body = init?.body ? JSON.parse(String(init.body)) as { operation?: string } : {};
      if (url.hostname.startsWith('register-')) {
        if (body.operation === 'capabilities') return Response.json(capabilitiesBody());
        if (body.operation === 'readiness') {
          const readiness = readinessBody(fixture.workspaceId, preflightAgentId);
          readiness.enterprise_url = enterpriseUrl;
          readiness.plugin = { ...(readiness.plugin as Record<string, unknown>), revision: pluginRevision };
          return Response.json(readiness);
        }
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    const env = hermesEnv();
    const input = {
      cloud_agent_id: cloudAgentId, instance_name: `pool-${randomUUID().slice(0, 8)}`,
      connector_url: connectorUrl, control_secret: 'registered-control-secret-longer-than-24',
      preflight_agent_id: preflightAgentId,
    };
    const prepared = await asUser(
      env, fixture.adminId, `/w/${fixture.workspaceId}/admin/runtime-discovery-grants`,
      { method: 'POST', body: { preflight_agent_id: preflightAgentId } },
    );
    expect(prepared.status).toBe(201);
    const grant = await prepared.json() as { id: string; bearer: string };
    const refused = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/admin/hermes-capacity`, {
      method: 'POST', body: { ...input, discovery_grant_id: grant.id },
    });
    expect(refused.status).toBe(403);

    const wrongOrigin = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/admin/hermes-capacity`, {
      method: 'POST', body: { ...input, discovery_grant_id: grant.id },
    });
    expect(wrongOrigin.status).toBe(409);
    enterpriseUrl = 'https://enterprise.example.test';
    pluginRevision = 'b'.repeat(40);
    const wrongPlugin = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/admin/hermes-capacity`, {
      method: 'POST', body: { ...input, discovery_grant_id: grant.id },
    });
    expect(wrongPlugin.status).toBe(409);
    pluginRevision = PLUGIN_REVISION;

    const registered = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/admin/hermes-capacity`, {
      method: 'POST', body: { ...input, discovery_grant_id: grant.id },
    });
    expect(registered.status).toBe(201);
    expect(registered.headers.get('cache-control')).toBe('no-store');
    const response = await registered.json() as Record<string, unknown>;
    expect(response).toMatchObject({
      cloud_agent_id: cloudAgentId, state: 'available', plugin_version: '1.7.0',
      agentcash_enabled: true, agentcash_wallet_present: true, native_cron_disabled: true,
    });
    expect(JSON.stringify(response)).not.toContain(input.control_secret);
    expect(JSON.stringify(response)).not.toContain(grant.bearer);
  });

  it('issues the discovery bearer once, permits only read-only discovery, rotates, and expires it', async () => {
    const fixture = await seedWorkspace();
    const preflightAgentId = randomUUID();
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    const env = hermesEnv({
      HERMES_BRIDGE_SECRET: 'bridge-secret-longer-than-thirty-two-characters',
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [preflightAgentId]: {
          workspace_id: fixture.workspaceId,
          base_url: 'https://stale-pool-map.example.test/control',
          api_key: 'stale-control-secret-longer-than-24',
          transport: 'dashboard_connector', assignment: 'invitee_pool', agentcash: true,
        },
      }),
    });

    const member = await asUser(
      env, fixture.memberId, `/w/${fixture.workspaceId}/admin/runtime-discovery-grants`,
    );
    expect(member.status).toBe(403);

    const prepared = await asUser(
      env, fixture.adminId, `/w/${fixture.workspaceId}/admin/runtime-discovery-grants`,
      { method: 'POST', body: { preflight_agent_id: preflightAgentId } },
    );
    expect(prepared.status).toBe(201);
    const first = await prepared.json() as { id: string; bearer: string; status: string };
    expect(first).toMatchObject({ status: 'prepared' });
    expect(first.bearer).toMatch(/^[0-9a-f]{64}$/);

    const listed = await asUser(
      env, fixture.adminId, `/w/${fixture.workspaceId}/admin/runtime-discovery-grants`,
    );
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain(first.bearer);

    const skills = await call(
      env, `/internal/runtime/w/${fixture.workspaceId}/agents/${preflightAgentId}/skills`,
      { origin: null, headers: { Authorization: `Bearer ${first.bearer}` } },
    );
    expect(skills.status).toBe(200);
    await expect(skills.json()).resolves.toMatchObject({
      skills: [expect.objectContaining({
        artifact_digest: PARTNER_PROGRAM_DEFINITION.artifactDigest,
        binding_source: 'preflight_grant', binding_state: 'prepared', grant_revision: 1,
      })],
    });
    const tools = await call(
      env, `/internal/runtime/w/${fixture.workspaceId}/agents/${preflightAgentId}/tools`,
      { origin: null, headers: { Authorization: `Bearer ${first.bearer}` } },
    );
    expect(tools.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
    const otherWorkspace = await seedWorkspace();
    const crossTenant = await call(
      env, `/internal/runtime/w/${otherWorkspace.workspaceId}/agents/${preflightAgentId}/skills`,
      { origin: null, headers: { Authorization: `Bearer ${first.bearer}` } },
    );
    expect(crossTenant.status).toBe(403);
    const staleHmac = await bridgeToken(env, fixture.workspaceId, preflightAgentId);
    const execution = await call(
      env, `/internal/runtime/w/${fixture.workspaceId}/agents/${preflightAgentId}/calls`,
      {
        method: 'POST', origin: null,
        headers: { Authorization: `Bearer ${staleHmac}` },
        body: { runtime_run_id: 'run-preflight', tool_call_id: 'call-preflight', name: 'list_requests', arguments: {} },
      },
    );
    expect(execution.status).toBe(403);

    const revoked = await asUser(
      env, fixture.adminId,
      `/w/${fixture.workspaceId}/admin/runtime-discovery-grants/${first.id}`,
      { method: 'DELETE' },
    );
    expect(revoked.status).toBe(200);
    const revokedHmacFallback = await call(
      env, `/internal/runtime/w/${fixture.workspaceId}/agents/${preflightAgentId}/skills`,
      { origin: null, headers: { Authorization: `Bearer ${staleHmac}` } },
    );
    expect(revokedHmacFallback.status).toBe(403);
    const rotated = await asUser(
      env, fixture.adminId, `/w/${fixture.workspaceId}/admin/runtime-discovery-grants`,
      { method: 'POST', body: { preflight_agent_id: preflightAgentId } },
    );
    expect(rotated.status).toBe(201);
    const second = await rotated.json() as { id: string; bearer: string };
    expect(second.bearer).not.toBe(first.bearer);
    const replay = await call(
      env, `/internal/runtime/w/${fixture.workspaceId}/agents/${preflightAgentId}/skills`,
      { origin: null, headers: { Authorization: `Bearer ${first.bearer}` } },
    );
    expect(replay.status).toBe(403);
    const current = await call(
      env, `/internal/runtime/w/${fixture.workspaceId}/agents/${preflightAgentId}/skills`,
      { origin: null, headers: { Authorization: `Bearer ${second.bearer}` } },
    );
    expect(current.status).toBe(200);

    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fixture.workspaceId, fixture.adminId);
      await client.query(
        `UPDATE runtime_discovery_grants SET expires_at=now()-interval '1 minute' WHERE id=$1`,
        [second.id],
      );
      await client.query('COMMIT');
    });
    const expired = await call(
      env, `/internal/runtime/w/${fixture.workspaceId}/agents/${preflightAgentId}/skills`,
      { origin: null, headers: { Authorization: `Bearer ${second.bearer}` } },
    );
    expect(expired.status).toBe(403);
  });

  it('cannot shadow the original fixed Iris credential with a discovery grant', async () => {
    const fixture = await seedWorkspace();
    const env = hermesEnv({
      ENVIRONMENT: 'development',
      HERMES_BRIDGE_SECRET: 'fixed-iris-bridge-secret-longer-than-32-chars',
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [fixture.agentId]: {
          workspace_id: fixture.workspaceId,
          base_url: 'https://fixed-iris.example.test/control',
          api_key: 'fixed-control-secret', transport: 'dashboard_connector', assignment: 'fixed',
        },
      }),
    });
    const refused = await asUser(
      env, fixture.adminId, `/w/${fixture.workspaceId}/admin/runtime-discovery-grants`,
      { method: 'POST', body: { preflight_agent_id: fixture.agentId } },
    );
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ reason: 'discovery_profile_assigned' });

    const token = await bridgeToken(env, fixture.workspaceId, fixture.agentId);
    const skills = await call(
      env, `/internal/runtime/w/${fixture.workspaceId}/agents/${fixture.agentId}/skills`,
      { origin: null, headers: { Authorization: `Bearer ${token}` } },
    );
    expect(skills.status).toBe(200);
  });

  it('assigns the pre-bound identity without Cloud mutation and makes Iris runnable after onboarding', async () => {
    const fixture = await seedWorkspace();
    const joinerId = randomUUID();
    const email = `ready-${randomUUID()}@example.test`;
    const env = hermesEnv({
      HERMES_BRIDGE_SECRET: 'bridge-secret-longer-than-thirty-two-characters',
      HERMES_ENTERPRISE_PUBLIC_URL: 'https://enterprise.example.test',
    });
    const capacityId = (await seedCapacity(fixture, env))[0]!;
    const upstream = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const body = init?.body ? JSON.parse(String(init.body)) as { operation?: string } : {};
      if (url.hostname.startsWith('pool-') && body.operation === 'capabilities') return Response.json(capabilitiesBody());
      if (url.hostname.startsWith('pool-') && body.operation === 'readiness') {
        return Response.json(readinessBody(fixture.workspaceId, capacityId));
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    vi.stubGlobal('fetch', upstream);
    await withClient('owner', (client) => client.query(
      `INSERT INTO users (id, email, email_verified, name) VALUES ($1,$2,true,'Ready Member')`,
      [joinerId, email],
    ));
    const invited = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST', body: { email },
    });
    expect(invited.status).toBe(201);
    const invitation = await invited.json() as { id: string };

    const accepted = await asUser(env, joinerId, `/invitations/${invitation.id}/accept`, {
      method: 'POST', body: {},
    });
    expect(accepted.status).toBe(200);
    const operations = upstream.mock.calls.map(([, init]) =>
      init?.body ? (JSON.parse(String(init.body)) as { operation?: string }).operation : null);
    expect(operations.sort()).toEqual(['capabilities', 'readiness']);
    expect(operations).not.toContain('submit');

    const afterAssignment = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const ownership = await client.query<{ member_id: string; agent_id: string }>(
        `SELECT ao.member_id, ao.agent_id FROM agent_owners ao JOIN members m ON m.id=ao.member_id
          WHERE ao.workspace_id=$1 AND m.user_id=$2`,
        [fixture.workspaceId, joinerId],
      );
      const agentId = ownership.rows[0]!.agent_id;
      const capacity = await client.query<{ state: string; assigned_agent_id: string; wallet: boolean }>(
        `SELECT state, assigned_agent_id, agentcash_wallet_present AS wallet
           FROM hermes_cloud_capacity WHERE id=$1`, [capacityId],
      );
      const binding = await client.query<{ ready: boolean; runtime_auth_mode: string; has_digest: boolean }>(
        `SELECT ready_at IS NOT NULL AS ready, runtime_auth_mode,
                runtime_credential_digest IS NOT NULL AS has_digest
           FROM agent_runtime_bindings WHERE agent_id=$1`, [agentId],
      );
      const grant = await client.query<{
        consumed: boolean; revoked: boolean; assignment_revision: number | null;
      }>(
        `SELECT consumed_at IS NOT NULL AS consumed, revoked_at IS NOT NULL AS revoked,
                assignment_revision
           FROM runtime_discovery_grants WHERE workspace_id=$1 AND agent_id=$2`,
        [fixture.workspaceId, agentId],
      );
      const provisioning = await client.query<{ status: string }>(
        `SELECT status FROM agent_provisioning WHERE agent_id=$1`, [agentId],
      );
      return {
        ownership: ownership.rows[0]!, capacity: capacity.rows[0]!,
        binding: binding.rows[0]!, grant: grant.rows[0]!, provisioning: provisioning.rows[0]!,
      };
    });
    expect(afterAssignment.ownership.agent_id).toBe(capacityId);
    expect(afterAssignment.capacity).toEqual({ state: 'assigned', assigned_agent_id: afterAssignment.ownership.agent_id, wallet: true });
    expect(afterAssignment.binding).toEqual({
      ready: true, runtime_auth_mode: 'token_digest', has_digest: true,
    });
    expect(afterAssignment.grant).toEqual({ consumed: true, revoked: false, assignment_revision: 1 });
    expect(afterAssignment.provisioning).toEqual({ status: 'ready' });

    const onboarded = await asUser(
      env, joinerId, `/w/${fixture.workspaceId}/agents/${afterAssignment.ownership.agent_id}`,
      {
        method: 'PATCH',
        body: { first_run: {
          role_id: 'partner-program', role_label: 'Partner Program', loop_id: 'screen-partners',
          partner_criteria: 'Developer infrastructure companies in North America with active ecosystem leadership.',
          reviewers: {
            admission: 'You', 'role-benefits': 'You', 'external-message': 'You', 'agreement-money': 'Admin + Finance',
          },
        } },
      },
    );
    expect(onboarded.status).toBe(204);
    const ready = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const agent = await client.query<{ status: string; setup_step: string | null }>(
        `SELECT status, setup_step FROM agents WHERE id=$1`, [afterAssignment.ownership.agent_id],
      );
      const criteria = await client.query<{ value: string }>(
        `SELECT value FROM agent_context_fields WHERE agent_id=$1 AND key='partner_criteria'`,
        [afterAssignment.ownership.agent_id],
      );
      return { agent: agent.rows[0]!, criteria: criteria.rows[0]?.value };
    });
    expect(ready).toEqual({
      agent: { status: 'started', setup_step: null },
      criteria: 'Developer infrastructure companies in North America with active ecosystem leadership.',
    });
  });

  it('rejects a stale acceptance proof and rolls member and agent writes back', async () => {
    const fixture = await seedWorkspace();
    const joinerId = randomUUID();
    const email = `stale-proof-${randomUUID()}@example.test`;
    const env = hermesEnv({
      HERMES_BRIDGE_SECRET: 'bridge-secret-longer-than-thirty-two-characters',
      HERMES_ENTERPRISE_PUBLIC_URL: 'https://enterprise.example.test',
    });
    const capacityId = (await seedCapacity(fixture, env))[0]!;
    await withClient('owner', (client) => client.query(
      `INSERT INTO users (id,email,email_verified,name) VALUES ($1,$2,true,'Stale Proof Member')`,
      [joinerId, email],
    ));
    const invited = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST', body: { email },
    });
    expect(invited.status).toBe(201);
    const invitationId = (await invited.json() as { id: string }).id;
    let drifted = false;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const body = init?.body ? JSON.parse(String(init.body)) as { operation?: string } : {};
      if (url.hostname.startsWith('pool-') && body.operation === 'capabilities') {
        return Response.json(capabilitiesBody());
      }
      if (url.hostname.startsWith('pool-') && body.operation === 'readiness') {
        if (!drifted) {
          drifted = true;
          await withClient('owner', async (client) => {
            await client.query('BEGIN');
            await setTenant(client, fixture.workspaceId, fixture.adminId);
            await client.query(
              `UPDATE runtime_discovery_grants
                  SET config_digest=$2
                WHERE workspace_id=$1 AND linked_capacity_id=$3`,
              [fixture.workspaceId, `sha256:${'0'.repeat(64)}`, capacityId],
            );
            await client.query('COMMIT');
          });
        }
        return Response.json(readinessBody(fixture.workspaceId, capacityId));
      }
      return new Response('unexpected fetch', { status: 500 });
    }));

    const accepted = await asUser(env, joinerId, `/invitations/${invitationId}/accept`, {
      method: 'POST', body: {},
    });
    expect(accepted.status).toBe(409);
    await expect(accepted.json()).resolves.toMatchObject({ reason: 'iris_capacity_unavailable' });
    const persisted = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => ({
      invitation: (await client.query<{ status: string }>(
        `SELECT status FROM invitations WHERE id=$1`, [invitationId],
      )).rows[0]!,
      members: (await client.query(
        `SELECT 1 FROM members WHERE workspace_id=$1 AND user_id=$2`,
        [fixture.workspaceId, joinerId],
      )).rowCount,
      agents: (await client.query(`SELECT 1 FROM agents WHERE id=$1`, [capacityId])).rowCount,
      capacity: (await client.query<{ state: string; quarantine_reason: string }>(
        `SELECT state,quarantine_reason FROM hermes_cloud_capacity WHERE id=$1`, [capacityId],
      )).rows[0]!,
    }));
    expect(persisted).toEqual({
      invitation: { status: 'pending' }, members: 0, agents: 0,
      capacity: { state: 'quarantined', quarantine_reason: 'discovery_profile_changed' },
    });
  });

  it('promotes an exact Finance reservation only after acceptance and creates no Partnerships or AgentCash artifacts', async () => {
    const fixture = await seedWorkspace();
    const joinerId = randomUUID();
    const email = `finance-ready-${randomUUID()}@example.test`;
    const env = hermesEnv({
      HERMES_BRIDGE_SECRET: 'bridge-secret-longer-than-thirty-two-characters',
      HERMES_ENTERPRISE_PUBLIC_URL: 'https://enterprise.example.test',
    });
    const capacityId = (await seedCapacity(fixture, env, 1, FINANCE_CAPACITY_ROLE))[0]!;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const body = init?.body ? JSON.parse(String(init.body)) as { operation?: string } : {};
      if (url.hostname.startsWith('pool-') && body.operation === 'capabilities') {
        return Response.json(capabilitiesBody());
      }
      if (url.hostname.startsWith('pool-') && body.operation === 'readiness') {
        return Response.json(readinessBody(fixture.workspaceId, capacityId, FINANCE_CAPACITY_ROLE));
      }
      return new Response('unexpected fetch', { status: 500 });
    }));
    await withClient('owner', (client) => client.query(
      `INSERT INTO users (id,email,email_verified,name) VALUES ($1,$2,true,'Finance Member')`,
      [joinerId, email],
    ));
    const invitationId = await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fixture.workspaceId, fixture.adminId);
      const invitation = await client.query<{ id: string }>(
        `INSERT INTO invitations
           (workspace_id,email,role,expires_at,invited_by,status,delivery_status)
         VALUES ($1,$2,'member',now()+interval '7 days',$3,'pending','not_required')
         RETURNING id`,
        [fixture.workspaceId, email, fixture.adminId],
      );
      const id = invitation.rows[0]!.id;
      await client.query(
        `INSERT INTO member_provisioning_operations
           (workspace_id,invitation_id,requested_by,role_template_key,role_template_version,preparation)
         VALUES ($1,$2,$3,'finance-agent','1.0.0','ready')`,
        [fixture.workspaceId, id, fixture.adminId],
      );
      const reserved = await reserveCapacityForInvitation(
        env, client as never, fixture.workspaceId, id, FINANCE_CAPACITY_ROLE,
      );
      expect(reserved?.id).toBe(capacityId);
      await client.query('COMMIT');
      return id;
    });

    const before = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => ({
      agents: (await client.query(`SELECT 1 FROM agents WHERE id=$1`, [capacityId])).rowCount,
      principals: (await client.query(
        `SELECT 1 FROM enterprise_team_agents WHERE agent_id=$1`, [capacityId],
      )).rowCount,
      assignments: (await client.query(
        `SELECT 1 FROM enterprise_skill_assignments WHERE agent_id=$1`, [capacityId],
      )).rowCount,
    }));
    expect(before).toEqual({ agents: 0, principals: 0, assignments: 0 });

    const accepted = await asUser(env, joinerId, `/invitations/${invitationId}/accept`, {
      method: 'POST', body: {},
    });
    expect(accepted.status).toBe(200);

    const after = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const agent = (await client.query<{
        status: string; setup_step: string | null; responsibility: string; instructions_active: string;
      }>(
        `SELECT status,setup_step,responsibility,instructions_active FROM agents WHERE id=$1`,
        [capacityId],
      )).rows[0]!;
      const owner = (await client.query<{ user_id: string }>(
        `SELECT m.user_id FROM agent_owners ao JOIN members m ON m.id=ao.member_id
          WHERE ao.workspace_id=$1 AND ao.agent_id=$2`,
        [fixture.workspaceId, capacityId],
      )).rows[0]!;
      const principal = (await client.query<{
        principal_user_id: string; role_template_key: string; role_template_version: string;
      }>(
        `SELECT principal_user_id,role_template_key,role_template_version
           FROM enterprise_team_agents WHERE workspace_id=$1 AND agent_id=$2`,
        [fixture.workspaceId, capacityId],
      )).rows[0]!;
      const assignment = (await client.query<{
        skill_key: string; skill_version: string; state: string; capability_grants: string[];
        schedule: { enabled: boolean }; approval_policy: { human_review_required: boolean };
      }>(
        `SELECT skill_key,skill_version,state,capability_grants,schedule,approval_policy
           FROM enterprise_skill_assignments WHERE workspace_id=$1 AND agent_id=$2`,
        [fixture.workspaceId, capacityId],
      )).rows[0]!;
      const binding = (await client.query<{ assignment: string; agentcash: boolean }>(
        `SELECT assignment,agentcash FROM agent_runtime_bindings WHERE agent_id=$1`, [capacityId],
      )).rows[0]!;
      const capacity = (await client.query<{
        state: string; agentcash_enabled: boolean; agentcash_wallet_present: boolean;
      }>(
        `SELECT state,agentcash_enabled,agentcash_wallet_present
           FROM hermes_cloud_capacity WHERE id=$1`, [capacityId],
      )).rows[0]!;
      const grant = (await client.query<{ consumed: boolean; assignment_revision: number | null }>(
        `SELECT consumed_at IS NOT NULL AS consumed,assignment_revision
           FROM runtime_discovery_grants WHERE workspace_id=$1 AND agent_id=$2`,
        [fixture.workspaceId, capacityId],
      )).rows[0]!;
      const partnershipArtifacts = (await client.query(
        `SELECT 1 FROM enterprise_skill_assignments
          WHERE workspace_id=$1 AND agent_id=$2 AND skill_key='partner-program-screening'
         UNION ALL
         SELECT 1 FROM requests
          WHERE workspace_id=$1 AND tool_call_id=$3
         UNION ALL
         SELECT 1 FROM approval_policies
          WHERE workspace_id=$1 AND requester_agent_id=$2 AND key=$4`,
        [fixture.workspaceId, capacityId, `partner-criteria:${invitationId}`, `partner-first-search-${capacityId}`],
      )).rowCount;
      return { agent, owner, principal, assignment, binding, capacity, grant, partnershipArtifacts };
    });
    expect(after.agent).toMatchObject({
      status: 'started', setup_step: null, responsibility: 'Finance invoice review',
    });
    expect(after.agent.instructions_active).toContain('Finance');
    expect(after.owner).toEqual({ user_id: joinerId });
    expect(after.principal).toEqual({
      principal_user_id: joinerId,
      role_template_key: 'finance-agent', role_template_version: '1.0.0',
    });
    expect(after.assignment).toMatchObject({
      skill_key: 'partner-invoice-review', skill_version: '1.0.1', state: 'active',
      capability_grants: ['partner.shared.read', 'partner.invoice.read', 'partner.invoice.review.prepare'],
      schedule: { enabled: false }, approval_policy: { human_review_required: true },
    });
    expect(after.binding).toEqual({ assignment: 'invitee_pool', agentcash: false });
    expect(after.capacity).toEqual({
      state: 'assigned', agentcash_enabled: false, agentcash_wallet_present: false,
    });
    expect(after.grant).toEqual({ consumed: true, assignment_revision: 1 });
    expect(after.partnershipArtifacts).toBe(0);
  });

  it('keeps a Finance reservation truthful when an inactive former Partnerships member already owns Iris', async () => {
    const fixture = await seedWorkspace();
    const joinerId = randomUUID();
    const oldAgentId = randomUUID();
    const oldSessionId = randomUUID();
    const email = `returning-finance-${randomUUID()}@example.test`;
    const env = hermesEnv({
      HERMES_BRIDGE_SECRET: 'bridge-secret-longer-than-thirty-two-characters',
      HERMES_ENTERPRISE_PUBLIC_URL: 'https://enterprise.example.test',
    });
    const capacityId = (await seedCapacity(fixture, env, 1, FINANCE_CAPACITY_ROLE))[0]!;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      const body = init?.body ? JSON.parse(String(init.body)) as { operation?: string } : {};
      if (url.hostname.startsWith('pool-') && body.operation === 'capabilities') {
        return Response.json(capabilitiesBody());
      }
      if (url.hostname.startsWith('pool-') && body.operation === 'readiness') {
        return Response.json(readinessBody(fixture.workspaceId, capacityId, FINANCE_CAPACITY_ROLE));
      }
      return new Response('unexpected fetch', { status: 500 });
    }));

    const invitationId = await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (id,email,email_verified,name)
         VALUES ($1,$2,true,'Returning Partnerships Member')`,
        [joinerId, email],
      );
      await setTenant(client, fixture.workspaceId, fixture.adminId);
      const member = await client.query<{ id: string }>(
        `INSERT INTO members (workspace_id,user_id,role,status,reviewer_roles)
         VALUES ($1,$2,'member','inactive',ARRAY[]::text[]) RETURNING id`,
        [fixture.workspaceId, joinerId],
      );
      await client.query(
        `INSERT INTO agents
           (id,workspace_id,name,responsibility,instructions_active,status,setup_step)
         VALUES ($1,$2,'Iris','Partner Program','Former Partnerships instructions','started',NULL)`,
        [oldAgentId, fixture.workspaceId],
      );
      await client.query(
        `INSERT INTO agent_owners (workspace_id,agent_id,member_id) VALUES ($1,$2,$3)`,
        [fixture.workspaceId, oldAgentId, member.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO sessions (id,workspace_id,owner_id,agent_id,title,model_id)
         VALUES ($1,$2,$3,$4,'Former Partner Program Iris','deepseek-flash')`,
        [oldSessionId, fixture.workspaceId, joinerId, oldAgentId],
      );
      const invitation = await client.query<{ id: string }>(
        `INSERT INTO invitations
           (workspace_id,email,role,expires_at,invited_by,status,delivery_status)
         VALUES ($1,$2,'member',now()+interval '7 days',$3,'pending','not_required')
         RETURNING id`,
        [fixture.workspaceId, email, fixture.adminId],
      );
      const id = invitation.rows[0]!.id;
      await client.query(
        `INSERT INTO member_provisioning_operations
           (workspace_id,invitation_id,requested_by,role_template_key,role_template_version,preparation)
         VALUES ($1,$2,$3,'finance-agent','1.0.0','ready')`,
        [fixture.workspaceId, id, fixture.adminId],
      );
      const reserved = await reserveCapacityForInvitation(
        env, client as never, fixture.workspaceId, id, FINANCE_CAPACITY_ROLE,
      );
      expect(reserved?.id).toBe(capacityId);
      await client.query('COMMIT');
      return id;
    });

    const accepted = await asUser(env, joinerId, `/invitations/${invitationId}/accept`, {
      method: 'POST', body: {},
    });
    expect(accepted.status).toBe(409);
    await expect(accepted.json()).resolves.toMatchObject({
      reason: 'member_agent_assignment_conflict',
    });

    const after = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const member = (await client.query<{ status: string; reviewer_roles: string[] }>(
        `SELECT status,reviewer_roles FROM members WHERE workspace_id=$1 AND user_id=$2`,
        [fixture.workspaceId, joinerId],
      )).rows[0]!;
      const invitation = (await client.query<{ status: string; accepted_by: string | null }>(
        `SELECT status,accepted_by FROM invitations WHERE id=$1`, [invitationId],
      )).rows[0]!;
      const ownership = (await client.query<{ agent_id: string }>(
        `SELECT ao.agent_id FROM agent_owners ao JOIN members m ON m.id=ao.member_id
          WHERE ao.workspace_id=$1 AND m.user_id=$2 ORDER BY ao.created_at,ao.agent_id`,
        [fixture.workspaceId, joinerId],
      )).rows;
      const capacity = (await client.query<{
        state: string; reserved_invitation_id: string; assigned_agent_id: string | null;
      }>(
        `SELECT state,reserved_invitation_id,assigned_agent_id
           FROM hermes_cloud_capacity WHERE id=$1`, [capacityId],
      )).rows[0]!;
      const grant = (await client.query<{ consumed: boolean; revoked: boolean }>(
        `SELECT consumed_at IS NOT NULL AS consumed,revoked_at IS NOT NULL AS revoked
           FROM runtime_discovery_grants WHERE workspace_id=$1 AND linked_capacity_id=$2`,
        [fixture.workspaceId, capacityId],
      )).rows[0]!;
      const financeArtifacts = (await client.query(
        `SELECT 1 FROM agents WHERE workspace_id=$1 AND id=$2
         UNION ALL
         SELECT 1 FROM enterprise_team_agents
          WHERE workspace_id=$1 AND (agent_id=$2 OR principal_user_id=$3)
         UNION ALL
         SELECT 1 FROM enterprise_skill_assignments
          WHERE workspace_id=$1 AND (agent_id=$2 OR agent_id=$4) AND skill_key='partner-invoice-review'
         UNION ALL
         SELECT 1 FROM agent_runtime_bindings WHERE workspace_id=$1 AND agent_id=$2
         UNION ALL
         SELECT 1 FROM events WHERE workspace_id=$1 AND invitation_id=$5
           AND kind IN ('member.joined','agent.joined')`,
        [fixture.workspaceId, capacityId, joinerId, oldAgentId, invitationId],
      )).rowCount;
      return { member, invitation, ownership, capacity, grant, financeArtifacts };
    });
    expect(after).toEqual({
      member: { status: 'inactive', reviewer_roles: [] },
      invitation: { status: 'pending', accepted_by: null },
      ownership: [{ agent_id: oldAgentId }],
      capacity: { state: 'reserved', reserved_invitation_id: invitationId, assigned_agent_id: null },
      grant: { consumed: false, revoked: false },
      financeArtifacts: 0,
    });
  });
});
