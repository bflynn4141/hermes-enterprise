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
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { connect, type Role } from '../db/client.js';
import type { Health } from '@hermes/shared';

const WORKER_VERSION = '0.1.0';

async function timed(name: string, fn: () => Promise<string>): Promise<Health['checks'][number]> {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, detail, duration_ms: Date.now() - started };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
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
    return `connected as ${row.role}, ${row.models} catalog rows readable`;
  } finally {
    await client.end();
  }
}

async function checkHub(env: Env): Promise<string> {
  const id = env.WORKSPACE_HUB.idFromName('health');
  const stub = env.WORKSPACE_HUB.get(id);
  const result = await stub.ping();
  return `workspace hub answered with ${result.sockets} sockets`;
}

export async function health(c: Context<{ Bindings: Env }>): Promise<Response> {
  const checks = await Promise.all([
    timed('postgres:app', () => checkPostgres(c.env, 'app')),
    timed('postgres:agent', () => checkPostgres(c.env, 'agent')),
    timed('hub:workspace', () => checkHub(c.env)),
  ]);

  const body: Health = {
    status: checks.every((check) => check.ok) ? 'ok' : 'degraded',
    version: `${WORKER_VERSION}+${c.env.ENVIRONMENT ?? 'unknown'}`,
    checks,
  };
  return c.json(body, body.status === 'ok' ? 200 : 503);
}
