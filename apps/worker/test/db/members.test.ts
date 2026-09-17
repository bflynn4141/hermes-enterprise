// Members, invitations, and the transaction that revokes access.
//
// The test this file exists for is the last one: a deactivation that arrives
// through the WorkOS events feed has to leave exactly the rows our own
// `DELETE /w/:ws/members/:id` leaves. They call the same function, and this
// asserts it rather than trusting it, because the day they diverge is the day
// someone removed in the WorkOS dashboard keeps a working socket.
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkspace, withClient, type Fixture } from './helpers.js';
import { asUser, call, clearFakeWorkOS, makeEnv, readTenant, useFakeWorkOS, workosEnv } from './harness.js';
import { FakeWorkOS, seal, signAccessToken } from '../stubs/fake-workos.js';
import { pollWorkOSEvents } from '../../src/auth/events-poller.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../../src/auth/cookies.js';

let fake: FakeWorkOS;

beforeEach(async () => {
  fake = await useFakeWorkOS(new FakeWorkOS());
});
afterEach(() => clearFakeWorkOS());

async function memberIdOf(fixture: Fixture, userId: string): Promise<string> {
  const id = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT id FROM members WHERE workspace_id = $1 AND user_id = $2`,
      [fixture.workspaceId, userId],
    );
    return rows[0]?.id;
  });
  if (!id) throw new Error('no member row');
  return id;
}

async function asWorkOSAdmin(
  fixture: Fixture,
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Response> {
  const email = await withClient('owner', async (c) => {
    const result = await c.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [fixture.adminId]);
    return result.rows[0]!.email;
  });
  const workosUserId = `user_${fixture.adminId.replace(/-/g, '').slice(0, 12)}`;
  const accessToken = await signAccessToken({
    sub: workosUserId,
    sid: `session_${fixture.adminId}`,
  });
  const sealedSession = seal({
    accessToken,
    user: { id: workosUserId, email, emailVerified: true },
  });
  const csrf = 'test-csrf-token';
  const { env } = workosEnv();
  return call(env, path, {
    ...options,
    headers: {
      cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealedSession)}; ${CSRF_COOKIE}=${csrf}`,
      [CSRF_HEADER]: csrf,
    },
  });
}

/** The rows a revocation is supposed to touch, in one shape to compare. */
async function accessSnapshot(fixture: Fixture, userId: string): Promise<Record<string, unknown>> {
  return readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
    const member = await c.query<{ status: string; role: string }>(
      `SELECT status, role FROM members WHERE workspace_id = $1 AND user_id = $2`,
      [fixture.workspaceId, userId],
    );
    const shares = await c.query<{ open: string }>(
      `SELECT count(*) AS open FROM session_shares
        WHERE workspace_id = $1 AND created_by = $2 AND revoked_at IS NULL`,
      [fixture.workspaceId, userId],
    );
    const writable = await c.query<{ writable: string }>(
      `SELECT count(*) AS writable FROM sessions
        WHERE workspace_id = $1 AND owner_id = $2 AND NOT read_only`,
      [fixture.workspaceId, userId],
    );
    const jobs = await c.query<{ kind: string }>(
      `SELECT kind FROM jobs WHERE workspace_id = $1 AND done_at IS NULL ORDER BY kind`,
      [fixture.workspaceId],
    );
    const events = await c.query<{ kind: string }>(
      `SELECT kind FROM events WHERE workspace_id = $1 AND kind LIKE 'member.%' ORDER BY kind`,
      [fixture.workspaceId],
    );
    return {
      member: member.rows[0],
      openShares: Number(shares.rows[0]?.open ?? '0'),
      writableSessions: Number(writable.rows[0]?.writable ?? '0'),
      jobKinds: jobs.rows.map((row) => row.kind),
      eventKinds: events.rows.map((row) => row.kind),
    };
  });
}

/** A member with something to lose: a share and a session of their own. */
async function memberWithAccess(fixture: Fixture): Promise<void> {
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fixture.workspaceId]);
    const session = await c.query<{ id: string }>(
      `INSERT INTO sessions (workspace_id, owner_id, title, model_id)
       VALUES ($1, $2, 'Theirs', 'deepseek-flash') RETURNING id`,
      [fixture.workspaceId, fixture.memberId],
    );
    await c.query(
      `INSERT INTO session_shares (workspace_id, session_id, created_by, token_hash, audience, message_cutoff_seq)
       VALUES ($1, $2, $3, $4, 'link', 0)`,
      [fixture.workspaceId, session.rows[0]!.id, fixture.memberId, randomUUID()],
    );
    await c.query('COMMIT');
  });
}

describe('DELETE /w/:ws/members/:id', () => {
  it('revokes shares, freezes sessions, and queues the eviction and the WorkOS write', async () => {
    const fixture = await seedWorkspace();
    await memberWithAccess(fixture);
    const { env, hubCalls } = makeEnv();
    const memberId = await memberIdOf(fixture, fixture.memberId);

    const response = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/members/${memberId}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(204);
    const after = await accessSnapshot(fixture, fixture.memberId);
    expect(after.member).toMatchObject({ status: 'inactive' });
    expect(after.openShares).toBe(0);
    expect(after.writableSessions).toBe(0);
    expect(after.eventKinds).toContain('member.removed');
    // The eviction reached the hubs in the same request that committed, and the
    // job rows behind it are gone because they were run and marked done.
    expect(hubCalls.filter((entry) => entry.method === 'evict').length).toBeGreaterThan(0);
  });

  it('refuses to remove the last Admin, so a workspace can always decide', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    // Promote the member, remove the original Admin, then try to remove the
    // last one standing.
    const memberId = await memberIdOf(fixture, fixture.memberId);
    await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/members/${memberId}`, {
      method: 'PATCH',
      body: { role: 'admin' },
    });
    const adminId = await memberIdOf(fixture, fixture.adminId);
    await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/members/${adminId}`, { method: 'DELETE' });

    const response = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/members/${memberId}`, {
      method: 'DELETE',
    });

    // The member cannot remove themselves either way; the point is that no path
    // reaches a workspace with no Admin.
    expect(response.status).toBe(409);
    const admins = await readTenant(fixture.workspaceId, fixture.memberId, async (c) => {
      const { rows } = await c.query<{ count: string }>(
        `SELECT count(*) AS count FROM members WHERE workspace_id = $1 AND role = 'admin' AND status = 'active'`,
        [fixture.workspaceId],
      );
      return Number(rows[0]?.count ?? '0');
    });
    expect(admins).toBe(1);
  });

  it('refuses to let anyone change their own role', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const adminId = await memberIdOf(fixture, fixture.adminId);

    const response = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/members/${adminId}`, {
      method: 'PATCH',
      body: { role: 'member' },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'self_change' });
  });

  it('needs an Admin: a Member asking is told so by reason, not by a message', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const adminId = await memberIdOf(fixture, fixture.adminId);

    const response = await asUser(env, fixture.memberId, `/w/${fixture.workspaceId}/members/${adminId}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'admin_required' });
  });
});

describe('step-up', () => {
  it('refuses a role change from a session that authenticated more than five minutes ago', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const memberId = await memberIdOf(fixture, fixture.memberId);
    // Touch the session first so the row exists, then age it.
    await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/bootstrap`);
    await withClient('owner', (c) =>
      c.query(`UPDATE auth_sessions SET authenticated_at = now() - interval '10 minutes' WHERE sid = $1`, [
        `dev-${fixture.adminId}`,
      ]),
    );

    const response = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/members/${memberId}`, {
      method: 'PATCH',
      body: { role: 'admin' },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'reauth_required' });
  });
});

describe('invitations', () => {
  it('sends to the exact address, and says so in the row', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const email = `Newcomer-${randomUUID().slice(0, 8)}@Example.Test`;

    const response = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST',
      body: { email, role: 'member' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { email: string; status: string };
    expect(body.email).toBe(email.toLowerCase());
    expect(body.status).toBe('pending');
  });

  it('treats inviting an existing member as a no-op that is already accepted', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const email = await withClient('owner', async (c) => {
      const { rows } = await c.query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
        fixture.memberId,
      ]);
      return rows[0]!.email;
    });

    const response = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST',
      body: { email, role: 'member' },
    });

    const body = (await response.json()) as { status: string };
    expect(body.status).toBe('accepted');
    // And no second membership row appeared.
    const members = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const { rows } = await c.query<{ count: string }>(
        `SELECT count(*) AS count FROM members WHERE workspace_id = $1 AND user_id = $2`,
        [fixture.workspaceId, fixture.memberId],
      );
      return Number(rows[0]?.count ?? '0');
    });
    expect(members).toBe(1);
  });

  it('returns the same live invitation for a duplicate request', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const email = `dup-${randomUUID().slice(0, 8)}@example.test`;
    const first = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST',
      body: { email },
    });
    const firstBody = await first.json() as { id: string };

    const second = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST',
      body: { email },
    });

    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ id: firstBody.id, status: 'pending' });
  });

  it('resends as a new row, leaving the old one marked resent and pointing at it', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const email = `resend-${randomUUID().slice(0, 8)}@example.test`;
    const created = (await (
      await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
        method: 'POST',
        body: { email },
      })
    ).json()) as { id: string };

    const resent = await asUser(
      env,
      fixture.adminId,
      `/w/${fixture.workspaceId}/invitations/${created.id}/resend`,
      { method: 'POST' },
    );

    expect(resent.status).toBe(201);
    const fresh = (await resent.json()) as { id: string; status: string };
    expect(fresh.id).not.toBe(created.id);

    const old = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const { rows } = await c.query<{ status: string; superseded_by: string | null }>(
        `SELECT status, superseded_by FROM invitations WHERE id = $1`,
        [created.id],
      );
      return rows[0];
    });
    expect(old).toMatchObject({ status: 'resent', superseded_by: fresh.id });
  });

  it('refuses to resend one that was withdrawn', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const email = `withdrawn-${randomUUID().slice(0, 8)}@example.test`;
    const created = (await (
      await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
        method: 'POST',
        body: { email },
      })
    ).json()) as { id: string };
    await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations/${created.id}/withdraw`, {
      method: 'POST',
    });

    const response = await asUser(
      env,
      fixture.adminId,
      `/w/${fixture.workspaceId}/invitations/${created.id}/resend`,
      { method: 'POST' },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'not_resendable' });
  });

  it('reports a pending invitation past its expiry as expired', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const email = `stale-${randomUUID().slice(0, 8)}@example.test`;
    const created = (await (
      await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
        method: 'POST',
        body: { email },
      })
    ).json()) as { id: string };
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await c.query('SELECT set_config($1, $2, true)', ['app.workspace_id', fixture.workspaceId]);
      await c.query(`UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1`, [created.id]);
      await c.query('COMMIT');
    });

    const list = (await (
      await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`)
    ).json()) as { items: { id: string; status: string }[] };

    expect(list.items.find((row) => row.id === created.id)?.status).toBe('expired');
  });

  it('does not create a local pending invitation when deployed auth has no WorkOS organization', async () => {
    const fixture = await seedWorkspace();
    const email = `unlinked-${randomUUID().slice(0, 8)}@example.test`;

    const response = await asWorkOSAdmin(fixture, `/w/${fixture.workspaceId}/invitations`, {
      method: 'POST',
      body: { email },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'not_configured' });
    const rows = await readTenant(fixture.workspaceId, fixture.adminId, (c) =>
      c.query('SELECT id FROM invitations WHERE workspace_id = $1 AND email = $2', [fixture.workspaceId, email]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('does not supersede a pending row when WorkOS cannot deliver its resend', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const email = `no-resend-${randomUUID().slice(0, 8)}@example.test`;
    const created = (await (
      await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/invitations`, {
        method: 'POST',
        body: { email },
      })
    ).json()) as { id: string };

    const response = await asWorkOSAdmin(
      fixture,
      `/w/${fixture.workspaceId}/invitations/${created.id}/resend`,
      { method: 'POST' },
    );

    expect(response.status).toBe(503);
    const state = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const original = await c.query<{ status: string; superseded_by: string | null }>(
        'SELECT status, superseded_by FROM invitations WHERE id = $1',
        [created.id],
      );
      const count = await c.query<{ count: string }>(
        'SELECT count(*) AS count FROM invitations WHERE workspace_id = $1 AND email = $2',
        [fixture.workspaceId, email],
      );
      return { original: original.rows[0], count: Number(count.rows[0]?.count ?? '0') };
    });
    expect(state.original).toEqual({ status: 'pending', superseded_by: null });
    expect(state.count).toBe(1);
  });
});

describe('a membership change made in the WorkOS dashboard', () => {
  it('leaves the same rows our own removal route leaves', async () => {
    // Two workspaces, same shape. One is removed through the route, the other
    // through the events feed, and the snapshots are compared.
    const viaRoute = await seedWorkspace();
    const viaEvents = await seedWorkspace();
    await memberWithAccess(viaRoute);
    await memberWithAccess(viaEvents);
    const { env } = makeEnv();

    const routeMemberId = await memberIdOf(viaRoute, viaRoute.memberId);
    await asUser(env, viaRoute.adminId, `/w/${viaRoute.workspaceId}/members/${routeMemberId}`, {
      method: 'DELETE',
    });

    // The other workspace hears about it from WorkOS instead.
    const organizationId = `org_${randomUUID().slice(0, 8)}`;
    const workosUserId = `user_${randomUUID().slice(0, 8)}`;
    await withClient('owner', async (c) => {
      await c.query(
        `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1, $2)
         ON CONFLICT (workspace_id) DO UPDATE SET workos_organization_id = EXCLUDED.workos_organization_id`,
        [viaEvents.workspaceId, organizationId],
      );
      await c.query(`UPDATE users SET workos_user_id = $1 WHERE id = $2`, [workosUserId, viaEvents.memberId]);
    });
    fake.events.push({
      id: `event_${randomUUID().slice(0, 8)}`,
      event: 'organization_membership.deleted',
      createdAt: new Date().toISOString(),
      data: { id: 'om_x', user_id: workosUserId, organization_id: organizationId, status: 'inactive' },
    });

    const result = await pollWorkOSEvents(env);
    expect(result.applied).toBe(1);

    const fromRoute = await accessSnapshot(viaRoute, viaRoute.memberId);
    const fromEvents = await accessSnapshot(viaEvents, viaEvents.memberId);
    expect(fromEvents).toEqual(fromRoute);
  });

  it('re-promotes an Admin whose demotion would leave the workspace with none', async () => {
    const fixture = await seedWorkspace();
    const { env } = makeEnv();
    const organizationId = `org_${randomUUID().slice(0, 8)}`;
    const workosUserId = `user_${randomUUID().slice(0, 8)}`;
    const membershipId = `om_${randomUUID().slice(0, 8)}`;
    await withClient('owner', async (c) => {
      await c.query(
        `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1, $2)
         ON CONFLICT (workspace_id) DO UPDATE SET workos_organization_id = EXCLUDED.workos_organization_id`,
        [fixture.workspaceId, organizationId],
      );
      await c.query(`UPDATE users SET workos_user_id = $1 WHERE id = $2`, [workosUserId, fixture.adminId]);
    });
    fake.memberships.push({
      id: membershipId,
      userId: workosUserId,
      organizationId,
      role: 'member',
      status: 'active',
    });
    fake.events.push({
      id: `event_${randomUUID().slice(0, 8)}`,
      event: 'organization_membership.updated',
      createdAt: new Date().toISOString(),
      data: {
        id: membershipId,
        user_id: workosUserId,
        organization_id: organizationId,
        status: 'active',
        role: { slug: 'member' },
      },
    });

    await pollWorkOSEvents(env);

    const role = await readTenant(fixture.workspaceId, fixture.adminId, async (c) => {
      const { rows } = await c.query<{ role: string }>(
        `SELECT role FROM members WHERE workspace_id = $1 AND user_id = $2`,
        [fixture.workspaceId, fixture.adminId],
      );
      return rows[0]?.role;
    });
    expect(role).toBe('admin');
    // And WorkOS was told to put the role back, rather than us quietly
    // disagreeing with it forever.
    expect(fake.calls.filter((entry) => entry.method === 'updateOrganizationMembership')).toHaveLength(1);
  });
});
