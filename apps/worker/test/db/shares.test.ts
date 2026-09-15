// `GET /shared/:token`, and what a share is now allowed to be.
//
// The finding this file exists for (security review O1) had two halves and they
// pointed in opposite directions: creating a link share handed the session to
// every *member* of the workspace, and handed the person holding the *link*
// nothing at all, because no route read `token_hash`. So the tests come in
// pairs — what the link holder gets, and what everybody else still does not.
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedWorkspace, withClient, type Fixture } from './helpers.js';
import { asUser, call, makeEnv } from './harness.js';
import { clearSharedSessionMemoForTests } from '../../src/routes/shares.js';

/** A session owned by the Admin with `count` messages, and a share on it. */
async function seedShared(
  fixture: Fixture,
  count: number,
  cutoff: number,
): Promise<{ sessionId: string; token: string; shareId: string }> {
  const token = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
  const tokenHash = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fixture.workspaceId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sessions (workspace_id, owner_id, title, model_id)
       VALUES ($1, $2, 'Partner applications', 'deepseek-flash') RETURNING id`,
      [fixture.workspaceId, fixture.adminId],
    );
    const sessionId = rows[0]!.id;
    for (let seq = 0; seq < count; seq += 1) {
      await c.query(
        `INSERT INTO messages (workspace_id, session_id, seq, role, text, blocks)
         VALUES ($1, $2, $3, 'user', $4, $5::jsonb)`,
        [
          fixture.workspaceId,
          sessionId,
          seq,
          `message ${seq}`,
          JSON.stringify([{ type: 'choice', options: [{ label: 'Open', command: { type: 'nav' } }] }]),
        ],
      );
    }
    const share = await c.query<{ id: string }>(
      `INSERT INTO session_shares (workspace_id, session_id, created_by, token_hash, audience, message_cutoff_seq)
       VALUES ($1, $2, $3, $4, 'link', $5) RETURNING id`,
      [fixture.workspaceId, sessionId, fixture.adminId, tokenHash, cutoff],
    );
    await c.query('COMMIT');
    return { sessionId, token, shareId: share.rows[0]!.id };
  });
}

const json = <T>(response: Response): Promise<T> => response.json() as Promise<T>;

describe('G1 · GET /shared/:token', () => {
  beforeEach(() => clearSharedSessionMemoForTests());

  it('serves the session to the link holder with no session cookie at all', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const { sessionId, token } = await seedShared(fixture, 4, 3);

    // No `x-dev-user`: the token *is* the authorisation, and this is the only
    // route in the Worker that answers without an identity.
    const response = await call(env, `/shared/${token}`, { headers: { accept: 'application/json' } });

    expect(response.status).toBe(200);
    const body = await json<{
      session: { id: string; title: string; workspace_name: string };
      messages: { seq: number; blocks: unknown[] }[];
      message_cutoff_seq: number;
      revoked: boolean;
    }>(response);
    expect(body.session.id).toBe(sessionId);
    expect(body.session.title).toBe('Partner applications');
    expect(body.revoked).toBe(false);
    expect(body.messages.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
  });

  it('stops at message_cutoff_seq, because a share is a snapshot and not a subscription', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const { token } = await seedShared(fixture, 5, 1);

    const body = await json<{ messages: { seq: number }[]; message_cutoff_seq: number }>(
      await call(env, `/shared/${token}`, { headers: { accept: 'application/json' } }),
    );

    expect(body.message_cutoff_seq).toBe(1);
    expect(body.messages.map((m) => m.seq)).toEqual([0, 1]);
  });

  it('carries no interactive blocks, because the viewer has no session to act under', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const { token } = await seedShared(fixture, 2, 1);

    const body = await json<{ messages: { blocks: unknown[] }[] }>(
      await call(env, `/shared/${token}`, { headers: { accept: 'application/json' } }),
    );

    expect(body.messages.length).toBeGreaterThan(0);
    for (const message of body.messages) expect(message.blocks).toEqual([]);
  });

  it('stops resolving the moment the share is revoked', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const { sessionId, token, shareId } = await seedShared(fixture, 2, 1);

    expect((await call(env, `/shared/${token}`, { headers: { accept: 'application/json' } })).status).toBe(200);

    const revoked = await asUser(
      env,
      fixture.adminId,
      `/w/${fixture.workspaceId}/sessions/${sessionId}/shares/${shareId}`,
      { method: 'DELETE' },
    );
    expect(revoked.status).toBe(204);

    // The memo is per isolate and lives five seconds; a revocation is felt
    // immediately once it expires, and the directory row is already gone.
    clearSharedSessionMemoForTests();
    const after = await call(env, `/shared/${token}`, { headers: { accept: 'application/json' } });
    expect(after.status).toBe(404);
    expect(await json<{ reason: string }>(after)).toMatchObject({ reason: 'share_unavailable' });
  });

  it('answers one thing for a token that never existed, a malformed one and a revoked one', async () => {
    const { env } = makeEnv();
    for (const token of ['x', `${randomUUID()}${randomUUID()}`.replace(/-/g, ''), 'not-a-token-at-all']) {
      const response = await call(env, `/shared/${token}`, { headers: { accept: 'application/json' } });
      expect(response.status).toBe(404);
      expect(await json<{ reason: string }>(response)).toMatchObject({ reason: 'share_unavailable' });
    }
  });

  it('answers 304 to a caller that already has this transcript', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const { token } = await seedShared(fixture, 2, 1);

    const first = await call(env, `/shared/${token}`, { headers: { accept: 'application/json' } });
    const etag = first.headers.get('etag') ?? '';
    expect(etag).not.toBe('');

    const second = await call(env, `/shared/${token}`, {
      headers: { accept: 'application/json', 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
  });

  it('serves the app shell to a browser navigating to the link', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv({
      ASSETS: { fetch: () => Promise.resolve(new Response('<!doctype html>', { status: 200 })) },
    } as never);
    const { token } = await seedShared(fixture, 1, 0);

    const response = await call(env, `/shared/${token}`, { headers: { 'sec-fetch-mode': 'navigate' } });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('doctype');
  });
});

describe('G1 · what a share is not', () => {
  beforeEach(() => clearSharedSessionMemoForTests());

  it('is not a workspace grant: a member who does not hold the link sees nothing of the session', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const { sessionId } = await seedShared(fixture, 3, 2);

    const routes = [
      `/w/${fixture.workspaceId}/sessions/${sessionId}`,
      `/w/${fixture.workspaceId}/sessions/${sessionId}/messages`,
      `/w/${fixture.workspaceId}/sessions/${sessionId}/draft`,
    ];
    for (const route of routes) {
      const response = await asUser(env, fixture.memberId, route);
      expect(response.status).toBe(404);
    }

    const listed = await json<{ items: { id: string }[] }>(
      await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/sessions`),
    );
    expect(listed.items.map((row) => row.id)).not.toContain(sessionId);
  });

  it('is not a subscription: the session replay stream carries none of it for a non-owner', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const { sessionId } = await seedShared(fixture, 2, 1);
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fixture.workspaceId]);
      await c.query(
        `INSERT INTO stream_events (workspace_id, session_id, kind, payload, schema_version, trace_id)
         VALUES ($1, $2, 'run.status', $3::jsonb, 1, $4)`,
        [
          fixture.workspaceId,
          sessionId,
          JSON.stringify({ run_id: randomUUID(), attempt: 1, status: 'working' }),
          randomUUID(),
        ],
      );
      await c.query('COMMIT');
    });

    const page = await json<{ events: { session_id: string | null }[] }>(
      await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/events?stream=session`),
    );

    expect(page.events.filter((event) => event.session_id === sessionId)).toEqual([]);
  });

  it('is not a socket: the upgrade is the owner’s and a share does not widen it', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const { sessionId } = await seedShared(fixture, 1, 0);

    const response = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/hub/session/${sessionId}`, {
      headers: { upgrade: 'websocket' },
    });

    expect(response.status).toBe(404);
    expect(await json<{ reason: string }>(response)).toMatchObject({ reason: 'unknown_session' });
  });
});
