// Postgres access, and the one transaction every tenant request runs inside.
//
// Two Hyperdrive configs, because two database roles: `app` for the Worker and
// `agent` for the run engine. Query caching is disabled on both (Hyperdrive
// caches by query text and does not document whether session settings enter the
// key, and a cache that ignored `SET LOCAL app.workspace_id` would serve one
// tenant's rows to another). The Neon string behind them is the direct one,
// because Neon's own pooler does not support SET.
import type { Client, QueryResult, QueryResultRow } from 'pg';
import type { Env } from '../env.js';

// node-postgres is CommonJS and pulls in node:net and node:dns. It is imported
// lazily so that the Worker's module graph can be loaded by tooling that cannot
// transform a CommonJS dependency (the Vitest module runner, for one) without
// every route becoming untestable. The deployed bundle is unaffected: esbuild
// resolves this the same way it resolves a static import.
type PgModule = typeof import('pg');
let pgModule: PgModule | null = null;

async function pg(): Promise<PgModule> {
  if (!pgModule) {
    const imported = (await import('pg')) as PgModule & { default?: PgModule };
    pgModule = imported.default ?? imported;
  }
  return pgModule;
}

export type Role = 'app' | 'agent';

export interface TenantContext {
  readonly workspaceId: string;
  readonly userId: string;
}

export interface Tx {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>>;
}

const configFor = (env: Env, role: Role): Hyperdrive =>
  role === 'app' ? env.HYPERDRIVE_APP : env.HYPERDRIVE_AGENT;

export function connectionString(env: Env, role: Role): string {
  const hyperdrive = configFor(env, role);
  if (!hyperdrive?.connectionString) {
    throw new Error(`the ${role} Hyperdrive binding is missing a connection string`);
  }
  return hyperdrive.connectionString;
}

/** A single connection, closed by the caller. Hyperdrive pools behind it. */
export async function connect(env: Env, role: Role): Promise<Client> {
  const { Client: PgClient } = await pg();
  const client = new PgClient({ connectionString: connectionString(env, role) });
  await client.connect();
  return client;
}

export class TenancyError extends Error {
  constructor(
    message: string,
    readonly reason: 'not_a_member' | 'no_workspace' | 'bad_workspace_id',
  ) {
    super(message);
    this.name = 'TenancyError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Run `fn` inside one transaction with the tenant settings applied.
 *
 * The order is the whole point. `SET LOCAL` first, then the membership lookup,
 * which is itself filtered by the policy that `SET LOCAL` just established. So
 * the check that the caller belongs to this workspace runs *under* the
 * isolation it is checking, and there is no window where a query runs with the
 * wrong tenant key or with none.
 *
 * `workspaceId` must come from the URL path and `userId` from the verified
 * session. Never from a header or a query parameter: row-level security is only
 * as good as the value it keys on, and if the client could choose that value,
 * the policy would protect nothing.
 */
export async function withTenantTransaction<T>(
  env: Env,
  role: Role,
  ctx: TenantContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!UUID.test(ctx.workspaceId)) {
    throw new TenancyError(`workspace id is not a uuid: ${ctx.workspaceId}`, 'bad_workspace_id');
  }
  if (!UUID.test(ctx.userId)) {
    throw new TenancyError('user id is not a uuid', 'bad_workspace_id');
  }

  const client = await connect(env, role);
  try {
    await client.query('BEGIN');
    try {
      // set_config(..., true) is SET LOCAL with a bindable value, so the ids
      // are parameters rather than string-interpolated SQL.
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', ctx.workspaceId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', ctx.userId]);

      const membership = await client.query<{ role: string }>(
        `SELECT role FROM members
          WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
        [ctx.workspaceId, ctx.userId],
      );
      if (membership.rowCount === 0) {
        // Rolled back below. The caller gets 404, not 403: whether a workspace
        // exists is itself information a non-member should not have.
        throw new TenancyError('not a member of this workspace', 'not_a_member');
      }

      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

/** The caller's role in the workspace, read inside the tenant transaction. */
export async function memberRole(tx: Tx, workspaceId: string, userId: string): Promise<string | null> {
  const { rows } = await tx.query<{ role: string }>(
    `SELECT role FROM members WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
    [workspaceId, userId],
  );
  return rows[0]?.role ?? null;
}
