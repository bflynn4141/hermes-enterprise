// The Worker, in workerd, through the same wrangler.jsonc a deploy reads.
//
// This is the test that would catch a binding that exists in the config but not
// in the code, or a route that only works because Node happens to have a global
// the Workers runtime does not.
import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('the Worker in workerd', () => {
  it('declares every binding the code expects', () => {
    expect(env.SESSION_HUB).toBeDefined();
    expect(env.WORKSPACE_HUB).toBeDefined();
    expect(env.RUN_ATTEMPT).toBeDefined();
    expect(env.EXTRACT_QUEUE).toBeDefined();
    expect(env.RENDERS_QUEUE).toBeDefined();
    expect(env.HYPERDRIVE_APP).toBeDefined();
    expect(env.HYPERDRIVE_AGENT).toBeDefined();
    expect(env.AUTH_MODE).toBe('fake');
  });

  it('answers /health with a check per dependency', async () => {
    const response = await SELF.fetch('https://hermes.test/health');
    const body = (await response.json()) as {
      status: string;
      checks: { name: string; ok: boolean; detail: string }[];
    };
    // `postgres:connections` is the M5a addition: two Hyperdrive configs of
    // about 100 connections each against a 209-connection origin is arithmetic
    // that only works while neither is near its ceiling, and this is the number
    // that says whether that is still true. `auth:config` is present in every
    // environment and proves fake auth is limited to development;
    // `workos:jwks` appears only in AUTH_MODE=workos.
    const expectedChecks = [
      'auth:config',
      'hub:workspace',
      'postgres:agent',
      'postgres:app',
      'postgres:connections',
    ];
    // A local checkout may opt into the official Hermes profile through its
    // untracked .dev.vars. In that mode health must expose the native Runs
    // capability gate as a separate dependency; the default CI fixture stays
    // on the legacy runtime and correctly omits it.
    if (env.AGENT_RUNTIME === 'hermes') expectedChecks.push('hermes:runs');
    expect(body.checks.map((c) => c.name).sort()).toEqual(expectedChecks.sort());
    // The hub round trip must succeed even when Postgres is unreachable: it is
    // a different dependency, and /health exists to tell them apart.
    expect(body.checks.find((c) => c.name === 'hub:workspace')?.ok).toBe(true);
    expect(body.checks.find((c) => c.name === 'auth:config')?.ok).toBe(true);
  });

  it('refuses a tenant route without a session, and says why', async () => {
    const response = await SELF.fetch('https://hermes.test/w/00000000-0000-4000-8000-000000000001/bootstrap');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'no_session' });
  });

  it('has an assets binding holding the client shell', async () => {
    // The SPA fallback itself is applied by the platform in front of the
    // Worker, not by the Worker, so the pool does not exercise it; what this
    // test can prove is that the binding exists and serves the shell. The
    // fallback configuration is checked by the wrangler dry run in CI.
    const response = await env.ASSETS.fetch('https://hermes.test/index.html');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Hermes Teams Demo');
  });

  it('answers an unknown API path with JSON, not the shell', async () => {
    const response = await SELF.fetch('https://hermes.test/api/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'unknown_route' });
  });
});
