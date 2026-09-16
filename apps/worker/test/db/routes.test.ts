// The tenant routes, against the real database.
//
// These run in Node rather than in workerd, because node-postgres needs
// node:net and node:dns and the Vitest module runner cannot hand those to the
// Workers runtime (see docs/DECISIONS.md). What runs here is the identical Hono
// app with an Env whose Hyperdrive bindings point at the same Docker Postgres,
// so the SQL, the transaction and the authorization are the real ones; what the
// workerd project covers instead is that the Worker boots in the real runtime
// with the real bindings.
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import type { Env } from '../../src/env.js';
import { APP_URL, AGENT_URL } from '../../scripts/db-config.mjs';
import { seedWorkspace, withClient, setTenant, type Fixture } from './helpers.js';

const env = {
  ENVIRONMENT: 'test',
  ENGINE_VERSION: '1',
  AUTH_MODE: 'fake',
  MODEL_GATEWAY_MODE: 'off',
  ENGINE_PAUSED: '0',
  ALLOWED_ORIGINS: 'http://localhost:8787',
  HYPERDRIVE_APP: { connectionString: APP_URL },
  HYPERDRIVE_AGENT: { connectionString: AGENT_URL },
} as unknown as Env;

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

const call = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  Promise.resolve(worker.fetch(new Request(`https://hermes.test${path}`, { headers }), env, ctx));

async function adminEmail(fx: Fixture): Promise<string> {
  return withClient('owner', async (c) => {
    const { rows } = await c.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [fx.adminId]);
    return rows[0]!.email;
  });
}

describe('GET /w/:ws/bootstrap', () => {
  it('returns the empty workspace shape for a fresh workspace', async () => {
    const fx = await seedWorkspace();
    const response = await call(`/w/${fx.workspaceId}/bootstrap`, { 'x-dev-user': fx.adminId });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      workspace: { id: string; settings: { default_model_id: string } };
      viewer: { role: string; reviewer_roles: string[] };
      agent: { id: string; name: string };
      sessions: { id: string; agent_id: string }[];
      counts: Record<string, number>;
      heads: { session: string; workspace: string };
      requests: unknown[];
      catalog: { model_id: string; enabled: boolean; disabled_reason: string | null }[];
    };

    expect(body.workspace.id).toBe(fx.workspaceId);
    expect(body.viewer.role).toBe('admin');
    expect(body.viewer.reviewer_roles).toEqual(['access', 'finance']);
    expect(body.agent).toMatchObject({ id: fx.agentId, name: 'Iris' });
    expect(body.sessions).toContainEqual(expect.objectContaining({ id: fx.sessionId, agent_id: fx.agentId }));
    expect(body.counts).toEqual({ inbox: 0, pending_grants: 0, created_documents: 0, decisions: 0, pending_for_me: 0, pending_for_others: 0 });
    expect(body.heads).toEqual({ session: '0', workspace: '0' });
    expect(body.requests).toEqual([]);

    // Only OpenRouter rows, and none of them offered: no provider key exists
    // yet, so the shell shows "Add your OpenRouter key in Settings to start".
    // The four seeded DeepSeek/Anthropic/OpenAI rows are still in the table and
    // are no longer in any payload a client sees (decision R12).
    expect(body.catalog.length).toBeGreaterThanOrEqual(1);
    expect(body.catalog.every((row) => row.enabled === false)).toBe(true);
    expect(body.catalog.map((row) => row.model_id)).toContain('nous:anthropic/claude-sonnet-5');
    for (const row of body.catalog) expect(row.model_id.startsWith('nous:')).toBe(true);
  });

  it('refuses a caller who is not a member, without confirming the workspace exists', async () => {
    const mine = await seedWorkspace();
    const theirs = await seedWorkspace();
    const response = await call(`/w/${theirs.workspaceId}/bootstrap`, { 'x-dev-user': mine.adminId });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'not_a_member' });
  });

  it('ignores a forged workspace header and a forged query parameter', async () => {
    const mine = await seedWorkspace();
    const theirs = await seedWorkspace();

    // Both of these are the attack the plan names: the tenant key must come
    // from the path plus a members lookup, never from something the caller can
    // set. If either were honoured, this would return the other workspace.
    const viaHeader = await call(`/w/${mine.workspaceId}/bootstrap`, {
      'x-dev-user': mine.adminId,
      'x-workspace-id': theirs.workspaceId,
      'x-hermes-workspace': theirs.workspaceId,
    });
    expect(viaHeader.status).toBe(200);
    expect(((await viaHeader.json()) as { workspace: { id: string } }).workspace.id).toBe(mine.workspaceId);

    const viaQuery = await call(
      `/w/${mine.workspaceId}/bootstrap?workspace_id=${theirs.workspaceId}&app.workspace_id=${theirs.workspaceId}`,
      { 'x-dev-user': mine.adminId },
    );
    expect(viaQuery.status).toBe(200);
    expect(((await viaQuery.json()) as { workspace: { id: string } }).workspace.id).toBe(mine.workspaceId);

    // And forging the path itself is refused by the membership lookup.
    const viaPath = await call(`/w/${theirs.workspaceId}/bootstrap`, { 'x-dev-user': mine.adminId });
    expect(viaPath.status).toBe(404);
  });

  it('accepts the seeded user by email as well as by id', async () => {
    const fx = await seedWorkspace();
    const response = await call(`/w/${fx.workspaceId}/bootstrap`, { 'x-dev-user': await adminEmail(fx) });
    expect(response.status).toBe(200);
  });

  it('refuses an unknown dev user rather than inventing one', async () => {
    const fx = await seedWorkspace();
    const response = await call(`/w/${fx.workspaceId}/bootstrap`, { 'x-dev-user': 'nobody@example.test' });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'unknown_user' });
  });
});

describe('GET /w/:ws/events', () => {
  it('replays the workspace stream after a cursor', async () => {
    const fx = await seedWorkspace();
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO stream_events (workspace_id, kind, payload, trace_id)
         VALUES ($1::uuid, 'entity.updated',
                 jsonb_build_object('entity_type', 'workspace_settings', 'entity_id', $2::text,
                                    'ref', NULL, 'version', 1),
                 'trace-test')`,
        [fx.workspaceId, fx.workspaceId],
      );
      await c.query('COMMIT');
    });

    const response = await call(`/w/${fx.workspaceId}/events?stream=workspace&after=0`, { 'x-dev-user': fx.adminId });
    expect(response.status).toBe(200);
    const page = (await response.json()) as { events: { kind: string }[]; head: string; resync: boolean };
    expect(page.events.map((e) => e.kind)).toEqual(['entity.updated']);
    expect(page.resync).toBe(false);
    expect(Number(page.head)).toBeGreaterThan(0);
  });

  it('asks the client to resync when a stored row no longer parses', async () => {
    const fx = await seedWorkspace();
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      // A row written by an older schema version, whose payload the current
      // contract cannot read. Dropping it silently would leave a hole in the
      // transcript; the client is told to refetch instead.
      await c.query(
        `INSERT INTO stream_events (workspace_id, kind, payload, trace_id)
         VALUES ($1, 'entity.updated', '{"unreadable": true}'::jsonb, 'trace-test')`,
        [fx.workspaceId],
      );
      await c.query('COMMIT');
    });

    const response = await call(`/w/${fx.workspaceId}/events?stream=workspace&after=0`, { 'x-dev-user': fx.adminId });
    const page = (await response.json()) as { events: unknown[]; resync: boolean };
    expect(page.resync).toBe(true);
    expect(page.events).toEqual([]);
  });

  it('never shows one member another member private session events', async () => {
    const fx = await seedWorkspace();
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO stream_events (workspace_id, session_id, kind, payload, trace_id)
         VALUES ($1, $2, 'message.delta', '{}'::jsonb, 'trace-test')`,
        [fx.workspaceId, fx.sessionId],
      );
      await c.query('COMMIT');
    });

    // The session belongs to the Admin; the Member holds no share on it.
    const asMember = await call(`/w/${fx.workspaceId}/events?stream=session&after=0`, { 'x-dev-user': fx.memberId });
    const page = (await asMember.json()) as { events: unknown[] };
    expect(page.events).toEqual([]);
  });

  it('rejects a cursor that is not a stream id', async () => {
    const fx = await seedWorkspace();
    const response = await call(`/w/${fx.workspaceId}/events?stream=workspace&after=head`, {
      'x-dev-user': fx.adminId,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: 'bad_cursor' });
  });
});
