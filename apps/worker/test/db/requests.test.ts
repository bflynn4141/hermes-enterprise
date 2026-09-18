// The Inbox's read routes, the review note, and the CSRF guard.
//
// The CSRF test runs in `AUTH_MODE=workos`, because that is the only mode where
// a double-submit token means anything: in fake mode the caller authenticates
// with a header, which a foreign page cannot set in the first place. Running it
// in the mode it applies to costs a sealed cookie and is the only way the test
// is about the guard rather than about the early return.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { asUser, call, clearFakeWorkOS, makeEnv, readTenant, useFakeWorkOS, workosEnv } from './harness.js';
import { seedWorkspace, withClient, type Fixture } from './helpers.js';
import { FakeQueue } from '../stubs/fake-r2.js';
import { FakeWorkOS, seal, signAccessToken } from '../stubs/fake-workos.js';
import { SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER } from '../../src/auth/cookies.js';
import { INBOX_HEADERS, seedQueue, seedRequest } from './m4-fixtures.js';

const env = () => makeEnv({ RENDERS_QUEUE: new FakeQueue() } as never);

describe('GET /w/:ws/requests', () => {
  it('filters by status, by kind and by label', async () => {
    const fx = await seedWorkspace();
    const { env: e } = env();
    await seedQueue(fx);

    const all = (await (await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests`)).json()) as {
      items: { kind: string; label: string; subject: string | null; title: string | null }[];
    };
    expect(all.items).toHaveLength(4);

    const applications = (await (
      await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests?kind=application`)
    ).json()) as { items: { subject: string; title: string }[] };
    expect(applications.items).toHaveLength(2);
    // Subject and title are derived from the payload, not stored twice.
    expect(applications.items[0]).toMatchObject({ subject: 'Owen Blake', title: 'Delivery partner' });

    const pending = (await (
      await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests?status=pending`)
    ).json()) as { items: unknown[] };
    expect(pending.items).toHaveLength(4);

    const search = (await (await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests?q=leah`)).json()) as {
      items: { label: string }[];
    };
    expect(search.items).toHaveLength(1);
    expect(search.items[0]?.label).toBe('Leah Martinez');
  });

  it('queues a bounded triage batch without running model work in the read request', async () => {
    const fx = await seedWorkspace();
    const { env: e } = env();
    e.INBOX_TRIAGE_MODE = 'shadow';
    for (let index = 0; index < 7; index += 1) {
      await seedRequest(fx, 'application', { label: `Candidate ${index}` });
    }

    const response = await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests?status=pending`);
    expect(response.status).toBe(200);
    const jobs = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const { rows } = await client.query<{ attempts: number }>(
        `SELECT attempts FROM jobs WHERE kind = 'request_triage' ORDER BY created_at`,
      );
      return rows;
    });
    expect(jobs).toHaveLength(5);
    expect(jobs.every((job) => job.attempts === 0)).toBe(true);
  });

  it('queues fresh triage work when the rubric changes without duplicating the same configuration', async () => {
    const fx = await seedWorkspace();
    const { env: e } = env();
    e.INBOX_TRIAGE_MODE = 'shadow';
    await seedRequest(fx, 'application', { label: 'Candidate' });

    await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests?status=pending`);
    e.INBOX_TRIAGE_RUBRIC_VERSION = '2';
    await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests?status=pending`);
    await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests?status=pending`);

    const keys = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const { rows } = await client.query<{ key: string }>(
        `SELECT key FROM jobs WHERE kind = 'request_triage' ORDER BY key`,
      );
      return rows.map((row) => row.key);
    });
    expect(keys).toHaveLength(2);
    expect(keys).toEqual(expect.arrayContaining([
      expect.stringContaining(':1:jev-latest'),
      expect.stringContaining(':2:jev-latest'),
    ]));
  });

  it('carries the payload, its sources and what the model could not find', async () => {
    const fx = await seedWorkspace();
    const { env: e } = env();
    const requestId = await seedRequest(fx, 'application');

    const response = await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sources: { id: string; name: string }[];
      missing: string[];
      payload: { score: number };
      decision_id: string | null;
    };
    expect(body.sources).toEqual([{ id: 'site', name: 'Website', note: 'Checked 2026-09-01' }]);
    expect(body.missing).toEqual(['Customer impact']);
    expect(body.payload.score).toBe(82);
    expect(body.decision_id).toBeNull();
  });

  it('shows the decision and who made it once one exists', async () => {
    const fx = await seedWorkspace();
    const { env: e } = env();
    const requestId = await seedRequest(fx, 'application');
    await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: INBOX_HEADERS,
      body: { decision: 'approve' },
    });

    const body = (await (await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}`)).json()) as {
      status: string;
      decision_id: string | null;
      decided_by_name: string | null;
    };
    expect(body.status).toBe('admitted');
    expect(body.decision_id).not.toBeNull();
    expect(body.decided_by_name).toBe('Maya Chen');
  });
});

describe('POST /w/:ws/requests/:id/notes', () => {
  it('records a human review note beside the agent’s, and never sends it', async () => {
    const fx = await seedWorkspace();
    const { env: e } = env();
    const requestId = await seedRequest(fx, 'application');

    // The agent's own note, written the way `save_review_note` writes one.
    await withClient('agent', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fx.workspaceId]);
      await c.query(
        `INSERT INTO request_notes (workspace_id, request_id, body, author_type) VALUES ($1, $2, $3, 'agent')`,
        [fx.workspaceId, requestId, 'Customer impact unverified.'],
      );
      await c.query('COMMIT');
    });

    const response = await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/notes`, {
      method: 'POST',
      body: { body: 'Spoke to Robin; the delivery evidence checks out.' },
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { note: string }).note).toBe(
      'Spoke to Robin; the delivery evidence checks out.',
    );

    const notes = await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const { rows } = await c.query<{ author_type: string }>(
        `SELECT author_type FROM request_notes WHERE request_id = $1 ORDER BY created_at`,
        [requestId],
      );
      return rows;
    });
    expect(notes.map((n) => n.author_type)).toEqual(['agent', 'user']);

    const empty = await asUser(e, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/notes`, {
      method: 'POST',
      body: { body: '   ' },
    });
    expect(empty.status).toBe(422);
  });
});

describe('the double-submit CSRF token, in the mode where it means something', () => {
  let fake: FakeWorkOS;
  beforeEach(async () => {
    fake = await useFakeWorkOS(new FakeWorkOS());
  });
  afterEach(() => clearFakeWorkOS());

  /** A live sealed cookie for the workspace's seeded Admin. */
  async function adminCookie(fx: Fixture): Promise<string> {
    const email = await withClient('owner', async (c) => {
      const { rows } = await c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [fx.adminId]);
      return rows[0]!.email;
    });
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

  it('refuses a decision whose cookie and header do not agree', async () => {
    const fx = await seedWorkspace();
    const { env: e } = workosEnv({ RENDERS_QUEUE: new FakeQueue() } as never);
    const requestId = await seedRequest(fx, 'application');
    const cookie = await adminCookie(fx);
    const token = randomUUID();

    const without = await call(e, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${token}`, ...INBOX_HEADERS },
      body: { decision: 'approve' },
    });
    expect(without.status).toBe(403);
    expect(((await without.json()) as { reason: string }).reason).toBe('csrf_failed');

    const mismatched = await call(e, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${token}`,
        [CSRF_HEADER]: randomUUID(),
        ...INBOX_HEADERS,
      },
      body: { decision: 'approve' },
    });
    expect(mismatched.status).toBe(403);

    // Nothing was recorded by either attempt.
    const still = await readTenant(fx.workspaceId, fx.adminId, (c) =>
      c.query<{ status: string }>(`SELECT status FROM requests WHERE id = $1`, [requestId]),
    );
    expect(still.rows[0]?.status).toBe('pending');

    // With the token, the same request is recorded.
    const matched = await call(e, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${cookie}; ${CSRF_COOKIE}=${token}`,
        [CSRF_HEADER]: token,
        ...INBOX_HEADERS,
      },
      body: { decision: 'approve' },
    });
    expect(matched.status).toBe(201);
  });
});
