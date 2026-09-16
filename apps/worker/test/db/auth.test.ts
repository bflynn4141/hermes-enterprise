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
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../../src/auth/cookies.js';
import { AUTH_TRANSACTION_COOKIE } from '../../src/auth/transactions.js';
import { makeEnv } from './harness.js';

let fake: FakeWorkOS;

beforeEach(async () => {
  fake = await useFakeWorkOS(new FakeWorkOS());
});

afterEach(() => clearFakeWorkOS());

async function beginLogin(
  env: ReturnType<typeof workosEnv>['env'],
  returnTo = '/',
  invitationToken?: string,
): Promise<{ state: string; cookie: string }> {
  const query = new URLSearchParams({ return_to: returnTo });
  if (invitationToken) query.set('invitation_token', invitationToken);
  const response = await call(env, `/auth/login?${query}`);
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location')!);
  const state = location.searchParams.get('state');
  const setCookie = response.headers.get('set-cookie');
  expect(state).toBeTruthy();
  expect(setCookie).toContain(AUTH_TRANSACTION_COOKIE);
  return { state: state!, cookie: setCookie!.split(';', 1)[0]! };
}

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
  it('starts with opaque state and a short-lived secure callback cookie', async () => {
    const { env } = workosEnv({
      ENVIRONMENT: 'production',
      ALLOWED_ORIGINS: 'https://app.hermes.test',
      WORKOS_REDIRECT_URI: 'https://app.hermes.test/auth/callback',
      WORKOS_ISSUER: 'https://api.workos.com',
    });
    const response = await call(env, '/auth/login?return_to=/inbox');
    const location = new URL(response.headers.get('location')!);
    const state = location.searchParams.get('state') ?? '';
    const cookie = response.headers.get('set-cookie') ?? '';

    expect(state).not.toBe('/inbox');
    expect(state.length).toBeGreaterThanOrEqual(40);
    expect(cookie).toContain(`${AUTH_TRANSACTION_COOKIE}=`);
    expect(cookie).toContain('Path=/auth/callback');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=600');
    expect(cookie).toContain('Secure');
  });

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

    const transaction = await beginLogin(env, '/inbox');
    const response = await call(env, `/auth/callback?code=code_1&state=${encodeURIComponent(transaction.state)}`, {
      headers: { cookie: transaction.cookie },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/inbox');
    expect(response.headers.get('set-cookie')).toContain(SESSION_COOKIE);
    expect(response.headers.get('set-cookie')).toContain(`${AUTH_TRANSACTION_COOKIE}=;`);

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

    const transaction = await beginLogin(env);
    const response = await call(env, `/auth/callback?code=code_2&state=${encodeURIComponent(transaction.state)}`, {
      headers: { cookie: transaction.cookie },
    });
    expect(response.status).toBe(302);

    const invitation = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const { rows } = await c.query<{ status: string }>(
        `SELECT status FROM invitations WHERE workspace_id = $1 AND email = $2`,
        [fixture.workspaceId, email],
      );
      return rows[0];
    });
    expect(invitation?.status).toBe('accepted');
  });

  it('rejects a missing or mismatched state before exchanging the code', async () => {
    const { env } = workosEnv();
    const transaction = await beginLogin(env, '/inbox');

    const missingCookie = await call(
      env,
      `/auth/callback?code=unused&state=${encodeURIComponent(transaction.state)}`,
    );
    const wrongState = await call(env, '/auth/callback?code=unused&state=wrong', {
      headers: { cookie: transaction.cookie },
    });
    const [name, value] = transaction.cookie.split('=');
    const tamperedValue = `${value?.startsWith('A') ? 'B' : 'A'}${value?.slice(1) ?? ''}`;
    const tampered = await call(
      env,
      `/auth/callback?code=unused&state=${encodeURIComponent(transaction.state)}`,
      { headers: { cookie: `${name}=${tamperedValue}` } },
    );

    expect(missingCookie.status).toBe(400);
    expect(await missingCookie.json()).toMatchObject({ reason: 'invalid_state' });
    expect(wrongState.status).toBe(400);
    expect(await wrongState.json()).toMatchObject({ reason: 'invalid_state' });
    expect(tampered.status).toBe(400);
    expect(await tampered.json()).toMatchObject({ reason: 'invalid_state' });
    expect(fake.calls.filter((entry) => entry.method === 'authenticateWithCode')).toHaveLength(0);
  });

  it('binds the invitation token to the browser transaction', async () => {
    const { env } = workosEnv();
    const workosUserId = `user_${randomUUID().slice(0, 8)}`;
    fake.users.set(workosUserId, {
      id: workosUserId,
      email: `invite-${randomUUID().slice(0, 8)}@example.test`,
      emailVerified: true,
    });
    fake.pendingCode = {
      code: 'code_invite',
      userId: workosUserId,
      organizationId: null,
      sid: `session_${randomUUID()}`,
    };
    const transaction = await beginLogin(env, '/', 'invitation_from_login');

    const response = await call(
      env,
      `/auth/callback?code=code_invite&state=${encodeURIComponent(transaction.state)}&invitation_token=substitute`,
      { headers: { cookie: transaction.cookie } },
    );

    expect(response.status).toBe(302);
    expect(fake.calls.find((entry) => entry.method === 'authenticateWithCode')?.argument).toEqual({
      code: 'code_invite',
      invitationToken: 'invitation_from_login',
    });
  });

  it('does not choose an arbitrary membership when AuthKit selected no organization', async () => {
    const { fixture, organizationId } = await linkedWorkspace();
    const { env } = workosEnv();
    const workosUserId = `user_${randomUUID().slice(0, 8)}`;
    fake.users.set(workosUserId, {
      id: workosUserId,
      email: `multi-${randomUUID().slice(0, 8)}@example.test`,
      emailVerified: true,
    });
    fake.memberships.push({
      id: `om_${randomUUID().slice(0, 8)}`,
      userId: workosUserId,
      organizationId,
      role: 'member',
      status: 'active',
    });
    fake.pendingCode = {
      code: 'code_no_org',
      userId: workosUserId,
      organizationId: null,
      sid: `session_${randomUUID()}`,
    };
    const transaction = await beginLogin(env);

    const response = await call(
      env,
      `/auth/callback?code=code_no_org&state=${encodeURIComponent(transaction.state)}`,
      { headers: { cookie: transaction.cookie } },
    );

    expect(response.status).toBe(302);
    expect(fake.calls.filter((entry) => entry.method === 'listOrganizationMemberships')).toHaveLength(0);
    const mirrored = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const result = await c.query(
        `SELECT 1 FROM members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 AND u.workos_user_id = $2`,
        [fixture.workspaceId, workosUserId],
      );
      return result.rowCount;
    });
    expect(mirrored).toBe(0);
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

describe('POST /workspaces in workos mode', () => {
  it('creates the owner membership and switches the sealed session to the new organization', async () => {
    const fixture = await seedWorkspace();
    const { env } = workosEnv();
    const email = await withClient('owner', async (c) => {
      const result = await c.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [fixture.adminId]);
      return result.rows[0]!.email;
    });
    const workosUserId = `user_${randomUUID().slice(0, 8)}`;
    const accessToken = await signAccessToken({
      sub: workosUserId,
      sid: `session_${randomUUID().slice(0, 8)}`,
    });
    const sealedSession = seal({
      accessToken,
      user: { id: workosUserId, email, emailVerified: true },
    });
    const csrf = 'workspace-create-csrf';

    const response = await call(env, '/workspaces', {
      method: 'POST',
      body: { name: 'WorkOS Created Workspace' },
      headers: {
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealedSession)}; ${CSRF_COOKIE}=${csrf}`,
        [CSRF_HEADER]: csrf,
      },
    });

    expect(response.status).toBe(201);
    const created = fake.calls.find((entry) => entry.method === 'createOrganizationMembership');
    expect(created?.argument).toMatchObject({ userId: workosUserId, roleSlug: 'admin' });
    const organizationId = (created?.argument as { organizationId: string }).organizationId;
    expect(fake.calls.find((entry) => entry.method === 'refresh')?.argument).toMatchObject({ organizationId });
    expect(response.headers.get('set-cookie')).toContain(SESSION_COOKIE);

    const body = (await response.json()) as { workspace: { id: string } };
    const linked = await withClient('owner', async (c) => {
      const result = await c.query<{ workos_organization_id: string }>(
        'SELECT workos_organization_id FROM workspace_directory WHERE workspace_id = $1',
        [body.workspace.id],
      );
      return result.rows[0]?.workos_organization_id;
    });
    expect(linked).toBe(organizationId);
  });
});

describe('GET /auth/logout', () => {
  it('revokes the sid, clears every auth cookie securely, and continues to WorkOS logout', async () => {
    const fixture = await seedWorkspace();
    const { env } = workosEnv({
      ENVIRONMENT: 'production',
      ALLOWED_ORIGINS: 'https://app.hermes.test',
      WORKOS_REDIRECT_URI: 'https://app.hermes.test/auth/callback',
      WORKOS_ISSUER: 'https://api.workos.com',
    });
    const email = await withClient('owner', async (c) => {
      const result = await c.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [fixture.adminId]);
      return result.rows[0]!.email;
    });
    const workosUserId = `user_${randomUUID().slice(0, 8)}`;
    const sid = `session_${randomUUID().slice(0, 8)}`;
    const accessToken = await signAccessToken({ sub: workosUserId, sid });
    const sealedSession = seal({
      accessToken,
      user: { id: workosUserId, email, emailVerified: true },
    });
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(sealedSession)}`;
    expect(
      (await call(env, `/auth/session?ws=${fixture.workspaceId}`, { headers: { cookie } })).status,
    ).toBe(200);

    const response = await call(env, '/auth/logout', { headers: { cookie } });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://api.workos.com/user_management/sessions/logout');
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=;`);
    expect(setCookie).toContain(`${CSRF_COOKIE}=;`);
    expect(setCookie).toContain(`${AUTH_TRANSACTION_COOKIE}=;`);
    expect(setCookie).toContain('Secure');
    expect(fake.calls.find((entry) => entry.method === 'logoutUrl')).toBeDefined();
    const revoked = await withClient('owner', async (c) => {
      const result = await c.query<{ revoked_at: Date | null }>('SELECT revoked_at FROM auth_sessions WHERE sid = $1', [sid]);
      return result.rows[0]?.revoked_at;
    });
    expect(revoked).toBeInstanceOf(Date);
  });
});
