// Real routes, tenant transactions, source ledger, job and approval domain.
// Source HTTP and Workflow execution are fixtures; this is not model-quality
// or real hosted/offline acceptance evidence.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { partnerWatchSchema, type PartnerWatch, type ApprovalProposal } from '@hermes/shared';
import type { Env } from '../../src/env.js';
import { withTenantTransaction } from '../../src/db/client.js';
import { proposeApproval } from '../../src/domain/approvals.js';
import { enqueueAutomatedPartnerScreening } from '../../src/partner-screening/automation.js';
import { runJob, type Job } from '../../src/jobs.js';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';

const LIMITATION = 'Evidence samples the ten most recently pushed public repositories; activity dates do not establish release content, commercial interest, availability, or consent.';
const WATCH = { enabled: true, source_id: 'url:0', max_cost_usd_per_run: 0.10, max_cost_usd_per_day: 0.30, max_model_calls: 6 };

async function fixture() {
  const fx = await seedWorkspace();
  let ownerMemberId = '';
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    ownerMemberId = (await client.query<{ id: string }>('SELECT id FROM members WHERE user_id=$1', [fx.adminId])).rows[0]!.id;
    await client.query('INSERT INTO agent_owners(workspace_id,agent_id,member_id) VALUES($1,$2,$3)', [fx.workspaceId, fx.agentId, ownerMemberId]);
    await client.query('INSERT INTO workspace_directory(workspace_id,workos_organization_id) VALUES($1,$2)', [fx.workspaceId, `watch-test-${fx.workspaceId}`]);
    // The fixture deliberately selects the seeded tool-capable test model;
    // watch admission may never silently substitute a different model.
    await client.query("UPDATE workspace_settings SET default_model_id='deepseek-flash' WHERE workspace_id=$1", [fx.workspaceId]);
    await client.query('COMMIT');
  });
  let description = 'Open source SDK for developer agents';
  let stars = 100;
  let requests = 0;
  let failSource = false;
  let sourceGate: Promise<void> | null = null;
  let signalSourceStarted: (() => void) | null = null;
  const workflows: { id: string; params: unknown }[] = [];
  const config = {
    source: 'github', source_purpose: 'organization_partner_research', organization_only: true, no_outreach: true,
    role_label: 'Potential technical ecosystem partner', search_queries: [],
    intake_urls: ['https://github.com/ExampleOrg', 'https://github.com/OtherOrg'],
    keywords: ['developer', 'agents', 'open source'], minimum_priority: 0,
    max_candidates: 1, max_api_requests: 2, minimum_rate_remaining: 0, github_watch: WATCH,
  };
  const body = (value: unknown) => new Response(JSON.stringify(value), { headers: {
    'content-type': 'application/json', 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '50',
  } });
  const { env } = makeEnv({
    MODEL_SCRIPTED: '1', AUTOMATED_TRIGGERS_ENABLED: '1',
    PARTNER_SCREENING_CONFIG_JSON: JSON.stringify({ [fx.agentId]: config }),
    PARTNER_SOURCE_FETCHER: { async fetch(request: Request) {
      requests += 1;
      if (sourceGate) {
        signalSourceStarted?.();
        await sourceGate;
      }
      if (failSource) return new Response('{}', { status: 503 });
      const url = new URL(request.url);
      expect(url.hostname).toBe('api.github.com');
      const login = url.pathname.split('/')[2]!;
      if (url.pathname === `/orgs/${login}`) return body({
        id: 9, node_id: `ORG_${login}`, login, name: login, description: 'Open source developer agents',
        html_url: `https://github.com/${login}`, blog: null, email: 'private@example.test',
        public_repos: 1, followers: 100, created_at: '2020-01-01T00:00:00Z', updated_at: new Date().toISOString(),
      });
      if (url.pathname === `/orgs/${login}/repos`) return body([{
        id: 1, node_id: `REPO_${login}`, name: 'sdk', full_name: `${login}/sdk`, html_url: `https://github.com/${login}/sdk`,
        description, topics: ['agents', 'developer'], language: 'TypeScript', stargazers_count: stars,
        forks_count: 10, open_issues_count: 2, fork: false, archived: false, disabled: false, has_issues: true,
        license: { spdx_id: 'MIT' }, pushed_at: '2026-09-20T00:00:00Z', updated_at: new Date().toISOString(),
        owner: { login, node_id: `ORG_${login}`, type: 'Organization' },
      }]);
      return new Response('{}', { status: 404 });
    } } as unknown as Fetcher,
    RUN_ATTEMPT: { create(input: { id: string; params: unknown }) {
      workflows.push(input); return Promise.resolve({ id: input.id });
    } } as unknown as Env['RUN_ATTEMPT'],
  });
  const path = `/w/${fx.workspaceId}/partner-screening/agents/${fx.agentId}/watch`;
  const view = async (): Promise<PartnerWatch> => {
    const response = await asUser(env, fx.adminId, path);
    expect(response.status).toBe(200);
    return partnerWatchSchema.parse(await response.json());
  };
  const queue = async (index: number) => {
    const now = new Date(Date.now() + index * 360 * 60_000);
    await enqueueAutomatedPartnerScreening(env, now);
    const job = await readTenant(fx.workspaceId, fx.adminId, async (client) => (await client.query<Job>(
      `SELECT id,workspace_id,kind,key,payload,attempts FROM jobs WHERE workspace_id=$1 AND kind='partner_screening'
       ORDER BY created_at DESC,id DESC LIMIT 1`, [fx.workspaceId],
    )).rows[0]!);
    expect(job).toBeDefined();
    return job;
  };
  const check = async (index: number) => {
    const job = await queue(index);
    await runJob(env, job);
    return { job, view: await view() };
  };
  return { ...fx, env, ownerMemberId, path, view, check, queue, workflows,
    setDescription: (value: string) => { description = value; },
    setStars: (value: number) => { stars = value; },
    failSource: () => { failSource = true; }, requests: () => requests,
    holdSource: () => {
      let release!: () => void;
      const started = new Promise<void>((resolve) => { signalSourceStarted = resolve; });
      sourceGate = new Promise<void>((resolve) => { release = resolve; });
      return { started, release: () => { sourceGate = null; release(); } };
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function writeTenant(fx: Fixture, sql: string, values: unknown[]) {
  return withClient('app', async (client) => {
    await client.query('BEGIN');
    try {
      await setTenant(client, fx.workspaceId, fx.adminId);
      const result = await client.query(sql, values);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
async function reviewInput(fx: Fixture, watch: PartnerWatch) {
  const runId = watch.last_check!.run_id!;
  const check = await readTenant(fx.workspaceId, fx.adminId, async (client) => (await client.query<{
    id: string; screening_run_id: string; selected_candidate_id: string;
  }>('SELECT id,screening_run_id,selected_candidate_id FROM partner_watch_checks WHERE run_id=$1', [runId])).rows[0]!);
  // Intentionally a random HTTP trace, unlike the persisted model-run trace.
  // The verified run binding must own candidate visibility.
  const db = new PgAgentDb(fx.env, fx.workspaceId, randomUUID());
  let detail: { source_artifacts: { id: string }[]; watch_review_context: {
    before_source_artifacts: { id: string }[]; change_summary: { field: string; before: string; after: string }[];
  } };
  try {
    db.bindRuntimeToolRun(runId);
    detail = await db.getPartnerCandidate(fx.agentId, check.selected_candidate_id) as typeof detail;
    expect(detail.watch_review_context.change_summary).toContainEqual({
      field: 'ExampleOrg/sdk · description', before: '"Open source SDK for developer agents"', after: '"SDK now documents deprecation and migration"',
    });
  } finally { await db.close(); }
  const evidenceIds = [...detail!.source_artifacts, ...detail!.watch_review_context.before_source_artifacts].map(({ id }) => id);
  const proposal: ApprovalProposal = {
    kind: 'approval', approval_type: 'deliverable', illustrative: false,
    summary: 'Review changed SDK positioning before considering partnership work.',
    consequence: 'Records the owner reviewing this research. Nothing is sent.',
    evidence: evidenceIds.map((id) => ({ id, kind: 'artifact', label: 'Stored public GitHub evidence' })),
    details: { artifact_id: `partner-watch:${check.id}`, version: check.screening_run_id,
      title: 'SDK positioning changed', content: 'The repository description now mentions deprecation and migration. Check the linked repository documentation before considering an SDK integration; a description alone does not establish its migration requirements.',
      evidence_ids: evidenceIds, missing_information: [LIMITATION], releases_dependent_request_ids: [],
    },
  };
  const input = { label: 'SDK positioning review', policy_key: `partner-watch-review-${fx.agentId}`, proposal,
    target_agent_ids: [], target_member_ids: [fx.ownerMemberId], target_resource_ids: [], dependent_request_ids: [],
    idempotency_key: `watch-test:${randomUUID()}`,
  };
  const propose = (raw: unknown = input) => withTenantTransaction(fx.env, 'app', { workspaceId: fx.workspaceId, userId: fx.adminId },
    (tx) => proposeApproval({ tx, workspaceId: fx.workspaceId, agentId: fx.agentId, sessionId: watch.last_check!.session_id!, runId, jobs: [] }, raw));
  return { runId, check, proposal, input, propose, evidenceIds };
}

async function changedFixture() {
  const fx = await fixture();
  expect((await fx.check(0)).view.last_check?.status).toBe('baseline');
  fx.setDescription('SDK now documents deprecation and migration');
  const changed = await fx.check(1);
  expect(changed.view.last_check).toMatchObject({ status: 'changed', changed_candidates: 1, run_id: expect.any(String) });
  return { fx, changed };
}

describe('one proactive GitHub responsibility', () => {
  it('replays one manual key without new source calls and permits a deliberate new check', async () => {
    const fx = await fixture();
    await fx.check(0);
    const key = randomUUID();
    const wake = (idempotency_key: string) => asUser(fx.env, fx.adminId,
      `/w/${fx.workspaceId}/agents/${fx.agentId}/wake`,
      { method: 'POST', body: { action: 'run_now', idempotency_key } });
    expect((await wake(key)).status).toBe(200);
    expect(fx.requests()).toBe(4);
    const checked = (await fx.view()).last_check!.id;
    expect((await wake(key)).status).toBe(200);
    expect(fx.requests()).toBe(4);
    expect((await fx.view()).last_check!.id).toBe(checked);
    expect((await wake(randomUUID())).status).toBe(200);
    expect(fx.requests()).toBe(6);
    expect((await fx.view()).last_check!.id).not.toBe(checked);
    expect(fx.workflows).toHaveLength(0);
  });

  it('coalesces overlapping jobs before a second source allowance is used', async () => {
    const fx = await fixture();
    const first = await fx.queue(0);
    const second = await fx.queue(1);
    const gate = fx.holdSource();
    const running = runJob(fx.env, first);
    try {
      await gate.started;
      await runJob(fx.env, second);
      expect(fx.requests()).toBe(1);
    } finally {
      gate.release();
      await running;
    }
    expect(fx.requests()).toBe(2);
    expect((await fx.view()).last_check?.status).toBe('baseline');
    const count = await readTenant(fx.workspaceId, fx.adminId, (client) => client.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM partner_watch_checks WHERE workspace_id=$1', [fx.workspaceId]));
    expect(count.rows[0]?.count).toBe(1);
  });

  it('preserves an Admin pause while the owner changes draft limits', async () => {
    const fx = await fixture();
    await fx.check(0);
    await writeTenant(fx,
      "UPDATE enterprise_skill_assignments SET state='paused',revision=revision+1 WHERE workspace_id=$1 AND agent_id=$2",
      [fx.workspaceId, fx.agentId]);
    const paused = await fx.view();
    expect(paused).toMatchObject({ blocked_reason: 'assignment_paused', may_run: false });
    const save = await asUser(fx.env, fx.adminId, fx.path, { method: 'PATCH', body: {
      revision: paused.revision!, interval_minutes: 360, ...WATCH, max_cost_usd_per_day: 0.40,
    } });
    expect(save.status).toBe(200);
    expect(await save.json()).toMatchObject({ blocked_reason: 'assignment_paused', enabled: false, may_run: false });
    const calls = fx.requests();
    await fx.check(1);
    expect(fx.requests()).toBe(calls);
  });

  it('keeps baseline/noise quiet, durably submits one change, and exposes one cited private Inbox review', async () => {
    const fx = await fixture();
    const baseline = await fx.check(0);
    expect(baseline.view.execution_mode).toBe('simulated');
    expect(baseline.view.last_check).toMatchObject({ status: 'baseline', run_id: null, review_id: null });
    expect(fx.requests()).toBe(2);
    expect(fx.workflows).toHaveLength(0);
    fx.setStars(900);
    expect((await fx.check(1)).view.last_check).toMatchObject({ status: 'unchanged', run_id: null });
    expect(fx.workflows).toHaveLength(0);
    fx.setDescription('SDK now documents deprecation and migration');
    const changed = await fx.check(2);
    const review = await reviewInput(fx, changed.view);
    expect(fx.workflows).toHaveLength(1);
    const sourceRequests = fx.requests();
    await runJob(fx.env, changed.job);
    expect(fx.requests()).toBe(sourceRequests);
    expect((await fx.view()).last_check?.run_id).toBe(review.runId);

    // A watch cannot release dependent work or omit the original source proof.
    await expect(review.propose({ ...review.input, proposal: { ...review.proposal, details: {
      ...review.proposal.details, releases_dependent_request_ids: [randomUUID()],
    } } })).rejects.toThrow(/exact owner-reviewed research brief/);
    await expect(review.propose({ ...review.input, proposal: { ...review.proposal, evidence: [] } })).rejects.toThrow(/before and after evidence/);
    const delivered = await review.propose();
    const replay = await review.propose();
    expect(replay.request_id).toBe(delivered.request_id);
    expect((await fx.view()).latest_review?.id).toBe(delivered.request_id);
    const evidence = await asUser(fx.env, fx.adminId, `/w/${fx.workspaceId}/requests/${delivered.request_id}/approval/evidence/${review.evidenceIds[0]}`);
    expect(evidence.status).toBe(200);
    expect(JSON.stringify(await evidence.json())).not.toContain('private@example.test');
    expect((await asUser(fx.env, fx.memberId, fx.path)).status).toBe(404);
    expect((await asUser(fx.env, fx.memberId, `/w/${fx.workspaceId}/requests/${delivered.request_id}/approval`)).status).toBe(404);

    await writeTenant(fx, "UPDATE runs SET status='completed',ended_at=now() WHERE id=$1", [review.runId]);
    const quiet = await fx.check(3);
    expect(quiet.view.last_check?.status).toBe('unchanged');
    expect(quiet.view.latest_review?.id).toBe(delivered.request_id);
    const counts = await readTenant(fx.workspaceId, fx.adminId, async (client) => ({
      reviews: (await client.query('SELECT id FROM requests WHERE run_id=$1', [review.runId])).rowCount,
      effects: (await client.query('SELECT id FROM effects WHERE workspace_id=$1', [fx.workspaceId])).rowCount,
      emails: (await client.query('SELECT id FROM outbound_email_outbox WHERE workspace_id=$1', [fx.workspaceId])).rowCount,
    }));
    expect(counts).toEqual({ reviews: 1, effects: 0, emails: 0 });
  });

  it('fences a queued old revision and starts a quiet baseline for a different configured source', async () => {
    const fx = await fixture();
    const baseline = await fx.check(0);
    const staleQueuedJob = await fx.queue(1);
    const save = (body: unknown) => asUser(fx.env, fx.adminId, fx.path, { method: 'PATCH', body });
    const input = { revision: baseline.view.revision!, interval_minutes: 360, ...WATCH, source_id: 'url:1' };
    expect((await asUser(fx.env, fx.memberId, fx.path, { method: 'PATCH', body: input })).status).toBe(404);
    expect((await save({ ...input, source_id: 'url:9' })).status).toBe(409);
    expect((await save(input)).status).toBe(200);
    expect((await save(input)).status).toBe(409);
    const sourceRequests = fx.requests();
    await runJob(fx.env, staleQueuedJob);
    expect(fx.requests()).toBe(sourceRequests);
    const switched = await fx.check(2);
    expect(switched.view.selected_source?.label).toBe('GitHub · OtherOrg');
    expect(switched.view.last_check).toMatchObject({ status: 'baseline', run_id: null });
    expect(fx.workflows).toHaveLength(0);
    const before = fx.requests();
    await save({ revision: switched.view.revision!, interval_minutes: 360, ...WATCH, enabled: false, source_id: 'url:1' });
    await runJob(fx.env, switched.job);
    expect(fx.requests()).toBe(before);
    expect((await fx.view()).may_run).toBe(false);
  });

  it('revokes an unfinished change on explicit Pause and prevents later proposal replay', async () => {
    const { fx, changed } = await changedFixture();
    const review = await reviewInput(fx, changed.view);
    const response = await asUser(fx.env, fx.adminId, fx.path, { method: 'PATCH', body: {
      revision: changed.view.revision!, interval_minutes: 360, ...WATCH, enabled: false,
    } });
    expect(response.status).toBe(200);
    await expect(review.propose()).rejects.toThrow(/no longer authorized|source run is not bound/);
    const authority = await readTenant(fx.workspaceId, fx.adminId, (client) => client.query<{ allowed: boolean }>('SELECT partner_watch_check_authorized($1) AS allowed', [review.check.id]));
    expect(authority.rows[0]?.allowed).toBe(false);
    expect((await fx.view()).state).toBe('paused');
  });

  it('lets the owner edit research prose while preserving the watch evidence and scope', async () => {
    const { fx, changed } = await changedFixture();
    const review = await reviewInput(fx, changed.view);
    const delivered = await review.propose();
    const revise = (proposal: ApprovalProposal) => asUser(fx.env, fx.adminId,
      `/w/${fx.workspaceId}/requests/${delivered.request_id}/approval/revisions`, {
        method: 'POST', headers: { 'x-requested-from': 'inbox' }, body: {
          expected_authorization_revision: delivered.payload.authorization.revision,
          expected_authorization_hash: delivered.payload.authorization.hash,
          idempotency_key: `watch-edit:${randomUUID()}`, change_summary: 'Clarify the research next step.', proposal,
        },
      });
    for (const patch of [
      { version: randomUUID() }, { evidence_ids: [] }, { missing_information: [] },
      { releases_dependent_request_ids: [randomUUID()] },
    ]) {
      const response = await revise({ ...review.proposal, details: { ...review.proposal.details, ...patch } });
      expect(response.status).toBe(422);
    }
    expect((await revise({ ...review.proposal, evidence: [] })).status).toBe(422);
    const edited = await revise({ ...review.proposal, details: { ...review.proposal.details,
      content: 'Read the cited SDK documentation and assess whether this migration affects our current integration.',
    } });
    expect(edited.status).toBe(201);
    expect((await edited.json()).payload.authorization.revision).toBe(2);
  });

  it('records a source failure without replenishing its request allowance on job replay', async () => {
    const fx = await fixture();
    fx.failSource();
    const failure = await fx.check(0);
    expect(failure.view.last_check).toMatchObject({ status: 'failed', run_id: null });
    expect(fx.requests()).toBe(1);
    await runJob(fx.env, failure.job);
    expect(fx.requests()).toBe(1);
    expect(fx.workflows).toHaveLength(0);
  });
});
