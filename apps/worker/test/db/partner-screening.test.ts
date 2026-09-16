import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toolByName } from '../../src/engine/tools.js';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import type { Env } from '../../src/env.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';
import { asUser, makeEnv, readTenant } from './harness.js';

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
      candidates: { id: string; deterministic_priority: number }[];
      handoff: { kind: string; candidate_ids: string[]; prompt: string };
      disclosure: string;
    };
    expect(snapshot.run).toMatchObject({ mode: 'live', authentication: 'unauthenticated' });
    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.handoff).toMatchObject({ kind: 'ask_iris_to_screen', candidate_ids: [snapshot.candidates[0]!.id] });
    expect(snapshot.handoff.prompt).toContain('Do not contact anyone');
    expect(snapshot.disclosure).toContain('No person was contacted');
    expect(calls).toBe(3);

    const replay = await asUser(env, fx.adminId, path, {
      method: 'POST', body: { agent_id: fx.agentId, idempotency_key: idempotencyKey },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-hermes-idempotent-replay')).toBe('true');
    expect(calls).toBe(3);

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
});
