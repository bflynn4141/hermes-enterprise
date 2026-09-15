// GET /health
//
// Checks the things whose failure the product cannot work around: Postgres
// through *both* Hyperdrive configs (they are separate configs with separate
// roles, so one can be healthy while the other is not) and a Durable Object
// round trip. Provider health is deliberately absent: it is per workspace and
// per key, and it lives on the key row as the last re-verify result.
//
// The route reports `degraded` rather than failing outright when a check fails,
// so a load balancer sees the difference between "the Worker is down" and "the
// database is unreachable", and the body says which.
//
// Two properties this route has to keep, because it is the one route in the
// Worker that answers an unauthenticated caller:
//
//   1. **`detail` is an enum, never an upstream's own words.** It used to be
//      `error.message`, which meant anyone on the internet could read
//      `getaddrinfo ENOTFOUND ep-....neon.tech`, `connect ECONNREFUSED
//      <host>:5432` or `password authentication failed for user "app"` — our
//      database's hostname, port and role names, handed out by the endpoint
//      whose whole job is to be polled constantly. The operator still gets the
//      real text: it goes to `console.error`, which is where an operator is
//      already looking and an attacker is not. The same reasoning trims the
//      success details, which named the role, the catalog row count, the hub's
//      socket count and the connection ceiling.
//   2. **A poll costs a cached answer, not three Postgres connections.** Each
//      check opens its own client (`connect`), so an unauthenticated request
//      loop was three origin connections per hit against a budget
//      `ops/connections.ts` documents as 209 and already alarms at 150 — a
//      denial of service with no credential, whose symptom for every tenant is
//      indistinguishable from the database being down. The answer is memoised
//      per isolate for `CACHE_MS`, which is far below any useful polling
//      interval and far above the rate needed to exhaust the origin.
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { connect, type Role } from '../db/client.js';
import type { Health } from '@hermes/shared';
import { describeConnections, readConnectionMetric } from '../ops/connections.js';
import { jwksKeyCount } from '../auth/jwks.js';

const WORKER_VERSION = '0.1.0';

/** How long one isolate reuses an answer. See property 2 in the header. */
export const CACHE_MS = 10_000;

/**
 * A failure, named without naming the upstream.
 *
 * Four buckets, because four is what an operator actually acts on differently,
 * and none of them repeats a host, a port, a role or a credential. The full
 * message is logged, not returned.
 */
function failureReason(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (/password|authentication|permission|not authori[sz]ed|role /.test(text)) return 'unauthorized';
  if (/enotfound|econnrefused|etimedout|ehostunreach|network|socket|connect/.test(text)) return 'unreachable';
  if (/missing|not set|no connection string|undefined/.test(text)) return 'misconfigured';
  return 'failed';
}

async function timed(name: string, fn: () => Promise<string>): Promise<Health['checks'][number]> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, detail, duration_ms: Date.now() - started };
  } catch (error) {
    // The operator's copy, with everything in it. The caller's copy, below,
    // gets the bucket only.
    console.error(JSON.stringify({ at: 'health.check', check: name, ok: false, error: String(error) }));
    return {
      name,
      ok: false,
      detail: failureReason(error),
      duration_ms: Date.now() - started,
    };
  }
}

async function checkPostgres(env: Env, role: Role): Promise<string> {
  const client = await connect(env, role);
  try {
    // `catalog` rather than `schema_migrations`: both roles can read it, so one
    // query proves both connections without widening the agent role's grants
    // for the sake of a health check.
    const { rows } = await client.query<{ role: string; models: string }>(
      `SELECT current_user AS role, (SELECT count(*)::text FROM catalog) AS models`,
    );
    const row = rows[0];
    if (!row) throw new Error('no row returned');
    if (row.role !== role) throw new Error(`connected as ${row.role}, expected ${role}`);
    if (row.models === '0') throw new Error('the catalog is empty');
    // The check's *name* already says which role this was, so repeating it —
    // along with the catalog's row count — only told an anonymous caller more
    // about the schema than it told the operator.
    return 'connected';
  } finally {
    await client.end();
  }
}

async function checkHub(env: Env): Promise<string> {
  const id = env.WORKSPACE_HUB.idFromName('health');
  const stub = env.WORKSPACE_HUB.get(id);
  await stub.ping();
  // Not the socket count: it is a live measure of how many people are using
  // this deployment, which is not an anonymous caller's business.
  return 'answered';
}

/**
 * The connection metric, reported as a check rather than as a failure.
 *
 * Two Hyperdrive configs of about 100 connections each against a 209-connection
 * origin is arithmetic that only works because neither is near its ceiling, and
 * this is the number that says whether that is still true. It reports `ok` at
 * any count: crossing the alarm means someone should look, not that the service
 * is down, and a health check that returned 503 at 151 connections would take
 * the product down to avoid taking it down. `detail` carries the denominator.
 */
async function checkConnections(env: Env): Promise<string> {
  const metric = await readConnectionMetric(env);
  // The count and the ceiling go to the log, where the operator reading an
  // alarm is. Published, they are a capacity map: they tell an anonymous
  // caller how many connections it takes to exhaust the origin.
  console.log(JSON.stringify({ at: 'health.connections', detail: describeConnections(metric) }));
  return metric.alarming ? 'alarming' : 'within budget';
}

/**
 * Can we still verify a WorkOS token?
 *
 * Only in `AUTH_MODE=workos`, because in fake mode there is no JWKS and a check
 * that failed there would make every local `/health` red. This is the one
 * upstream whose unavailability the product cannot work around: with no JWKS we
 * can verify nothing, so every request is a 401 and the symptom — everybody
 * signed out at once — is indistinguishable from us having broken auth.
 *
 * The fetcher caches for ten minutes, so this costs a subrequest at most once
 * per cache window however often the health route is polled.
 */
async function checkJwks(env: Env): Promise<string> {
  const keys = await jwksKeyCount(env);
  if (keys === 0) throw new Error('the JWKS document carries no signing keys');
  return 'reachable';
}

/**
 * The memoised answer, per isolate.
 *
 * A promise rather than a value, so that a burst arriving together shares one
 * round of checks instead of each starting its own — which is the case the
 * cache exists for.
 */
let cached: { at: number; key: string; body: Promise<Health> } | null = null;

/**
 * Keyed on the inputs the answer actually depends on.
 *
 * A deployed isolate only ever sees one configuration, so in production the key
 * is constant — but an unkeyed cache is a footgun rather than a cache: the
 * first test to warm it handed its answer, `version` string and all, to every
 * later caller with a different `Env`. Naming the dependency is cheaper than
 * remembering to clear it.
 */
const cacheKey = (env: Env): string => `${env.ENVIRONMENT ?? ''}|${env.AUTH_MODE ?? ''}`;

/** Tests reach for this rather than waiting out `CACHE_MS`. */
export function resetHealthCacheForTests(): void {
  cached = null;
}

async function runChecks(c: Context<{ Bindings: Env }>): Promise<Health> {
  const checks = await Promise.all([
    timed('postgres:app', () => checkPostgres(c.env, 'app')),
    timed('postgres:agent', () => checkPostgres(c.env, 'agent')),
    timed('hub:workspace', () => checkHub(c.env)),
    timed('postgres:connections', () => checkConnections(c.env)),
    ...(c.env.AUTH_MODE === 'workos' ? [timed('workos:jwks', () => checkJwks(c.env))] : []),
  ]);

  return {
    status: checks.every((check) => check.ok) ? 'ok' : 'degraded',
    version: `${WORKER_VERSION}+${c.env.ENVIRONMENT ?? 'unknown'}`,
    checks,
  };
}

export async function health(c: Context<{ Bindings: Env }>): Promise<Response> {
  const now = Date.now();
  const key = cacheKey(c.env);
  if (!cached || cached.key !== key || now - cached.at >= CACHE_MS) {
    // Replaced before it is awaited, so concurrent callers join this round.
    // A round that throws is not kept: the next caller retries rather than
    // being served a cached failure to produce an answer at all.
    const body = runChecks(c).catch((error) => {
      cached = null;
      throw error;
    });
    cached = { at: now, key, body };
  }
  const body = await cached.body;
  return c.json(body, body.status === 'ok' ? 200 : 503);
}
