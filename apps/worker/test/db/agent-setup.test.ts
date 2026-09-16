import { describe, expect, it } from 'vitest';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, withClient, setTenant } from './helpers.js';

async function bindAgent(fx: Awaited<ReturnType<typeof seedWorkspace>>): Promise<void> {
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    await client.query(`UPDATE agents SET status = 'draft', responsibility = NULL, started_at = NULL WHERE id = $1`, [fx.agentId]);
    await client.query(
      `INSERT INTO agent_owners (workspace_id, agent_id, member_id)
       SELECT $1, $2, id FROM members WHERE workspace_id = $1 AND user_id = $3`,
      [fx.workspaceId, fx.agentId, fx.adminId],
    );
    await client.query('COMMIT');
  });
}

describe('durable first-run agent setup', () => {
  it('stores the repeatable loop, starts the owned agent, and grants only proposal/read tools', async () => {
    const fx = await seedWorkspace();
    await bindAgent(fx);
    const { env } = makeEnv();
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.agentId}`, {
      method: 'PATCH',
      body: {
        first_run: {
          role_id: 'partner-program',
          role_label: 'Partner Program',
          loop_id: 'screen-partners',
          reviewers: {
            admission: 'You',
            'role-benefits': 'You',
            'external-message': 'You',
            'agreement-money': 'Admin + Finance',
          },
        },
      },
    });
    expect(response.status).toBe(204);

    const stored = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const agent = await client.query<{ status: string; responsibility: string; instructions_active: string; started: boolean }>(
        `SELECT status, responsibility, instructions_active, started_at IS NOT NULL AS started FROM agents WHERE id = $1`,
        [fx.agentId],
      );
      const capabilities = await client.query<{ tool_names: string[] }>(
        `SELECT tool_names FROM agent_capabilities WHERE agent_id = $1`, [fx.agentId],
      );
      return { agent: agent.rows[0], tools: capabilities.rows.flatMap((row) => row.tool_names) };
    });
    expect(stored.agent).toMatchObject({ status: 'started', responsibility: 'Partner Program', started: true });
    expect(stored.agent?.instructions_active).toContain('Screen partner applications');
    expect(stored.tools).toEqual(expect.arrayContaining(['list_requests', 'propose_request', 'ask_for_context']));
    expect(stored.tools).not.toContain('send_email');
  });

  it('refuses to configure an agent owned by a different member', async () => {
    const fx = await seedWorkspace();
    await bindAgent(fx);
    const { env } = makeEnv();
    const response = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/agents/${fx.agentId}`, {
      method: 'PATCH', body: { setup_step: 'context' },
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ reason: 'agent_not_bound' });
  });
});
