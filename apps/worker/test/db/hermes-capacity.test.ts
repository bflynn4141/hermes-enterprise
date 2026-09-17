import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { POOL_CONTROL_NAMESPACE } from '../../src/hermes-cloud/capacity.js';
import { sealSecret } from '../../src/keys/envelope.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../../src/auth/cookies.js';
import { FakeWorkOS, seal, signAccessToken } from '../stubs/fake-workos.js';
import {
  asUser, call, clearFakeWorkOS, makeEnv, readTenant, useFakeWorkOS, workosEnv,
} from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const KEK_V1 = Buffer.alloc(32, 29).toString('base64');

function hermesEnv(overrides: Partial<Env> = {}): Env {
  return makeEnv({ AGENT_RUNTIME: 'hermes', KEK_V1, ...overrides }).env;
}

async function seedCapacity(fixture: Fixture, env: Env, count = 1): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  const envelopes = await Promise.all(ids.map((id) => sealSecret(
    env,
    { workspaceId: fixture.workspaceId, keyId: id, namespace: POOL_CONTROL_NAMESPACE },
    `pool-control-${id}-long-enough`,
  )));
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fixture.workspaceId, fixture.adminId);
    for (const [index, id] of ids.entries()) {
      const envelope = envelopes[index]!;
      await client.query(
        `INSERT INTO hermes_cloud_capacity
           (id, workspace_id, cloud_agent_id, instance_name, connector_url,
            ciphertext, iv, wrapped_dek, wrap_iv, kek_version, plugin_version,
            agentcash_enabled, agentcash_wallet_present, native_cron_disabled,
            readiness_checked_at, last_health_checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'1.4.0',true,true,true,now(),now())`,
        [id, fixture.workspaceId, `cloud-${id}`, `pool-${id.slice(0, 8)}`,
         `https://pool-${id}.example.test/api/plugins/enterprise_bridge/control`,
         Buffer.from(envelope.ciphertext), Buffer.from(envelope.iv), Buffer.from(envelope.wrappedDek),
         Buffer.from(envelope.wrapIv), envelope.kekVersion],
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

  it('fails capacity exhaustion before committing or delivering an invitation', async () => {
    const fixture = await seedWorkspace();
    const organizationId = `org_${randomUUID().slice(0, 12)}`;
    await withClient('owner', (client) => client.query(
      `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1,$2)
       ON CONFLICT (workspace_id) DO UPDATE SET workos_organization_id=EXCLUDED.workos_organization_id`,
      [fixture.workspaceId, organizationId],
    ));
    const env = workosEnv({ AGENT_RUNTIME: 'hermes', KEK_V1 }).env;
    const email = `exhausted-${randomUUID()}@example.test`;

    const response = await asWorkOSAdmin(
      fixture, env, `/w/${fixture.workspaceId}/invitations`, { email },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: 'iris_capacity_unavailable' });
    expect(fake.calls.filter((call) => call.method.includes('Invitation'))).toHaveLength(0);

    const state = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const invitations = await client.query(`SELECT id FROM invitations WHERE workspace_id=$1 AND email=$2`, [fixture.workspaceId, email]);
      const sync = await client.query(`SELECT id FROM workos_sync WHERE workspace_id=$1 AND resource_type='invitation'`, [fixture.workspaceId]);
      const jobs = await client.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND kind='workos_sync'`, [fixture.workspaceId]);
      return { invitations: invitations.rowCount, sync: sync.rowCount, jobs: jobs.rowCount };
    });
    expect(state).toEqual({ invitations: 0, sync: 0, jobs: 0 });
  });

  it('delivers through WorkOS only after the exact invitation has reserved capacity', async () => {
    const fixture = await seedWorkspace();
    const organizationId = `org_${randomUUID().slice(0, 12)}`;
    await withClient('owner', (client) => client.query(
      `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1,$2)
       ON CONFLICT (workspace_id) DO UPDATE SET workos_organization_id=EXCLUDED.workos_organization_id`,
      [fixture.workspaceId, organizationId],
    ));
    const env = workosEnv({ AGENT_RUNTIME: 'hermes', KEK_V1 }).env;
    const [capacityId] = await seedCapacity(fixture, env);
    const email = `deliverable-${randomUUID()}@example.test`;

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
    const connectorUrl = `https://register-${randomUUID()}.example.test/control`;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/oauth/token') return Response.json({ access_token: 'registration-token-that-is-long-enough' });
      const body = init?.body ? JSON.parse(String(init.body)) as { id?: number; method?: string; operation?: string; params?: { arguments?: { agent_id?: string } } } : {};
      if (url.pathname === '/mcp') {
        if (body.method === 'notifications/initialized') return new Response(null, { status: 204 });
        if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
        return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({
          agent: { id: body.params?.arguments?.agent_id, name: 'Registered pool Iris', status: 'RUNNING', health: 'HEALTHY', dashboardUrl: 'https://cloud.example.test/registered' },
        }) }] } });
      }
      if (url.hostname.startsWith('register-')) {
        if (body.operation === 'capabilities') return Response.json({
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
        });
        if (body.operation === 'readiness') return Response.json({
          object: 'hermes.enterprise_bridge.readiness', version: '1.5.0',
          workspace_id: fixture.workspaceId, agent_id: fixture.agentId, enterprise_url: 'https://enterprise.example.test',
          agentcash_enabled: true, agentcash_wallet_present: true, native_cron_disabled: true,
        });
      }
      return new Response('unexpected fetch', { status: 500 });
    });
    const env = hermesEnv({
      HERMES_CLOUD_CLIENT_ID: 'cloud-client', HERMES_CLOUD_CLIENT_SECRET: 'cloud-secret',
      HERMES_CLOUD_TOKEN_URL: 'https://cloud.example.test/oauth/token', HERMES_CLOUD_MCP_URL: 'https://cloud.example.test/mcp',
    });
    const input = {
      cloud_agent_id: cloudAgentId, instance_name: `pool-${randomUUID().slice(0, 8)}`,
      connector_url: connectorUrl, control_secret: 'registered-control-secret-longer-than-24',
      preflight_agent_id: fixture.agentId,
    };
    const refused = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/admin/hermes-capacity`, {
      method: 'POST', body: input,
    });
    expect(refused.status).toBe(403);

    const registered = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/admin/hermes-capacity`, {
      method: 'POST', body: input,
    });
    expect(registered.status).toBe(201);
    const response = await registered.json() as Record<string, unknown>;
    expect(response).toMatchObject({
      cloud_agent_id: cloudAgentId, state: 'available', plugin_version: '1.5.0',
      agentcash_enabled: true, agentcash_wallet_present: true, native_cron_disabled: true,
    });
    expect(JSON.stringify(response)).not.toContain(input.control_secret);
  });

  it('assigns one reserved instance, verifies it, and makes Iris runnable after onboarding', async () => {
    const fixture = await seedWorkspace();
    const joinerId = randomUUID();
    const email = `ready-${randomUUID()}@example.test`;
    let assignedAgentId = '';
    let assignedWorkspaceId = '';
    let assignedControlSecret = '';
    const managementActions: string[] = [];
    const runtimeOperations: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
      if (url.pathname === '/oauth/token') {
        return Response.json({ access_token: 'cloud-test-access-token-that-is-long-enough' });
      }
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (url.pathname === '/mcp') {
        if (body.method === 'notifications/initialized') return new Response(null, { status: 204 });
        if (body.method === 'initialize') {
          return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } });
        }
        const params = body.params as { arguments?: { action?: string; agent_id?: string; env?: Record<string, string> } };
        const action = params.arguments?.action ?? '';
        managementActions.push(action);
        if (action === 'update') {
          assignedAgentId = params.arguments?.env?.ENTERPRISE_AGENT_ID ?? '';
          assignedWorkspaceId = params.arguments?.env?.ENTERPRISE_WORKSPACE_ID ?? '';
          assignedControlSecret = params.arguments?.env?.HERMES_ENTERPRISE_CONTROL_SECRET ?? '';
          expect(params.arguments?.env).toMatchObject({
            HERMES_NATIVE_CRON_ENABLED: '0',
            HERMES_AGENTCASH_MCP_ENABLED: '1',
            AGENTCASH_HOME: '/opt/data/agentcash',
          });
        }
        return Response.json({
          jsonrpc: '2.0', id: body.id,
          result: { content: [{ type: 'text', text: JSON.stringify({
            agent: { id: params.arguments?.agent_id, name: 'Ready pool Iris', status: 'RUNNING', health: 'HEALTHY', dashboardUrl: 'https://cloud.example.test/agents/ready' },
          }) }] },
        });
      }
      if (url.hostname.startsWith('pool-') && url.hostname.endsWith('.example.test')) {
        const operation = typeof body.operation === 'string' ? body.operation : '';
        runtimeOperations.push(operation);
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${assignedControlSecret}`);
        if (operation === 'capabilities') return Response.json({
          object: 'hermes.api_server.capabilities', platform: 'hermes-agent',
          auth: { type: 'bearer', required: true },
          runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
          features: {
            run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_steer: true,
            runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 },
          },
          endpoints: {
            runs: { method: 'POST', path: '/v1/runs' },
            run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
            run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
            run_steer: { method: 'POST', path: '/v1/runs/{run_id}/steer' },
            run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
          },
        });
        if (operation === 'readiness') return Response.json({
          object: 'hermes.enterprise_bridge.readiness', version: '1.5.0',
          workspace_id: assignedWorkspaceId, agent_id: assignedAgentId,
          enterprise_url: 'https://enterprise.example.test',
          agentcash_enabled: true, agentcash_wallet_present: true, native_cron_disabled: true,
        });
      }
      return new Response('unexpected fetch', { status: 500 });
    });

    const env = hermesEnv({
      HERMES_BRIDGE_SECRET: 'bridge-secret-longer-than-thirty-two-characters',
      HERMES_ENTERPRISE_PUBLIC_URL: 'https://enterprise.example.test',
      HERMES_CLOUD_CLIENT_ID: 'cloud-client',
      HERMES_CLOUD_CLIENT_SECRET: 'cloud-secret',
      HERMES_CLOUD_TOKEN_URL: 'https://cloud.example.test/oauth/token',
      HERMES_CLOUD_MCP_URL: 'https://cloud.example.test/mcp',
    });
    const [capacityId] = await seedCapacity(fixture, env);
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
    expect(managementActions).toEqual(['update', 'restart']);
    expect(runtimeOperations.sort()).toEqual(['capabilities', 'readiness']);

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
      const binding = await client.query<{ ready: boolean }>(
        `SELECT ready_at IS NOT NULL AS ready FROM agent_runtime_bindings WHERE agent_id=$1`, [agentId],
      );
      const provisioning = await client.query<{ status: string }>(
        `SELECT status FROM agent_provisioning WHERE agent_id=$1`, [agentId],
      );
      return { ownership: ownership.rows[0]!, capacity: capacity.rows[0]!, binding: binding.rows[0]!, provisioning: provisioning.rows[0]! };
    });
    expect(afterAssignment.capacity).toEqual({ state: 'assigned', assigned_agent_id: afterAssignment.ownership.agent_id, wallet: true });
    expect(afterAssignment.binding).toEqual({ ready: true });
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
});
