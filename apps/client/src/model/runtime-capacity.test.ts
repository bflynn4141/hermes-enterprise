import { describe, expect, it } from 'vitest';
import { createAuth } from './auth.js';
import { createRest, RestError } from './rest.js';
import {
  hermesCapacityInputSchema,
  runtimeDiscoveryGrantCreatedSchema,
  runtimeDiscoveryGrantPageSchema,
  runtimeGrantStatusLabel,
} from './runtime-capacity.js';
import { runtimeCapacityErrorMessage } from '../app/views/RuntimeCapacity.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const GRANT = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const CAPACITY = '44444444-4444-4444-8444-444444444444';
const CREATED = '2026-09-19T20:00:00.000Z';
const EXPIRES = '2026-09-20T20:00:00.000Z';
const BEARER = 'a'.repeat(64);

const grant = {
  id: GRANT,
  preflight_agent_id: AGENT,
  role_template_key: 'finance-agent' as const,
  role_template_version: '1.0.0' as const,
  skill_key: 'partner-invoice-review' as const,
  skill_version: '1.0.1' as const,
  role: 'Finance',
  assignment_revision: null,
  grant_revision: 1,
  linked_capacity_id: null,
  capacity_state: null,
  status: 'prepared' as const,
  expires_at: EXPIRES,
  created_at: CREATED,
};

describe('runtime capacity contracts', () => {
  it('accepts the exact discovery grant response and one-time bearer shape', () => {
    expect(runtimeDiscoveryGrantPageSchema.parse({ grants: [grant] }).grants[0]?.status).toBe('prepared');
    expect(runtimeDiscoveryGrantCreatedSchema.parse({
      id: GRANT,
      preflight_agent_id: AGENT,
      role_template_key: 'finance-agent',
      role_template_version: '1.0.0',
      bearer: BEARER,
      status: 'prepared',
      expires_at: EXPIRES,
      created_at: CREATED,
    }).bearer).toBe(BEARER);
    expect(() => runtimeDiscoveryGrantCreatedSchema.parse({
      id: GRANT,
      preflight_agent_id: AGENT,
      role_template_key: 'finance-agent',
      role_template_version: '1.0.0',
      bearer: 'visible-but-not-a-runtime-bearer',
      status: 'prepared',
      expires_at: EXPIRES,
      created_at: CREATED,
    })).toThrow();
  });

  it('matches the server clean-HTTPS and secret constraints before submission', () => {
    const base = {
      cloud_agent_id: 'cloud-agent-1',
      instance_name: 'Partnerships pool 1',
      connector_url: 'https://connector.example.test/plugin',
      control_secret: 'control-secret-at-least-24-chars',
      preflight_agent_id: AGENT,
      discovery_grant_id: GRANT,
    };
    expect(hermesCapacityInputSchema.safeParse(base).success).toBe(true);
    expect(hermesCapacityInputSchema.safeParse({ ...base, connector_url: 'http://connector.example.test' }).success).toBe(false);
    expect(hermesCapacityInputSchema.safeParse({ ...base, connector_url: 'https://user:pass@connector.example.test' }).success).toBe(false);
    expect(hermesCapacityInputSchema.safeParse({ ...base, connector_url: 'https://connector.example.test?secret=1' }).success).toBe(false);
    expect(hermesCapacityInputSchema.safeParse({ ...base, control_secret: 'too-short' }).success).toBe(false);
  });

  it('uses stable operator labels for every grant lifecycle state', () => {
    expect(runtimeGrantStatusLabel({ status: 'prepared', capacity_state: null })).toBe('Prepared');
    expect(runtimeGrantStatusLabel({ status: 'linked', capacity_state: 'available' })).toBe('Verified and available');
    expect(runtimeGrantStatusLabel({ status: 'linked', capacity_state: 'reserved' })).toBe('Reserved');
    expect(runtimeGrantStatusLabel({ status: 'linked', capacity_state: 'quarantined' })).toBe('Quarantined');
    expect(runtimeGrantStatusLabel({ status: 'consumed', capacity_state: 'assigned' })).toBe('Assigned');
    expect(runtimeGrantStatusLabel({ status: 'revoked', capacity_state: null })).toBe('Revoked');
    expect(runtimeGrantStatusLabel({ status: 'expired', capacity_state: null })).toBe('Expired');
  });

  it('never includes an untrusted server error or secret in operator copy', () => {
    const error = new RestError(409, 'capacity_not_ready', 'control-secret private@example.test', null, 'trace-safe');
    const copy = runtimeCapacityErrorMessage(error, 'register');
    expect(copy).toContain('did not prove');
    expect(copy).toContain('trace-safe');
    expect(copy).not.toContain('control-secret');
    expect(copy).not.toContain('private@example.test');
  });

  it('calls the Admin routes with credentials and CSRF policy through the shared REST seam', async () => {
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://hermes.test').pathname;
      calls.push({ path, init });
      if (init.method === 'GET') return Response.json({ grants: [grant] });
      if (init.method === 'DELETE') return Response.json({ id: GRANT, status: 'revoked' });
      if (path.endsWith('/runtime-discovery-grants')) return Response.json({
        id: GRANT,
        preflight_agent_id: AGENT,
        role_template_key: 'finance-agent',
        role_template_version: '1.0.0',
        bearer: BEARER,
        status: 'prepared',
        expires_at: EXPIRES,
        created_at: CREATED,
      }, { status: 201 });
      return Response.json({
        id: CAPACITY,
        cloud_agent_id: 'cloud-agent-1',
        instance_name: 'Partnerships pool 1',
        preflight_agent_id: AGENT,
        state: 'available',
        plugin_version: '1.0.0',
        agentcash_enabled: true,
        agentcash_wallet_present: true,
        native_cron_disabled: true,
        verified_at: CREATED,
        discovery_grant_id: GRANT,
        role_template_key: 'finance-agent',
        role_template_version: '1.0.0',
      }, { status: 201 });
    }) as typeof fetch;
    const rest = createRest({ auth: createAuth('fake'), fetchImpl });

    await rest.runtimeDiscoveryGrants(WORKSPACE);
    await rest.createRuntimeDiscoveryGrant(WORKSPACE, {
      preflight_agent_id: AGENT,
      role_template_key: 'finance-agent',
    });
    await rest.revokeRuntimeDiscoveryGrant(WORKSPACE, GRANT);
    await rest.registerHermesCapacity(WORKSPACE, {
      cloud_agent_id: 'cloud-agent-1',
      instance_name: 'Partnerships pool 1',
      connector_url: 'https://connector.example.test/plugin',
      control_secret: 'control-secret-at-least-24-chars',
      preflight_agent_id: AGENT,
      discovery_grant_id: GRANT,
    });

    expect(calls.map((call) => `${call.init.method} ${call.path}`)).toEqual([
      `GET /w/${WORKSPACE}/admin/runtime-discovery-grants`,
      `POST /w/${WORKSPACE}/admin/runtime-discovery-grants`,
      `DELETE /w/${WORKSPACE}/admin/runtime-discovery-grants/${GRANT}`,
      `POST /w/${WORKSPACE}/admin/hermes-capacity`,
    ]);
    for (const call of calls) expect(call.init.credentials).toBe('include');
    for (const call of calls.slice(1)) {
      expect(new Headers(call.init.headers).has('X-CSRF-Token')).toBe(true);
    }
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      preflight_agent_id: AGENT,
      role_template_key: 'finance-agent',
    });
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({
      cloud_agent_id: 'cloud-agent-1',
      instance_name: 'Partnerships pool 1',
      connector_url: 'https://connector.example.test/plugin',
      control_secret: 'control-secret-at-least-24-chars',
      preflight_agent_id: AGENT,
      discovery_grant_id: GRANT,
    });
  });

  it('does not retry credential creation after an ambiguous server failure', async () => {
    let calls = 0;
    const rest = createRest({
      auth: createAuth('fake'),
      fetchImpl: (async () => {
        calls += 1;
        return Response.json({ error: 'try later', reason: 'unavailable' }, { status: 503 });
      }) as typeof fetch,
      sleep: async () => undefined,
    });
    await expect(rest.createRuntimeDiscoveryGrant(WORKSPACE, {
      preflight_agent_id: AGENT,
      role_template_key: 'finance-agent',
    })).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(1);
  });
});
