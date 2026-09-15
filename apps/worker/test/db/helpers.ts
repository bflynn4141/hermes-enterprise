// Test fixtures against the real Docker Postgres.
//
// Seeding is itself a demonstration of the rule under test: even `owner` cannot
// insert a tenant row without first setting `app.workspace_id`, because every
// tenant table is FORCEd, so the helper sets it and the insert's WITH CHECK
// accepts the row. If that stops being true, these helpers stop working, which
// is the loudest possible way to find out.
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AGENT_URL, APP_URL, OWNER_URL } from '../../scripts/db-config.mjs';

export type RoleName = 'owner' | 'app' | 'agent';

const URLS: Record<RoleName, string> = { owner: OWNER_URL, app: APP_URL, agent: AGENT_URL };

export async function client(role: RoleName): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: URLS[role] });
  await c.connect();
  return c;
}

/** Run `fn` with a connection as `role`, closing it afterwards. */
export async function withClient<T>(role: RoleName, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await client(role);
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

export async function setTenant(c: pg.Client, workspaceId: string, userId: string): Promise<void> {
  await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', workspaceId]);
  await c.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
}

export interface Fixture {
  readonly workspaceId: string;
  readonly adminId: string;
  readonly memberId: string;
  readonly sessionId: string;
  readonly agentId: string;
}

let counter = 0;

/**
 * One workspace with an Admin, a Member, an agent and a session. Committed, so
 * other connections (the `app` and `agent` roles) can see it.
 */
export async function seedWorkspace(): Promise<Fixture> {
  counter += 1;
  const workspaceId = randomUUID();
  const adminId = randomUUID();
  const memberId = randomUUID();
  const agentId = randomUUID();
  const sessionId = randomUUID();
  const slug = `ws-${counter}-${workspaceId.slice(0, 8)}`;

  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    // `users` is a platform table: no tenant key needed, and deliberately so,
    // because a user exists across workspaces.
    await c.query(
      `INSERT INTO users (id, email, email_verified, name) VALUES
         ($1, $3, true, 'Maya Chen'),
         ($2, $4, true, 'Dana Kim')`,
      [adminId, memberId, `admin-${slug}@example.test`, `member-${slug}@example.test`],
    );
    await setTenant(c, workspaceId, adminId);
    await c.query(`INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, $2, $3, $4)`, [
      workspaceId,
      `Workspace ${counter}`,
      slug,
      adminId,
    ]);
    await c.query(`INSERT INTO workspace_settings (workspace_id) VALUES ($1)`, [workspaceId]);
    await c.query(
      `INSERT INTO members (workspace_id, user_id, role, reviewer_roles) VALUES
         ($1, $2, 'admin', ARRAY['access','finance']),
         ($1, $3, 'member', ARRAY[]::text[])`,
      [workspaceId, adminId, memberId],
    );
    await c.query(`INSERT INTO agents (id, workspace_id, name, status) VALUES ($1, $2, 'Iris', 'started')`, [
      agentId,
      workspaceId,
    ]);
    await c.query(
      `INSERT INTO sessions (id, workspace_id, owner_id, title, model_id)
       VALUES ($1, $2, $3, 'Partner applications', 'deepseek-flash')`,
      [sessionId, workspaceId, adminId],
    );
    await c.query('COMMIT');
  });

  return { workspaceId, adminId, memberId, sessionId, agentId };
}

/** A pending request the agent role proposed, for decision and trigger tests. */
export async function seedPendingRequest(fx: Fixture, kind: 'application' | 'invoice' = 'application'): Promise<string> {
  const requestId = randomUUID();
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    await c.query(
      `INSERT INTO requests (id, workspace_id, kind, label, payload, session_id)
       VALUES ($1, $2, $3, 'Leah Martinez', '{"kind":"application"}'::jsonb, $4)`,
      [requestId, fx.workspaceId, kind, fx.sessionId],
    );
    await c.query('COMMIT');
  });
  return requestId;
}
