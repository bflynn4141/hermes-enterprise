// The Admin agent directory and governance access, through the real routes.
//
// Decision: an Admin may set any agent's role and permissions, including a
// member's private agent, but never reads that agent's conversations. These
// tests hold both halves: what an Admin can now change, and what they still
// cannot see or decide.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentDirectorySchema, type AgentDirectory } from '@hermes/shared';
import { configurePartnerWorkflow } from '../../src/partner-workflow/service.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';

const SECRET_TITLE = 'Dana private negotiation';
const SECRET_MESSAGE = 'Offer them 40 percent off, do not tell Maya';
const SECRET_ARGUMENT = 'PARKED-ARGUMENT-ONLY-DANA-MAY-READ';
const SECRET_HOST = 'dana-private-instance.example.test';

/**
 * Maya (Admin) and Dana (Member). Iris is shared and bound to Maya as the
 * Partnerships principal. Ledger is Dana's private agent, bound to Dana as the
 * Finance principal, with a session, a message, a live run and a parked call
 * whose arguments only Dana's side may read.
 */
async function fixture() {
  const fx = await seedWorkspace();
  const ledgerId = randomUUID();
  const sessionId = randomUUID();
  const runId = randomUUID();
  const approvalId = randomUUID();
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    const dana = await client.query<{ id: string }>(
      'SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2', [fx.workspaceId, fx.memberId],
    );
    await client.query(
      `INSERT INTO agents (id,workspace_id,name,status,context_scope,responsibility)
       VALUES ($1,$2,'Ledger','started','private','Finance review')`,
      [ledgerId, fx.workspaceId],
    );
    await client.query('INSERT INTO agent_owners (workspace_id,agent_id,member_id) VALUES ($1,$2,$3)', [fx.workspaceId, ledgerId, dana.rows[0]!.id]);
    await client.query(
      `INSERT INTO agent_capabilities (workspace_id,agent_id,kind,title,tool_names)
       VALUES ($1,$2,'can','Draft',ARRAY['propose_instruction'])`,
      [fx.workspaceId, ledgerId],
    );
    await client.query(
      `INSERT INTO agent_provisioning (workspace_id,agent_id,status,instance_name,dashboard_url)
       VALUES ($1,$2,'creating','hermes-pool-04',$3)`,
      [fx.workspaceId, ledgerId, `https://${SECRET_HOST}/dashboard`],
    );
    await client.query(
      `INSERT INTO sessions (id,workspace_id,owner_id,agent_id,title,model_id)
       VALUES ($1,$2,$3,$4,$5,'deepseek-flash')`,
      [sessionId, fx.workspaceId, fx.memberId, ledgerId, SECRET_TITLE],
    );
    await client.query(
      `INSERT INTO messages (workspace_id,session_id,seq,role,text)
       VALUES ($1,$2,1,'user',$3)`,
      [fx.workspaceId, sessionId, SECRET_MESSAGE],
    );
    await client.query(
      `INSERT INTO runs (id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,mode)
       VALUES ($1,$2,$3,$4,'working','deepseek-flash',$5,'work')`,
      [runId, fx.workspaceId, sessionId, ledgerId, randomUUID()],
    );
    await client.query(
      `INSERT INTO agent_operation_approvals
         (id,workspace_id,agent_id,run_id,tool_call_id,operation_id,tool_name,arguments,policy_revision)
       VALUES ($1,$2,$3,$4,'parked-call','prepare_drafts','propose_instruction',$5::jsonb,1)`,
      [approvalId, fx.workspaceId, ledgerId, runId, JSON.stringify({ body: SECRET_ARGUMENT })],
    );
    await client.query('COMMIT');
  });
  await withClient('app', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    await configurePartnerWorkflow(client, fx.workspaceId, fx.adminId, {
      partnerships: { agent_id: fx.agentId, principal_user_id: fx.adminId },
      finance: { agent_id: ledgerId, principal_user_id: fx.memberId },
    });
    await client.query('COMMIT');
  });
  return { ...fx, ledgerId, sessionId, runId, approvalId };
}

async function staleStepUp(userId: string): Promise<void> {
  await withClient('owner', (client) => client.query(
    `UPDATE auth_sessions SET authenticated_at = now() - interval '10 minutes' WHERE sid = $1`, [`dev-${userId}`],
  ));
}

describe('Admin agent directory', () => {
  it('lists every agent with its owner, role, skills, placement and approvals, and nothing it has done', async () => {
    const fx = await fixture();
    const { env } = makeEnv();

    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/admin/agents`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    const directory: AgentDirectory = agentDirectorySchema.parse(JSON.parse(text));
    expect(directory.items.map((agent) => agent.name)).toEqual(['Iris', 'Ledger']);

    const ledger = directory.items.find((agent) => agent.id === fx.ledgerId)!;
    expect(ledger).toMatchObject({
      responsibility: 'Finance invoice review',
      status: 'started',
      context_scope: 'private',
      owner: { user_id: fx.memberId, name: 'Dana Kim' },
      role: { team: { slug: 'finance', name: 'Finance' }, role_template_key: 'finance-agent', principal: { user_id: fx.memberId, name: 'Dana Kim' } },
      skills: [expect.objectContaining({ skill_key: 'partner-invoice-review', state: 'active' })],
      runtime: { source: 'cloud_provisioned', label: 'hermes-pool-04', state: 'setting_up' },
      approvals: { revision: 0, required: [] },
      viewer: { can_configure: true, can_view_conversations: false },
    });
    const iris = directory.items.find((agent) => agent.id === fx.agentId)!;
    expect(iris.viewer).toEqual({ can_configure: true, can_view_conversations: true });
    expect(iris.role?.principal.user_id).toBe(fx.adminId);

    // The conversations boundary, checked on the raw body rather than the
    // parsed shape: no session, message, run, parked argument or hostname.
    for (const secret of [SECRET_TITLE, SECRET_MESSAGE, SECRET_ARGUMENT, SECRET_HOST, fx.sessionId, fx.runId, fx.approvalId]) {
      expect(text).not.toContain(secret);
    }
    expect(Object.keys(ledger).sort()).toEqual([
      'approvals', 'context_scope', 'id', 'name', 'owner', 'responsibility', 'role', 'runtime', 'skills', 'status', 'viewer',
    ]);
  });

  it('is Admin only', async () => {
    const fx = await fixture();
    const { env } = makeEnv();
    const response = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/admin/agents`);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'admin_required' });
  });

  it('shows an approval switch an Admin turned on for a member agent', async () => {
    const fx = await fixture();
    const { env } = makeEnv();
    const path = `/w/${fx.workspaceId}/agents/${fx.ledgerId}/permissions`;
    expect((await asUser(env, fx.adminId, path, {
      method: 'PATCH', body: { revision: 0, operation_id: 'prepare_drafts', require_human_approval: true },
    })).status).toBe(200);
    const directory = agentDirectorySchema.parse(await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/admin/agents`)).json());
    expect(directory.items.find((agent) => agent.id === fx.ledgerId)?.approvals).toEqual({
      revision: 1, required: [{ id: 'prepare_drafts', label: 'Prepare drafts' }],
    });
  });
});

describe('governing a member agent without reading its conversations', () => {
  it('lets an Admin toggle approval on a member private agent, recorded as theirs', async () => {
    const fx = await fixture();
    const { env } = makeEnv();
    const path = `/w/${fx.workspaceId}/agents/${fx.ledgerId}/permissions`;
    const saved = await asUser(env, fx.adminId, path, {
      method: 'PATCH', body: { revision: 0, operation_id: 'prepare_drafts', require_human_approval: true },
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      revision: 1,
      operations: [expect.objectContaining({ id: 'prepare_drafts', require_human_approval: true })],
      pending_approvals: [],
      pending_approvals_visible: false,
    });
    const revisions = await readTenant(fx.workspaceId, fx.adminId, (client) => client.query(
      'SELECT operation_id, require_human_approval, changed_by FROM agent_operation_policy_revisions WHERE agent_id=$1', [fx.ledgerId],
    ));
    expect(revisions.rows).toEqual([{ operation_id: 'prepare_drafts', require_human_approval: true, changed_by: fx.adminId }]);
  });

  it('never shows the Admin the parked arguments, the decision, or the sessions', async () => {
    const fx = await fixture();
    const { env } = makeEnv();
    const permissions = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.ledgerId}/permissions`);
    expect(permissions.status).toBe(200);
    const body = await permissions.text();
    expect(JSON.parse(body)).toMatchObject({ pending_approvals: [], pending_approvals_visible: false });
    expect(body).not.toContain(SECRET_ARGUMENT);
    expect(body).not.toContain(fx.runId);

    const decide = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.ledgerId}/permissions/approvals/${fx.approvalId}`, {
      method: 'POST', body: { decision: 'approved' },
    });
    expect(decide.status).toBe(404);
    const stillPending = await readTenant(fx.workspaceId, fx.adminId, (client) => client.query(
      'SELECT status FROM agent_operation_approvals WHERE id=$1', [fx.approvalId],
    ));
    expect(stillPending.rows[0]).toEqual({ status: 'pending' });

    for (const path of [
      `/w/${fx.workspaceId}/sessions/${fx.sessionId}`,
      `/w/${fx.workspaceId}/sessions/${fx.sessionId}/messages`,
      `/w/${fx.workspaceId}/sessions/${fx.sessionId}/runs/${fx.runId}`,
      `/w/${fx.workspaceId}/instructions?agent_id=${fx.ledgerId}`,
      `/w/${fx.workspaceId}/agents/${fx.ledgerId}/context-notes`,
    ]) {
      const denied = await asUser(env, fx.adminId, path);
      expect(denied.status, path).toBe(404);
      expect(await denied.text(), path).not.toContain(SECRET_MESSAGE);
    }
    const sessions = await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/sessions`)).text();
    expect(sessions).not.toContain(SECRET_TITLE);
  });

  it('lets an Admin pause and reconfigure a member agent skill', async () => {
    const fx = await fixture();
    const { env } = makeEnv();
    const list = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.ledgerId}/skill-assignments`);
    expect(list.status).toBe(200);
    const assignment = ((await list.json()) as { items: Array<{ id: string; revision: number }> }).items[0]!;
    const paused = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.ledgerId}/skill-assignments/${assignment.id}`, {
      method: 'PATCH', body: { revision: assignment.revision, state: 'paused' },
    });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ state: 'paused', revision: assignment.revision + 1 });
  });

  it('asks for a recent sign-in before an Admin changes someone else\'s agent', async () => {
    const fx = await fixture();
    const { env } = makeEnv();
    // The first call creates the fake session row; then it goes stale.
    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/admin/agents`)).status).toBe(200);
    await staleStepUp(fx.adminId);

    const body = { revision: 0, operation_id: 'prepare_drafts', require_human_approval: true };
    const refused = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.ledgerId}/permissions`, { method: 'PATCH', body });
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ reason: 'reauth_required' });
    const assignments = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.ledgerId}/skill-assignments`);
    const assignment = ((await assignments.json()) as { items: Array<{ id: string; revision: number }> }).items[0]!;
    const skill = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.ledgerId}/skill-assignments/${assignment.id}`, {
      method: 'PATCH', body: { revision: assignment.revision, state: 'paused' },
    });
    expect(skill.status).toBe(401);

    // Their own agent keeps today's behaviour: no step-up for the owner's side.
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO agent_capabilities (workspace_id,agent_id,kind,title,tool_names) VALUES ($1,$2,'can','Draft',ARRAY['propose_instruction'])`,
        [fx.workspaceId, fx.agentId],
      );
      await client.query('COMMIT');
    });
    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.agentId}/permissions`, { method: 'PATCH', body })).status).toBe(200);
  });

  it('still refuses a Member who configures or reads another person\'s agent', async () => {
    const fx = await fixture();
    const { env } = makeEnv();
    // Make Iris Maya's private agent so Dana has no content access to it.
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      const maya = await client.query<{ id: string }>('SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2', [fx.workspaceId, fx.adminId]);
      await client.query(`UPDATE agents SET context_scope='private' WHERE id=$1`, [fx.agentId]);
      await client.query('INSERT INTO agent_owners (workspace_id,agent_id,member_id) VALUES ($1,$2,$3)', [fx.workspaceId, fx.agentId, maya.rows[0]!.id]);
      await client.query('COMMIT');
    });
    const permissions = `/w/${fx.workspaceId}/agents/${fx.agentId}/permissions`;
    expect((await asUser(env, fx.memberId, permissions)).status).toBe(404);
    expect((await asUser(env, fx.memberId, `/w/${fx.workspaceId}/agents/${fx.agentId}/skill-assignments`)).status).toBe(404);
    expect((await asUser(env, fx.memberId, permissions, {
      method: 'PATCH', body: { revision: 0, operation_id: 'prepare_drafts', require_human_approval: true },
    })).status).toBe(403);
    expect((await asUser(env, fx.memberId, `/w/${fx.workspaceId}/agents/${fx.agentId}/skill-assignments/${randomUUID()}`, {
      method: 'PATCH', body: { revision: 1, state: 'paused' },
    })).status).toBe(403);
    // An agent id from another workspace is not governable by this Admin.
    const other = await seedWorkspace();
    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${other.agentId}/permissions`)).status).toBe(404);
  });
});
