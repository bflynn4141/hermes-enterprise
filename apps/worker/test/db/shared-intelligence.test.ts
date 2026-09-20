import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalView, SharedIntelligenceProposal } from '@hermes/shared';
import { withTenantTransaction } from '../../src/db/client.js';
import type { TenantWork } from '../../src/routes/tenant.js';
import {
  prepareSharedIntelligenceProposal,
  revokeSharedIntelligenceProposal,
  saveSharedIntelligenceProposal,
  scoreSharedIntelligenceAssessment,
  submitSharedIntelligenceProposal,
} from '../../src/shared-intelligence/service.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { INBOX_HEADERS } from './m4-fixtures.js';

interface IntelligenceFixture extends Fixture {
  teamId: string;
  runIds: [string, string];
  messageIds: [string, string];
}

const env = makeEnv().env;
const FIRST_SOURCE_MESSAGE = 'Separate the partner claim from independently verified evidence before escalating the review.';

async function seedIntelligenceFixture(): Promise<IntelligenceFixture> {
  const fx = await seedWorkspace();
  const teamId = randomUUID();
  const runIds: [string, string] = [randomUUID(), randomUUID()];
  const messageIds: [string, string] = [randomUUID(), randomUUID()];
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    await client.query(
      `UPDATE members SET reviewer_roles=array_append(reviewer_roles,'shared_intelligence_reviewer')
        WHERE workspace_id=$1 AND user_id=$2`,
      [fx.workspaceId, fx.memberId],
    );
    await client.query(
      `INSERT INTO enterprise_teams(id,workspace_id,slug,name) VALUES($1,$2,'partnerships','Partnerships')`,
      [teamId, fx.workspaceId],
    );
    await client.query(
      `INSERT INTO enterprise_team_agents(workspace_id,team_id,agent_id,principal_user_id,role_template_key)
       VALUES($1,$2,$3,$4,'partnerships-agent')`,
      [fx.workspaceId, teamId, fx.agentId, fx.adminId],
    );
    for (let index = 0; index < runIds.length; index += 1) {
      await client.query(
        `INSERT INTO runs(id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,active_ms,ended_at,runtime_request)
         VALUES($1,$2,$3,$4,'completed','deepseek-flash',$5,1200,now()-($6::int * interval '1 minute'),$7::jsonb)`,
        [runIds[index], fx.workspaceId, fx.sessionId, fx.agentId, randomUUID(), index, JSON.stringify({ _enterprise_tool_names: ['partner_record_read'] })],
      );
      await client.query(
        `INSERT INTO messages(id,workspace_id,session_id,seq,role,text,status,run_id,turn)
         VALUES($1,$2,$3,$4,'iris',$5,'complete',$6,$4)`,
        [messageIds[index], fx.workspaceId, fx.sessionId, index + 1,
          index === 0
            ? FIRST_SOURCE_MESSAGE
            : 'Record the evidence source and review date so a later reviewer can reproduce the decision.',
          runIds[index]],
      );
      await client.query(
        `INSERT INTO run_steps(workspace_id,run_id,turn,step_id,label,state)
         VALUES($1,$2,0,$3,'Checked source record','done')`,
        [fx.workspaceId, runIds[index], `check-${index}`],
      );
    }
    await client.query('COMMIT');
  });
  return { ...fx, teamId, runIds, messageIds };
}

async function createAndSubmit(
  fx: IntelligenceFixture,
  options: {
    teamId?: string;
    agentId?: string;
    userId?: string;
    lesson?: string;
    rationale?: string;
    evidence?: Array<{ run_id: string; approved_excerpt: string }>;
  } = {},
): Promise<{ proposal: SharedIntelligenceProposal; requestId: string }> {
  const userId = options.userId ?? fx.adminId;
  return withTenantTransaction(env, 'app', { workspaceId: fx.workspaceId, userId }, async (tx) => {
    const work = { tx, workspaceId: fx.workspaceId, userId, jobs: [] } as unknown as TenantWork;
    const prepared = await prepareSharedIntelligenceProposal(work, {
      agent_id: options.agentId ?? fx.agentId,
      title: 'Record evidence provenance before escalation',
      goal: 'Make partner reviews reproducible',
      lesson: options.lesson ?? 'Separate claims from independently verified evidence and record the evidence source and review date.',
      rationale: options.rationale ?? 'Two completed reviews exposed the same reproducibility gap.',
      team_ids: [options.teamId ?? fx.teamId],
      evidence: options.evidence ?? [
        { run_id: fx.runIds[0], approved_excerpt: 'Separate the partner claim from independently verified evidence before escalating the review.' },
        { run_id: fx.runIds[1], approved_excerpt: 'Record the evidence source and review date so a later reviewer can reproduce the decision.' },
      ],
    });
    const assessment = scoreSharedIntelligenceAssessment({
      model: 'jev-1.13.0-test',
      answers: {
        usefulness: { score: 3, confidence: .9 }, novelty: { score: 2.5, confidence: .9 },
        corroboration: { score: 3, confidence: .9 }, urgency: { score: 2, confidence: .9 }, uncertainty: { score: .5, confidence: .9 },
      },
    }, { evidenceCount: prepared.evidence.length, stateSha256: prepared.stateSha256, latencyMs: 12 });
    const proposal = await saveSharedIntelligenceProposal(work, prepared, assessment);
    const submitted = await submitSharedIntelligenceProposal(work, proposal.id);
    return { proposal: submitted.proposal, requestId: submitted.approval_request_id };
  });
}

async function approvalFor(fx: IntelligenceFixture, requestId: string, reviewerId = fx.memberId): Promise<ApprovalView> {
  const response = await asUser(env, reviewerId, `/w/${fx.workspaceId}/requests/${requestId}/approval`);
  expect(response.status).toBe(200);
  return await response.json() as ApprovalView;
}

async function approve(fx: IntelligenceFixture, view: ApprovalView, reviewerId = fx.memberId): Promise<Response> {
  return asUser(env, reviewerId, `/w/${fx.workspaceId}/requests/${view.request_id}/approval/decisions`, {
    method: 'POST',
    headers: INBOX_HEADERS,
    body: {
      decision: 'approve', note: 'Evidence and audience verified.', idempotency_key: `shared-intelligence-vote:${randomUUID()}`,
      expected_authorization_revision: view.payload.authorization.revision,
      expected_authorization_hash: view.payload.authorization.hash,
    },
  });
}

describe('Shared Intelligence publication boundary', () => {
  let fx: IntelligenceFixture;
  beforeEach(async () => { fx = await seedIntelligenceFixture(); });

  it('publishes one immutable team-scoped Library version after an independent review, then revokes access without deleting audit facts', async () => {
    const submitted = await createAndSubmit(fx);
    const pending = await approvalFor(fx, submitted.requestId);
    expect(pending.payload.context.requester.user_id).toBe(fx.adminId);
    expect(pending.identities.reviewers.map((reviewer) => reviewer.user_id)).toContain(fx.memberId);
    expect(pending.effect).toMatchObject({ kind: 'shared_learning_publish', status: 'waiting' });

    const response = await approve(fx, pending);
    const approvedBody = await response.json();
    expect({ status: response.status, body: approvedBody }).toMatchObject({ status: 201, body: { status: 'approved', effect: { status: 'executed' } } });

    const visible = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/library-sources?agent_id=${fx.agentId}`);
    expect(visible.status).toBe(200);
    const items = ((await visible.json()) as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Record evidence provenance before escalation', version: 1, audiences: ['Partnerships'] });
    expect(String(items[0]?.content_markdown)).toContain('approved redacted excerpt from a hash-pinned final user-visible agent response');
    expect(String(items[0]?.content_markdown)).toContain('Runtime completion does not establish business success');

    await withClient('agent', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await expect(client.query('SELECT * FROM shared_intelligence_proposals')).rejects.toMatchObject({ code: '42501' });
      await expect(client.query('SELECT * FROM shared_intelligence_evidence')).rejects.toMatchObject({ code: '25P02' });
      await client.query('ROLLBACK');
    });

    await withTenantTransaction(env, 'app', { workspaceId: fx.workspaceId, userId: fx.adminId }, async (tx) => {
      const work = { tx, workspaceId: fx.workspaceId, userId: fx.adminId, jobs: [] } as unknown as TenantWork;
      await revokeSharedIntelligenceProposal(work, submitted.proposal.id);
    });
    const afterRevoke = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/library-sources?agent_id=${fx.agentId}`);
    expect(((await afterRevoke.json()) as { items: unknown[] }).items).toEqual([]);
    await withClient('owner', async (client) => {
      await client.query('BEGIN'); await setTenant(client, fx.workspaceId, fx.adminId);
      const facts = await client.query<{ sources: number; versions: number; grants: number }>(
        `SELECT
          (SELECT count(*)::int FROM library_sources WHERE workspace_id=$1) AS sources,
          (SELECT count(*)::int FROM library_source_versions WHERE workspace_id=$1) AS versions,
          (SELECT count(*)::int FROM library_source_team_grants WHERE workspace_id=$1) AS grants`, [fx.workspaceId],
      );
      expect(facts.rows[0]).toEqual({ sources: 1, versions: 1, grants: 0 });
      await client.query('ROLLBACK');
    });
  });

  it('refuses publication when a pinned visible message changes after submission', async () => {
    const submitted = await createAndSubmit(fx);
    const pending = await approvalFor(fx, submitted.requestId);
    await withClient('owner', async (client) => {
      await client.query('BEGIN'); await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(`UPDATE messages SET text='Changed after the proposal was frozen.' WHERE workspace_id=$1 AND id=$2`, [fx.workspaceId, fx.messageIds[0]]);
      await client.query('COMMIT');
    });
    const response = await approve(fx, pending);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'shared_intelligence_evidence_changed' });
    const published = await withClient('owner', async (client) => {
      await client.query('BEGIN'); await setTenant(client, fx.workspaceId, fx.adminId);
      const count = await client.query<{ count: number }>('SELECT count(*)::int AS count FROM library_sources WHERE workspace_id=$1', [fx.workspaceId]);
      await client.query('ROLLBACK'); return count.rows[0]!.count;
    });
    expect(published).toBe(0);
  });

  it('rejects an initially case-altered excerpt while accepting the exact sanitized rendering', async () => {
    await expect(withTenantTransaction(env, 'app', { workspaceId: fx.workspaceId, userId: fx.adminId }, async (tx) => {
      const work = { tx, workspaceId: fx.workspaceId, userId: fx.adminId, jobs: [] } as unknown as TenantWork;
      return prepareSharedIntelligenceProposal(work, {
        agent_id: fx.agentId,
        title: 'Record evidence provenance before escalation',
        goal: 'Make partner reviews reproducible',
        lesson: 'Separate claims from evidence before escalation.',
        rationale: 'A completed review exposed a reproducibility gap.',
        team_ids: [fx.teamId],
        evidence: [{ run_id: fx.runIds[0], approved_excerpt: FIRST_SOURCE_MESSAGE.toLowerCase() }],
      });
    })).rejects.toMatchObject({ reason: 'shared_intelligence_excerpt_unverified', status: 422 });

    const prepared = await withTenantTransaction(env, 'app', { workspaceId: fx.workspaceId, userId: fx.adminId }, async (tx) => {
      const work = { tx, workspaceId: fx.workspaceId, userId: fx.adminId, jobs: [] } as unknown as TenantWork;
      return prepareSharedIntelligenceProposal(work, {
        agent_id: fx.agentId,
        title: 'Record evidence provenance before escalation',
        goal: 'Make partner reviews reproducible',
        lesson: 'Separate claims from evidence before escalation.',
        rationale: 'A completed review exposed a reproducibility gap.',
        team_ids: [fx.teamId],
        evidence: [{ run_id: fx.runIds[0], approved_excerpt: FIRST_SOURCE_MESSAGE }],
      });
    });
    expect(prepared.evidence[0]?.approvedExcerpt).toBe(FIRST_SOURCE_MESSAGE);
  });

  it.each([
    ['case', FIRST_SOURCE_MESSAGE.toLowerCase()],
    ['whitespace', FIRST_SOURCE_MESSAGE.replace('partner claim', 'partner  claim')],
    ['Unicode compatibility', FIRST_SOURCE_MESSAGE.replace('Separate', 'Ｓeparate')],
  ])('refuses publication after a %s-only source edit', async (_kind, changedText) => {
    const submitted = await createAndSubmit(fx);
    const pending = await approvalFor(fx, submitted.requestId);
    await withClient('owner', async (client) => {
      await client.query('BEGIN'); await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query('UPDATE messages SET text=$3 WHERE workspace_id=$1 AND id=$2', [fx.workspaceId, fx.messageIds[0], changedText]);
      await client.query('COMMIT');
    });
    const response = await approve(fx, pending);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'shared_intelligence_evidence_changed' });
  });

  it('rechecks team ownership at the final human decision', async () => {
    const submitted = await createAndSubmit(fx);
    const pending = await approvalFor(fx, submitted.requestId);
    await withClient('owner', async (client) => {
      await client.query('BEGIN'); await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query('DELETE FROM enterprise_team_agents WHERE workspace_id=$1 AND team_id=$2', [fx.workspaceId, fx.teamId]);
      await client.query('COMMIT');
    });
    const response = await approve(fx, pending);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'shared_intelligence_audience_changed' });
  });

  it('keeps same-title publications isolated by proposal, team, summary, version, and revocation', async () => {
    const financeTeamId = randomUUID();
    const financeAgentId = randomUUID();
    const financeSessionId = randomUUID();
    const financeUserId = randomUUID();
    const financeRunIds = [randomUUID(), randomUUID()];
    await withClient('owner', async (client) => {
      await client.query('BEGIN'); await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO users(id,email,email_verified,name) VALUES($1,$2,true,'Finley Reed')`,
        [financeUserId, `finance-${financeUserId.slice(0, 8)}@example.test`],
      );
      await client.query(
        `INSERT INTO members(workspace_id,user_id,role,reviewer_roles) VALUES($1,$2,'member',ARRAY[]::text[])`,
        [fx.workspaceId, financeUserId],
      );
      await client.query(
        `INSERT INTO enterprise_teams(id,workspace_id,slug,name) VALUES($1,$2,'finance','Finance')`,
        [financeTeamId, fx.workspaceId],
      );
      await client.query(
        `INSERT INTO agents(id,workspace_id,name,status,context_scope) VALUES($1,$2,'Ledger','started','workspace')`,
        [financeAgentId, fx.workspaceId],
      );
      await client.query(
        `INSERT INTO sessions(id,workspace_id,owner_id,agent_id,title,model_id)
         VALUES($1,$2,$3,$4,'Finance evidence review','deepseek-flash')`,
        [financeSessionId, fx.workspaceId, financeUserId, financeAgentId],
      );
      await client.query(
        `INSERT INTO enterprise_team_agents(workspace_id,team_id,agent_id,principal_user_id,role_template_key)
         VALUES($1,$2,$3,$4,'finance-agent')`,
        [fx.workspaceId, financeTeamId, financeAgentId, financeUserId],
      );
      for (let index = 0; index < financeRunIds.length; index += 1) {
        await client.query(
          `INSERT INTO runs(id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,active_ms,ended_at,runtime_request)
           VALUES($1,$2,$3,$4,'completed','deepseek-flash',$5,900,now()-($6::int * interval '1 minute'),$7::jsonb)`,
          [financeRunIds[index], fx.workspaceId, financeSessionId, financeAgentId, randomUUID(), index,
            JSON.stringify({ _enterprise_tool_names: ['finance_record_read'] })],
        );
        await client.query(
          `INSERT INTO messages(id,workspace_id,session_id,seq,role,text,status,run_id,turn)
           VALUES($1,$2,$3,$4,'iris',$5,'complete',$6,$4)`,
          [randomUUID(), fx.workspaceId, financeSessionId, index + 1,
            index === 0
              ? 'Record the finance evidence date before escalating a mismatch.'
              : 'Keep the reviewed finance source attached to the decision record.',
            financeRunIds[index]],
        );
        await client.query(
          `INSERT INTO run_steps(workspace_id,run_id,turn,step_id,label,state)
           VALUES($1,$2,0,$3,'Checked finance source','done')`,
          [fx.workspaceId, financeRunIds[index], `finance-check-${index}`],
        );
      }
      await client.query('COMMIT');
    });

    const partnershipsLesson = 'Separate partnership claims from verified evidence before escalation.';
    const financeLesson = 'Record finance evidence dates before escalating a mismatch.';
    const partnerships = await createAndSubmit(fx, { lesson: partnershipsLesson, teamId: fx.teamId });
    const partnershipsApproval = await approvalFor(fx, partnerships.requestId);
    expect((await approve(fx, partnershipsApproval)).status).toBe(201);
    const finance = await createAndSubmit(fx, {
      agentId: financeAgentId,
      userId: financeUserId,
      lesson: financeLesson,
      teamId: financeTeamId,
      evidence: [
        { run_id: financeRunIds[0]!, approved_excerpt: 'Record the finance evidence date before escalating a mismatch.' },
        { run_id: financeRunIds[1]!, approved_excerpt: 'Keep the reviewed finance source attached to the decision record.' },
      ],
    });
    const financeApproval = await approvalFor(fx, finance.requestId, fx.adminId);
    expect((await approve(fx, financeApproval, fx.adminId)).status).toBe(201);

    const beforeRevoke = await withClient('owner', async (client) => {
      await client.query('BEGIN'); await setTenant(client, fx.workspaceId, fx.adminId);
      const rows = await client.query<{ id: string; summary: string; versions: number; team_ids: string[] }>(
        `SELECT source.id,source.summary,count(DISTINCT version.id)::int AS versions,
                COALESCE(array_agg(DISTINCT source_grant.team_id) FILTER (WHERE source_grant.team_id IS NOT NULL),'{}'::uuid[]) AS team_ids
           FROM library_sources source
           JOIN library_source_versions version ON version.workspace_id=source.workspace_id AND version.source_id=source.id
           LEFT JOIN library_source_team_grants source_grant ON source_grant.workspace_id=source.workspace_id AND source_grant.source_id=source.id
          WHERE source.workspace_id=$1 GROUP BY source.id,source.summary ORDER BY source.summary`,
        [fx.workspaceId],
      );
      await client.query('ROLLBACK');
      return rows.rows;
    });
    expect(beforeRevoke).toHaveLength(2);
    expect(beforeRevoke).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: partnershipsLesson, versions: 1, team_ids: [fx.teamId] }),
      expect.objectContaining({ summary: financeLesson, versions: 1, team_ids: [financeTeamId] }),
    ]));
    expect(new Set(beforeRevoke.map((row) => row.id)).size).toBe(2);

    await withTenantTransaction(env, 'app', { workspaceId: fx.workspaceId, userId: fx.adminId }, async (tx) => {
      const work = { tx, workspaceId: fx.workspaceId, userId: fx.adminId, jobs: [] } as unknown as TenantWork;
      await revokeSharedIntelligenceProposal(work, partnerships.proposal.id);
    });
    const afterRevoke = await withClient('owner', async (client) => {
      await client.query('BEGIN'); await setTenant(client, fx.workspaceId, fx.adminId);
      const rows = await client.query<{ summary: string; grants: number }>(
        `SELECT source.summary,count(source_grant.team_id)::int AS grants
           FROM library_sources source
           LEFT JOIN library_source_team_grants source_grant ON source_grant.workspace_id=source.workspace_id AND source_grant.source_id=source.id
          WHERE source.workspace_id=$1 GROUP BY source.id,source.summary ORDER BY source.summary`,
        [fx.workspaceId],
      );
      await client.query('ROLLBACK');
      return rows.rows;
    });
    expect(afterRevoke).toEqual(expect.arrayContaining([
      { summary: partnershipsLesson, grants: 0 },
      { summary: financeLesson, grants: 1 },
    ]));
  });
});
