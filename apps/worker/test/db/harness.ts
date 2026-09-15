// One place that knows how to call the real Worker against the real database.
//
// The `db` project runs in Node because node-postgres needs `node:net`, which
// the Workers pool cannot hand to workerd (docs/DECISIONS.md, decision 8). What
// runs here is the identical Hono app with an `Env` whose Hyperdrive bindings
// carry the same connection strings, so the SQL, the transaction and every
// authorization check are the real ones.
import worker from '../../src/index.js';
import { PROVIDERS } from '@hermes/shared';
import type { Env } from '../../src/env.js';
import { APP_URL, AGENT_URL } from '../../scripts/db-config.mjs';
import type { WorkOSPort } from '../../src/auth/workos.js';
import { setWorkOSPortForTests } from '../../src/auth/workos.js';
import { setJwksFetcherForTests } from '../../src/auth/jwks.js';
import { FakeWorkOS, signingKeys } from '../stubs/fake-workos.js';

export const ALLOWED_ORIGIN = 'http://localhost:8787';

/**
 * The hubs are Durable Objects, which Node has no runtime for. Every binding is
 * recorded rather than run, so a test can assert that a publish or an eviction
 * was asked for; what the hub does with it is the unit project's subject.
 */
export interface HubCall {
  readonly namespace: 'session' | 'workspace';
  readonly name: string;
  readonly method: string;
  readonly argument: unknown;
}

export function makeEnv(overrides: Partial<Env> = {}): { env: Env; hubCalls: HubCall[] } {
  const hubCalls: HubCall[] = [];
  const namespace = (kind: 'session' | 'workspace'): unknown => ({
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      publish: (events: unknown) => {
        hubCalls.push({ namespace: kind, name: id.name, method: 'publish', argument: events });
        return { delivered: 0, lastId: null };
      },
      evict: (userId: string) => {
        hubCalls.push({ namespace: kind, name: id.name, method: 'evict', argument: userId });
        return 0;
      },
      // A real upgrade answers 101, which Node's `Response` refuses to
      // construct. The stub answers 200 with a marker instead, so a test can
      // still assert that the Worker authorised the socket and handed it on.
      fetch: (request: Request) => {
        hubCalls.push({ namespace: kind, name: id.name, method: 'fetch', argument: request.headers.get('x-hermes-attachment') });
        return new Response(null, { status: 200, headers: { 'x-hermes-upgraded': '1' } });
      },
    }),
  });

  const env = {
    ENVIRONMENT: 'test',
    ENGINE_VERSION: '1',
    AUTH_MODE: 'fake',
    MODEL_GATEWAY_MODE: 'off',
    ENGINE_PAUSED: '0',
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    // Every provider, on purpose. A deployment offers OpenRouter alone
    // (decision R12) and `wrangler.jsonc` says so in all three environments,
    // but most tests in this project are about key state, catalog policy or
    // the turns route rather than about that rule — and narrowing the default
    // here would make them all assert the new rule by accident instead of the
    // thing they were written for. The tests that *are* about it pass
    // `ALLOWED_PROVIDERS: 'openrouter'` explicitly.
    ALLOWED_PROVIDERS: PROVIDERS.filter((provider) => provider !== 'nous_portal').join(','),
    HUB_TICKET_SECRET: 'db-test-secret',
    HYPERDRIVE_APP: { connectionString: APP_URL },
    HYPERDRIVE_AGENT: { connectionString: AGENT_URL },
    SESSION_HUB: namespace('session'),
    WORKSPACE_HUB: namespace('workspace'),
    ...overrides,
  } as unknown as Env;

  return { env, hubCalls };
}

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  origin?: string | null;
}

export function call(env: Env, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  if (options.origin !== null) headers.set('origin', options.origin ?? ALLOWED_ORIGIN);
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  const request = new Request(`${ALLOWED_ORIGIN}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return Promise.resolve(worker.fetch(request, env, ctx));
}

/** Call as a seeded user, the way `AUTH_MODE=fake` expects. */
export const asUser = (env: Env, userId: string, path: string, options: CallOptions = {}): Promise<Response> =>
  call(env, path, { ...options, headers: { 'x-dev-user': userId, ...(options.headers ?? {}) } });

/**
 * Point the Worker at an in-process WorkOS for the length of one test file.
 * The JWKS fetcher is redirected too, so the production verifier checks a real
 * signature against a key this process holds.
 */
export async function useFakeWorkOS(fake: FakeWorkOS = new FakeWorkOS()): Promise<FakeWorkOS> {
  const keys = await signingKeys();
  setJwksFetcherForTests(() => Promise.resolve(keys.jwks));
  setWorkOSPortForTests(() => fake as WorkOSPort);
  return fake;
}

export function clearFakeWorkOS(): void {
  setWorkOSPortForTests(null);
  setJwksFetcherForTests(null);
}

/** The env a WorkOS-mode test needs: real mode, credentials present. */
export const workosEnv = (overrides: Partial<Env> = {}): { env: Env; hubCalls: HubCall[] } =>
  makeEnv({
    AUTH_MODE: 'workos',
    WORKOS_API_KEY: 'sk_test',
    WORKOS_CLIENT_ID: 'client_test',
    WORKOS_COOKIE_PASSWORD: 'a'.repeat(32),
    ...overrides,
  } as Partial<Env>);

/**
 * Read rows as a tenant would.
 *
 * `SET LOCAL` needs a transaction: outside one Postgres accepts the call and
 * discards it, so a test that forgot the BEGIN would silently read zero rows
 * and look like a missing write. This is the one place that remembers.
 */
export async function readTenant<T>(
  workspaceId: string,
  userId: string,
  fn: (c: import('pg').Client) => Promise<T>,
): Promise<T> {
  const { withClient, setTenant } = await import('./helpers.js');
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    try {
      await setTenant(c, workspaceId, userId);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });
}
