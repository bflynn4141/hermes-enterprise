// One test per finding in `docs/SECURITY-REVIEW.md`.
//
// The file is kept together for the reason `server-findings.test.ts` gives for
// its own: it is the answer to "did the review's fixes actually hold?", and a
// reviewer reading the table in that document can find the property each row
// claims without grepping for it.
//
// Node rather than workerd: the real Hono app, the real SQL, the real
// transactions, an `Env` whose Hyperdrive bindings point at Docker Postgres.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { seedWorkspace, withClient, type Fixture } from './helpers.js';
import {
  ALLOWED_ORIGIN,
  asUser,
  call,
  clearFakeWorkOS,
  makeEnv,
  readTenant,
  useFakeWorkOS,
  workosEnv,
} from './harness.js';
import { FakeWorkOS, seal, signAccessToken } from '../stubs/fake-workos.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../../src/auth/cookies.js';

const emailOf = (userId: string): Promise<string> =>
  withClient('owner', async (c) => {
    const { rows } = await c.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
    return rows[0]!.email;
  });

// ---------------------------------------------------------------------------
// SR-1 · `AUTH_MODE=fake` is refused outside a development environment
// ---------------------------------------------------------------------------

describe('SR-1 · the development auth adapter cannot run in a deployed environment', () => {
  it('refuses x-dev-user when ENVIRONMENT is production or staging', async () => {
    const fx = await seedWorkspace();

    for (const environment of ['production', 'staging']) {
      const { env } = makeEnv({ ENVIRONMENT: environment } as Partial<Env>);
      const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/bootstrap`);
      // 503 `not_configured`, the same answer an unknown AUTH_MODE gets: an
      // environment that cannot authenticate properly refuses to answer rather
      // than falling back to trusting a header. Not 401, because this is a
      // deployment fault and not the caller's.
      expect(response.status).toBe(503);
      expect(((await response.json()) as { reason: string }).reason).toBe('not_configured');
    }
  });

  it('still works in development and in test, which is what it is for', async () => {
    const fx = await seedWorkspace();
    for (const environment of ['development', 'test']) {
      const { env } = makeEnv({ ENVIRONMENT: environment } as Partial<Env>);
      const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/bootstrap`);
      expect(response.status).toBe(200);
    }
  });
});

// ---------------------------------------------------------------------------
// SR-2 · a revoked `auth_sessions` row ends the session
// ---------------------------------------------------------------------------

describe('SR-2 · signing out ends the session on the server, not only in the browser', () => {
  it('refuses a session whose sid has been revoked', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv();

    // The first call creates the `auth_sessions` row the fake adapter uses.
    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/bootstrap`)).status).toBe(200);

    // What `POST /auth/logout` and the WorkOS `user.deleted` poller write. It
    // was written by both and read by nothing, so a sealed cookie captured
    // before a sign-out kept working — and kept satisfying the five-minute
    // step-up check, because revoking never moved `authenticated_at`.
    await withClient('owner', (c) =>
      c.query(`UPDATE auth_sessions SET revoked_at = now() WHERE sid = $1`, [`dev-${fx.adminId}`]),
    );

    const after = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/bootstrap`);
    expect(after.status).toBe(401);
    expect(((await after.json()) as { reason: string }).reason).toBe('invalid_session');
  });

  it('a revoked session cannot record a decision either', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv();
    const requestId = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      const { setTenant } = await import('./helpers.js');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO requests (id, workspace_id, session_id, kind, status, label, payload)
         VALUES ($1, $2, $3, 'application', 'pending', 'Ada Lovelace', '{}'::jsonb)`,
        [requestId, fx.workspaceId, fx.sessionId],
      );
      await c.query('COMMIT');
    });

    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/bootstrap`)).status).toBe(200);
    await withClient('owner', (c) =>
      c.query(`UPDATE auth_sessions SET revoked_at = now() WHERE sid = $1`, [`dev-${fx.adminId}`]),
    );

    const decision = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: { 'x-requested-from': 'inbox' },
      body: { decision: 'approve' },
    });
    expect(decision.status).toBe(401);

    const still = await readTenant(fx.workspaceId, fx.adminId, (c) =>
      c.query<{ status: string }>(`SELECT status FROM requests WHERE id = $1`, [requestId]),
    );
    expect(still.rows[0]?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// SR-3 · the provider-key routes carry the same CSRF guard as everything else
// ---------------------------------------------------------------------------

describe('SR-3 · installing and revoking a billing credential needs a CSRF token', () => {
  let fake: FakeWorkOS;
  beforeEach(async () => {
    fake = await useFakeWorkOS(new FakeWorkOS());
  });
  afterEach(() => clearFakeWorkOS());

  async function adminCookie(fx: Fixture): Promise<string> {
    const email = await emailOf(fx.adminId);
    const workosUserId = `user_${randomUUID().slice(0, 8)}`;
    const sid = `session_${randomUUID().slice(0, 8)}`;
    fake.users.set(workosUserId, { id: workosUserId, email, emailVerified: true, firstName: 'Maya' });
    const accessToken = await signAccessToken({
      sub: workosUserId,
      sid,
      exp: Math.floor(Date.now() / 1000) + 600,
    });
    return seal({ accessToken, user: { id: workosUserId, email, emailVerified: true } });
  }

  // These four were the only state-changing routes in the Worker with no CSRF
  // check at all — the ones that install, replace and revoke the credential
  // the workspace's model calls are billed to.
  const routes = [
    { method: 'POST', path: (ws: string) => `/w/${ws}/provider-keys`, body: { provider: 'anthropic', key: 'x'.repeat(40) } },
    { method: 'POST', path: (ws: string) => `/w/${ws}/provider-keys/${randomUUID()}/verify`, body: {} },
    { method: 'POST', path: (ws: string) => `/w/${ws}/provider-keys/${randomUUID()}/rotate`, body: { key: 'x'.repeat(40) } },
    { method: 'DELETE', path: (ws: string) => `/w/${ws}/provider-keys/${randomUUID()}`, body: undefined },
  ] as const;

  it('refuses every mutating key route when the cookie and header do not agree', async () => {
    const fx = await seedWorkspace();
    const { env } = workosEnv();
    const cookie = await adminCookie(fx);
    const token = randomUUID();

    for (const route of routes) {
      const missing = await call(env, route.path(fx.workspaceId), {
        method: route.method,
        headers: { cookie: `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${token}` },
        ...(route.body === undefined ? {} : { body: route.body }),
      });
      expect(missing.status).toBe(403);
      expect(((await missing.json()) as { reason: string }).reason).toBe('csrf_failed');

      const mismatched = await call(env, route.path(fx.workspaceId), {
        method: route.method,
        headers: {
          cookie: `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${token}`,
          [CSRF_HEADER]: randomUUID(),
        },
        ...(route.body === undefined ? {} : { body: route.body }),
      });
      expect(mismatched.status).toBe(403);
    }

    // Nothing reached the store by either attempt.
    const keys = await readTenant(fx.workspaceId, fx.adminId, (c) =>
      c.query(`SELECT id FROM workspace_provider_keys WHERE workspace_id = $1`, [fx.workspaceId]),
    );
    expect(keys.rowCount).toBe(0);
  });

  it('refuses a foreign Origin on a key route', async () => {
    const fx = await seedWorkspace();
    const { env } = workosEnv();
    const response = await call(env, `/w/${fx.workspaceId}/provider-keys`, {
      method: 'POST',
      origin: 'https://evil.example',
      body: { provider: 'anthropic', key: 'x'.repeat(40) },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason: string }).reason).toBe('forbidden_origin');
  });
});

// ---------------------------------------------------------------------------
// SR-4 · an invitation is matched against a *verified* address
// ---------------------------------------------------------------------------

describe('SR-4 · accepting an invitation requires a verified email', () => {
  async function pendingInvitation(fx: Fixture, email: string): Promise<string> {
    const id = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      const { setTenant } = await import('./helpers.js');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO invitations (id, workspace_id, email, role, expires_at, invited_by)
         VALUES ($1, $2, $3, 'member', now() + interval '7 days', $4)`,
        [id, fx.workspaceId, email.toLowerCase(), fx.adminId],
      );
      await c.query('COMMIT');
    });
    return id;
  }

  it('refuses a caller whose address is not verified, and admits them once it is', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv();
    const joinerId = randomUUID();
    const email = `joiner-${randomUUID().slice(0, 8)}@example.test`;
    // The route promised the *verified* email had to match and read the column
    // it selected for that exactly never: an identity provider that lets
    // someone sign up claiming an address without proving it turned "a
    // forwarded link does not admit the forwardee" into "whoever knows the
    // invited address can claim it".
    await withClient('owner', (c) =>
      c.query(`INSERT INTO users (id, email, email_verified, name) VALUES ($1, $2, false, 'Joiner')`, [
        joinerId,
        email,
      ]),
    );
    const token = await pendingInvitation(fx, email);

    const refused = await asUser(env, joinerId, `/invitations/${token}/accept`, { method: 'POST', body: {} });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { reason: string }).reason).toBe('email_unverified');

    const members = await readTenant(fx.workspaceId, fx.adminId, (c) =>
      c.query(`SELECT id FROM members WHERE workspace_id = $1 AND user_id = $2`, [fx.workspaceId, joinerId]),
    );
    expect(members.rowCount).toBe(0);

    await withClient('owner', (c) =>
      c.query(`UPDATE users SET email_verified = true WHERE id = $1`, [joinerId]),
    );
    const admitted = await asUser(env, joinerId, `/invitations/${token}/accept`, { method: 'POST', body: {} });
    expect(admitted.status).toBe(200);
  });

  it('spends rate-limit budget on a wrong token, so the route is not a free guessing oracle', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv();
    const joinerId = randomUUID();
    await withClient('owner', (c) =>
      c.query(`INSERT INTO users (id, email, email_verified, name) VALUES ($1, $2, true, 'Guesser')`, [
        joinerId,
        `guesser-${randomUUID().slice(0, 8)}@example.test`,
      ]),
    );

    // The limit is 10 an hour. Each attempt names a token that does not exist,
    // so each one fails — and the point is that a failure still costs. The
    // counter is consumed on a plain client rather than inside a transaction
    // precisely so a wrong guess is not refunded.
    const reasons: string[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await asUser(env, joinerId, `/invitations/${randomUUID()}/accept`, {
        method: 'POST',
        body: {},
      });
      reasons.push(((await response.json()) as { reason: string }).reason);
    }
    expect(reasons.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 'invitation_unavailable'));
    expect(reasons.slice(10)).toEqual(['rate_limited', 'rate_limited']);
  });
});

// ---------------------------------------------------------------------------
// SR-5 · Traces obeys the session visibility rule
// ---------------------------------------------------------------------------

describe('SR-5 · a member cannot read another member’s run through Traces', () => {
  /** A run in the Admin's own session, which the Member has no share of. */
  async function seedRun(fx: Fixture): Promise<string> {
    const runId = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      const { setTenant } = await import('./helpers.js');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO runs (id, workspace_id, session_id, status, mode, model_id, attempt, client_turn_id)
         VALUES ($1, $2, $3, 'completed', 'work', 'deepseek-flash', 1, $4)`,
        [runId, fx.workspaceId, fx.sessionId, randomUUID()],
      );
      await c.query(
        `INSERT INTO run_turns (workspace_id, run_id, turn, seq, role, provider_message)
         VALUES ($1, $2, 1, 1, 'assistant', $3::jsonb)`,
        [
          fx.workspaceId,
          runId,
          JSON.stringify({ content: 'the applicant’s salary history is 91,000' }),
        ],
      );
      await c.query('COMMIT');
    });
    return runId;
  }

  it('hides a run in a session the caller cannot see, from the list and by id', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv();
    const runId = await seedRun(fx);

    // The owner sees their own run.
    const mine = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/traces`);
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { items: { run_id: string }[] }).items.map((i) => i.run_id)).toContain(runId);
    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/traces/${runId}`)).status).toBe(200);

    // The other member does not. The module's header claimed Traces was "not
    // new authority over anything" because every row was already readable
    // through `messages` — but `messages` is gated on ownership-or-share and
    // this was gated on workspace membership alone, so it handed every member
    // every session's run titles and, by id, the tool arguments and results
    // those runs were built from.
    const theirs = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/traces`);
    expect(theirs.status).toBe(200);
    expect(((await theirs.json()) as { items: { run_id: string }[] }).items.map((i) => i.run_id)).not.toContain(
      runId,
    );

    const byId = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/traces/${runId}`);
    // 404 rather than 403, for the reason the tenant transaction answers 404 to
    // a non-member: whether it exists is itself the thing being withheld.
    expect(byId.status).toBe(404);

    // `?session=` is not a way around it either.
    const targeted = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/traces?session=${fx.sessionId}`);
    expect(((await targeted.json()) as { items: unknown[] }).items).toEqual([]);
  });

  it('shows the run once the session is shared', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv();
    const runId = await seedRun(fx);
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      const { setTenant } = await import('./helpers.js');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO session_shares (workspace_id, session_id, token_hash, created_by, audience, message_cutoff_seq)
         VALUES ($1, $2, $3, $4, 'link', 1000)`,
        [fx.workspaceId, fx.sessionId, randomUUID(), fx.adminId],
      );
      await c.query('COMMIT');
    });

    const theirs = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/traces`);
    expect(((await theirs.json()) as { items: { run_id: string }[] }).items.map((i) => i.run_id)).toContain(runId);
  });
});

// ---------------------------------------------------------------------------
// SR-6 · the allowed-origin list is what the key routes check against
// ---------------------------------------------------------------------------

describe('SR-6 · the Origin allowlist', () => {
  it('is the configured list, not any origin that looks like ours', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv();
    for (const origin of [`${ALLOWED_ORIGIN}.evil.example`, `https://evil.example/${ALLOWED_ORIGIN}`]) {
      const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/sessions`, {
        method: 'POST',
        origin,
        body: { title: 'x' },
      });
      expect(response.status).toBe(403);
    }
  });
});
