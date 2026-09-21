// `POST /demo/request-access` against the real schema: the passcode gate, the
// domain allowlist, the persistent budget, and the rows the invitation path
// writes on behalf of the earliest Admin.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { DEMO_ACCESS_BUDGET } from '../../src/routes/demo-access.js';
import { call, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, withClient, type Fixture } from './helpers.js';

const PASSCODE = 'open-sesame';

function demoEnv(fx: Fixture, overrides: Partial<Env> = {}): Env {
  return makeEnv({
    DEMO_ACCESS_PASSCODE: PASSCODE,
    DEMO_ACCESS_WORKSPACE_ID: fx.workspaceId,
    DEMO_ACCESS_ALLOWED_DOMAINS: 'nous.example',
    ...overrides,
  }).env;
}

let caller = 0;
/** Each test is its own visitor, so the per-caller budget never crosses tests. */
function request(env: Env, body: unknown, ip = `10.0.${++caller}.1`): Promise<Response> {
  return call(env, '/demo/request-access', { method: 'POST', body, headers: { 'x-forwarded-for': ip } });
}

const freshEmail = (): string => `guest-${randomUUID().slice(0, 8)}@nous.example`;

async function invitationsFor(fx: Fixture, email: string) {
  return readTenant(fx.workspaceId, fx.adminId, async (c) => {
    const { rows } = await c.query<{ id: string; status: string; role: string; invited_by: string }>(
      `SELECT id, status, role, invited_by FROM invitations
        WHERE workspace_id = $1 AND email = $2 ORDER BY created_at ASC`,
      [fx.workspaceId, email],
    );
    return rows;
  });
}

async function attemptsFor(email: string): Promise<string[]> {
  return withClient('owner', async (c) => {
    const { rows } = await c.query<{ outcome: string }>(
      `SELECT outcome FROM demo_access_requests WHERE email = $1 ORDER BY created_at ASC`,
      [email],
    );
    return rows.map((row) => row.outcome);
  });
}

describe('POST /demo/request-access', () => {
  it('invites nobody until the passcode and workspace are configured', async () => {
    const fx = await seedWorkspace();
    const response = await request(makeEnv().env, { email: freshEmail(), passcode: PASSCODE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'unavailable', reason: 'demo_access_not_configured' });
    void fx;
  });

  it('refuses a wrong passcode and remembers the attempt', async () => {
    const fx = await seedWorkspace();
    const email = freshEmail();
    const response = await request(demoEnv(fx), { email, passcode: 'nope' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'demo_passcode_invalid' });
    expect(await invitationsFor(fx, email)).toEqual([]);
    expect(await attemptsFor(email)).toEqual(['passcode_invalid']);
  });

  it('refuses an address outside the allowlist without naming the allowed domains', async () => {
    const fx = await seedWorkspace();
    const email = `guest-${randomUUID().slice(0, 8)}@elsewhere.example`;
    const response = await request(demoEnv(fx), { email, passcode: PASSCODE });
    expect(response.status).toBe(403);
    const body = await response.json() as { error: string; reason: string };
    expect(body.reason).toBe('demo_domain_not_allowed');
    expect(body.error).not.toContain('nous.example');
    expect(await invitationsFor(fx, email)).toEqual([]);
  });

  it('creates the Admin-path invitation as a Member, signed by the earliest Admin, audited as system', async () => {
    const fx = await seedWorkspace();
    const email = freshEmail();
    const response = await request(demoEnv(fx), { email: email.toUpperCase(), passcode: PASSCODE });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'invited', email });

    const rows = await invitationsFor(fx, email);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', role: 'member', invited_by: fx.adminId });

    const audit = await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const { rows: events } = await c.query<{ actor_type: string; actor_user_id: string | null }>(
        `SELECT actor_type, actor_user_id FROM events
          WHERE workspace_id = $1 AND kind = 'member.invited' AND invitation_id = $2`,
        [fx.workspaceId, rows[0]!.id],
      );
      return events;
    });
    expect(audit).toEqual([{ actor_type: 'system', actor_user_id: null }]);
    expect(await attemptsFor(email)).toEqual(['invited']);
  });

  it('resends instead of stacking a second pending invitation', async () => {
    const fx = await seedWorkspace();
    const email = freshEmail();
    const env = demoEnv(fx);
    expect((await request(env, { email, passcode: PASSCODE })).status).toBe(200);
    const again = await request(env, { email, passcode: PASSCODE });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'invited', email });

    const rows = await invitationsFor(fx, email);
    expect(rows.map((row) => row.status)).toEqual(['resent', 'pending']);
    expect(await attemptsFor(email)).toEqual(['invited', 'resent']);
  });

  it('tells an active member to sign in, only after the passcode matched', async () => {
    const fx = await seedWorkspace();
    const email = await withClient('owner', async (c) => {
      const { rows } = await c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [fx.memberId]);
      return rows[0]!.email;
    });
    const env = demoEnv(fx, { DEMO_ACCESS_ALLOWED_DOMAINS: '' });

    const wrong = await request(env, { email, passcode: 'nope' });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toMatchObject({ reason: 'demo_passcode_invalid' });

    const right = await request(env, { email, passcode: PASSCODE });
    expect(right.status).toBe(200);
    expect(await right.json()).toEqual({ status: 'already_member', email });
    expect(await invitationsFor(fx, email)).toEqual([]);
  });

  it('spends the per-address budget on wrong guesses and then refuses for an hour', async () => {
    const fx = await seedWorkspace();
    const email = freshEmail();
    const env = demoEnv(fx);
    const ip = '10.9.9.9';
    for (let attempt = 0; attempt < DEMO_ACCESS_BUDGET.perEmail; attempt += 1) {
      expect((await request(env, { email, passcode: 'nope' }, ip)).status).toBe(403);
    }
    const limited = await request(env, { email, passcode: PASSCODE }, ip);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe(String(DEMO_ACCESS_BUDGET.windowSeconds));
    expect(await limited.json()).toMatchObject({ reason: 'rate_limited' });
    expect(await invitationsFor(fx, email)).toEqual([]);
  });

  it('rejects a malformed address before touching the budget', async () => {
    const fx = await seedWorkspace();
    const response = await request(demoEnv(fx), { email: 'not-an-address', passcode: PASSCODE });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ reason: 'bad_email' });
    expect(await attemptsFor('not-an-address')).toEqual([]);
  });
});
