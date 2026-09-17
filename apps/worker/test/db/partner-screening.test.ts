import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toolByName } from '../../src/engine/tools.js';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import type { Env } from '../../src/env.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';
import { asUser, call, makeEnv, readTenant } from './harness.js';
import { enqueueAutomatedPartnerScreening } from '../../src/partner-screening/automation.js';
import { runJob, type Job } from '../../src/jobs.js';
import { bridgeToken } from '../../src/runtime/config.js';
import { agentCashPeopleSearchArguments } from '../../src/partner-screening/agentcash-people.js';
import { partnerAgentConfig } from '../../src/partner-screening/config.js';

async function bindAgent(fx: Awaited<ReturnType<typeof seedWorkspace>>): Promise<void> {
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    await client.query(
      `INSERT INTO agent_owners (workspace_id, agent_id, member_id)
       SELECT $1, $2, id FROM members WHERE workspace_id = $1 AND user_id = $3`,
      [fx.workspaceId, fx.agentId, fx.adminId],
    );
    await client.query('COMMIT');
  });
}

async function seedRun(fx: Awaited<ReturnType<typeof seedWorkspace>>): Promise<string> {
  return withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    const run = await client.query<{ id: string }>(
      `INSERT INTO runs (workspace_id, session_id, agent_id, status, model_id, client_turn_id, trace_id, mode)
       VALUES ($1,$2,$3,'working','deepseek-flash',$4,'partner-screening-test','work') RETURNING id`,
      [fx.workspaceId, fx.sessionId, fx.agentId, randomUUID()],
    );
    await client.query('COMMIT');
    return run.rows[0]!.id;
  });
}

const owner = { login: 'ExampleOrg', node_id: 'ORG_node_1', type: 'Organization' };
const repository = (repoOwner = owner) => ({
  id: 1, node_id: 'REPO_node_1', name: 'developer-agents', full_name: `${repoOwner.login}/developer-agents`,
  html_url: `https://github.com/${repoOwner.login}/developer-agents`,
  description: 'Open source developer education agents', topics: ['agents', 'education'], language: 'TypeScript',
  stargazers_count: 100, forks_count: 12, open_issues_count: 4,
  fork: false, archived: false, disabled: false, has_issues: true,
  license: { spdx_id: 'MIT' }, pushed_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z',
  owner: repoOwner,
});
const response = (body: unknown, resource: string) => new Response(JSON.stringify(body), {
  headers: {
    'content-type': 'application/json', 'x-ratelimit-resource': resource,
    'x-ratelimit-limit': resource === 'search' ? '30' : '5000', 'x-ratelimit-remaining': '20',
    'x-ratelimit-reset': '1800000000',
  },
});

describe('live Partner Program source ingestion and Iris handoff', () => {
  it('lets a member use only the one approved AgentCash onboarding allowance on their own pool Iris', async () => {
    const fx = await seedWorkspace();
    const memberUserId = randomUUID();
    await bindAgent(fx);
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (id, email, email_verified, name) VALUES ($1, $2, true, 'Invited Member')`,
        [memberUserId, `member-${memberUserId.slice(0, 8)}@example.test`],
      );
      await setTenant(client, fx.workspaceId, fx.adminId);
      const member = await client.query<{ id: string }>(
        `INSERT INTO members (workspace_id, user_id, role, status) VALUES ($1, $2, 'member', 'active') RETURNING id`,
        [fx.workspaceId, memberUserId],
      );
      await client.query(
        `UPDATE agent_owners SET member_id = $3 WHERE workspace_id = $1 AND agent_id = $2`,
        [fx.workspaceId, fx.agentId, member.rows[0]!.id],
      );
      await client.query('COMMIT');
    });
    const config = {
      source: 'agentcash_people', source_purpose: 'person_partner_research', organization_only: false, no_outreach: true,
      role_label: 'Potential ecosystem lead', search_queries: [], intake_urls: [],
      keywords: ['artificial intelligence'],
      people_search: {
        current_position_seniority_level: ['Founder'], person_skills: ['Artificial Intelligence (AI)'],
        current_position_titles: [], person_locations: [],
      },
      ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
      minimum_priority: 40, lookback_days: 365, max_candidates: 5,
      max_api_requests: 1, minimum_rate_remaining: 0, max_spend_usd: 0.15,
    };
    const { env } = makeEnv({
      AGENT_RUNTIME: 'hermes',
      HERMES_BRIDGE_SECRET: 'member-agentcash-test-secret-longer-than-32-characters',
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [fx.agentId]: {
          workspace_id: fx.workspaceId,
          base_url: 'https://invitee-iris.example/api/plugins/enterprise_bridge/control',
          api_key: 'member-runtime-profile-key', transport: 'dashboard_connector',
          assignment: 'invitee_pool', agentcash: true,
        },
      }),
      PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(config),
    });
    const path = `/w/${fx.workspaceId}/partner-screening/runs`;
    const key = `onboarding:${randomUUID()}`;
    const first = await asUser(env, memberUserId, path, {
      method: 'POST', body: { agent_id: fx.agentId, idempotency_key: key },
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ run: { source: 'agentcash_people', status: 'running' } });

    const replay = await asUser(env, memberUserId, path, {
      method: 'POST', body: { agent_id: fx.agentId, idempotency_key: key },
    });
    expect(replay.status).toBe(200);
    const second = await asUser(env, memberUserId, path, {
      method: 'POST', body: { agent_id: fx.agentId, idempotency_key: `onboarding:${randomUUID()}` },
    });
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ reason: 'partner_onboarding_allowance_used' });
  });

  it('persists source artifacts, exposes them to the bound agent, and deduplicates pending Inbox proposals', async () => {
    const fx = await seedWorkspace();
    await bindAgent(fx);
    const config = {
      [fx.agentId]: {
        source_purpose: 'organization_partner_research', organization_only: true, no_outreach: true,
        role_label: 'Potential technical ecosystem partner',
        search_queries: ['developer education in:name,description,readme archived:false'], intake_urls: [],
        keywords: ['developer education', 'agents', 'open source'],
        ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
        minimum_priority: 50, lookback_days: 365, max_candidates: 2,
        max_api_requests: 6, minimum_rate_remaining: 0,
      },
    };
    let calls = 0;
    const fetcher = {
      async fetch(request: Request): Promise<Response> {
        calls += 1;
        const url = new URL(request.url);
        expect(url.hostname).toBe('api.github.com');
        if (url.pathname === '/search/repositories') {
          return response({
            total_count: 2, incomplete_results: false,
            items: [repository(), repository({ login: 'SomePerson', node_id: 'USER_node_1', type: 'User' })],
          }, 'search');
        }
        if (url.pathname === '/orgs/ExampleOrg') {
          return response({
            id: 9, node_id: owner.node_id, login: owner.login, name: 'Example Org',
            description: 'Developer education and open source agents', html_url: 'https://github.com/ExampleOrg',
            blog: 'https://example.org', email: 'must-not-persist@example.org', public_repos: 8, followers: 500,
            created_at: '2020-01-01T00:00:00Z', updated_at: '2026-09-11T00:00:00Z',
          }, 'core');
        }
        if (url.pathname === '/orgs/ExampleOrg/repos') return response([repository()], 'core');
        return new Response('{}', { status: 404 });
      },
    };
    const { env } = makeEnv({
      PARTNER_SCREENING_CONFIG_JSON: JSON.stringify(config),
      PARTNER_SOURCE_FETCHER: fetcher as unknown as Fetcher,
    });
    const path = `/w/${fx.workspaceId}/partner-screening/runs`;
    const idempotencyKey = `partner-${randomUUID()}`;
    const started = await asUser(env, fx.adminId, path, {
      method: 'POST', body: { agent_id: fx.agentId, idempotency_key: idempotencyKey },
    });
    expect(started.status).toBe(201);
    const snapshot = await started.json() as {
      run: { id: string; mode: string; authentication: string };
      candidates: { id: string; deterministic_priority: number; confidence: string; evidence_gaps: string[] }[];
      handoff: { kind: string; candidate_ids: string[]; prompt: string };
      disclosure: string;
    };
    expect(snapshot.run).toMatchObject({ mode: 'live', authentication: 'unauthenticated' });
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]).toMatchObject({
      confidence: 'low',
      evidence_gaps: expect.arrayContaining([expect.stringContaining('repository-search evidence only')]),
    });
    expect(snapshot.handoff).toMatchObject({ kind: 'ask_iris_to_screen', candidate_ids: [snapshot.candidates[0]!.id] });
    expect(snapshot.handoff.prompt).toContain('Do not contact anyone');
    expect(snapshot.disclosure).toContain('No person was contacted');
    expect(calls).toBe(1);

    const replay = await asUser(env, fx.adminId, path, {
      method: 'POST', body: { agent_id: fx.agentId, idempotency_key: idempotencyKey },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-hermes-idempotent-replay')).toBe('true');
    expect(calls).toBe(1);

    const beforeIris = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const requests = await client.query(`SELECT id FROM requests WHERE subject_key LIKE 'partner-candidate:%'`);
      const artifacts = await client.query<{ body: string }>(
        `SELECT string_agg(content::text, ' ') AS body FROM partner_source_artifacts WHERE run_id = $1`,
        [snapshot.run.id],
      );
      const candidates = await client.query(`SELECT id FROM partner_candidates WHERE agent_id = $1`, [fx.agentId]);
      return { requests: requests.rowCount, artifacts: artifacts.rows[0]?.body ?? '', candidates: candidates.rowCount };
    });
    expect(beforeIris).toMatchObject({ requests: 0, candidates: 1 });
    expect(beforeIris.artifacts).not.toContain('must-not-persist@example.org');
    expect(beforeIris.artifacts).not.toContain('SomePerson');

    const runId = await seedRun(fx);
    const db = new PgAgentDb(env as Env, fx.workspaceId, 'trace-partner-screening');
    try {
      const run = await db.loadRun(runId);
      expect(run).not.toBeNull();
      expect(await db.loadToolNames(fx.agentId)).toEqual(expect.arrayContaining([
        'list_partner_candidates', 'get_partner_candidate', 'propose_request',
      ]));
      const detail = await db.getPartnerCandidate(fx.agentId, snapshot.candidates[0]!.id) as {
        source: 'github'; source_key: string; deterministic_priority: number; last_seen_at: Date;
        source_artifacts: { id: string; kind: string; source_url: string }[];
      };
      expect(detail.source_artifacts).toHaveLength(2);
      const artifactIds = detail.source_artifacts.map((artifact) => artifact.id);
      const proposal = {
        kind: 'application',
        applicant: { name: 'Example Org', title: 'Discovered organization; did not apply' },
        proposed_role: 'Potential technical ecosystem partner',
        score: 80, score_max: 100,
        criteria: [{
          id: 'fit', label: 'Program fit', points: 80, points_max: 100,
          evidence: 'Iris assessment based on the stored public organization and repository artifacts.',
          source_ids: artifactIds,
        }],
        sources: detail.source_artifacts.map((artifact) => ({
          id: artifact.id, name: artifact.kind, note: 'Fetched public evidence.', url: artifact.source_url,
        })),
        missing: ['Capacity, interest and consent are unverified.'],
        discovery: {
          candidate_id: snapshot.candidates[0]!.id, source: detail.source, source_key: detail.source_key,
          discovered_at: detail.last_seen_at.toISOString(), deterministic_priority: detail.deterministic_priority,
        },
      };
      const propose = toolByName('propose_request')!;
      const first = await propose.run({ kind: 'application', label: 'Potential partner · Example Org', payload: proposal }, {
        writes: db, reads: db, run: run!, toolCallId: 'partner-proposal-1', now: () => new Date(), mode: 'work',
      });
      const second = await propose.run({ kind: 'application', label: 'Potential partner · Example Org', payload: proposal }, {
        writes: db, reads: db, run: run!, toolCallId: 'partner-proposal-2', now: () => new Date(), mode: 'work',
      });
      expect(first).toMatchObject({ ok: true, data: { created: true, status: 'pending' } });
      expect(second).toMatchObject({ ok: true, data: { created: false, status: 'pending' } });
    } finally {
      await db.close();
    }

    const afterIris = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const requests = await client.query<{ status: string; payload: Record<string, unknown> }>(
        `SELECT status, payload FROM requests WHERE subject_key = $1`,
        [`partner-candidate:${snapshot.candidates[0]!.id}`],
      );
      const modelCalls = await client.query(`SELECT id FROM model_calls WHERE workspace_id = $1`, [fx.workspaceId]);
      const effects = await client.query(`SELECT id FROM effects WHERE workspace_id = $1`, [fx.workspaceId]);
      return { requests: requests.rows, modelCalls: modelCalls.rowCount, effects: effects.rowCount };
    });
    expect(afterIris.requests).toHaveLength(1);
    expect(afterIris.requests[0]?.status).toBe('pending');
    expect(afterIris.requests[0]?.payload).toMatchObject({ discovery: { candidate_id: snapshot.candidates[0]!.id } });
    expect(afterIris).toMatchObject({ modelCalls: 0, effects: 0 });
  });

  it('lets Cloudflare Cron durably discover candidates and start one idempotent Iris turn', async () => {
    const fx = await seedWorkspace();
    const memberUserId = randomUUID();
    await bindAgent(fx);
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO users (id, email, email_verified, name)
         VALUES ($1, $2, true, 'Partner Member')`,
        [memberUserId, `partner-${memberUserId.slice(0, 8)}@example.test`],
      );
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO members (workspace_id, user_id, role, status)
         VALUES ($1, $2, 'member', 'active')`,
        [fx.workspaceId, memberUserId],
      );
      await client.query(
        `DELETE FROM agent_owners WHERE workspace_id=$1 AND agent_id=$2`,
        [fx.workspaceId, fx.agentId],
      );
      await client.query(
        `UPDATE sessions SET owner_id=$3 WHERE workspace_id=$1 AND agent_id=$2`,
        [fx.workspaceId, fx.agentId, memberUserId],
      );
      await client.query(
        `INSERT INTO workspace_directory (workspace_id, workos_organization_id)
         VALUES ($1,$2) ON CONFLICT (workspace_id) DO NOTHING`,
        [fx.workspaceId, `cron-test-${fx.workspaceId}`],
      );
      await client.query('COMMIT');
    });
    const config = {
      [fx.agentId]: {
        source_purpose: 'organization_partner_research', organization_only: true, no_outreach: true,
        role_label: 'Potential technical ecosystem partner',
        search_queries: ['developer education in:name,description,readme archived:false'], intake_urls: [],
        keywords: ['developer education', 'agents', 'open source'],
        ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
        minimum_priority: 50, lookback_days: 365, max_candidates: 2,
        max_api_requests: 6, minimum_rate_remaining: 0,
      },
    };
    const fetcher = {
      async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/search/repositories') {
          return response({ total_count: 1, incomplete_results: false, items: [repository()] }, 'search');
        }
        if (url.pathname === '/orgs/ExampleOrg') {
          return response({
            id: 9, node_id: owner.node_id, login: owner.login, name: 'Example Org',
            description: 'Developer education and open source agents', html_url: 'https://github.com/ExampleOrg',
            blog: 'https://example.org', email: null, public_repos: 8, followers: 500,
            created_at: '2020-01-01T00:00:00Z', updated_at: '2026-09-11T00:00:00Z',
          }, 'core');
        }
        if (url.pathname === '/orgs/ExampleOrg/repos') return response([repository()], 'core');
        return new Response('{}', { status: 404 });
      },
    };
    const workflows: { id: string; params: unknown }[] = [];
    const { env } = makeEnv({
      MODEL_SCRIPTED: '1',
      AUTOMATED_TRIGGERS_ENABLED: '1',
      PARTNER_SCREENING_AUTOMATION_INTERVAL_MINUTES: '360',
      PARTNER_SCREENING_CONFIG_JSON: JSON.stringify(config),
      PARTNER_SOURCE_FETCHER: fetcher as unknown as Fetcher,
      RUN_ATTEMPT: {
        create: (input: { id: string; params: unknown }) => {
          workflows.push(input);
          return Promise.resolve({ id: input.id });
        },
      } as unknown as Env['RUN_ATTEMPT'],
    });
    const now = new Date('2026-09-16T19:00:00Z');
    const first = await enqueueAutomatedPartnerScreening(env, now);
    const replay = await enqueueAutomatedPartnerScreening(env, now);
    expect(first).toMatchObject({
      enabled: true, candidateAgents: 1, startedAgents: 1, activeOwnedAgents: 1,
      configuredAgents: 1, queued: 1,
    });
    expect(replay.queued).toBe(0);

    const queuedJob = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const result = await client.query<Job>(
        `SELECT id, workspace_id, kind, key, payload, attempts FROM jobs
          WHERE workspace_id=$1 AND kind='partner_screening' ORDER BY created_at DESC LIMIT 1`,
        [fx.workspaceId],
      );
      return result.rows[0];
    });
    expect(queuedJob).toBeDefined();
    await runJob(env, queuedJob!);
    expect(workflows).toHaveLength(1);
    const stored = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const screening = await client.query(`SELECT id FROM partner_screening_runs WHERE agent_id=$1 AND status='completed'`, [fx.agentId]);
      const candidates = await client.query(`SELECT id FROM partner_candidates WHERE agent_id=$1`, [fx.agentId]);
      const sessions = await client.query(`SELECT id FROM sessions WHERE agent_id=$1 AND title='Iris · Automated partner screening'`, [fx.agentId]);
      const runs = await client.query(`SELECT id, client_turn_id FROM runs WHERE session_id=$1`, [sessions.rows[0]?.id]);
      const prompt = await client.query<{ text: string }>(
        `SELECT text FROM messages WHERE session_id=$1 AND role='user' ORDER BY seq DESC LIMIT 1`,
        [sessions.rows[0]?.id],
      );
      const policy = await client.query<{ approval_type: string; requester_agent_id: string }>(
        `SELECT approval_type, requester_agent_id FROM approval_policies
          WHERE workspace_id=$1 AND key=$2 AND active`,
        [fx.workspaceId, `partner-outreach-draft-${fx.agentId}`],
      );
      return {
        screening: screening.rowCount, candidates: candidates.rowCount, sessions: sessions.rowCount,
        runs: runs.rows, prompt: prompt.rows[0]?.text ?? '', policy: policy.rows,
      };
    });
    expect(stored).toMatchObject({ screening: 1, candidates: 1, sessions: 1 });
    expect(stored.runs).toHaveLength(1);
    expect(stored.runs[0]?.client_turn_id).toMatch(/^partner-screening:/);
    expect(stored.prompt).toContain('details.draft_only to true');
    expect(stored.prompt).toContain('address null');
    expect(stored.prompt).toContain('Do not use propose_request');
    expect(stored.policy).toEqual([{ approval_type: 'communication', requester_agent_id: fx.agentId }]);
  });

  it('requires a separate spend gate before Cron queues AgentCash discovery', async () => {
    const fx = await seedWorkspace();
    await bindAgent(fx);
    await withClient('owner', (client) => client.query(
      `INSERT INTO workspace_directory (workspace_id, workos_organization_id)
       VALUES ($1,$2) ON CONFLICT (workspace_id) DO NOTHING`,
      [fx.workspaceId, `paid-cron-test-${fx.workspaceId}`],
    ));
    const policy = {
      [fx.agentId]: {
        source: 'agentcash_people', source_purpose: 'person_partner_research',
        organization_only: false, no_outreach: true, role_label: 'Potential ecosystem lead',
        search_queries: [], intake_urls: [], keywords: ['artificial intelligence'],
        people_search: {
          current_position_seniority_level: ['Founder'], person_skills: ['Artificial Intelligence (AI)'],
          current_position_titles: [], person_locations: [],
        },
        ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
        minimum_priority: 40, lookback_days: 365, max_candidates: 5,
        max_api_requests: 1, minimum_rate_remaining: 0, max_spend_usd: 0.15,
      },
    };
    const base = {
      AUTOMATED_TRIGGERS_ENABLED: '1',
      PARTNER_SCREENING_AUTOMATION_INTERVAL_MINUTES: '360',
      PARTNER_SCREENING_CONFIG_JSON: JSON.stringify(policy),
    };
    const now = new Date('2026-09-16T19:00:00Z');
    const gated = await enqueueAutomatedPartnerScreening(makeEnv(base).env, now);
    expect(gated).toMatchObject({
      enabled: true, paidEnabled: false,
      candidateAgents: 1, startedAgents: 1, activeOwnedAgents: 1,
      configuredAgents: 1, skippedPaid: 1, queued: 0,
    });

    const admitted = await enqueueAutomatedPartnerScreening(makeEnv({
      ...base, PARTNER_SCREENING_PAID_AUTOMATION_ENABLED: '1',
    }).env, now);
    expect(admitted).toMatchObject({
      enabled: true, paidEnabled: true, configuredAgents: 1, skippedPaid: 0, queued: 1,
    });
  });

  it('imports one run-bound AgentCash People Search response as sanitized Inbox evidence', async () => {
    const fx = await seedWorkspace();
    await bindAgent(fx);
    const rawConfig = {
      source: 'agentcash_people',
      source_purpose: 'person_partner_research', organization_only: false, no_outreach: true,
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
    const bridgeSecret = 'agentcash-people-bridge-secret-1234567890';
    const { env } = makeEnv({
      AGENT_RUNTIME: 'hermes', HERMES_BRIDGE_SECRET: bridgeSecret,
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [fx.agentId]: {
          workspace_id: fx.workspaceId,
          base_url: 'https://iris-nous-cloud.example/api/plugins/enterprise_bridge/control',
          api_key: 'runtime-profile-key', transport: 'dashboard_connector',
        },
      }),
      PARTNER_SCREENING_CONFIG_JSON: JSON.stringify({ [fx.agentId]: rawConfig }),
    });
    const startedResponse = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/partner-screening/runs`, {
      method: 'POST', body: { agent_id: fx.agentId, idempotency_key: `agentcash-${randomUUID()}` },
    });
    expect(startedResponse.status).toBe(201);
    const started = await startedResponse.json() as { run: { id: string; status: string; source: string }; candidates: unknown[] };
    expect(started).toMatchObject({ run: { status: 'running', source: 'agentcash_people' }, candidates: [] });

    const nativeRunId = `run_${'b'.repeat(32)}`;
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO runs
           (workspace_id,session_id,agent_id,status,model_id,client_turn_id,trace_id,mode,
            runtime_kind,runtime_run_id,runtime_session_id,runtime_profile,runtime_attempt)
         VALUES ($1::uuid,$2::uuid,$3::uuid,'working','deepseek-flash',$4,$5,'work','hermes',$6,$2::text,'agent-' || $3::text,1)`,
        [fx.workspaceId, fx.sessionId, fx.agentId, `partner-screening:${started.run.id}`, randomUUID(), nativeRunId],
      );
      await client.query('COMMIT');
    });
    const config = partnerAgentConfig(env, fx.agentId).config!;
    const runtimeAuthorization = { Authorization: `Bearer ${await bridgeToken(env, fx.workspaceId, fx.agentId)}` };
    const unleasedImport = await call(
      env,
      `/internal/runtime/w/${fx.workspaceId}/agents/${fx.agentId}/agentcash/people-search/import`,
      {
        method: 'POST', origin: null, headers: runtimeAuthorization,
        body: {
          runtime_run_id: nativeRunId,
          tool_call_id: 'call_people_1',
          arguments: agentCashPeopleSearchArguments(config),
          result: '{}',
        },
      },
    );
    expect(unleasedImport.status).toBe(409);
    expect(await unleasedImport.json()).toMatchObject({ reason: 'partner_source_payment_not_authorized' });
    const authorized = await call(
      env,
      `/internal/runtime/w/${fx.workspaceId}/agents/${fx.agentId}/agentcash/people-search/authorize`,
      {
        method: 'POST', origin: null, headers: runtimeAuthorization,
        body: {
          runtime_run_id: nativeRunId,
          tool_call_id: 'call_people_1',
          arguments: agentCashPeopleSearchArguments(config),
        },
      },
    );
    expect(authorized.status).toBe(201);
    expect(await authorized.json()).toMatchObject({ ok: true, reserved_requests: 1 });
    const authorizedReplay = await call(
      env,
      `/internal/runtime/w/${fx.workspaceId}/agents/${fx.agentId}/agentcash/people-search/authorize`,
      {
        method: 'POST', origin: null, headers: runtimeAuthorization,
        body: {
          runtime_run_id: nativeRunId,
          tool_call_id: 'call_people_1',
          arguments: agentCashPeopleSearchArguments(config),
        },
      },
    );
    expect(authorizedReplay.status).toBe(200);
    const duplicatePayment = await call(
      env,
      `/internal/runtime/w/${fx.workspaceId}/agents/${fx.agentId}/agentcash/people-search/authorize`,
      {
        method: 'POST', origin: null, headers: runtimeAuthorization,
        body: {
          runtime_run_id: nativeRunId,
          tool_call_id: 'call_people_2',
          arguments: agentCashPeopleSearchArguments(config),
        },
      },
    );
    expect(duplicatePayment.status).toBe(409);
    expect(await duplicatePayment.json()).toMatchObject({ reason: 'partner_source_budget_exhausted' });
    const pendingImport = await call(
      env,
      `/internal/runtime/w/${fx.workspaceId}/agents/${fx.agentId}/agentcash/people-search/pending`,
      { method: 'GET', origin: null, headers: runtimeAuthorization },
    );
    expect(pendingImport.status).toBe(200);
    expect(await pendingImport.json()).toEqual({
      runtime_run_id: nativeRunId,
      tool_call_id: 'call_people_1',
      arguments: agentCashPeopleSearchArguments(config),
    });
    // The observer can outlive the model turn when a large result takes longer
    // than the normal bridge timeout. Recovery must import the exact leased
    // result after the native run is terminal without authorizing another call.
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(`UPDATE runs SET status='completed', ended_at=now() WHERE runtime_run_id=$1`, [nativeRunId]);
      await client.query('COMMIT');
    });
    const imported = await call(
      env,
      `/internal/runtime/w/${fx.workspaceId}/agents/${fx.agentId}/agentcash/people-search/import`,
      {
        method: 'POST',
        origin: null,
        headers: runtimeAuthorization,
        body: {
          runtime_run_id: nativeRunId,
          tool_call_id: 'call_people_1',
          arguments: agentCashPeopleSearchArguments(config),
          result: JSON.stringify({
            people: [{
              id: 'person-1', full_name: 'Rik Turner', headline: 'Founder, PR for AI',
              email: 'must-not-persist@example.com', phone_numbers: ['+15551234567'],
              skills: ['Artificial Intelligence (AI)', 'Developer Relations'],
              social_profiles: { professional_network: { url: 'https://www.linkedin.com/in/rikturner', handle: 'rikturner' } },
              employment: { current: { title: 'Founder', seniority: 'Founder', company_id: 'company-1' } },
            }],
            companies: { 'company-1': { id: 'company-1', name: 'PR for AI', domain: 'prfor.ai' } },
            metadata: { total: 1, credits: 1, offset: 0 },
          }),
        },
      },
    );
    expect(imported.status).toBe(201);
    expect(await imported.json()).toMatchObject({ ok: true, imported_candidates: 1 });
    const noLongerPending = await call(
      env,
      `/internal/runtime/w/${fx.workspaceId}/agents/${fx.agentId}/agentcash/people-search/pending`,
      { method: 'GET', origin: null, headers: runtimeAuthorization },
    );
    expect(noLongerPending.status).toBe(204);

    const stored = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const run = await client.query(`SELECT status, source, monetary_cost_usd, api_requests_used, agentcash_tool_call_id FROM partner_screening_runs WHERE id=$1`, [started.run.id]);
      const candidates = await client.query(`SELECT source, display_name, profile_url FROM partner_candidates WHERE latest_run_id=$1`, [started.run.id]);
      const artifacts = await client.query<{ body: string }>(`SELECT string_agg(content::text, ' ') AS body FROM partner_source_artifacts WHERE run_id=$1`, [started.run.id]);
      return { run: run.rows[0], candidates: candidates.rows, artifacts: artifacts.rows[0]?.body ?? '' };
    });
    expect(stored.run).toMatchObject({ status: 'completed', source: 'agentcash_people', api_requests_used: 1, agentcash_tool_call_id: 'call_people_1' });
    expect(Number(stored.run.monetary_cost_usd)).toBe(0.15);
    expect(stored.candidates).toEqual([expect.objectContaining({ source: 'agentcash_people', display_name: 'Rik Turner' })]);
    expect(stored.artifacts).not.toContain('must-not-persist');
    expect(stored.artifacts).not.toContain('+15551234567');
  });
});
