import { renderToStaticMarkup } from 'react-dom/server';
import type { Rest } from '../../model/rest.js';
import {
  FirstRunLiveSearch,
  getLivePartnerSearch,
  handoffLivePartnerSearch,
  startLivePartnerSearch,
  type LiveSearchView,
} from './FirstRunLiveSearch.js';

const RUN_ID = '10000000-0000-4000-8000-000000000001';
const AGENT_ID = '10000000-0000-4000-8000-000000000002';
const CANDIDATE_ID = '10000000-0000-4000-8000-000000000003';
const REQUEST_ID = '10000000-0000-4000-8000-000000000004';
const at = '2026-09-16T20:00:00.000Z';

function snapshot(requestId: string | null = null) {
  return {
    run: { id: RUN_ID, agent_id: AGENT_ID, status: 'completed' as const, mode: 'live' as const, source: 'github' as const, authentication: 'unauthenticated' as const, started_at: at, completed_at: at, error_code: null, error_detail: null },
    budget: { api_requests_used: 3, api_requests_max: 5, monetary_cost_usd: 0 as const },
    rate_limits: [],
    ranking: { kind: 'deterministic_discovery_priority' as const, note: 'This is connector-side triage, not an Iris or Hermes decision.' as const, weights: { relevance: 40 }, minimum_priority: 50 },
    candidates: [{ id: CANDIDATE_ID, source: 'github' as const, source_key: 'ORG_1', display_name: 'Example Org', profile_url: 'https://github.com/example', deterministic_priority: 78, priority_max: 100 as const, confidence: 'medium' as const, evidence_gaps: ['Interest and capacity are unverified.'], source_updated_at: at, last_seen_at: at, existing_request_id: requestId }],
    handoff: { kind: 'ask_iris_to_screen' as const, prompt: 'Review the stored candidate.', candidate_ids: [CANDIDATE_ID], agent_run: requestId ? { id: '10000000-0000-4000-8000-000000000005', session_id: '10000000-0000-4000-8000-000000000006', status: 'completed' as const } : null },
    disclosure: 'Public organization evidence was fetched through the official GitHub REST API. No person was contacted and no application, admission, message, payment, signature, or external write was performed.' as const,
  };
}

describe('first-run live search contract', () => {
  it('uses the live discovery and explicit Iris handoff routes', async () => {
    const request = vi.fn().mockResolvedValue(snapshot());
    const client = { request: request as Rest['request'] };

    await startLivePartnerSearch(client, 'workspace-id', AGENT_ID, 'onboarding:attempt');
    expect(request).toHaveBeenLastCalledWith('POST', '/w/workspace-id/partner-screening/runs', expect.anything(), { agent_id: AGENT_ID, idempotency_key: 'onboarding:attempt' });
    await getLivePartnerSearch(client, 'workspace-id', RUN_ID);
    expect(request).toHaveBeenLastCalledWith('GET', `/w/workspace-id/partner-screening/runs/${RUN_ID}`, expect.anything());
    await handoffLivePartnerSearch(client, 'workspace-id', RUN_ID);
    expect(request).toHaveBeenLastCalledWith('POST', `/w/workspace-id/partner-screening/runs/${RUN_ID}/handoff`, expect.anything(), {});
  });

  it('labels real evidence and counts only persisted Inbox requests', () => {
    const view: LiveSearchView = { phase: 'complete', snapshot: snapshot(REQUEST_ID), message: null };
    const html = renderToStaticMarkup(<FirstRunLiveSearch view={view} onOpenInbox={() => {}} />);

    expect(html).toContain('Live Partner Program search');
    expect(html).toContain('Official GitHub API');
    expect(html).toContain('aria-label="1 candidates need review"');
    expect(html).toContain('Example Org');
    expect(html).toContain('3/5 API requests used');
    expect(html).not.toContain('simulated');
    expect(html).not.toContain('Sample ·');
  });

  it('labels imported AgentCash people as professional prospects, not applicants', () => {
    const base = snapshot(REQUEST_ID);
    const peopleSnapshot = {
      ...base,
      run: { ...base.run, source: 'agentcash_people' as const, authentication: 'wallet' as const },
      budget: { ...base.budget, api_requests_used: 1, api_requests_max: 1, monetary_cost_usd: 0.15 },
      candidates: [{
        ...base.candidates[0]!, source: 'agentcash_people' as const,
        display_name: 'Rik Turner', profile_url: 'https://www.linkedin.com/in/rikturner',
      }],
      disclosure: 'Public professional evidence was fetched through AgentCash People Search using one capped wallet payment. No person was contacted and no application, admission, message, signature, or other external write was performed.' as const,
    };
    const html = renderToStaticMarkup(<FirstRunLiveSearch view={{ phase: 'complete', snapshot: peopleSnapshot, message: null }} />);

    expect(html).toContain('AgentCash');
    expect(html).toContain('Professional profile');
    expect(html).toContain('Rik Turner');
    expect(html).not.toContain('GitHub organization');
    expect(html).not.toContain('applied');
  });
});
