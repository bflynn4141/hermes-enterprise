// `/health`, and the two checks M5a added to it.
//
// The workerd project already asserts the shape of the response; this file
// asserts the things that need a real Postgres and a real JWKS verifier: the
// connection metric reads `pg_stat_activity` and reports its denominator, and
// the WorkOS check appears only in `AUTH_MODE=workos` — because in fake mode
// there is no JWKS and a check that failed there would make every local
// `/health` red for no reason.
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { CONNECTION_ALARM, CONNECTION_CEILING, readConnectionMetric } from '../../src/ops/connections.js';
import { setJwksFetcherForTests } from '../../src/auth/jwks.js';
import { signingKeys } from '../stubs/fake-workos.js';
import { call, makeEnv, workosEnv } from './harness.js';

interface HealthBody {
  status: string;
  version: string;
  checks: { name: string; ok: boolean; detail: string; duration_ms: number }[];
}

afterEach(() => setJwksFetcherForTests(null));

describe('GET /health', () => {
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
    // "152" means nothing and "152 of 209" means the afternoon is about to go
    // badly, so the check carries both numbers and the threshold.
    expect(connections?.detail).toMatch(/\d+ of 209 connections/);
    expect(connections?.detail).toContain('alarm at 150');
    expect(connections?.detail).toContain('idle in transaction');
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
  });

  it('checks the WorkOS JWKS in workos mode, and counts the signing keys', async () => {
    const keys = await signingKeys();
    setJwksFetcherForTests(() => Promise.resolve(keys.jwks));
    const { env } = workosEnv();
    const body = (await (await call(env, '/health')).json()) as HealthBody;

    const jwks = body.checks.find((check) => check.name === 'workos:jwks');
    expect(jwks).toBeDefined();
    expect(jwks?.ok).toBe(true);
    expect(jwks?.detail).toContain('signing keys');
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
    expect(body.checks.find((check) => check.name === 'workos:jwks')?.detail).toContain('no signing keys');
  });

  it('names the environment in the version, so a smoke test can tell them apart', async () => {
    const { env } = makeEnv({ ENVIRONMENT: 'staging' } as Partial<Env>);
    const body = (await (await call(env, '/health')).json()) as HealthBody;
    expect(body.version).toContain('staging');
  });
});
