// Sessions, drafts, shares, and who may open a socket.
//
// The thread running through all of it: membership is not visibility. Being in
// a workspace lets you see the workspace stream; it does not let you read
// someone else's conversation, open their socket, or replay their events. The
// same rule is written in three places — the list query, the replay route and
// the socket upgrade — so it is asserted in all three.
//
// A link share is not visibility either, which is the half this file used to
// assert backwards (security review O1). Creating one gave every member of the
// workspace the session and gave the link holder nothing; the token is redeemed
// at `GET /shared/:token` now, and the in-workspace predicate is `owner_id =
// me` in all three places. The share tests below are the ones that changed.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { seedWorkspace, withClient, type Fixture } from './helpers.js';
import { ALLOWED_ORIGIN, asUser, makeEnv, readTenant } from './harness.js';

/** A session belonging to `ownerId`, with `count` messages in it. */
async function seedSession(fixture: Fixture, ownerId: string, count = 0): Promise<string> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fixture.workspaceId]);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sessions (workspace_id, owner_id, title, model_id)
       VALUES ($1, $2, 'Seeded', 'deepseek-flash') RETURNING id`,
      [fixture.workspaceId, ownerId],
    );
    const sessionId = rows[0]!.id;
    for (let seq = 0; seq < count; seq += 1) {
      await c.query(
        `INSERT INTO messages (workspace_id, session_id, seq, role, text)
         VALUES ($1, $2, $3, 'user', $4)`,
        [fixture.workspaceId, sessionId, seq, `message ${seq}`],
      );
    }
    await c.query('COMMIT');
    return sessionId;
  });
}

describe('POST /w/:ws/sessions', () => {
  it('takes the model, effort and runtime from the workspace defaults', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fixture.workspaceId]);
      await c.query(
        `UPDATE workspace_settings SET default_effort = 'low', default_runtime = 'local' WHERE workspace_id = $1`,
        [fixture.workspaceId],
      );
      await c.query('COMMIT');
    });

    const response = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/sessions`, {
      method: 'POST',
      body: { title: 'Partner applications' },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      agent_id: fixture.agentId,
      title: 'Partner applications',
      // The exact product default, backed by migration 0041's placeholder.
      model_id: 'nous:deepseek/deepseek-v4.1-flash',
      effort: 'low',
      runtime: 'local',
      status: 'idle',
    });
  });

  it('refuses an agent from outside the workspace', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const response = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/sessions`, {
      method: 'POST',
      body: { agent_id: randomUUID() },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ reason: 'unknown_agent' });
  });
});

describe('GET /w/:ws/sessions', () => {
  it('lists the caller’s own sessions and nobody else’s, link-shared or not', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const mine = await seedSession(fixture, fixture.memberId);
    const theirs = await seedSession(fixture, fixture.adminId);
    const shared = await seedSession(fixture, fixture.adminId);
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fixture.workspaceId]);
      await c.query(
        `INSERT INTO session_shares (workspace_id, session_id, created_by, token_hash, audience, message_cutoff_seq)
         VALUES ($1, $2, $3, $4, 'link', 0)`,
        [fixture.workspaceId, shared, fixture.adminId, randomUUID()],
      );
      await c.query('COMMIT');
    });

    const body = (await (
      await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/sessions`)
    ).json()) as { items: { id: string }[] };
    const ids = body.items.map((row) => row.id);

    expect(ids).toContain(mine);
    // The share is a link, not a workspace grant: the Member who does not hold
    // the link sees no more of the Admin's session than of any other.
    expect(ids).not.toContain(shared);
    expect(ids).not.toContain(theirs);
  });

  it('answers 404 for another person’s session, because its existence is theirs to know', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const theirs = await seedSession(fixture, fixture.adminId);

    const response = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/sessions/${theirs}`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'unknown_session' });
  });
});

describe('drafts', () => {
  it('survive a round trip, per session and per person', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const sessionId = await seedSession(fixture, fixture.adminId);

    await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/sessions/${sessionId}/draft`, {
      method: 'PUT',
      body: { text: 'half a thought' },
    });
    const mine = (await (
      await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/sessions/${sessionId}/draft`)
    ).json()) as { text: string };

    expect(mine.text).toBe('half a thought');

    // Sharing the session does not put a second person's box on it: they
    // cannot reach the session at all, because a share is redeemed at
    // `/shared/:token` and grants a read-only snapshot with no draft in it.
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fixture.workspaceId]);
      await c.query(
        `INSERT INTO session_shares (workspace_id, session_id, created_by, token_hash, audience, message_cutoff_seq)
         VALUES ($1, $2, $3, $4, 'link', 0)`,
        [fixture.workspaceId, sessionId, fixture.adminId, randomUUID()],
      );
      await c.query('COMMIT');
    });
    const theirs = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/sessions/${sessionId}/draft`);

    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toMatchObject({ reason: 'unknown_session' });
  });
});

describe('GET /w/:ws/sessions/:id/messages', () => {
  it('pages backwards from the newest and says whether there is more', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const sessionId = await seedSession(fixture, fixture.adminId, 5);

    const first = (await (
      await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/sessions/${sessionId}/messages?limit=2`)
    ).json()) as { items: { seq: number }[]; cursor: string | null };

    expect(first.items.map((row) => row.seq)).toEqual([3, 4]);
    expect(first.cursor).toBe('3');

    const next = (await (
      await asUser(
        env,
        fixture.adminId,
        `/w/${fixture.workspaceId}/sessions/${sessionId}/messages?before=${first.cursor}&limit=2`,
      )
    ).json()) as { items: { seq: number }[] };

    expect(next.items.map((row) => row.seq)).toEqual([1, 2]);
  });

  it('is the owner’s route: a member with a share on the session is still 404 here', async () => {
    // The cutoff assertion that used to live here moved to the route that now
    // enforces it — `GET /shared/:token`, in shares.test.ts. This half is the
    // other side of the same fix: the in-workspace transcript is not a share's
    // to read at all, capped or otherwise.
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const sessionId = await seedSession(fixture, fixture.adminId, 4);
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fixture.workspaceId]);
      await c.query(
        `INSERT INTO session_shares (workspace_id, session_id, created_by, token_hash, audience, message_cutoff_seq)
         VALUES ($1, $2, $3, $4, 'link', 1)`,
        [fixture.workspaceId, sessionId, fixture.adminId, randomUUID()],
      );
      await c.query('COMMIT');
    });

    const response = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/sessions/${sessionId}/messages`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'unknown_session' });
  });
});

describe('shares', () => {
  it('returns the token once and stores only its hash', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const sessionId = await seedSession(fixture, fixture.adminId, 3);

    const body = (await (
      await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/sessions/${sessionId}/shares`, {
        method: 'POST',
        body: { audience: 'Finance' },
      })
    ).json()) as { id: string; url: string; audience: string; message_cutoff_seq: number };

    expect(body.message_cutoff_seq).toBe(2);
    expect(body.audience).toBe('Anyone with the link');
    const token = body.url.split('/').pop() ?? '';
    const stored = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const { rows } = await c.query<{ token_hash: string; audience: string }>(
        `SELECT token_hash, audience FROM session_shares WHERE id = $1`,
        [body.id],
      );
      return rows[0];
    });
    expect(stored?.token_hash).not.toBe(token);
    expect(stored?.token_hash).toHaveLength(64);
    // A stale or hostile client cannot put a presentation-only audience back.
    expect(stored?.audience).toBe('Anyone with the link');
  });

  it('lets only the owner share: an existing share does not make a second person one', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const sessionId = await seedSession(fixture, fixture.adminId);
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fixture.workspaceId]);
      await c.query(
        `INSERT INTO session_shares (workspace_id, session_id, created_by, token_hash, audience, message_cutoff_seq)
         VALUES ($1, $2, $3, $4, 'link', 0)`,
        [fixture.workspaceId, sessionId, fixture.adminId, randomUUID()],
      );
      await c.query('COMMIT');
    });

    const response = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/sessions/${sessionId}/shares`, {
      method: 'POST',
      body: {},
    });

    // 404 rather than 403 now: the session is not visible to them in the first
    // place, and "whether it exists is theirs to know" is the same answer every
    // other session route gives a non-owner.
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'unknown_session' });
  });
});

describe('the WebSocket upgrade routes', () => {
  const upgrade = { upgrade: 'websocket' };

  it('refuses an upgrade from an origin we do not serve', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();

    const response = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/hub/workspace`, {
      headers: upgrade,
      origin: 'https://evil.example',
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'forbidden_origin' });
  });

  it('refuses an upgrade with no Origin at all, because a browser always sends one', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();

    const response = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/hub/workspace`, {
      headers: upgrade,
      origin: null,
    });

    expect(response.status).toBe(403);
  });

  it('refuses a session socket for a session the caller cannot see', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const theirs = await seedSession(fixture, fixture.adminId);

    const response = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/hub/session/${theirs}`, {
      headers: upgrade,
      origin: ALLOWED_ORIGIN,
    });

    expect(response.status).toBe(404);
  });

  it('upgrades a member on their own session, stamping who they are on the socket', async () => {
    const fixture = await seedWorkspace();
    const { env, hubCalls } = makeEnv();
    const mine = await seedSession(fixture, fixture.memberId);

    const response = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/hub/session/${mine}`, {
      headers: upgrade,
      origin: ALLOWED_ORIGIN,
    });

    expect(response.headers.get('x-hermes-upgraded')).toBe('1');
    const handoff = hubCalls.find((entry) => entry.method === 'fetch');
    expect(handoff?.name).toBe(mine);
    // The attachment is the authorisation decision, made here and only here.
    expect(JSON.parse(String(handoff?.argument))).toMatchObject({
      userId: fixture.memberId,
      workspaceId: fixture.workspaceId,
      sessionId: mine,
    });
  });

  it('refuses a socket to someone who is no longer a member', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const memberRow = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM members WHERE workspace_id = $1 AND user_id = $2`,
        [fixture.workspaceId, fixture.memberId],
      );
      return rows[0]!.id;
    });
    await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/members/${memberRow}`, { method: 'DELETE' });

    const socket = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/hub/workspace`, {
      headers: upgrade,
    });
    const request = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/bootstrap`);

    // 404 rather than 403: whether the workspace exists is not theirs to learn
    // any more either.
    expect(socket.status).toBe(404);
    expect(request.status).toBe(404);
    expect(await request.json()).toMatchObject({ reason: 'not_a_member' });
  });
});

describe('the tenant key', () => {
  it('ignores a forged workspace header and query parameter', async () => {
    const one = await seedWorkspace();
    const two = await seedWorkspace();
    const { env } = makeEnv();
    const mine = await seedSession(one, one.adminId);

    // The caller is an Admin of `one` and forges `two` in both places a lazy
    // implementation might read it from.
    const body = (await (
      await asUser(env, one.adminId, `/w/${one.workspaceId}/sessions?workspace_id=${two.workspaceId}`, {
        headers: { 'x-workspace-id': two.workspaceId },
      })
    ).json()) as { items: { id: string }[] };

    const ids = body.items.map((row) => row.id);
    expect(ids).toContain(mine);
    // Nothing from the forged workspace came back, whichever place it was read
    // from — because it is read from neither.
    const theirs = await readTenant(two.workspaceId, two.adminId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM sessions WHERE workspace_id = $1`, [
        two.workspaceId,
      ]);
      return rows.map((row) => row.id);
    });
    expect(ids.filter((id) => theirs.includes(id))).toEqual([]);
  });
});
