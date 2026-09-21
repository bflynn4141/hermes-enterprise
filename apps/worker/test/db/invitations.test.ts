// Finding an invitation without the emailed link.
//
// Two reads that take no tenant in their path: the picker's "who has invited
// me?" (`GET /auth/session` with no `?ws`) and the join page's "what is this
// link for?" (`GET /invitations/:token`). Both are answered under the invited
// workspace's own row-level security after a platform-side lookup, and both
// match the session's *verified* email — the tests here are about what they
// refuse to reveal as much as what they show.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { asUser, call, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

async function seedUser(email: string, options: { verified?: boolean; name?: string } = {}): Promise<string> {
  const id = randomUUID();
  await withClient('owner', (c) => c.query(
    `INSERT INTO users (id, email, email_verified, name) VALUES ($1, $2, $3, $4)`,
    [id, email, options.verified ?? true, options.name ?? 'Invitee'],
  ));
  return id;
}

async function invite(fx: Fixture, email: string, roleTemplateKey?: 'partnerships-agent' | 'finance-agent'): Promise<string> {
  const { env } = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: roleTemplateKey ? '1' : '0' });
  const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations`, { method: 'POST', body: {
    email, role: 'member', ...(roleTemplateKey ? { role_template_key: roleTemplateKey } : {}),
  } });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json() as { id: string }).id;
}

describe('the workspace picker lists pending invitations', () => {
  it('shows an invitation to its verified addressee and to nobody else', async () => {
    const fx = await seedWorkspace();
    const email = `invitee-${randomUUID().slice(0, 8)}@example.test`;
    const invitationId = await invite(fx, email, 'partnerships-agent');
    const invitee = await seedUser(email);
    const { env } = makeEnv();

    const listed = await asUser(env, invitee, '/auth/session');
    expect(listed.status, await listed.clone().text()).toBe(200);
    const body = await listed.json() as { workspaces: unknown[]; invitations: Array<Record<string, unknown>> };
    expect(body.workspaces).toEqual([]);
    expect(body.invitations).toHaveLength(1);
    expect(body.invitations[0]).toMatchObject({
      token: invitationId,
      workspace: { id: fx.workspaceId },
      role: 'member',
      role_template_key: 'partnerships-agent',
      invited_by: 'Maya Chen',
    });
    // Never the address, never a provider id.
    expect(JSON.stringify(body.invitations)).not.toContain(email);
    expect(body.invitations[0]).not.toHaveProperty('email');

    // A different verified person: no membership, no invitations, the same
    // 404 the picker has always shown for "in no workspace yet".
    const stranger = await seedUser(`stranger-${randomUUID().slice(0, 8)}@example.test`);
    const other = await asUser(env, stranger, '/auth/session');
    expect(other.status).toBe(404);
    expect(await other.json()).toMatchObject({ reason: 'no_workspace' });

    // The same address, unverified: an unverified address is not an identity.
    const claimant = await seedUser(`unverified-${randomUUID().slice(0, 8)}@example.test`, { verified: false });
    await withClient('owner', (c) => c.query(`UPDATE users SET email=$2 WHERE id=$1`, [claimant, `x-${email}`]));
    const unverified = await asUser(env, claimant, '/auth/session');
    expect(unverified.status).toBe(404);
  });

  it('drops withdrawn and expired invitations, and lists invitations beside existing workspaces', async () => {
    const fx = await seedWorkspace();
    const other = await seedWorkspace();
    const email = `member-${randomUUID().slice(0, 8)}@example.test`;
    const invitee = await seedUser(email);
    // Already a member of `other`, invited to `fx`.
    await withClient('owner', async (c) => {
      await c.query('BEGIN'); await setTenant(c, other.workspaceId, other.adminId);
      await c.query(`INSERT INTO members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [other.workspaceId, invitee]);
      await c.query('COMMIT');
    });
    const live = await invite(fx, email);
    const { env } = makeEnv();

    const listed = await asUser(env, invitee, '/auth/session');
    const body = await listed.json() as { workspaces: Array<{ id: string }>; invitations: Array<{ token: string }> };
    expect(body.workspaces.map((row) => row.id)).toEqual([other.workspaceId]);
    expect(body.invitations.map((row) => row.token)).toEqual([live]);

    // Withdrawn: gone from the list the moment it stops being an invitation.
    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations/${live}/withdraw`, { method: 'POST' })).status).toBe(204);
    const afterWithdraw = await asUser(env, invitee, '/auth/session');
    expect((await afterWithdraw.json() as { invitations: unknown[] }).invitations).toEqual([]);

    // Expired but still `pending` in the row: not offered.
    const stale = await invite(fx, email);
    await withClient('owner', async (c) => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(`UPDATE invitations SET expires_at=now()-interval '1 hour' WHERE id=$1`, [stale]);
      await c.query('COMMIT');
    });
    const afterExpiry = await asUser(env, invitee, '/auth/session');
    expect((await afterExpiry.json() as { invitations: unknown[] }).invitations).toEqual([]);
  });
});

describe('GET /invitations/:token', () => {
  it('names the workspace for a valid token and refuses anything else', async () => {
    const fx = await seedWorkspace();
    const email = `preview-${randomUUID().slice(0, 8)}@example.test`;
    const invitationId = await invite(fx, email, 'partnerships-agent');
    const { env } = makeEnv();
    const workspaceName = await withClient('owner', async (c) => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      const name = (await c.query<{ name: string }>('SELECT name FROM workspaces WHERE id=$1', [fx.workspaceId])).rows[0]!.name;
      await c.query('ROLLBACK');
      return name;
    });

    // Signed out: the link is the secret, and the page needs the name before
    // it sends the person through sign-in.
    const anonymous = await call(env, `/invitations/${invitationId}`);
    expect(anonymous.status, await anonymous.clone().text()).toBe(200);
    const preview = await anonymous.json() as Record<string, unknown>;
    expect(preview).toMatchObject({
      token: invitationId,
      workspace: { id: fx.workspaceId, name: workspaceName },
      role: 'member',
      role_template_key: 'partnerships-agent',
      invited_by: 'Maya Chen',
    });
    expect(JSON.stringify(preview)).not.toContain(email);

    // Signed in as the addressee: the same answer.
    const invitee = await seedUser(email);
    const own = await asUser(env, invitee, `/invitations/${invitationId}`);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ workspace: { name: workspaceName } });

    // Signed in as someone else: a forwarded link reveals nothing, in the
    // words the accept uses.
    const stranger = await seedUser(`other-${randomUUID().slice(0, 8)}@example.test`);
    const forwarded = await asUser(env, stranger, `/invitations/${invitationId}`);
    expect(forwarded.status).toBe(403);
    const refusal = await forwarded.text();
    expect(JSON.parse(refusal)).toMatchObject({ reason: 'invitation_email_mismatch' });
    expect(refusal).not.toContain(workspaceName);

    // Unknown, withdrawn: one answer.
    const unknown = await call(env, `/invitations/${randomUUID()}`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ reason: 'invitation_unavailable' });
    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations/${invitationId}/withdraw`, { method: 'POST' })).status).toBe(204);
    const withdrawn = await call(env, `/invitations/${invitationId}`);
    expect(withdrawn.status).toBe(404);
  });
});
