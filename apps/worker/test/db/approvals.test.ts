import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApprovalProposal, ApprovalView } from '@hermes/shared';
import { withTenantTransaction } from '../../src/db/client.js';
import { proposeApproval } from '../../src/domain/approvals.js';
import { installApprovalDemoFixture } from '../../src/domain/approval-fixtures.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { INBOX_HEADERS, seedRequest } from './m4-fixtures.js';

interface ApprovalFixture extends Fixture {
  readonly adminMemberId: string;
  readonly reviewerMemberId: string;
  readonly secondReviewerUserId: string;
  readonly secondReviewerMemberId: string;
  readonly outsiderUserId: string;
  readonly targetAgentId: string;
}

const env = () => makeEnv();

async function seedApprovalFixture(): Promise<ApprovalFixture> {
  const base = await seedWorkspace();
  const secondReviewerUserId = randomUUID();
  const outsiderUserId = randomUUID();
  const targetAgentId = randomUUID();
  let adminMemberId = '';
  let reviewerMemberId = '';
  let secondReviewerMemberId = '';
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO users (id, email, email_verified, name) VALUES
        ($1, $3, true, 'Avery Singh'), ($2, $4, true, 'Pat Lee')`,
      [secondReviewerUserId, outsiderUserId, `avery-${base.workspaceId}@example.test`, `pat-${base.workspaceId}@example.test`],
    );
    await setTenant(c, base.workspaceId, base.adminId);
    const existing = await c.query<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM members WHERE workspace_id = $1`, [base.workspaceId],
    );
    adminMemberId = existing.rows.find((row) => row.user_id === base.adminId)!.id;
    reviewerMemberId = existing.rows.find((row) => row.user_id === base.memberId)!.id;
    const inserted = await c.query<{ id: string }>(
      `INSERT INTO members (workspace_id, user_id, role, reviewer_roles) VALUES
        ($1, $2, 'member', ARRAY['budget']), ($1, $3, 'member', ARRAY[]::text[])
       RETURNING id`,
      [base.workspaceId, secondReviewerUserId, outsiderUserId],
    );
    secondReviewerMemberId = inserted.rows[0]!.id;
    await c.query(`INSERT INTO agents (id, workspace_id, name, status) VALUES ($1,$2,'Theo','draft')`, [targetAgentId, base.workspaceId]);
    await c.query(
      `INSERT INTO agent_owners (workspace_id, agent_id, member_id) VALUES
        ($1,$2,$3), ($1,$4,$5)`,
      [base.workspaceId, base.agentId, adminMemberId, targetAgentId, reviewerMemberId],
    );
    const twoReviewers = [{
      id: 'budget-review', label: 'Two distinct budget reviewers', order: 0,
      reviewers: [{ kind: 'member', member_id: reviewerMemberId }, { kind: 'member', member_id: secondReviewerMemberId }],
      quorum: 2,
    }];
    await c.query(
      `INSERT INTO approval_policies
        (workspace_id, key, version, approval_type, requester_agent_id, max_budget_minor,
         priority, mode, prevent_self_review, steps)
       VALUES
        ($1,'run-plan-low',1,'run_plan',$2,500,10,'parallel',true,$3::jsonb),
        ($1,'run-plan-high',1,'run_plan',$2,5000,10,'parallel',true,$3::jsonb)`,
      [base.workspaceId, base.agentId, JSON.stringify(twoReviewers)],
    );
    const sequential = [
      { id: 'receiving-owner', label: 'Receiving owner', order: 0, reviewers: [{ kind: 'member', member_id: reviewerMemberId }], quorum: 1 },
      { id: 'second-review', label: 'Independent reviewer', order: 1, reviewers: [{ kind: 'member', member_id: reviewerMemberId }, { kind: 'member', member_id: secondReviewerMemberId }], quorum: 1 },
    ];
    await c.query(
      `INSERT INTO approval_policies
        (workspace_id, key, version, approval_type, requester_agent_id, priority, mode, prevent_self_review, steps)
       VALUES ($1,'team-sequential',1,'team_commitment',$2,10,'sequential',true,$3::jsonb)`,
      [base.workspaceId, base.agentId, JSON.stringify(sequential)],
    );
    await c.query('COMMIT');
  });
  return { ...base, adminMemberId, reviewerMemberId, secondReviewerUserId, secondReviewerMemberId, outsiderUserId, targetAgentId };
}

function runPlan(fx: ApprovalFixture, capMinor = 500, summary = 'Run weekly partner research.'): ApprovalProposal {
  return {
    kind: 'approval', approval_type: 'run_plan', summary,
    consequence: 'Authorize this exact plan and its hard limits; no external message is sent.',
    evidence: [], illustrative: true,
    details: {
      goal: 'Produce a cited weekly partner shortlist.',
      steps: [{ id: 'research', label: 'Research partners', agent_id: fx.agentId, output: 'Cited shortlist' }],
      participating_agents: [{ agent_id: fx.agentId, role: 'Researcher' }],
      deliverables: ['Weekly shortlist'], schedule: 'Mondays at 09:00 America/Los_Angeles',
      budget: {
        currency: 'USD', estimated_min_minor: 100, estimated_max_minor: Math.min(300, capMinor), cap_minor: capMinor,
        estimated_input_tokens: 10_000, estimated_output_tokens: 2_000,
        total_token_cap: 15_000, call_cap: 4, max_output_tokens_per_call: 2_000, max_parallel_calls: 1,
        model_ids: ['deepseek-flash'], metered_tools: [], retries_included: 1, illustrative: true,
      },
    },
  };
}

function teamCommitment(fx: ApprovalFixture): Extract<ApprovalProposal, { approval_type: 'team_commitment' }> {
  return {
    kind: 'approval', approval_type: 'team_commitment', summary: 'Ask Theo to verify technical evidence.',
    consequence: 'Accept only this bounded task for the receiving agent.', evidence: [], illustrative: true,
    details: { requester_agent_id: fx.agentId, recipient_agent_id: fx.targetAgentId, receiving_owner_member_id: fx.reviewerMemberId, workload: 'Verify the shortlist evidence.', due_at: '2026-10-01T17:00:00-07:00', dependencies: [], acceptance_criteria: ['Every claim has a primary source'] },
  };
}

function outreachDraft(fx: ApprovalFixture): Extract<ApprovalProposal, { approval_type: 'communication' }> {
  return {
    kind: 'approval', approval_type: 'communication', illustrative: false,
    summary: 'Review a personalized partner invitation draft.',
    consequence: 'Approval records the reviewed copy only and sends no message.',
    evidence: [{ id: 'candidate-evidence', kind: 'source', label: 'Stored professional evidence' }],
    details: {
      channel: 'email', draft_only: true,
      sender: { member_id: fx.adminMemberId, address: 'maya@example.test' },
      recipients: [{ name: 'Taylor Brooks', address: null }],
      subject: 'Explore the Hermes Partner Program',
      body: 'Hi Taylor,\n\nYour public work suggests a possible fit. Would you be interested in exploring the Hermes Partner Program?',
      attachments: [],
    },
  };
}

async function propose(fx: ApprovalFixture, proposal: ApprovalProposal, key: string, policyKey = 'run-plan-low'): Promise<ApprovalView> {
  const e = env();
  return withTenantTransaction(e.env, 'app', { workspaceId: fx.workspaceId, userId: fx.adminId }, (tx) =>
    proposeApproval(
      { tx, workspaceId: fx.workspaceId, jobs: [], agentId: fx.agentId, userId: fx.adminId, sessionId: fx.sessionId },
      { label: proposal.summary, policy_key: policyKey, proposal, target_agent_ids: [], target_member_ids: [], target_resource_ids: [], dependent_request_ids: [], idempotency_key: key },
    ),
  );
}

const decision = (view: ApprovalView, idempotencyKey: string, choice: 'approve' | 'decline' | 'request_changes' = 'approve') => ({
  decision: choice,
  expected_authorization_revision: view.payload.authorization.revision,
  expected_authorization_hash: view.payload.authorization.hash,
  idempotency_key: idempotencyKey,
  note: null,
});

describe('enterprise approval policy and voting', () => {
  let fx: ApprovalFixture;
  beforeEach(async () => { fx = await seedApprovalFixture(); });

  it('stores outreach as a draft-only review with no delivery effect', async () => {
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO approval_policies
          (workspace_id, key, version, approval_type, requester_agent_id, priority, mode,
           prevent_self_review, steps)
         VALUES ($1,'partner-outreach-draft',1,'communication',$2,100,'sequential',false,$3::jsonb)`,
        [fx.workspaceId, fx.agentId, JSON.stringify([{
          id: 'owner-review', label: 'Review personalized outreach draft', order: 0,
          reviewers: [{ kind: 'member', member_id: fx.adminMemberId }], quorum: 1,
        }])],
      );
      await client.query('COMMIT');
    });
    const proposed = await propose(fx, outreachDraft(fx), `proposal:${randomUUID()}`, 'partner-outreach-draft');
    expect(proposed.payload.approval_type).toBe('communication');
    if (proposed.payload.approval_type !== 'communication') throw new Error('fixture drift');
    expect(proposed.payload.details).toMatchObject({
      draft_only: true, recipients: [{ name: 'Taylor Brooks', address: null }],
    });
    expect(proposed.effect).toMatchObject({
      kind: 'communication', status: 'not_required', reason: expect.stringContaining('does not send'),
    });
  });

  it('accepts only contact fields copied from stored verified partner evidence', async () => {
    const seeded = await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      const screening = await client.query<{ id: string }>(
        `INSERT INTO partner_screening_runs
           (workspace_id,agent_id,created_by,idempotency_key,status,source,authentication,
            config_snapshot,api_requests_max,api_requests_used,agentcash_tool_call_id,
            candidates_discovered,monetary_cost_usd,completed_at)
         VALUES ($1,$2,$3,$4,'completed','agentcash_people','wallet','{}',1,1,'seed',1,0.15,now())
         RETURNING id`,
        [fx.workspaceId, fx.agentId, fx.adminId, `approval-contact:${randomUUID()}`],
      );
      const candidate = await client.query<{ id: string }>(
        `INSERT INTO partner_candidates
           (workspace_id,agent_id,source,source_key,display_name,profile_url,
            deterministic_priority,priority_breakdown,confidence,evidence_gaps,
            latest_run_id,first_seen_at,last_seen_at)
         VALUES ($1,$2,'agentcash_people',$3,'Taylor Brooks','https://www.linkedin.com/in/taylor-brooks',
                 90,'[]','high','{}',$4,now(),now()) RETURNING id`,
        [fx.workspaceId, fx.agentId, `approval-contact:${randomUUID()}`, screening.rows[0]!.id],
      );
      const run = await client.query<{ id: string }>(
        `INSERT INTO runs (workspace_id,session_id,agent_id,status,model_id,client_turn_id,trace_id,mode)
         VALUES ($1,$2,$3,'completed','deepseek-flash',$4,$5,'work') RETURNING id`,
        [fx.workspaceId, fx.sessionId, fx.agentId, randomUUID(), randomUUID()],
      );
      const enrichment = await client.query<{ id: string }>(
        `INSERT INTO partner_contact_enrichments
           (workspace_id,agent_id,candidate_id,run_id,runtime_run_id,status,contact_data,
            preferred_email,verification_status,verification_checks,draft_eligible,
            monetary_cost_usd,fetched_at,verified_at)
         VALUES ($1,$2,$3,$4,$5,'completed',$6::jsonb,'taylor@example.com','valid',$7::jsonb,true,0.08,now(),now())
         RETURNING id`,
        [fx.workspaceId, fx.agentId, candidate.rows[0]!.id, run.rows[0]!.id, `run_${'d'.repeat(32)}`,
          JSON.stringify({ professional_emails: ['taylor@example.com'], phones: [{ number: '+1 415 555 0100', type: 'mobile' }], social_profiles: [{ network: 'linkedin', url: 'https://www.linkedin.com/in/taylor-brooks' }] }),
          JSON.stringify({ regexp: true, mx_records: true, smtp_server: true, smtp_check: true, disposable: false, block: false })],
      );
      await client.query(
        `INSERT INTO approval_policies
          (workspace_id,key,version,approval_type,requester_agent_id,priority,mode,
           prevent_self_review,steps)
         VALUES ($1,$2,1,'communication',$3,1000000,'sequential',false,$4::jsonb)`,
        [fx.workspaceId, `partner-outreach-draft-${fx.agentId}`, fx.agentId, JSON.stringify([{
          id: 'owner-review', label: 'Review partner draft', order: 0,
          reviewers: [{ kind: 'member', member_id: fx.adminMemberId }], quorum: 1,
        }])],
      );
      await client.query('COMMIT');
      return { candidateId: candidate.rows[0]!.id, enrichmentId: enrichment.rows[0]!.id };
    });
    const proposal = outreachDraft(fx);
    proposal.evidence.push({ id: seeded.enrichmentId, kind: 'artifact', label: 'Verified professional contact' });
    proposal.details.recipients = [{
      name: 'Taylor Brooks', address: 'taylor@example.com', candidate_id: seeded.candidateId,
      phone_numbers: [{ number: '+1 415 555 0100', type: 'mobile' }],
      social_profiles: [{ network: 'linkedin', url: 'https://www.linkedin.com/in/taylor-brooks' }],
    }];
    const policyKey = `partner-outreach-draft-${fx.agentId}`;
    const accepted = await propose(fx, proposal, `proposal:${randomUUID()}`, policyKey);
    expect(accepted.payload.approval_type).toBe('communication');

    const forged = structuredClone(proposal);
    forged.details.recipients[0]!.address = 'invented@example.net';
    await expect(propose(fx, forged, `proposal:${randomUUID()}`, policyKey)).rejects.toMatchObject({
      reason: 'invalid_partner_outreach_contact',
    });
  });

  it('requires two distinct current reviewers and prevents requester self-review', async () => {
    const e = env();
    const proposed = await propose(fx, runPlan(fx), `proposal:${randomUUID()}`);

    const self = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, `vote:${randomUUID()}`),
    });
    expect(self.status).toBe(403);

    const first = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, `vote:${randomUUID()}`),
    });
    expect(first.status).toBe(201);
    const afterFirst = await first.json() as ApprovalView;
    expect(afterFirst.status).toBe('pending');
    expect(afterFirst.steps[0]).toMatchObject({ approvals_recorded: 1, quorum: 2 });

    const duplicateReviewer = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, `vote:${randomUUID()}`),
    });
    expect(duplicateReviewer.status).toBe(409);

    const second = await asUser(e.env, fx.secondReviewerUserId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, `vote:${randomUUID()}`),
    });
    expect(second.status).toBe(201);
    const final = await second.json() as ApprovalView;
    expect(final.status).toBe('approved');
    expect(final.work.status).toBe('ready');

    const persisted = await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const votes = await c.query(`SELECT reviewer_member_id FROM approval_votes WHERE request_id = $1`, [proposed.request_id]);
      const jobs = await c.query<{ kind: string; key: string; done_at: Date | null }>(`SELECT kind, key, done_at FROM jobs WHERE kind = 'approval_continue' AND payload->>'request_id' = $1`, [proposed.request_id]);
      return { votes: votes.rows, jobs: jobs.rows };
    });
    expect(new Set(persisted.votes.map((vote) => vote.reviewer_member_id)).size).toBe(2);
    expect(persisted.jobs).toHaveLength(1);
    expect(persisted.jobs[0]?.done_at).not.toBeNull();
  });

  it('deduplicates simultaneous identical decisions without double voting', async () => {
    const e = env();
    const proposed = await propose(fx, runPlan(fx), `proposal:${randomUUID()}`);
    const key = `vote:${randomUUID()}`;
    const path = `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`;
    const [a, b] = await Promise.all([
      asUser(e.env, fx.memberId, path, { method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, key) }),
      asUser(e.env, fx.memberId, path, { method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, key) }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    const count = await readTenant(fx.workspaceId, fx.adminId, async (c) => (await c.query<{ count: number }>(`SELECT count(*)::int AS count FROM approval_votes WHERE request_id = $1`, [proposed.request_id])).rows[0]!.count);
    expect(count).toBe(1);

    const changed = await asUser(e.env, fx.memberId, path, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, key, 'decline'),
    });
    expect(changed.status).toBe(409);
    expect((await changed.json() as { reason: string }).reason).toBe('idempotency_conflict');
  });

  it('rejects reuse of a proposal idempotency key with different material', async () => {
    const key = `proposal:${randomUUID()}`;
    await propose(fx, runPlan(fx), key);
    await expect(propose(fx, runPlan(fx, 500, 'A different plan under the same retry key.'), key)).rejects.toMatchObject({
      reason: 'idempotency_conflict',
    });
  });

  it('deduplicates simultaneous identical proposals to one request', async () => {
    const key = `proposal:${randomUUID()}`;
    const proposal = runPlan(fx);
    const [first, second] = await Promise.all([propose(fx, proposal, key), propose(fx, proposal, key)]);
    expect(first.request_id).toBe(second.request_id);
    const count = await readTenant(fx.workspaceId, fx.adminId, async (c) => (
      await c.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM approval_requests WHERE proposal_idempotency_key = $1`,
        [key],
      )
    ).rows[0]!.count);
    expect(count).toBe(1);
  });

  it('blocks later sequential steps until the current owner approves', async () => {
    const e = env();
    const proposed = await propose(fx, teamCommitment(fx), `proposal:${randomUUID()}`, 'team-sequential');
    expect(proposed.steps.map((step) => step.status)).toEqual(['current', 'blocked']);

    const early = await asUser(e.env, fx.secondReviewerUserId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, `vote:${randomUUID()}`),
    });
    expect(early.status).toBe(403);

    const first = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, `vote:${randomUUID()}`),
    });
    const afterFirst = await first.json() as ApprovalView;
    expect(afterFirst.steps.map((step) => step.status)).toEqual(['approved', 'current']);
    expect(afterFirst.steps[1]?.current_reviewer_member_ids).toEqual(expect.arrayContaining([fx.reviewerMemberId, fx.secondReviewerMemberId]));

    const repeated = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(afterFirst, `vote:${randomUUID()}`),
    });
    expect(repeated.status).toBe(409);

    const second = await asUser(e.env, fx.secondReviewerUserId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(afterFirst, `vote:${randomUUID()}`),
    });
    expect(second.status).toBe(201);
    expect((await second.json() as ApprovalView).status).toBe('approved');
  });

  it('counts actionable requests for me separately from requests waiting on others', async () => {
    const e = env();
    const proposed = await propose(fx, runPlan(fx), `proposal:${randomUUID()}`);
    const mine = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/bootstrap`);
    const mineCounts = (await mine.json() as { counts: { pending_for_me: number; pending_for_others: number } }).counts;
    expect(mineCounts).toMatchObject({ pending_for_me: 1, pending_for_others: 0 });

    const notMine = await asUser(e.env, fx.outsiderUserId, `/w/${fx.workspaceId}/bootstrap`);
    const otherCounts = (await notMine.json() as { counts: { pending_for_me: number; pending_for_others: number } }).counts;
    expect(otherCounts).toMatchObject({ pending_for_me: 0, pending_for_others: 1 });

    await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, `vote:${randomUUID()}`),
    });
    const afterVote = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/bootstrap`);
    expect((await afterVote.json() as { counts: unknown }).counts).toMatchObject({ pending_for_me: 0, pending_for_others: 1 });
  });

  it('rejects a weaker caller-selected policy key for a higher cap', async () => {
    await expect(propose(fx, runPlan(fx, 1000), `proposal:${randomUUID()}`, 'run-plan-low')).rejects.toMatchObject({ reason: 'policy_key_mismatch' });
    const accepted = await propose(fx, runPlan(fx, 1000), `proposal:${randomUUID()}`, 'run-plan-high');
    expect(accepted.payload.policy.key).toBe('run-plan-high');
  });

  it('rejects an asserted receiving owner that does not own the target agent', async () => {
    const proposal = teamCommitment(fx);
    proposal.details.receiving_owner_member_id = fx.secondReviewerMemberId;
    await expect(propose(fx, proposal, `proposal:${randomUUID()}`, 'team-sequential')).rejects.toMatchObject({
      reason: 'receiving_owner_mismatch',
    });
  });

  it('accepts proposals only from a live source run that has not been stopped', async () => {
    const runId = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO runs
          (id, workspace_id, session_id, agent_id, status, model_id, client_turn_id, trace_id, stop_requested)
         VALUES ($1, $2, $3, $4, 'working', 'deepseek-flash', 'approval-live-run', 'approval-live-run', true)`,
        [runId, fx.workspaceId, fx.sessionId, fx.agentId],
      );
      await c.query('COMMIT');
    });
    const e = env();
    await expect(withTenantTransaction(e.env, 'app', { workspaceId: fx.workspaceId, userId: fx.adminId }, (tx) =>
      proposeApproval(
        { tx, workspaceId: fx.workspaceId, jobs: [], agentId: fx.agentId, userId: fx.adminId, sessionId: fx.sessionId, runId },
        { label: 'Stopped run proposal', policy_key: 'run-plan-low', proposal: runPlan(fx), target_agent_ids: [], target_member_ids: [], target_resource_ids: [], dependent_request_ids: [], idempotency_key: `proposal:${randomUUID()}` },
      ),
    )).rejects.toMatchObject({ reason: 'invalid_source_run' });
  });

  it('supersedes old votes and rejects stale revision-bound commands', async () => {
    const e = env();
    const proposed = await propose(fx, runPlan(fx), `proposal:${randomUUID()}`);
    const first = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, `vote:${randomUUID()}`),
    });
    expect(first.status).toBe(201);
    const revisedProposal = runPlan(fx, 500, 'Run a materially revised weekly partner plan.');
    const revision = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/revisions`, {
      method: 'POST', headers: INBOX_HEADERS,
      body: { expected_authorization_revision: 1, expected_authorization_hash: proposed.payload.authorization.hash, idempotency_key: `revision:${randomUUID()}`, proposal: revisedProposal, change_summary: 'Changed the reviewed plan summary.' },
    });
    expect(revision.status).toBe(201);
    const current = await revision.json() as ApprovalView;
    expect(current.payload.authorization.revision).toBe(2);
    expect(current.votes).toHaveLength(0);

    const stale = await asUser(e.env, fx.secondReviewerUserId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, `vote:${randomUUID()}`),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { reason: string }).reason).toBe('stale_authorization');
  });

  it('persists expiry and never records an expired vote', async () => {
    const e = env();
    const proposed = await propose(fx, runPlan(fx), `proposal:${randomUUID()}`);
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(`UPDATE approval_requests SET expires_at = now() - interval '1 second' WHERE request_id = $1`, [proposed.request_id]);
      await c.query('COMMIT');
    });
    const response = await asUser(e.env, fx.memberId, `/w/${fx.workspaceId}/requests/${proposed.request_id}/approval/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: decision(proposed, `vote:${randomUUID()}`),
    });
    expect(response.status).toBe(409);
    const state = await readTenant(fx.workspaceId, fx.adminId, async (c) => {
      const approval = await c.query<{ status: string }>(`SELECT status FROM approval_requests WHERE request_id = $1`, [proposed.request_id]);
      const votes = await c.query(`SELECT 1 FROM approval_votes WHERE request_id = $1`, [proposed.request_id]);
      return { status: approval.rows[0]?.status, votes: votes.rowCount };
    });
    expect(state).toEqual({ status: 'expired', votes: 0 });
  });

  it('hides an approval across tenants and the agent role cannot write a vote', async () => {
    const e = env();
    const proposed = await propose(fx, runPlan(fx), `proposal:${randomUUID()}`);
    const other = await seedWorkspace();
    const hidden = await asUser(e.env, other.adminId, `/w/${other.workspaceId}/requests/${proposed.request_id}/approval`);
    expect(hidden.status).toBe(404);

    await withClient('agent', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.memberId);
      await expect(c.query(
        `INSERT INTO approval_votes
          (workspace_id, request_id, revision, authorization_hash, step_id, decision,
           reviewer_member_id, reviewer_user_id, idempotency_key)
         VALUES ($1,$2,1,$3,'budget-review','approve',$4,$5,$6)`,
        [fx.workspaceId, proposed.request_id, proposed.payload.authorization.hash, fx.reviewerMemberId, fx.memberId, `forged:${randomUUID()}`],
      )).rejects.toThrow(/permission denied/i);
      await c.query('ROLLBACK');
    });
  });

  it('keeps legacy application decisions working', async () => {
    const e = env();
    const requestId = await seedRequest(fx, 'application');
    const response = await asUser(e.env, fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: { decision: 'approve' },
    });
    expect(response.status).toBe(201);
    expect((await response.json() as { resulting_status: string }).resulting_status).toBe('admitted');
  });

  it('creates all ten illustrative types only when an isolated fixture opts in', async () => {
    const e = env();
    const views = await withTenantTransaction(e.env, 'app', { workspaceId: fx.workspaceId, userId: fx.adminId }, (tx) =>
      installApprovalDemoFixture(
        { tx, workspaceId: fx.workspaceId, jobs: [], agentId: fx.agentId, userId: fx.adminId, sessionId: fx.sessionId },
        {
          requesterOwnerMemberId: fx.adminMemberId,
          primaryReviewerMemberId: fx.reviewerMemberId,
          secondaryReviewerMemberId: fx.secondReviewerMemberId,
          targetAgentId: fx.targetAgentId,
          targetAgentOwnerMemberId: fx.reviewerMemberId,
          idempotencyPrefix: `demo:${randomUUID()}`,
        },
      ),
    );
    expect(views.map((view) => view.payload.approval_type)).toEqual([
      'run_plan', 'team_commitment', 'access', 'communication', 'shared_learning',
      'deliverable', 'data_disclosure', 'record_change', 'exception', 'agent_governance',
    ]);
    expect(views.every((view) => view.payload.illustrative)).toBe(true);
    expect(views.filter((view) => view.effect.kind !== 'none').every((view) => view.effect.status === 'unavailable')).toBe(true);
  });
});
