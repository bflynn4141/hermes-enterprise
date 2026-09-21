import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asUser, call, clearFakeWorkOS, makeEnv, useFakeWorkOS } from './harness.js';
import { client, seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { drainJobs, runJobsAfterCommit, withWorkspaceTransaction } from '../../src/jobs.js';
import { FINANCE_CAPACITY_ROLE } from '../../src/runtime/discovery-grants.js';
import { hermesEnv, seedCapacity } from './capacity-fixture.js';
import { queueSetupInvitationDelivery } from '../../src/member-provisioning/service.js';
import { FakeWorkOS, seal, signAccessToken } from '../stubs/fake-workos.js';
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from '../../src/auth/cookies.js';
import type { Env } from '../../src/env.js';

/** The Hermes runtime with deployed WorkOS auth, the shape staging runs. */
const workosHermesEnv = (overrides: Partial<Env> = {}): Env => hermesEnv({
  AUTH_MODE: 'workos', WORKOS_API_KEY: 'sk_test', WORKOS_CLIENT_ID: 'client_test',
  WORKOS_COOKIE_PASSWORD: 'a'.repeat(32), HERMES_MEMBER_PROVISIONING_ENABLED: '1',
  ...overrides,
} as Partial<Env>);

async function linkOrganization(fx: Fixture): Promise<string> {
  const organizationId = `org_${randomUUID().slice(0, 12)}`;
  await withClient('owner', (c) => c.query(
    `INSERT INTO workspace_directory (workspace_id, workos_organization_id) VALUES ($1, $2)
     ON CONFLICT (workspace_id) DO UPDATE SET workos_organization_id = EXCLUDED.workos_organization_id`,
    [fx.workspaceId, organizationId],
  ));
  return organizationId;
}

/** A sealed WorkOS session for the fixture's Admin, the way members.test.ts builds one. */
async function asWorkOSAdmin(fx: Fixture, env: Env, path: string, options: { method?: string; body?: unknown } = {}): Promise<Response> {
  const email = await withClient('owner', async (c) =>
    (await c.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [fx.adminId])).rows[0]!.email);
  const workosUserId = `user_${fx.adminId.replace(/-/g, '').slice(0, 12)}`;
  const accessToken = await signAccessToken({ sub: workosUserId, sid: `session_${fx.adminId}` });
  const sealedSession = seal({ accessToken, user: { id: workosUserId, email, emailVerified: true } });
  const csrf = 'test-csrf-token';
  return call(env, path, {
    ...options,
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sealedSession)}; ${CSRF_COOKIE}=${csrf}`, [CSRF_HEADER]: csrf },
  });
}

async function seedQueuedProvisioningJob(
  fx: Awaited<ReturnType<typeof seedWorkspace>>,
  email: string,
  roleTemplateKey: 'partnerships-agent' | 'finance-agent' = 'partnerships-agent',
): Promise<{ invitationId: string; operationId: string; jobId: string }> {
  const invitationId = randomUUID();
  const operationId = randomUUID();
  const jobId = randomUUID();
  await withClient('app', async c => {
    await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
    await c.query(
      `INSERT INTO invitations(id,workspace_id,email,role,expires_at,invited_by,delivery_status)
       VALUES($1,$2,$3,'member',now()+interval '7 days',$4,'not_required')`,
      [invitationId, fx.workspaceId, email, fx.adminId],
    );
    await c.query(
      `INSERT INTO member_provisioning_operations(id,workspace_id,invitation_id,requested_by,role_template_key)
       VALUES($1,$2,$3,$4,$5)`,
      [operationId, fx.workspaceId, invitationId, fx.adminId, roleTemplateKey],
    );
    await c.query(
      `INSERT INTO jobs(id,workspace_id,kind,key,payload) VALUES($1,$2,'member_provision',$3,$4::jsonb)`,
      [jobId, fx.workspaceId, `member-provision:${operationId}:0`, JSON.stringify({ operation_id: operationId, revision: 0 })],
    );
    await c.query(`INSERT INTO job_ready(job_id,workspace_id) VALUES($1,$2)`, [jobId, fx.workspaceId]);
    await c.query('COMMIT');
  });
  return { invitationId, operationId, jobId };
}

describe('durable member provisioning', () => {
  afterEach(() => { vi.unstubAllGlobals(); clearFakeWorkOS(); });

  it('rejects a flag-off setup request before any invitation side effect', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '0', AGENT_RUNTIME: 'hermes' });
    const network = vi.fn(() => { throw new Error('A rejected setup request must not reach a provider'); });
    vi.stubGlobal('fetch', network);
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations`, { method: 'POST', body: {
      email: 'flag-off-finance@example.test', role: 'member', role_template_key: 'finance-agent',
    } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'member_setup_unavailable' });
    expect(network).not.toHaveBeenCalled();

    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT id FROM invitations WHERE email='flag-off-finance@example.test'`)).rows).toHaveLength(0);
      expect((await c.query('SELECT id FROM member_provisioning_operations')).rows).toHaveLength(0);
      expect((await c.query(`SELECT id FROM jobs WHERE payload->>'email'='flag-off-finance@example.test'`)).rows).toHaveLength(0);
      expect((await c.query(`SELECT id FROM events WHERE kind='member.invited'`)).rows).toHaveLength(0);
      expect((await c.query(`SELECT id FROM hermes_cloud_capacity WHERE state='reserved'`)).rows).toHaveLength(0);
      expect((await c.query(
        `SELECT user_id FROM rate_counters WHERE user_id=$1 AND workspace_id=$2 AND action='member.invite'`,
        [fx.adminId, fx.workspaceId],
      )).rows).toHaveLength(0);
      await c.query('COMMIT');
    });
  });

  it('rejects flag-on Finance before invitation, operation, job, reservation, event, or rate writes', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1', AGENT_RUNTIME: 'hermes' });
    const network = vi.fn(() => { throw new Error('An unavailable setup role must not reach a provider'); });
    vi.stubGlobal('fetch', network);
    const email = 'unsupported-finance@example.test';
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations`, { method: 'POST', body: {
      email, role: 'member', role_template_key: 'finance-agent',
    } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'member_setup_role_unavailable' });
    expect(network).not.toHaveBeenCalled();

    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT id FROM invitations WHERE email=$1`, [email])).rows).toHaveLength(0);
      expect((await c.query('SELECT id FROM member_provisioning_operations')).rows).toHaveLength(0);
      expect((await c.query(`SELECT id FROM jobs WHERE payload::text LIKE $1`, [`%${email}%`])).rows).toHaveLength(0);
      expect((await c.query(`SELECT id FROM events WHERE kind='member.invited'`)).rows).toHaveLength(0);
      expect((await c.query(`SELECT id FROM hermes_cloud_capacity WHERE state='reserved'`)).rows).toHaveLength(0);
      expect((await c.query(
        `SELECT user_id FROM rate_counters WHERE user_id=$1 AND workspace_id=$2 AND action='member.invite'`,
        [fx.adminId, fx.workspaceId],
      )).rows).toHaveLength(0);
      await c.query('COMMIT');
    });
  });

  it('records one safe background operation and makes no Cloud or WorkOS call', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1', AGENT_RUNTIME: 'hermes' });
    const network = vi.fn(() => { throw new Error('No external call is allowed in preparation'); });
    vi.stubGlobal('fetch', network);
    const path = `/w/${fx.workspaceId}/invitations`;
    const first = await asUser(env, fx.adminId, path, { method: 'POST', body: {
      email: 'new-partner@example.test', role: 'member', role_template_key: 'partnerships-agent',
    } });
    expect(first.status).toBe(201);
    const body = await first.json() as Record<string, unknown>;
    expect(body).toMatchObject({ email: 'new-partner@example.test', role_template_key: 'partnerships-agent' });
    expect(body).not.toHaveProperty('cloud_agent_id');
    expect(JSON.stringify(body)).not.toMatch(/token|credential|instance_id/i);

    const duplicate = await asUser(env, fx.adminId, path, { method: 'POST', body: {
      email: 'new-partner@example.test', role: 'member', role_template_key: 'partnerships-agent',
    } });
    expect(duplicate.status).toBe(200);
    expect(network).not.toHaveBeenCalled();

    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      const operations = await c.query(`SELECT preparation,issue,role_template_key,cancellation FROM member_provisioning_operations`);
      expect(operations.rows).toEqual([{ preparation: 'awaiting_connection', issue: 'cloud_not_connected', role_template_key: 'partnerships-agent', cancellation: 'none' }]);
      const delivery = await c.query(`SELECT delivery_status,workos_invitation_id FROM invitations WHERE email='new-partner@example.test'`);
      expect(delivery.rows).toEqual([{ delivery_status: 'not_required', workos_invitation_id: null }]);
      const sendJobs = await c.query(`SELECT id FROM jobs WHERE kind='workos_sync' AND payload->>'action' IN ('send_invitation','resend_invitation')`);
      expect(sendJobs.rows).toHaveLength(0);
      const expiryJobs = await c.query(`SELECT id FROM jobs WHERE kind='hermes_invitation_expire'`);
      expect(expiryJobs.rows).toHaveLength(0);
      await c.query('COMMIT');
    });
  });

  it('advertises legacy delivery or setup-only roles from the server flag', async () => {
    const fx = await seedWorkspace();
    const legacy = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '0' }).env;
    const setup = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1' }).env;

    const legacyBody = await (await asUser(legacy, fx.adminId, `/w/${fx.workspaceId}/bootstrap`)).json() as {
      capabilities: { member_invitations: unknown };
    };
    const setupBody = await (await asUser(setup, fx.adminId, `/w/${fx.workspaceId}/bootstrap`)).json() as {
      capabilities: { member_invitations: unknown };
    };
    expect(legacyBody.capabilities.member_invitations).toEqual({ mode: 'legacy_delivery', role_templates: [] });
    expect(setupBody.capabilities.member_invitations).toEqual({
      mode: 'setup_only', role_templates: ['partnerships-agent'],
    });
  });

  it('keeps duplicate invitation mode and role sticky without mutating the existing row', async () => {
    const fx = await seedWorkspace();
    const legacy = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '0' }).env;
    const setup = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1' }).env;
    const path = `/w/${fx.workspaceId}/invitations`;

    expect((await asUser(legacy, fx.adminId, path, { method: 'POST', body: {
      email: 'sticky-legacy@example.test', role: 'member',
    } })).status).toBe(201);
    const retrofit = await asUser(setup, fx.adminId, path, { method: 'POST', body: {
      email: 'sticky-legacy@example.test', role: 'member', role_template_key: 'partnerships-agent',
    } });
    expect(retrofit.status).toBe(409);
    expect(await retrofit.json()).toMatchObject({ reason: 'invitation_mode_conflict' });

    expect((await asUser(setup, fx.adminId, path, { method: 'POST', body: {
      email: 'sticky-role@example.test', role: 'member', role_template_key: 'partnerships-agent',
    } })).status).toBe(201);
    const unsupportedRole = await asUser(setup, fx.adminId, path, { method: 'POST', body: {
      email: 'sticky-role@example.test', role: 'member', role_template_key: 'finance-agent',
    } });
    expect(unsupportedRole.status).toBe(409);
    expect(await unsupportedRole.json()).toMatchObject({ reason: 'member_setup_role_unavailable' });

    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT count(*)::int AS count FROM invitations WHERE email='sticky-legacy@example.test'`)).rows)
        .toEqual([{ count: 1 }]);
      expect((await c.query(
        `SELECT op.role_template_key FROM member_provisioning_operations op
          JOIN invitations i ON i.id=op.invitation_id
         WHERE i.email='sticky-role@example.test'`,
      )).rows).toEqual([{ role_template_key: 'partnerships-agent' }]);
      expect((await c.query(
        `SELECT count(*)::int AS count FROM member_provisioning_operations op
          JOIN invitations i ON i.id=op.invitation_id
         WHERE i.email='sticky-legacy@example.test'`,
      )).rows).toEqual([{ count: 0 }]);
      await c.query('COMMIT');
    });
  });

  it('keeps setup-aware expiry visible as pending while delivery has not started', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1' });
    const created = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations`, { method: 'POST', body: {
      email: 'slow-setup@example.test', role: 'member', role_template_key: 'partnerships-agent',
    } });
    expect(created.status).toBe(201);
    const invitation = await created.json() as { id: string };
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(`UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1`, [invitation.id]);
      await c.query('COMMIT');
    });

    const listed = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations`);
    expect(listed.status).toBe(200);
    const body = await listed.json() as { items: Array<{ id: string; status: string; provisioning?: unknown }> };
    expect(body.items.find((row) => row.id === invitation.id)).toMatchObject({ status: 'pending' });
    expect(body.items.find((row) => row.id === invitation.id)).toHaveProperty('provisioning');
  });

  it('never downgrades an existing setup resend to legacy delivery while the flag is off', async () => {
    const fx = await seedWorkspace();
    const disabled = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '0', AGENT_RUNTIME: 'hermes' }).env;
    const seeded = await seedQueuedProvisioningJob(fx, 'paused-finance@example.test', 'finance-agent');
    const resend = await asUser(disabled, fx.adminId, `/w/${fx.workspaceId}/invitations/${seeded.invitationId}/resend`, {
      method: 'POST', body: {},
    });
    expect(resend.status).toBe(409);
    expect(await resend.json()).toMatchObject({ reason: 'member_setup_unavailable' });

    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT id,status FROM invitations WHERE email='paused-finance@example.test'`)).rows)
        .toEqual([{ id: seeded.invitationId, status: 'pending' }]);
      expect((await c.query(`SELECT role_template_key,invitation_id FROM member_provisioning_operations`)).rows)
        .toEqual([{ role_template_key: 'finance-agent', invitation_id: seeded.invitationId }]);
      expect((await c.query(`SELECT id FROM jobs WHERE kind='workos_sync' AND payload->>'invitation_id'=$1`, [seeded.invitationId])).rows)
        .toHaveLength(0);
      expect((await c.query(`SELECT id FROM hermes_cloud_capacity WHERE reserved_invitation_id=$1`, [seeded.invitationId])).rows)
        .toHaveLength(0);
      await c.query('COMMIT');
    });
  });

  it('offers and prepares a Finance setup only while the workspace holds verified Finance capacity', async () => {
    const fx = await seedWorkspace();
    const env = hermesEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1' });
    const network = vi.fn(() => { throw new Error('Finance setup must not reach a provider before acceptance'); });
    vi.stubGlobal('fetch', network);
    const path = `/w/${fx.workspaceId}/invitations`;

    // Nothing verified yet: the role is neither advertised nor admitted.
    const before = await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/bootstrap`)).json() as {
      capabilities: { member_invitations: { mode: string; role_templates: string[] } };
    };
    expect(before.capabilities.member_invitations).toEqual({ mode: 'setup_only', role_templates: ['partnerships-agent'] });
    const refused = await asUser(env, fx.adminId, path, { method: 'POST', body: {
      email: 'finance-early@example.test', role: 'member', role_template_key: 'finance-agent',
    } });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ reason: 'member_setup_role_unavailable' });

    // One verified Finance instance, exactly as the capacity route stores it.
    const [capacityId] = await seedCapacity(fx, env, 1, FINANCE_CAPACITY_ROLE);
    const after = await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/bootstrap`)).json() as typeof before;
    expect(after.capabilities.member_invitations.role_templates).toEqual(['partnerships-agent', 'finance-agent']);

    const email = 'finance-ready@example.test';
    const created = await asUser(env, fx.adminId, path, { method: 'POST', body: {
      email, role: 'member', role_template_key: 'finance-agent',
    } });
    const createdBody = await created.text();
    expect(created.status, createdBody).toBe(201);
    const invitation = JSON.parse(createdBody) as { id: string; role_template_key?: string; provisioning?: { cancellation: string } };
    // No Cloud connection in this fixture, so the operation starts as
    // awaiting_connection; the setup job still reserves verified capacity.
    expect(invitation).toMatchObject({ role_template_key: 'finance-agent', provisioning: { cancellation: 'none' } });

    // The setup job reserves that instance for this invitation and reports ready.
    await drainJobs(env, 50);
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(
        `SELECT role_template_key, preparation FROM member_provisioning_operations WHERE invitation_id=$1`, [invitation.id],
      )).rows).toEqual([{ role_template_key: 'finance-agent', preparation: 'ready' }]);
      expect((await c.query(
        `SELECT state, reserved_invitation_id FROM hermes_cloud_capacity WHERE id=$1`, [capacityId],
      )).rows).toEqual([{ state: 'reserved', reserved_invitation_id: invitation.id }]);
      await c.query('COMMIT');
    });

    // Capacity is now spoken for: the role disappears for a second invitation,
    // while a resend of the existing Finance setup keeps what it reserved.
    const spent = await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/bootstrap`)).json() as typeof before;
    expect(spent.capabilities.member_invitations.role_templates).toEqual(['partnerships-agent']);
    const second = await asUser(env, fx.adminId, path, { method: 'POST', body: {
      email: 'finance-second@example.test', role: 'member', role_template_key: 'finance-agent',
    } });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ reason: 'member_setup_role_unavailable' });
    const resend = await asUser(env, fx.adminId, `${path}/${invitation.id}/resend`, { method: 'POST', body: {} });
    expect(resend.status, await resend.text()).toBe(201);
    expect(network).not.toHaveBeenCalled();
  });

  it('keeps historical Finance setup readable and cancellable but refuses to restart it', async () => {
    const fx = await seedWorkspace();
    const env = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1', AGENT_RUNTIME: 'hermes' }).env;
    const seeded = await seedQueuedProvisioningJob(fx, 'historical-finance@example.test', 'finance-agent');

    const listed = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations`);
    const body = await listed.json() as { items: Array<Record<string, unknown>> };
    expect(body.items.find((row) => row.id === seeded.invitationId)).toMatchObject({
      role_template_key: 'finance-agent',
      provisioning: { preparation: 'queued', cancellation: 'none' },
    });

    const resend = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations/${seeded.invitationId}/resend`, {
      method: 'POST', body: {},
    });
    expect(resend.status).toBe(409);
    expect(await resend.json()).toMatchObject({ reason: 'member_setup_role_unavailable' });
    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations/${seeded.invitationId}/withdraw`, {
      method: 'POST', body: {},
    })).status).toBe(204);

    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT status FROM invitations WHERE id=$1`, [seeded.invitationId])).rows)
        .toEqual([{ status: 'withdrawn' }]);
      expect((await c.query(`SELECT cancellation FROM member_provisioning_operations WHERE id=$1`, [seeded.operationId])).rows)
        .toEqual([{ cancellation: 'complete' }]);
      await c.query('COMMIT');
    });
  });

  it('pauses a claimed setup job durably and resumes only that disposition when enabled', async () => {
    const fx = await seedWorkspace();
    const invitationId = randomUUID();
    const operationId = randomUUID();
    const jobId = randomUUID();
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO invitations(id,workspace_id,email,role,expires_at,invited_by,delivery_status)
         VALUES($1,$2,'paused-job@example.test','member',now()+interval '7 days',$3,'not_required')`,
        [invitationId, fx.workspaceId, fx.adminId],
      );
      await c.query(
        `INSERT INTO member_provisioning_operations(id,workspace_id,invitation_id,requested_by,role_template_key)
         VALUES($1,$2,$3,$4,'partnerships-agent')`,
        [operationId, fx.workspaceId, invitationId, fx.adminId],
      );
      await c.query(
        `INSERT INTO jobs(id,workspace_id,kind,key,payload) VALUES($1,$2,'member_provision',$3,$4::jsonb)`,
        [jobId, fx.workspaceId, `member-provision:${operationId}:0`, JSON.stringify({ operation_id: operationId, revision: 0 })],
      );
      await c.query(`INSERT INTO job_ready(job_id,workspace_id) VALUES($1,$2)`, [jobId, fx.workspaceId]);
      await c.query('COMMIT');
    });
    const disabled = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '0' }).env;
    await runJobsAfterCommit(disabled, fx.workspaceId, [jobId]);
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT done_at,last_error FROM jobs WHERE id=$1`, [jobId])).rows)
        .toEqual([{ done_at: null, last_error: 'member_provisioning_disabled' }]);
      expect((await c.query(`SELECT pause_reason FROM job_ready WHERE job_id=$1`, [jobId])).rows)
        .toEqual([{ pause_reason: 'member_provisioning_disabled' }]);
      await c.query('COMMIT');
    });

    const enabled = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1' }).env;
    // `job_ready` is global and a Cron pass is intentionally bounded. Model a
    // busy database explicitly: re-enabling makes this job due, but it need not
    // be one of the first 200 older pointers claimed by the same pass.
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `WITH backlog AS (
           INSERT INTO jobs(id,workspace_id,kind,key,payload,next_at)
           SELECT gen_random_uuid(),$1,'member_provision',$2 || n::text,'{}'::jsonb,now()-interval '1 minute'
             FROM generate_series(1,201) n
           RETURNING id,workspace_id,next_at
         )
         INSERT INTO job_ready(job_id,workspace_id,next_at)
         SELECT id,workspace_id,next_at FROM backlog`,
        [fx.workspaceId, `pause-resume-backlog:${jobId}:`],
      );
      await c.query('COMMIT');
    });
    const targetDone = async (): Promise<boolean> => withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      const { rows } = await c.query<{ done: boolean }>(
        `SELECT done_at IS NOT NULL AS done FROM jobs WHERE id=$1`, [jobId],
      );
      await c.query('COMMIT');
      return rows[0]?.done ?? false;
    });
    expect((await drainJobs(enabled, 200)).claimed).toBe(200);
    expect(await targetDone()).toBe(false);

    // Cron promises bounded eventual progress, not that one workspace's job is
    // always inside the first global page. Drain until this exact job finishes,
    // as production does on subsequent minute ticks.
    let resumed = false;
    for (let attempt = 0; attempt < 20 && !resumed; attempt += 1) {
      await drainJobs(enabled, 200);
      resumed = await targetDone();
    }
    expect(resumed).toBe(true);
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT done_at IS NOT NULL AS done FROM jobs WHERE id=$1`, [jobId])).rows)
        .toEqual([{ done: true }]);
      expect((await c.query(`SELECT job_id FROM job_ready WHERE job_id=$1`, [jobId])).rows).toHaveLength(0);
      expect((await c.query(`SELECT preparation,issue FROM member_provisioning_operations WHERE id=$1`, [operationId])).rows)
        .toEqual([{ preparation: 'awaiting_connection', issue: 'cloud_not_connected' }]);
      await c.query('COMMIT');
    });
  });

  it('allows cancellation while paused and makes the old revision harmless after re-enable', async () => {
    const fx = await seedWorkspace();
    const { invitationId, operationId, jobId } = await seedQueuedProvisioningJob(
      fx, 'paused-cancellation@example.test',
    );
    const disabled = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '0' }).env;
    await runJobsAfterCommit(disabled, fx.workspaceId, [jobId]);
    expect((await asUser(disabled, fx.adminId, `/w/${fx.workspaceId}/invitations/${invitationId}/withdraw`, {
      method: 'POST', body: {},
    })).status).toBe(204);

    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT cancellation,revision FROM member_provisioning_operations WHERE id=$1`, [operationId])).rows)
        .toEqual([{ cancellation: 'complete', revision: 2 }]);
      expect((await c.query(`SELECT pause_reason FROM job_ready WHERE job_id=$1`, [jobId])).rows)
        .toEqual([{ pause_reason: 'member_provisioning_disabled' }]);
      await c.query('COMMIT');
    });

    await drainJobs(makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1' }).env, 200);
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT done_at IS NOT NULL AS done FROM jobs WHERE id=$1`, [jobId])).rows)
        .toEqual([{ done: true }]);
      expect((await c.query(`SELECT cancellation,revision FROM member_provisioning_operations WHERE id=$1`, [operationId])).rows)
        .toEqual([{ cancellation: 'complete', revision: 2 }]);
      expect((await c.query(`SELECT id FROM hermes_cloud_capacity WHERE reserved_invitation_id=$1`, [invitationId])).rows)
        .toHaveLength(0);
      await c.query('COMMIT');
    });
  });

  it('revalidates a persisted ready operation instead of trusting the status bit', async () => {
    const fx = await seedWorkspace();
    const invitationId = randomUUID();
    const operationId = randomUUID();
    const jobId = randomUUID();
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO invitations(id,workspace_id,email,role,expires_at,invited_by,delivery_status)
         VALUES($1,$2,'stale-ready@example.test','member',now()+interval '7 days',$3,'not_required')`,
        [invitationId, fx.workspaceId, fx.adminId],
      );
      await c.query(
        `INSERT INTO member_provisioning_operations(id,workspace_id,invitation_id,requested_by,role_template_key,preparation)
         VALUES($1,$2,$3,$4,'partnerships-agent','ready')`,
        [operationId, fx.workspaceId, invitationId, fx.adminId],
      );
      await c.query(
        `INSERT INTO jobs(id,workspace_id,kind,key,payload) VALUES($1,$2,'member_provision',$3,$4::jsonb)`,
        [jobId, fx.workspaceId, `member-provision:${operationId}:0`, JSON.stringify({ operation_id: operationId, revision: 0 })],
      );
      await c.query(`INSERT INTO job_ready(job_id,workspace_id) VALUES($1,$2)`, [jobId, fx.workspaceId]);
      await c.query('COMMIT');
    });
    await runJobsAfterCommit(makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1' }).env, fx.workspaceId, [jobId]);
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT preparation,issue FROM member_provisioning_operations WHERE id=$1`, [operationId])).rows)
        .toEqual([{ preparation: 'awaiting_connection', issue: 'cloud_not_connected' }]);
      await c.query('COMMIT');
    });
  });

  it('demotes ready on resend when its exact reservation cannot transfer', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1', AGENT_RUNTIME: 'hermes' });
    const created = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations`, { method: 'POST', body: {
      email: 'ready-without-reservation@example.test', role: 'member', role_template_key: 'partnerships-agent',
    } });
    const invitation = await created.json() as { id: string };
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `UPDATE member_provisioning_operations
            SET preparation='ready', issue=NULL, revision=revision+1
          WHERE invitation_id=$1`,
        [invitation.id],
      );
      await c.query('COMMIT');
    });

    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations/${invitation.id}/resend`, {
      method: 'POST', body: {},
    });
    expect(response.status).toBe(201);
    const successor = await response.json() as {
      id: string; provisioning: { preparation: string; issue: string | null };
    };
    // The response is re-read after the re-queued setup job ran: the lost
    // reservation demoted `ready`, and with no Cloud connection the successor
    // is honestly waiting rather than reported as the transient `queued`.
    expect(successor.provisioning).toMatchObject({ preparation: 'awaiting_connection', issue: 'cloud_not_connected', delivery: 'not_queued' });
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(
        `SELECT invitation_id,preparation FROM member_provisioning_operations`,
      )).rows).toEqual([{ invitation_id: successor.id, preparation: 'awaiting_connection' }]);
      expect((await c.query(`SELECT id FROM jobs WHERE kind='workos_sync' AND payload->>'invitation_id'=$1`, [successor.id])).rows)
        .toHaveLength(0);
      expect((await c.query(`SELECT id FROM hermes_cloud_capacity WHERE reserved_invitation_id=$1`, [successor.id])).rows)
        .toHaveLength(0);
      await c.query('COMMIT');
    });
  });

  it('blocks direct delivery, isolates tenants, and completes local cancellation', async () => {
    const first = await seedWorkspace(); const second = await seedWorkspace();
    const { env } = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1', AGENT_RUNTIME: 'hermes' });
    const created = await asUser(env, first.adminId, `/w/${first.workspaceId}/invitations`, { method: 'POST', body: {
      email: 'finance@example.test', role: 'member', role_template_key: 'partnerships-agent',
    } });
    const invitation = await created.json() as { id: string };
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, first.workspaceId, first.adminId);
      await expect(c.query(`INSERT INTO jobs(workspace_id,kind,key,payload) VALUES($1,'workos_sync',$2,$3::jsonb)`, [
        first.workspaceId, `forbidden-send:${invitation.id}`,
        JSON.stringify({ action: 'send_invitation', invitation_id: invitation.id }),
      ])).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');
    });
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, second.workspaceId, second.adminId);
      expect((await c.query('SELECT id FROM member_provisioning_operations')).rows).toHaveLength(0);
      await expect(c.query(`INSERT INTO member_provisioning_operations(workspace_id,invitation_id,requested_by,role_template_key)
        VALUES($1,$2,$3,'finance-agent')`, [second.workspaceId, invitation.id, second.adminId])).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
    await withClient('agent', async c => {
      await c.query('BEGIN'); await setTenant(c, first.workspaceId, first.adminId);
      await expect(c.query('SELECT * FROM member_provisioning_operations')).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
    expect((await asUser(env, first.adminId, `/w/${first.workspaceId}/invitations/${invitation.id}/withdraw`, { method: 'POST' })).status).toBe(204);
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, first.workspaceId, first.adminId);
      expect((await c.query('SELECT cancellation FROM member_provisioning_operations')).rows).toEqual([{ cancellation: 'complete' }]);
      await c.query('COMMIT');
    });
  });

  it.each([
    { action: 'resend', reason: 'not_resendable' },
    { action: 'withdraw', reason: 'already_accepted' },
  ] as const)('serializes $action behind an acceptance-owned invitation lock', async ({ action, reason }) => {
    const fx = await seedWorkspace();
    const { env } = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1' });
    const created = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations`, { method: 'POST', body: {
      email: `accept-race-${action}@example.test`, role: 'member', role_template_key: 'partnerships-agent',
    } });
    const invitation = await created.json() as { id: string };
    const locker = await client('app');
    try {
      await locker.query('BEGIN');
      await setTenant(locker, fx.workspaceId, fx.adminId);
      await locker.query(`SELECT id FROM invitations WHERE id=$1 FOR UPDATE`, [invitation.id]);
      let settled = false;
      const request = asUser(env, fx.adminId, `/w/${fx.workspaceId}/invitations/${invitation.id}/${action}`, {
        method: 'POST', body: {},
      }).finally(() => { settled = true; });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(settled).toBe(false);
      await locker.query(`UPDATE invitations SET status='accepted' WHERE id=$1`, [invitation.id]);
      await locker.query('COMMIT');

      const response = await request;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ reason });
    } finally {
      try { await locker.query('ROLLBACK'); } catch { /* already committed */ }
      await locker.end();
    }

    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT status FROM invitations WHERE id=$1`, [invitation.id])).rows)
        .toEqual([{ status: 'accepted' }]);
      expect((await c.query(`SELECT count(*)::int AS count FROM invitations WHERE email=$1`, [`accept-race-${action}@example.test`])).rows)
        .toEqual([{ count: 1 }]);
      expect((await c.query(`SELECT cancellation FROM member_provisioning_operations WHERE invitation_id=$1`, [invitation.id])).rows)
        .toEqual([{ cancellation: 'none' }]);
      await c.query('COMMIT');
    });
  });

  it('hands a verified-ready setup to WorkOS delivery exactly once, and never before readiness', async () => {
    const fx = await seedWorkspace();
    const fake = await useFakeWorkOS(new FakeWorkOS());
    const env = workosHermesEnv();
    const organizationId = await linkOrganization(fx);
    const [capacityId] = await seedCapacity(fx, env, 1, FINANCE_CAPACITY_ROLE);
    const email = 'finance-delivered@example.test';

    const created = await asWorkOSAdmin(fx, env, `/w/${fx.workspaceId}/invitations`, { method: 'POST', body: {
      email, role: 'member', role_template_key: 'finance-agent',
    } });
    const body = await created.text();
    expect(created.status, body).toBe(201);
    const invitation = JSON.parse(body) as { id: string; delivery_status: string; provisioning: { preparation: string; delivery: string } };
    // The route's own after-commit job reserved capacity, queued delivery and
    // ran it: the response is re-read, so it reports what WorkOS answered.
    expect(invitation.delivery_status).toBe('delivered');
    expect(invitation.provisioning).toMatchObject({ preparation: 'ready', delivery: 'sent' });
    const sends = fake.calls.filter((entry) => entry.method === 'sendInvitation');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.argument).toMatchObject({ email, organizationId, roleSlug: 'member', expiresInDays: 7 });

    // Draining again finds nothing to send twice.
    await drainJobs(env, 50);
    expect(fake.calls.filter((entry) => entry.method === 'sendInvitation')).toHaveLength(1);

    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(
        `SELECT delivery_status, delivery_error, workos_invitation_id IS NOT NULL AS delivered_id,
                expires_at > now() + interval '6 days' AS clock_started
           FROM invitations WHERE id=$1`, [invitation.id],
      )).rows).toEqual([{ delivery_status: 'delivered', delivery_error: null, delivered_id: true, clock_started: true }]);
      expect((await c.query(
        `SELECT payload->>'action' AS action, done_at IS NOT NULL AS done FROM jobs
          WHERE kind='workos_sync' AND payload->>'invitation_id'=$1`, [invitation.id],
      )).rows).toEqual([{ action: 'send_invitation', done: true }]);
      // The seven-day clock started at the handoff, not at creation.
      expect((await c.query(
        `SELECT next_at > now() + interval '6 days' AS scheduled FROM jobs
          WHERE kind='hermes_invitation_expire' AND key=$1 AND done_at IS NULL`, [`invitation-expire:${invitation.id}`],
      )).rows).toEqual([{ scheduled: true }]);
      expect((await c.query(
        `SELECT state, reserved_invitation_id FROM hermes_cloud_capacity WHERE id=$1`, [capacityId],
      )).rows).toEqual([{ state: 'reserved', reserved_invitation_id: invitation.id }]);
      // The invitation directory carries the address digest for the picker.
      expect((await c.query(
        `SELECT count(*)::int AS rows FROM invitation_directory
          WHERE invitation_id=$1 AND email_digest=hermes_invitation_email_digest($2)`, [invitation.id, email],
      )).rows).toEqual([{ rows: 2 }]);
      await c.query('COMMIT');
    });

    // The Members list reads the same truth.
    const listed = await asWorkOSAdmin(fx, env, `/w/${fx.workspaceId}/invitations`);
    const items = (await listed.json() as { items: Array<{ id: string; delivery_status: string; provisioning: { delivery: string } }> }).items;
    expect(items.find((row) => row.id === invitation.id)).toMatchObject({ delivery_status: 'delivered', provisioning: { delivery: 'sent' } });
  });

  it('queues delivery at the handoff with the clock started, and keeps fake auth on not_required', async () => {
    const fx = await seedWorkspace();
    await linkOrganization(fx);
    const seeded = await seedQueuedProvisioningJob(fx, 'handoff@example.test');
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(`UPDATE member_provisioning_operations SET preparation='ready' WHERE id=$1`, [seeded.operationId]);
      await c.query('COMMIT');
    });

    // AUTH_MODE=fake: the invitation id is the join token, nothing is queued.
    const fakeMode = await withWorkspaceTransaction(hermesEnv(), fx.workspaceId, (tx) => queueSetupInvitationDelivery(
      hermesEnv(), tx, { workspaceId: fx.workspaceId, invitationId: seeded.invitationId, inviterUserId: fx.adminId },
    ));
    expect(fakeMode).toBeNull();

    const env = workosHermesEnv();
    const jobId = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => queueSetupInvitationDelivery(
      env, tx, { workspaceId: fx.workspaceId, invitationId: seeded.invitationId, inviterUserId: fx.adminId },
    ));
    expect(jobId).not.toBeNull();
    // Readiness re-observed later does not queue a second send.
    const again = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => queueSetupInvitationDelivery(
      env, tx, { workspaceId: fx.workspaceId, invitationId: seeded.invitationId, inviterUserId: fx.adminId },
    ));
    expect(again).toBeNull();

    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT delivery_status FROM invitations WHERE id=$1`, [seeded.invitationId])).rows)
        .toEqual([{ delivery_status: 'queued' }]);
      expect((await c.query(
        `SELECT payload->>'action' AS action, payload->>'inviter_user_id' AS inviter FROM jobs
          WHERE kind='workos_sync' AND payload->>'invitation_id'=$1`, [seeded.invitationId],
      )).rows).toEqual([{ action: 'send_invitation', inviter: fx.adminId }]);
      expect((await c.query(
        `SELECT count(*)::int AS count FROM jobs WHERE kind='hermes_invitation_expire' AND key=$1`,
        [`invitation-expire:${seeded.invitationId}`],
      )).rows).toEqual([{ count: 1 }]);
      expect((await c.query(`SELECT status FROM workos_sync WHERE resource_type='invitation' AND resource_id=$1`, [seeded.invitationId])).rows)
        .toEqual([{ status: 'pending' }]);
      await c.query('COMMIT');
    });
  });

  it('fails delivery closed when the reservation is lost before the send job runs', async () => {
    const fx = await seedWorkspace();
    const fake = await useFakeWorkOS(new FakeWorkOS());
    const env = workosHermesEnv();
    const organizationId = await linkOrganization(fx);
    const [capacityId] = await seedCapacity(fx, env, 1, FINANCE_CAPACITY_ROLE);
    const seeded = await seedQueuedProvisioningJob(fx, 'lost-reservation@example.test', 'finance-agent');

    // Readiness verified: the setup job reserves and queues delivery — but
    // the delivery job is held back here so the reservation can be lost first.
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(`UPDATE hermes_cloud_capacity SET state='reserved', reserved_invitation_id=$2 WHERE id=$1`, [capacityId, seeded.invitationId]);
      await c.query(`UPDATE member_provisioning_operations SET preparation='ready' WHERE id=$1`, [seeded.operationId]);
      await c.query('COMMIT');
    });
    const deliveryJobId = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => queueSetupInvitationDelivery(
      env, tx, { workspaceId: fx.workspaceId, invitationId: seeded.invitationId, inviterUserId: fx.adminId },
    ));
    expect(deliveryJobId).not.toBeNull();
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(`UPDATE hermes_cloud_capacity SET state='available', reserved_invitation_id=NULL WHERE id=$1`, [capacityId]);
      await c.query('COMMIT');
    });

    await runJobsAfterCommit(env, fx.workspaceId, [deliveryJobId!]);
    expect(fake.calls.filter((entry) => entry.method === 'sendInvitation')).toHaveLength(0);
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT delivery_status, delivery_error, workos_invitation_id FROM invitations WHERE id=$1`, [seeded.invitationId])).rows)
        .toEqual([{ delivery_status: 'failed', delivery_error: 'iris_capacity_reservation_missing', workos_invitation_id: null }]);
      // Terminal: the job is finished, not retried into a send.
      expect((await c.query(`SELECT done_at IS NOT NULL AS done FROM jobs WHERE id=$1`, [deliveryJobId])).rows).toEqual([{ done: true }]);
      await c.query('COMMIT');
    });
    // The Members card names the cause so the Admin is offered a resend.
    const listed = await asWorkOSAdmin(fx, env, `/w/${fx.workspaceId}/invitations`);
    const items = (await listed.json() as { items: Array<{ id: string; provisioning: { delivery: string; issue: string | null } }> }).items;
    expect(items.find((row) => row.id === seeded.invitationId)?.provisioning).toMatchObject({ delivery: 'failed', issue: 'readiness_failed' });
    expect(organizationId).toBeTruthy();
  });

  it('resends by transferring the reservation and re-queues delivery only once the successor is ready', async () => {
    const fx = await seedWorkspace();
    const fake = await useFakeWorkOS(new FakeWorkOS());
    const env = workosHermesEnv();
    await linkOrganization(fx);
    const [capacityId] = await seedCapacity(fx, env, 1, FINANCE_CAPACITY_ROLE);
    const email = 'finance-resend@example.test';
    const created = await asWorkOSAdmin(fx, env, `/w/${fx.workspaceId}/invitations`, { method: 'POST', body: {
      email, role: 'member', role_template_key: 'finance-agent',
    } });
    const original = await created.json() as { id: string; delivery_status: string };
    expect(original.delivery_status).toBe('delivered');

    const resend = await asWorkOSAdmin(fx, env, `/w/${fx.workspaceId}/invitations/${original.id}/resend`, { method: 'POST', body: {} });
    const resendBody = await resend.text();
    expect(resend.status, resendBody).toBe(201);
    const successor = JSON.parse(resendBody) as { id: string; delivery_status: string; provisioning: { preparation: string; delivery: string } };
    expect(successor.id).not.toBe(original.id);
    expect(successor.delivery_status).toBe('delivered');
    expect(successor.provisioning).toMatchObject({ preparation: 'ready', delivery: 'sent' });
    // One fresh send for the original, one provider resend for the successor.
    expect(fake.calls.filter((entry) => entry.method === 'sendInvitation')).toHaveLength(1);
    expect(fake.calls.filter((entry) => entry.method === 'resendInvitation')).toHaveLength(1);

    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      expect((await c.query(`SELECT status, superseded_by FROM invitations WHERE id=$1`, [original.id])).rows)
        .toEqual([{ status: 'resent', superseded_by: successor.id }]);
      expect((await c.query(`SELECT state, reserved_invitation_id FROM hermes_cloud_capacity WHERE id=$1`, [capacityId])).rows)
        .toEqual([{ state: 'reserved', reserved_invitation_id: successor.id }]);
      expect((await c.query(`SELECT invitation_id, preparation FROM member_provisioning_operations`)).rows)
        .toEqual([{ invitation_id: successor.id, preparation: 'ready' }]);
      expect((await c.query(
        `SELECT payload->>'action' AS action FROM jobs WHERE kind='workos_sync' AND payload->>'invitation_id'=$1`, [successor.id],
      )).rows).toEqual([{ action: 'resend_invitation' }]);
      await c.query('COMMIT');
    });
  });
});
