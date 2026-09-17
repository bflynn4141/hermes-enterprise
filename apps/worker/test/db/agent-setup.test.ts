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
  it('repairs legacy ownership when the active member already owns a writable session for Iris', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv();
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.agentId}`, {
      method: 'PATCH',
      body: { setup_step: 'context' },
    });
    expect(response.status).toBe(204);

    const stored = await readTenant(fx.workspaceId, fx.adminId, async (client) => client.query<{ user_id: string }>(
      `SELECT m.user_id
         FROM agent_owners ao
         JOIN members m ON m.workspace_id = ao.workspace_id AND m.id = ao.member_id
        WHERE ao.workspace_id = $1 AND ao.agent_id = $2`,
      [fx.workspaceId, fx.agentId],
    ));
    expect(stored.rows).toEqual([{ user_id: fx.adminId }]);
  });

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
    expect(stored.agent?.instructions_active).toContain('Discover and screen partners');
    expect(stored.tools).toEqual(expect.arrayContaining(['list_requests', 'propose_request', 'ask_for_context']));
    expect(stored.tools).not.toContain('send_email');
  });

  it('queues Cloud provisioning after onboarding and does not mark Iris started early', async () => {
    const fx = await seedWorkspace();
    await bindAgent(fx);
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO agent_provisioning (workspace_id, agent_id, instance_name)
         VALUES ($1,$2,$3)`,
        [fx.workspaceId, fx.agentId, `iris-partner-${fx.agentId.slice(0, 8)}`],
      );
      await client.query('COMMIT');
    });
    const { env } = makeEnv({ AGENT_RUNTIME: 'hermes' });
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.agentId}`, {
      method: 'PATCH',
      body: {
        first_run: {
          role_id: 'partner-program', role_label: 'Partner Program', loop_id: 'screen-partners',
          reviewers: {
            admission: 'You', 'role-benefits': 'You', 'external-message': 'You', 'agreement-money': 'Admin + Finance',
          },
        },
      },
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'queued' });
    const stored = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const agent = await client.query<{ status: string; started: boolean }>(
        `SELECT status, started_at IS NOT NULL AS started FROM agents WHERE id=$1`, [fx.agentId],
      );
      const provisioning = await client.query<{ status: string }>(
        `SELECT status FROM agent_provisioning WHERE agent_id=$1`, [fx.agentId],
      );
      const jobs = await client.query<{ kind: string; payload: { agent_id: string } }>(
        `SELECT kind, payload FROM jobs WHERE workspace_id=$1 AND key=$2`, [fx.workspaceId, `hermes-cloud:${fx.agentId}`],
      );
      return { agent: agent.rows[0], provisioning: provisioning.rows[0], jobs: jobs.rows };
    });
    expect(stored.agent).toEqual({ status: 'provisioning', started: false });
    expect(stored.provisioning).toEqual({ status: 'queued' });
    expect(stored.jobs).toEqual([{ kind: 'hermes_cloud_provision', payload: { agent_id: fx.agentId } }]);

    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `UPDATE agent_provisioning SET status='awaiting_bootstrap' WHERE workspace_id=$1 AND agent_id=$2`,
        [fx.workspaceId, fx.agentId],
      );
      await client.query('COMMIT');
    });
    const repeatedWhileBootstrapping = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.agentId}`, {
      method: 'PATCH',
      body: {
        first_run: {
          role_id: 'partner-program', role_label: 'Partner Program', loop_id: 'screen-partners',
          reviewers: {
            admission: 'You', 'role-benefits': 'You', 'external-message': 'You', 'agreement-money': 'Admin + Finance',
          },
        },
      },
    });
    expect(repeatedWhileBootstrapping.status).toBe(202);
    const bootstrapStatus = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const provisioning = await client.query<{ status: string }>(
        `SELECT status FROM agent_provisioning WHERE workspace_id=$1 AND agent_id=$2`, [fx.workspaceId, fx.agentId],
      );
      const jobs = await client.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND key=$2`, [fx.workspaceId, `hermes-cloud:${fx.agentId}`]);
      return { status: provisioning.rows[0]?.status, jobs: jobs.rowCount };
    });
    expect(bootstrapStatus).toEqual({ status: 'awaiting_bootstrap', jobs: 1 });

    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(`UPDATE agent_provisioning SET status='ready' WHERE workspace_id=$1 AND agent_id=$2`, [fx.workspaceId, fx.agentId]);
      await client.query('COMMIT');
    });
    const repeatedWhenReady = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${fx.agentId}`, {
      method: 'PATCH',
      body: {
        first_run: {
          role_id: 'partner-program', role_label: 'Partner Program', loop_id: 'screen-partners',
          reviewers: {
            admission: 'You', 'role-benefits': 'You', 'external-message': 'You', 'agreement-money': 'Admin + Finance',
          },
        },
      },
    });
    expect(repeatedWhenReady.status).toBe(204);
    const readyAgent = await readTenant(fx.workspaceId, fx.adminId, async (client) => client.query<{ status: string; started: boolean }>(
      `SELECT status, started_at IS NOT NULL AS started FROM agents WHERE workspace_id=$1 AND id=$2`, [fx.workspaceId, fx.agentId],
    ));
    expect(readyAgent.rows[0]).toEqual({ status: 'started', started: true });
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
