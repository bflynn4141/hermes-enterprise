// `/health`, and the two checks M5a added to it.
//
// The workerd project already asserts the shape of the response; this file
// asserts the things that need a real Postgres and a real JWKS verifier: the
// connection metric reads `pg_stat_activity` and reports its denominator, and
// the WorkOS check appears only in `AUTH_MODE=workos` — because in fake mode
// there is no JWKS and a check that failed there would make every local
// `/health` red for no reason.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { CONNECTION_ALARM, CONNECTION_CEILING, readConnectionMetric } from '../../src/ops/connections.js';
import { setJwksFetcherForTests } from '../../src/auth/jwks.js';
import { signingKeys } from '../stubs/fake-workos.js';
import { resetHealthCacheForTests } from '../../src/routes/health.js';
import { call, makeEnv, workosEnv } from './harness.js';

interface HealthBody {
  status: string;
  version: string;
  checks: { name: string; ok: boolean; detail: string; duration_ms: number }[];
}

afterEach(() => {
  setJwksFetcherForTests(null);
  vi.unstubAllGlobals();
});
// The route memoises its answer per isolate for `CACHE_MS` so that an
// unauthenticated poll does not cost three Postgres connections a hit. These
// tests change the world between calls, which no real deployment does.
beforeEach(() => resetHealthCacheForTests());

describe('GET /health', () => {
  it('checks every configured Hermes profile for the durable Runs contract', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const agentId = '44444444-4444-4444-8444-444444444444';
    const upstream = vi.fn<typeof fetch>(async () => Response.json({
      object: 'hermes.api_server.capabilities', platform: 'hermes-agent',
      auth: { type: 'bearer', required: true },
      runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
      features: {
        run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_steer: true,
        runs_idempotency: { supported: true, durable: true, retention_seconds: 86_400 },
      },
      endpoints: {
        runs: { method: 'POST', path: '/v1/runs' },
        run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
        run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
        run_steer: { method: 'POST', path: '/v1/runs/{run_id}/steer' },
        run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
      },
    }));
    vi.stubGlobal('fetch', upstream);
    const { env } = makeEnv({
      AGENT_RUNTIME: 'hermes',
      HERMES_BRIDGE_SECRET: 'test-only-secret-longer-than-thirty-two-characters',
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [agentId]: { workspace_id: workspaceId, base_url: 'https://runtime.example', api_key: 'native-secret' },
      }),
    } as Partial<Env>);
    const body = (await (await call(env, '/health')).json()) as HealthBody;

    expect(body.checks.find((check) => check.name === 'hermes:runs')).toMatchObject({ ok: true, detail: 'ready' });
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('fails readiness when a Hermes profile reports in-memory run reservations', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    const agentId = '44444444-4444-4444-8444-444444444444';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
      object: 'hermes.api_server.capabilities', platform: 'hermes-agent',
      auth: { type: 'bearer', required: true },
      runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
      features: {
        run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_steer: true,
        runs_idempotency: { supported: true, durable: false, retention_seconds: 86_400 },
      },
      endpoints: {
        runs: { method: 'POST', path: '/v1/runs' },
        run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
        run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
        run_steer: { method: 'POST', path: '/v1/runs/{run_id}/steer' },
        run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
      },
    })));
    const { env } = makeEnv({
      AGENT_RUNTIME: 'hermes',
      HERMES_BRIDGE_SECRET: 'test-only-secret-longer-than-thirty-two-characters',
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [agentId]: { workspace_id: workspaceId, base_url: 'https://runtime.example', api_key: 'native-secret' },
      }),
    } as Partial<Env>);
    const response = await call(env, '/health');
    const body = (await response.json()) as HealthBody;

    expect(response.status).toBe(503);
    expect(body.checks.find((check) => check.name === 'hermes:runs')).toMatchObject({ ok: false, detail: 'failed' });
  });

  it('reports the connection count with its denominator', async () => {
    const { env } = makeEnv();
    // The Node harness has no Durable Object runtime, so `hub:workspace` fails
    // and the overall status is `degraded` — which is itself the behaviour the
    // route exists for: one dependency down is not the Worker being down, and
    // the body says which. The check under test is read by name.
    const response = await call(env, '/health');
    const body = (await response.json()) as HealthBody;

    const connections = body.checks.find((check) => check.name === 'postgres:connections');
    expect(connections).toBeDefined();
    expect(connections?.ok).toBe(true);
    // The verdict, not the arithmetic. "152 of 209, alarm at 150" is what an
    // operator needs and it goes to the log; published on an unauthenticated
    // route it is a capacity map — it tells an anonymous caller how many
    // connections it takes to exhaust the origin. See the header of
    // src/routes/health.ts.
    expect(connections?.detail).toBe('within budget');
    expect(connections?.detail).not.toMatch(/\d/);
  });

  // The regression test for the finding: `/health` is the one route that
  // answers an unauthenticated caller, and its `detail` used to be the
  // upstream's own `error.message`. That published our database's hostname,
  // port and role names (`getaddrinfo ENOTFOUND ep-....neon.tech`, `password
  // authentication failed for user "app"`) to anyone who could curl it, and
  // the deploy smoke tests `cat` the body into CI logs as well.
  it('never puts a host, a port, a role name or an upstream message in the body', async () => {
    setJwksFetcherForTests(() =>
      Promise.reject(new Error('getaddrinfo ENOTFOUND ep-secret-123.eu-central-1.aws.neon.tech:5432')),
    );
    const { env } = workosEnv();
    const body = (await (await call(env, '/health')).json()) as HealthBody;

    const failed = body.checks.filter((check) => !check.ok);
    expect(failed.length).toBeGreaterThan(0);
    for (const check of body.checks) {
      // A closed vocabulary rather than a blocklist: anything a future upstream
      // invents has to be added here deliberately, which is the review this
      // test exists to force.
      expect([
        'connected',
        'answered',
        'reachable',
        'within budget',
        'configured',
        'alarming',
        'unauthorized',
        'unreachable',
        'misconfigured',
        'failed',
      ]).toContain(check.detail);
    }
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('neon.tech');
    expect(serialised).not.toContain('5432');
    expect(serialised).not.toContain('ENOTFOUND');
  });

  it('serves a cached answer rather than three Postgres connections a hit', async () => {
    const { env } = makeEnv();
    const first = (await (await call(env, '/health')).json()) as HealthBody;
    const second = (await (await call(env, '/health')).json()) as HealthBody;
    // Identical durations prove the second call did no work: a fresh round of
    // checks cannot reproduce another round's millisecond timings.
    expect(second.checks.map((c) => c.duration_ms)).toEqual(first.checks.map((c) => c.duration_ms));
  });

  it('does not fail the service at the alarm, because 151 connections is not an outage', async () => {
    const { env } = makeEnv();
    const metric = await readConnectionMetric(env);
    expect(metric.ceiling).toBe(CONNECTION_CEILING);
    expect(metric.alarm).toBe(CONNECTION_ALARM);
    expect(metric.total).toBeGreaterThanOrEqual(0);
    // The check reports `ok` whatever the count: a health route that answered
    // 503 at 151 connections would take the product down to avoid taking it
    // down. Crossing the threshold is an alert, not a failure.
    const { env: again } = makeEnv();
    const body = (await (await call(again, '/health')).json()) as HealthBody;
    expect(body.checks.find((c) => c.name === 'postgres:connections')?.ok).toBe(true);
  });

  it('omits the WorkOS check in fake mode, where there is no JWKS to reach', async () => {
    const { env } = makeEnv();
    const body = (await (await call(env, '/health')).json()) as HealthBody;
    expect(body.checks.map((c) => c.name)).not.toContain('workos:jwks');
    expect(body.checks.find((c) => c.name === 'auth:config')?.ok).toBe(true);
  });

  it('fails readiness when a deployed environment enables fake authentication', async () => {
    const { env } = makeEnv({ ENVIRONMENT: 'production', AUTH_MODE: 'fake' } as Partial<Env>);
    const response = await call(env, '/health');
    const body = (await response.json()) as HealthBody;

    expect(response.status).toBe(503);
    expect(body.checks.find((check) => check.name === 'auth:config')).toMatchObject({
      ok: false,
      detail: 'misconfigured',
    });
  });

  it('fails readiness when deployed WorkOS auth has no explicit callback configuration', async () => {
    const keys = await signingKeys();
    setJwksFetcherForTests(() => Promise.resolve(keys.jwks));
    const { env } = workosEnv({
      ENVIRONMENT: 'production',
      ALLOWED_ORIGINS: 'https://app.hermes.test',
      WORKOS_REDIRECT_URI: undefined,
    } as Partial<Env>);
    const body = (await (await call(env, '/health')).json()) as HealthBody;

    expect(body.checks.find((check) => check.name === 'auth:config')).toMatchObject({
      ok: false,
      detail: 'misconfigured',
    });
  });

  it('checks the WorkOS JWKS in workos mode', async () => {
    const keys = await signingKeys();
    setJwksFetcherForTests(() => Promise.resolve(keys.jwks));
    const { env } = workosEnv();
    const body = (await (await call(env, '/health')).json()) as HealthBody;

    const jwks = body.checks.find((check) => check.name === 'workos:jwks');
    expect(jwks).toBeDefined();
    expect(jwks?.ok).toBe(true);
    expect(jwks?.detail).toBe('reachable');
  });

  it('degrades, rather than lying, when the JWKS cannot be reached', async () => {
    setJwksFetcherForTests(() => Promise.reject(new Error('getaddrinfo ENOTFOUND api.workos.com')));
    const { env } = workosEnv();
    const response = await call(env, '/health');
    // With no JWKS we can verify nothing, so every request is a 401 and the
    // symptom — everybody signed out at once — is indistinguishable from us
    // having broken auth. The health route is where the difference is stated.
    expect(response.status).toBe(503);
    const body = (await response.json()) as HealthBody;
    expect(body.status).toBe('degraded');
    expect(body.checks.find((check) => check.name === 'workos:jwks')?.ok).toBe(false);
  });

  it('degrades when the JWKS document is empty, which a 200 would otherwise hide', async () => {
    setJwksFetcherForTests(() => Promise.resolve({ keys: [] }));
    const { env } = workosEnv();
    const response = await call(env, '/health');
    expect(response.status).toBe(503);
    const body = (await response.json()) as HealthBody;
    // An empty JWKS is a failure, not a 200 — but the caller is told the
    // bucket, not the sentence. The sentence is in the log.
    const jwks = body.checks.find((check) => check.name === 'workos:jwks');
    expect(jwks?.ok).toBe(false);
    expect(jwks?.detail).toBe('failed');
  });

  it('names the environment in the version, so a smoke test can tell them apart', async () => {
    const { env } = makeEnv({ ENVIRONMENT: 'staging' } as Partial<Env>);
    const body = (await (await call(env, '/health')).json()) as HealthBody;
    expect(body.version).toContain('staging');
  });
});
