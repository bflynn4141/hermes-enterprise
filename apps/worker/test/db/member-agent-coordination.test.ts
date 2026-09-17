import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApprovalView, Bootstrap } from '@hermes/shared';
import type { Env } from '../../src/env.js';
import { POOL_CONTROL_NAMESPACE } from '../../src/hermes-cloud/capacity.js';
import { sealSecret } from '../../src/keys/envelope.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';

const KEK_V1 = Buffer.alloc(32, 23).toString('base64');

async function seedInvitation(
  env: Env,
  workspaceId: string,
  adminId: string,
  joinerId: string,
  invitationId: string,
  withCapacity: boolean,
): Promise<{ capacityId: string | null; preflightAgentId: string | null }> {
  const email = `new-teammate-${joinerId.slice(0, 8)}@example.test`;
  const capacityId = withCapacity ? randomUUID() : null;
  const preflightAgentId = withCapacity ? randomUUID() : null;
  const envelope = capacityId
    ? await sealSecret(
        env,
        { workspaceId, keyId: capacityId, namespace: POOL_CONTROL_NAMESPACE },
        'pool-control-secret-longer-than-twenty-four-characters',
      )
    : null;
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (id, email, email_verified, name) VALUES ($1, $2, true, 'Riley Park')`,
      [joinerId, email],
    );
    await setTenant(client, workspaceId, adminId);
    await client.query(
      `INSERT INTO invitations (id, workspace_id, email, role, expires_at, invited_by)
       VALUES ($1, $2, $3, 'member', now() + interval '7 days', $4)`,
      [invitationId, workspaceId, email, adminId],
    );
    if (capacityId && envelope) {
      await client.query(
        `INSERT INTO hermes_cloud_capacity
           (id, workspace_id, cloud_agent_id, instance_name, preflight_agent_id, connector_url, state,
            reserved_invitation_id, ciphertext, iv, wrapped_dek, wrap_iv, kek_version,
            plugin_version, agentcash_enabled, agentcash_wallet_present, native_cron_disabled,
            readiness_checked_at, last_health_checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,'reserved',$7,$8,$9,$10,$11,$12,'1.5.0',true,true,true,now(),now())`,
        [capacityId, workspaceId, `cloud-${capacityId}`, `iris-pool-${capacityId.slice(0, 8)}`,
         preflightAgentId, `https://reserved-${capacityId}.example.test/api/plugins/enterprise_bridge/control`, invitationId,
         Buffer.from(envelope.ciphertext), Buffer.from(envelope.iv), Buffer.from(envelope.wrappedDek),
         Buffer.from(envelope.wrapIv), envelope.kekVersion],
      );
    }
    await client.query('COMMIT');
  });
  return { capacityId, preflightAgentId };
}

describe('invitation-derived member and agent coordination', () => {
  it('consumes the exact reserved instance and creates real, capped Inbox starter work', async () => {
    const fixture = await seedWorkspace();
    const joinerId = randomUUID();
    const invitationId = randomUUID();
    const { env } = makeEnv({
      AGENT_RUNTIME: 'hermes',
      KEK_V1,
      HERMES_BRIDGE_SECRET: 'invitee-pool-test-secret-longer-than-32-characters',
      HERMES_ENTERPRISE_PUBLIC_URL: 'https://enterprise.example.test',
    });
    const seeded = await seedInvitation(
      env, fixture.workspaceId, fixture.adminId, joinerId, invitationId, true,
    );

    const accepted = await asUser(env, joinerId, `/invitations/${invitationId}/accept`, {
      method: 'POST', body: {},
    });
    expect(accepted.status).toBe(200);
    const bootstrap = await accepted.json() as Bootstrap;

    const persisted = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const joiner = await client.query<{
        member_id: string; agent_id: string; status: string; responsibility: string; setup_step: string;
      }>(
        `SELECT m.id AS member_id, ao.agent_id, a.status, a.responsibility, a.setup_step
           FROM members m
           JOIN agent_owners ao ON ao.member_id=m.id AND ao.workspace_id=m.workspace_id
           JOIN agents a ON a.id=ao.agent_id
          WHERE m.workspace_id=$1 AND m.user_id=$2`,
        [fixture.workspaceId, joinerId],
      );
      const requests = await client.query<{ id: string; kind: string; label: string; payload: Record<string, unknown> }>(
        `SELECT id, kind, label, payload FROM requests
          WHERE workspace_id=$1 AND session_id IN (SELECT id FROM sessions WHERE owner_id=$2)
          ORDER BY created_at, id`,
        [fixture.workspaceId, joinerId],
      );
      const approval = await client.query<{ request_id: string; payload: ApprovalView['payload'] }>(
        `SELECT ar.request_id, r.payload FROM approval_requests ar JOIN requests r ON r.id=ar.request_id
          WHERE ar.workspace_id=$1 AND ar.requester_agent_id=$2`,
        [fixture.workspaceId, joiner.rows[0]!.agent_id],
      );
      const policy = await client.query<{ steps: Array<{ reviewers: Array<{ kind: string; member_id: string }> }> }>(
        `SELECT steps FROM approval_policies WHERE workspace_id=$1 AND requester_agent_id=$2 AND active`,
        [fixture.workspaceId, joiner.rows[0]!.agent_id],
      );
      const welcome = await client.query<{ text: string }>(
        `SELECT m.text FROM messages m JOIN sessions s ON s.id=m.session_id
          WHERE m.workspace_id=$1 AND s.owner_id=$2 AND m.kind='welcome'`,
        [fixture.workspaceId, joinerId],
      );
      const capacity = await client.query<{
        id: string; state: string; reserved_invitation_id: string; assigned_agent_id: string;
        agentcash_enabled: boolean; agentcash_wallet_present: boolean;
      }>(`SELECT id, state, reserved_invitation_id, assigned_agent_id,
                 agentcash_enabled, agentcash_wallet_present
            FROM hermes_cloud_capacity WHERE workspace_id=$1`, [fixture.workspaceId]);
      const binding = await client.query<{ assignment: string; agentcash: boolean; ready: boolean }>(
        `SELECT assignment, agentcash, ready_at IS NOT NULL AS ready
           FROM agent_runtime_bindings WHERE workspace_id=$1 AND agent_id=$2`,
        [fixture.workspaceId, joiner.rows[0]!.agent_id],
      );
      const provisioning = await client.query<{ status: string }>(
        `SELECT status FROM agent_provisioning WHERE workspace_id=$1 AND agent_id=$2`,
        [fixture.workspaceId, joiner.rows[0]!.agent_id],
      );
      const runs = await client.query(`SELECT id FROM runs WHERE workspace_id=$1`, [fixture.workspaceId]);
      return {
        joiner: joiner.rows[0]!, requests: requests.rows, approval: approval.rows[0]!,
        policy: policy.rows[0]!, welcome: welcome.rows[0]!, capacity: capacity.rows[0]!,
        binding: binding.rows[0]!, provisioning: provisioning.rows[0]!, runCount: runs.rowCount,
      };
    });

    expect(bootstrap.agent.id).toBe(persisted.joiner.agent_id);
    expect(bootstrap.agent.id).toBe(seeded.preflightAgentId);
    expect(bootstrap.agent.provisioning_status).toBe('ready');
    expect(persisted.joiner).toMatchObject({ status: 'draft', responsibility: 'Partner Program', setup_step: 'identity' });
    expect(persisted.capacity).toMatchObject({
      id: seeded.capacityId,
      state: 'assigned',
      reserved_invitation_id: invitationId,
      assigned_agent_id: persisted.joiner.agent_id,
      agentcash_enabled: true,
      agentcash_wallet_present: true,
    });
    expect(persisted.binding).toEqual({ assignment: 'invitee_pool', agentcash: true, ready: true });
    expect(persisted.provisioning).toEqual({ status: 'ready' });
    expect(persisted.welcome.text).toContain('Your organization has assigned you Iris');
    expect(persisted.welcome.text).not.toMatch(/Admin bootstrap|Hermes Cloud/i);
    expect(persisted.requests.map((request) => [request.kind, request.label])).toEqual(expect.arrayContaining([
      ['task', 'Complete Partner Program criteria'],
      ['approval', 'Approve the first capped partner search'],
    ]));
    expect(persisted.requests.find((request) => request.kind === 'task')?.payload).toMatchObject({
      kind: 'task', task_type: 'partner_criteria_setup', agent_id: persisted.joiner.agent_id,
    });
    expect(persisted.approval.payload).toMatchObject({
      approval_type: 'run_plan',
      context: { source: { dependent_request_ids: [] } },
      details: {
        budget: { currency: 'USD', cap_minor: 15, call_cap: 1, metered_tools: ['agentcash_people'] },
      },
    });
    expect(persisted.policy.steps[0]?.reviewers).toEqual([
      { kind: 'member', member_id: persisted.joiner.member_id },
    ]);
    expect(persisted.runCount).toBe(0);
    const assignmentJobs = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => (
      await client.query(`SELECT id FROM jobs WHERE workspace_id=$1 AND kind='hermes_pool_assign'`, [fixture.workspaceId])
    ).rowCount);
    expect(assignmentJobs).toBe(0);
  });

  it('rejects a legacy invitation with no reservation and rolls membership creation back', async () => {
    const fixture = await seedWorkspace();
    const joinerId = randomUUID();
    const invitationId = randomUUID();
    const { env } = makeEnv({
      AGENT_RUNTIME: 'hermes',
      KEK_V1,
      HERMES_BRIDGE_SECRET: 'invitee-pool-test-secret-longer-than-32-characters',
    });
    await seedInvitation(env, fixture.workspaceId, fixture.adminId, joinerId, invitationId, false);

    const response = await asUser(env, joinerId, `/invitations/${invitationId}/accept`, { method: 'POST', body: {} });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ reason: 'invitation_capacity_unavailable' });

    const persisted = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const invitation = await client.query<{ status: string }>(`SELECT status FROM invitations WHERE id=$1`, [invitationId]);
      const membership = await client.query(`SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2`, [fixture.workspaceId, joinerId]);
      const ownership = await client.query(
        `SELECT ao.agent_id FROM agent_owners ao JOIN members m ON m.id=ao.member_id
          WHERE ao.workspace_id=$1 AND m.user_id=$2`,
        [fixture.workspaceId, joinerId],
      );
      return { invitation: invitation.rows[0]?.status, memberships: membership.rowCount, ownerships: ownership.rowCount };
    });
    expect(persisted).toEqual({ invitation: 'pending', memberships: 0, ownerships: 0 });
  });
});
