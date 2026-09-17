import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApprovalView, Bootstrap } from '@hermes/shared';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';
import { INBOX_HEADERS } from './m4-fixtures.js';

const AGENTCASH_CONFIG = {
  source: 'agentcash_people', source_purpose: 'person_partner_research', organization_only: false, no_outreach: true,
  role_label: 'Potential ecosystem lead', search_queries: [], intake_urls: [],
  keywords: ['artificial intelligence', 'developer relations'],
  people_search: {
    current_position_seniority_level: ['Founder', 'Head', 'Director'],
    person_skills: ['Artificial Intelligence (AI)', 'Developer Relations'],
    current_position_titles: [], person_locations: [],
  },
  ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
  minimum_priority: 40, lookback_days: 365, max_candidates: 5,
  max_api_requests: 1, minimum_rate_remaining: 0, max_spend_usd: 0.15,
};

describe('invitation-derived member and agent coordination', () => {
  it('creates one owned agent and a sequential human review without outreach or a run', async () => {
    const fixture = await seedWorkspace();
    const joinerId = randomUUID();
    const invitationId = randomUUID();
    const email = `new-teammate-${joinerId.slice(0, 8)}@example.test`;
    let adminMemberId = '';
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (id, email, email_verified, name) VALUES ($1, $2, true, 'Riley Park')`,
        [joinerId, email],
      );
      await setTenant(client, fixture.workspaceId, fixture.adminId);
      const admin = await client.query<{ id: string }>(
        `SELECT id FROM members WHERE workspace_id = $1 AND user_id = $2`,
        [fixture.workspaceId, fixture.adminId],
      );
      adminMemberId = admin.rows[0]!.id;
      await client.query(
        `INSERT INTO agent_owners (workspace_id, agent_id, member_id) VALUES ($1, $2, $3)`,
        [fixture.workspaceId, fixture.agentId, adminMemberId],
      );
      await client.query(
        `INSERT INTO invitations (id, workspace_id, email, role, expires_at, invited_by)
         VALUES ($1, $2, $3, 'member', now() + interval '7 days', $4)`,
        [invitationId, fixture.workspaceId, email, fixture.adminId],
      );
      await client.query('COMMIT');
    });

    const poolAgentId = randomUUID();
    const { env } = makeEnv({
      AGENT_RUNTIME: 'hermes',
      HERMES_BRIDGE_SECRET: 'invitee-pool-test-secret-longer-than-32-characters',
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [poolAgentId]: {
          workspace_id: fixture.workspaceId,
          base_url: 'https://invitee-iris.example/api/plugins/enterprise_bridge/control',
          api_key: 'invitee-runtime-profile-key',
          transport: 'dashboard_connector',
          assignment: 'invitee_pool',
          agentcash: true,
        },
      }),
      PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(AGENTCASH_CONFIG),
    });
    const accepted = await asUser(env, joinerId, `/invitations/${invitationId}/accept`, {
      method: 'POST',
      body: {},
    });
    expect(accepted.status).toBe(200);
    const bootstrap = await accepted.json() as Bootstrap;

    const persisted = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const joiner = await client.query<{ member_id: string; agent_id: string; status: string; responsibility: string; setup_step: string; instructions_active: string }>(
        `SELECT m.id AS member_id, ao.agent_id, a.status, a.responsibility, a.setup_step, a.instructions_active
           FROM members m
           JOIN agent_owners ao ON ao.member_id = m.id AND ao.workspace_id = m.workspace_id
           JOIN agents a ON a.id = ao.agent_id
          WHERE m.workspace_id = $1 AND m.user_id = $2`,
        [fixture.workspaceId, joinerId],
      );
      const requests = await client.query<{ request_id: string; payload: ApprovalView['payload'] }>(
        `SELECT r.id AS request_id, r.payload
           FROM requests r JOIN approval_requests ar ON ar.request_id = r.id
          WHERE r.workspace_id = $1 AND r.kind = 'approval'`,
        [fixture.workspaceId],
      );
      const messages = await client.query<{ owner_id: string; kind: string; text: string; title: string; focus_ref: Record<string, unknown> | null }>(
        `SELECT s.owner_id, m.kind, m.text, s.title, s.focus_ref
           FROM messages m JOIN sessions s ON s.id = m.session_id
          WHERE m.workspace_id = $1 ORDER BY m.created_at`,
        [fixture.workspaceId],
      );
      const audit = await client.query<{ kind: string; agent_id: string | null }>(
        `SELECT kind, agent_id FROM events
          WHERE workspace_id = $1 AND kind IN ('member.joined', 'agent.joined') ORDER BY kind`,
        [fixture.workspaceId],
      );
      const streamed = await client.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM stream_events WHERE workspace_id = $1 AND kind = 'member.agent_joined'`,
        [fixture.workspaceId],
      );
      const runs = await client.query(`SELECT id FROM runs WHERE workspace_id = $1`, [fixture.workspaceId]);
      const effects = await client.query(`SELECT id FROM effects WHERE workspace_id = $1`, [fixture.workspaceId]);
      const capabilities = await client.query<{ title: string; scope: string; tool_names: string[] }>(
        `SELECT title, scope, tool_names FROM agent_capabilities WHERE workspace_id = $1 AND agent_id = $2`,
        [fixture.workspaceId, joiner.rows[0]!.agent_id],
      );
      return {
        joiner: joiner.rows[0]!,
        requests: requests.rows,
        messages: messages.rows,
        audit: audit.rows,
        streamed: streamed.rows,
        runCount: runs.rowCount,
        effectCount: effects.rowCount,
        capabilities: capabilities.rows,
      };
    });

    expect(bootstrap.agent.id).toBe(persisted.joiner.agent_id);
    expect(persisted.joiner.agent_id).toBe(poolAgentId);
    expect(persisted.joiner.status).toBe('draft');
    expect(persisted.joiner).toMatchObject({ responsibility: 'Partner Program', setup_step: 'identity' });
    expect(persisted.joiner.instructions_active).toContain('one filtered request capped at $0.15');
    expect(persisted.capabilities).toEqual([expect.objectContaining({
      title: 'Discover and screen partners', scope: 'Partner Program',
    })]);
    const welcome = persisted.messages.find((message) => message.owner_id === joinerId && message.kind === 'welcome');
    expect(welcome).toMatchObject({
      title: 'Set up Partner Program Iris',
      focus_ref: { section: 'agents', view: 'setup', step: 'identity' },
    });
    expect(welcome?.text).toContain('AgentCash People Search is attached');
    expect(persisted.requests).toHaveLength(1);
    const request = persisted.requests[0]!;
    expect(request.payload.approval_type).toBe('team_commitment');
    expect(request.payload.context.source.trigger).toEqual({
      kind: 'member_agent_joined',
      invitation_id: invitationId,
      member_id: persisted.joiner.member_id,
      agent_id: persisted.joiner.agent_id,
    });
    expect(request.payload.policy.steps.map((step) => step.id)).toEqual(['requester-owner', 'receiving-owner']);
    expect(persisted.messages.filter((message) => message.owner_id === fixture.adminId && message.kind === 'coordination')).toHaveLength(1);
    expect(persisted.messages.filter((message) => message.owner_id === joinerId && message.kind === 'coordination')).toHaveLength(0);
    expect(persisted.messages.find((message) => message.kind === 'coordination')?.text).toContain('I have not contacted them or started either agent');
    expect(persisted.audit.map((event) => event.kind)).toEqual(['agent.joined', 'member.joined']);
    expect(persisted.audit.find((event) => event.kind === 'agent.joined')?.agent_id).toBe(persisted.joiner.agent_id);
    expect(persisted.streamed).toHaveLength(1);
    expect(persisted.streamed[0]?.payload).toMatchObject({
      source: 'invitation.accepted',
      invitation_id: invitationId,
      coordination_request_id: request.request_id,
    });
    expect(persisted.runCount).toBe(0);
    expect(persisted.effectCount).toBe(0);

    const viewResponse = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/requests/${request.request_id}/approval`);
    expect(viewResponse.status).toBe(200);
    const view = await viewResponse.json() as ApprovalView;
    expect(view.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ step_id: 'requester-owner', status: 'current' }),
      expect.objectContaining({ step_id: 'receiving-owner', status: 'blocked' }),
    ]));

    const early = await asUser(env, joinerId, `/w/${fixture.workspaceId}/requests/${request.request_id}/approval/decisions`, {
      method: 'POST',
      headers: INBOX_HEADERS,
      body: {
        decision: 'approve',
        note: null,
        expected_authorization_revision: view.payload.authorization.revision,
        expected_authorization_hash: view.payload.authorization.hash,
        idempotency_key: `early:${randomUUID()}`,
      },
    });
    expect(early.status).toBe(403);

    const sponsorDecision = await asUser(env, fixture.adminId, `/w/${fixture.workspaceId}/requests/${request.request_id}/approval/decisions`, {
      method: 'POST',
      headers: INBOX_HEADERS,
      body: {
        decision: 'approve',
        note: null,
        expected_authorization_revision: view.payload.authorization.revision,
        expected_authorization_hash: view.payload.authorization.hash,
        idempotency_key: `sponsor:${randomUUID()}`,
      },
    });
    expect(sponsorDecision.status).toBe(201);
    const afterSponsor = await sponsorDecision.json() as ApprovalView;
    expect(afterSponsor.status).toBe('pending');
    expect(afterSponsor.steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ step_id: 'requester-owner', status: 'approved' }),
      expect.objectContaining({ step_id: 'receiving-owner', status: 'current' }),
    ]));
    expect(afterSponsor.effect).toMatchObject({ kind: 'none', status: 'not_required' });
    expect(afterSponsor.work.status).toBe('waiting');

    const repeated = await asUser(env, joinerId, `/invitations/${invitationId}/accept`, { method: 'POST', body: {} });
    expect(repeated.status).toBe(404);
    const counts = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const agents = await client.query(`SELECT agent_id FROM agent_owners WHERE workspace_id = $1 AND member_id = $2`, [fixture.workspaceId, persisted.joiner.member_id]);
      const approvals = await client.query(`SELECT request_id FROM approval_requests WHERE workspace_id = $1`, [fixture.workspaceId]);
      const joins = await client.query(`SELECT id FROM stream_events WHERE workspace_id = $1 AND kind = 'member.agent_joined'`, [fixture.workspaceId]);
      return { agents: agents.rowCount, approvals: approvals.rowCount, joins: joins.rowCount };
    });
    expect(counts).toEqual({ agents: 1, approvals: 1, joins: 1 });
  });

  it('rolls invitation acceptance back when no attested invitee runtime is available', async () => {
    const fixture = await seedWorkspace();
    const joinerId = randomUUID();
    const invitationId = randomUUID();
    const email = `no-capacity-${joinerId.slice(0, 8)}@example.test`;
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await client.query(`INSERT INTO users (id, email, email_verified) VALUES ($1, $2, true)`, [joinerId, email]);
      await setTenant(client, fixture.workspaceId, fixture.adminId);
      await client.query(
        `INSERT INTO invitations (id, workspace_id, email, role, expires_at, invited_by)
         VALUES ($1, $2, $3, 'member', now() + interval '7 days', $4)`,
        [invitationId, fixture.workspaceId, email, fixture.adminId],
      );
      await client.query('COMMIT');
    });
    const { env } = makeEnv({
      AGENT_RUNTIME: 'hermes',
      HERMES_BRIDGE_SECRET: 'invitee-pool-test-secret-longer-than-32-characters',
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [fixture.agentId]: {
          workspace_id: fixture.workspaceId,
          base_url: 'https://fixed-iris.example/api/plugins/enterprise_bridge/control',
          api_key: 'fixed-runtime-profile-key',
          transport: 'dashboard_connector',
        },
      }),
    });
    const response = await asUser(env, joinerId, `/invitations/${invitationId}/accept`, { method: 'POST', body: {} });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'invitee_runtime_capacity_unavailable' });
    const persisted = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const invitation = await client.query<{ status: string }>(`SELECT status FROM invitations WHERE id = $1`, [invitationId]);
      const membership = await client.query(`SELECT id FROM members WHERE workspace_id = $1 AND user_id = $2`, [fixture.workspaceId, joinerId]);
      const ownership = await client.query(
        `SELECT ao.agent_id FROM agent_owners ao JOIN members m ON m.id = ao.member_id
          WHERE ao.workspace_id = $1 AND m.user_id = $2`,
        [fixture.workspaceId, joinerId],
      );
      return { invitation: invitation.rows[0]?.status, memberships: membership.rowCount, ownerships: ownership.rowCount };
    });
    expect(persisted).toEqual({ invitation: 'pending', memberships: 0, ownerships: 0 });
  });
});
