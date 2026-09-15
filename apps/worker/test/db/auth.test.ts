// Sign-in, against the real database.
//
// The three behaviours here are the ones that decide whether a WorkOS incident
// is an inconvenience or an outage:
//
//   * the callback mirrors the user and the membership, so someone who just
//     accepted an invitation sees the workspace immediately rather than when
//     the poller next runs;
//   * a transient WorkOS failure is a 503 that keeps the cookie, because
//     clearing it would sign every open tab out over a blip;
//   * a terminal one is a 401 and the session is over.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkspace, withClient, type Fixture } from './helpers.js';
import { asUser, call, clearFakeWorkOS, readTenant, useFakeWorkOS, workosEnv } from './harness.js';
import { FakeWorkOS, FakeWorkOSError, seal, signAccessToken } from '../stubs/fake-workos.js';
import { SESSION_COOKIE } from '../../src/auth/cookies.js';
import { makeEnv } from './harness.js';

let fake: FakeWorkOS;

beforeEach(async () => {
  fake = await useFakeWorkOS(new FakeWorkOS());
});

afterEach(() => clearFakeWorkOS());

/** A workspace that WorkOS knows about: the directory row is the link. */
async function linkedWorkspace(): Promise<{ fixture: Fixture; organizationId: string }> {
  const fixture = await seedWorkspace();
  const organizationId = `org_${randomUUID().slice(0, 8)}`;
  await withClient('owner', async (c) => {
    await c.query(
      `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1, $2)
       ON CONFLICT (workspace_id) DO UPDATE SET workos_organization_id = EXCLUDED.workos_organization_id`,
      [fixture.workspaceId, organizationId],
    );
  });
  return { fixture, organizationId };
}

describe('GET /auth/callback', () => {
  it('mirrors the user, the membership and the sid in one pass', async () => {
    const { fixture, organizationId } = await linkedWorkspace();
    const { env } = workosEnv();
    const email = `joiner-${randomUUID().slice(0, 8)}@example.test`;
    const workosUserId = `user_${randomUUID().slice(0, 8)}`;
    const sid = `session_${randomUUID().slice(0, 8)}`;

    fake.users.set(workosUserId, { id: workosUserId, email, emailVerified: true, firstName: 'Dana' });
    fake.memberships.push({
      id: `om_${randomUUID().slice(0, 8)}`,
      userId: workosUserId,
      organizationId,
      role: 'member',
      status: 'active',
    });
    fake.pendingCode = { code: 'code_1', userId: workosUserId, organizationId, sid };

    const response = await call(env, '/auth/callback?code=code_1&state=/inbox');

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/inbox');
    expect(response.headers.get('set-cookie')).toContain(SESSION_COOKIE);

    await withClient('owner', async (c) => {
      const user = await c.query<{ id: string }>(`SELECT id FROM users WHERE workos_user_id = $1`, [
        workosUserId,
      ]);
      expect(user.rowCount).toBe(1);

      const authSession = await c.query(`SELECT sid FROM auth_sessions WHERE sid = $1`, [sid]);
      expect(authSession.rowCount).toBe(1);
    });

    // `members` is a tenant table, so it is read under the workspace's own key.
    const member = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const { rows } = await c.query<{ role: string; status: string }>(
        `SELECT m.role, m.status FROM members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 AND u.workos_user_id = $2`,
        [fixture.workspaceId, workosUserId],
      );
      return rows[0];
    });
    expect(member).toMatchObject({ role: 'member', status: 'active' });
  });

  it('marks a pending invitation accepted when the person it named signs in', async () => {
    const { fixture, organizationId } = await linkedWorkspace();
    const { env } = workosEnv();
    const email = `invited-${randomUUID().slice(0, 8)}@example.test`;
    const workosUserId = `user_${randomUUID().slice(0, 8)}`;

    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fixture.workspaceId]);
      await c.query(
        `INSERT INTO invitations (workspace_id, email, role, expires_at)
         VALUES ($1, $2, 'member', now() + interval '7 days')`,
        [fixture.workspaceId, email],
      );
      await c.query('COMMIT');
    });

    fake.users.set(workosUserId, { id: workosUserId, email, emailVerified: true });
    fake.memberships.push({
      id: `om_${randomUUID().slice(0, 8)}`,
      userId: workosUserId,
      organizationId,
      role: 'member',
      status: 'active',
    });
    fake.pendingCode = { code: 'code_2', userId: workosUserId, organizationId, sid: `session_${randomUUID()}` };

    await call(env, '/auth/callback?code=code_2');

    const invitation = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const { rows } = await c.query<{ status: string }>(
        `SELECT status FROM invitations WHERE workspace_id = $1 AND email = $2`,
        [fixture.workspaceId, email],
      );
      return rows[0];
    });
    expect(invitation?.status).toBe('accepted');
  });
});

describe('a session whose access token has expired', () => {
  /** A cookie whose token expired an hour ago: the refresh path's input. */
  async function staleCookie(workosUserId: string, email: string, sid: string): Promise<string> {
    const accessToken = await signAccessToken({
      sub: workosUserId,
      sid,
      exp: Math.floor(Date.now() / 1000) - 3600,
    });
    return seal({ accessToken, user: { id: workosUserId, email, emailVerified: true } });
  }

  it('answers a transient WorkOS failure with 503 and keeps the cookie', async () => {
    const { fixture, organizationId } = await linkedWorkspace();
    void organizationId;
    const { env } = workosEnv();
    const email = await withClient('owner', async (c) => {
      const { rows } = await c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
        fixture.adminId,
      ]);
      return rows[0]!.email;
    });
    const workosUserId = `user_${randomUUID().slice(0, 8)}`;
    const cookie = await staleCookie(workosUserId, email, `session_${randomUUID().slice(0, 8)}`);
    fake.refreshFailure = new FakeWorkOSError('gateway timeout', 504);

    const response = await call(env, `/auth/session?ws=${fixture.workspaceId}`, {
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'upstream_unavailable' });
    // The cookie is untouched: no Set-Cookie at all, so nothing clears it.
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('answers a terminal invalid_grant with 401, because no retry will help', async () => {
    const { fixture } = await linkedWorkspace();
    const { env } = workosEnv();
    const workosUserId = `user_${randomUUID().slice(0, 8)}`;
    const cookie = await staleCookie(workosUserId, 'gone@example.test', `session_${randomUUID().slice(0, 8)}`);
    fake.refreshFailure = new FakeWorkOSError('refresh token spent', 400, 'invalid_grant');

    const response = await call(env, `/auth/session?ws=${fixture.workspaceId}`, {
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'invalid_session' });
  });

  it('refreshes, re-seals and answers, when WorkOS is well', async () => {
    const { fixture } = await linkedWorkspace();
    const { env } = workosEnv();
    const email = await withClient('owner', async (c) => {
      const { rows } = await c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
        fixture.adminId,
      ]);
      return rows[0]!.email;
    });
    const workosUserId = `user_${randomUUID().slice(0, 8)}`;
    const cookie = await staleCookie(workosUserId, email, `session_${randomUUID().slice(0, 8)}`);

    const response = await call(env, `/auth/session?ws=${fixture.workspaceId}`, {
      headers: { cookie: `${SESSION_COOKIE}=${cookie}` },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain(SESSION_COOKIE);
    const body = (await response.json()) as { hub_ticket: string; workspace: { id: string } };
    expect(body.workspace.id).toBe(fixture.workspaceId);
    expect(body.hub_ticket.length).toBeGreaterThan(20);
  });
});

describe('GET /auth/session in fake mode', () => {
  it('returns both stream heads and a hub ticket', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();

    const response = await asUser(env, fixture.adminId, `/auth/session?ws=${fixture.workspaceId}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      stream_heads: { workspace: string; session: string };
      hub_ticket: string;
      user: { role: string };
    };
    expect(body.stream_heads).toEqual({ workspace: '0', session: '0' });
    expect(body.user.role).toBe('admin');
    expect(body.hub_ticket).toContain('.');
  });

  it('refuses a caller with no session, and says which reason', async () => {
    const { env } = makeEnv();
    const response = await call(env, '/auth/session');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'no_session' });
  });
});
