import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApprovalView, Bootstrap } from '@hermes/shared';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';
import { INBOX_HEADERS } from './m4-fixtures.js';

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

    const { env } = makeEnv();
    const accepted = await asUser(env, joinerId, `/invitations/${invitationId}/accept`, {
      method: 'POST',
      body: {},
    });
    expect(accepted.status).toBe(200);
    const bootstrap = await accepted.json() as Bootstrap;

    const persisted = await readTenant(fixture.workspaceId, fixture.adminId, async (client) => {
      const joiner = await client.query<{ member_id: string; agent_id: string; status: string }>(
        `SELECT m.id AS member_id, ao.agent_id, a.status
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
      const messages = await client.query<{ owner_id: string; kind: string; text: string }>(
        `SELECT s.owner_id, m.kind, m.text
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
      return {
        joiner: joiner.rows[0]!,
        requests: requests.rows,
        messages: messages.rows,
        audit: audit.rows,
        streamed: streamed.rows,
        runCount: runs.rowCount,
        effectCount: effects.rowCount,
      };
    });

    expect(bootstrap.agent.id).toBe(persisted.joiner.agent_id);
    expect(persisted.joiner.status).toBe('draft');
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
});
