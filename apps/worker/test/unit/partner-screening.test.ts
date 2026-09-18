import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { partnerAgentConfig, partnerScreeningAgentIds, partnerSourceMatrix, type PartnerAgentConfig } from '../../src/partner-screening/config.js';
import { automationIntervalMinutes, automatedTriggersEnabled } from '../../src/partner-screening/automation.js';
import {
  discoverGitHubOrganizations,
  organizationFromIntakeUrl,
  type PartnerFetch,
} from '../../src/partner-screening/github.js';
import { deterministicDiscoveryPriority, type PublicOrganization, type PublicRepository } from '../../src/partner-screening/score.js';

const AGENT_ID = '11111111-1111-4111-8111-111111111111';

const config: PartnerAgentConfig = {
  source: 'github',
  program_name: 'Hermes Partner Program',
  source_purpose: 'organization_partner_research',
  organization_only: true,
  no_outreach: true,
  role_label: 'Potential technical ecosystem partner',
  search_queries: ['developer education in:name,description,readme archived:false'],
  intake_urls: [],
  keywords: ['developer education', 'agents', 'open source'],
  ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
  minimum_priority: 50,
  lookback_days: 365,
  max_candidates: 2,
  max_api_requests: 6,
  minimum_rate_remaining: 0,
  max_spend_usd: 0,
};

const owner = { login: 'ExampleOrg', node_id: 'ORG_node_1', type: 'Organization' };
const userOwner = { login: 'ExamplePerson', node_id: 'USER_node_1', type: 'User' };
const repo = (repoOwner = owner, name = 'developer-agents') => ({
  id: 1, node_id: `REPO_${name}`, name, full_name: `${repoOwner.login}/${name}`,
  html_url: `https://github.com/${repoOwner.login}/${name}`,
  description: 'Open source developer education agents', topics: ['agents', 'education'], language: 'TypeScript',
  stargazers_count: 100, forks_count: 12, open_issues_count: 4,
  fork: false, archived: false, disabled: false, has_issues: true,
  license: { spdx_id: 'MIT' }, pushed_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z',
  owner: repoOwner,
});

const json = (body: unknown, resource: 'search' | 'core', remaining = 20): Response => new Response(JSON.stringify(body), {
  status: 200,
  headers: {
    'content-type': 'application/json',
    'x-ratelimit-resource': resource,
    'x-ratelimit-limit': resource === 'search' ? '30' : '5000',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': '1800000000',
  },
});

function scriptedFetch(seen: Request[]): PartnerFetch {
  return async (input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    const url = new URL(request.url);
    if (url.pathname === '/search/repositories') {
      return json({ total_count: 2, incomplete_results: false, items: [repo(), repo(userOwner, 'personal-project')] }, 'search');
    }
    if (url.pathname === '/orgs/ExampleOrg') {
      // Public email can exist in the upstream shape. The connector must not
      // retain it in its sanitized organization artifact.
      return json({
        id: 9, node_id: owner.node_id, login: owner.login,
        description: 'Developer education and open source agents', html_url: 'https://github.com/ExampleOrg',
        email: 'not-retained@example.org', public_repos: 8, followers: 500,
        created_at: '2020-01-01T00:00:00Z', updated_at: '2026-09-11T00:00:00Z',
      }, 'core');
    }
    if (url.pathname === '/orgs/ExampleOrg/repos') return json([repo()], 'core');
    return new Response('{}', { status: 404 });
  };
}

describe('partner screening source configuration', () => {
  it('requires explicit organization-only/no-outreach policy and keeps connector states truthful', () => {
    const env = {
      PARTNER_SCREENING_CONFIG_JSON: JSON.stringify({ [AGENT_ID]: config }),
      PARTNER_GITHUB_TOKEN: 'configured-but-never-returned',
    } as Env;
    expect(partnerAgentConfig(env, AGENT_ID).config).toMatchObject({ organization_only: true, no_outreach: true });
    const matrix = partnerSourceMatrix(env, AGENT_ID);
    expect(matrix.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'github', state: 'live', authentication: 'authenticated' }),
      expect.objectContaining({ id: 'youtube', state: 'live', authentication: 'wallet' }),
      expect.objectContaining({ id: 'x', state: 'live', authentication: 'wallet' }),
      expect.objectContaining({ id: 'linkedin', state: 'live', authentication: 'wallet' }),
    ]));
    expect(matrix.onboarding_live_search).toMatchObject({ available: true, source: 'github' });
    expect(JSON.stringify(matrix)).not.toContain('configured-but-never-returned');
  });

  it('uses a bounded default policy for a new onboarding agent without scheduling it', () => {
    const env = { PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify({ ...config, max_candidates: 2, max_api_requests: 5 }) } as Env;
    expect(partnerAgentConfig(env, AGENT_ID).config).toMatchObject({ max_candidates: 2, max_api_requests: 5 });
    expect(partnerSourceMatrix(env, AGENT_ID).onboarding_live_search.available).toBe(true);
    expect(partnerScreeningAgentIds(env)).toEqual([]);
  });

  it('rejects malformed weights and individual/social URLs', () => {
    const invalid = { ...config, ranking_weights: { ...config.ranking_weights, relevance: 39 } };
    const parsed = partnerAgentConfig({ PARTNER_SCREENING_CONFIG_JSON: JSON.stringify({ [AGENT_ID]: invalid }) } as Env, AGENT_ID);
    expect(parsed.config).toBeNull();
    expect(organizationFromIntakeUrl('https://github.com/ExampleOrg/repository')).toBe('ExampleOrg');
    expect(organizationFromIntakeUrl('https://github.com/topics/agents')).toBeNull();
    expect(organizationFromIntakeUrl('https://linkedin.com/in/person')).toBeNull();
  });

  it('requires an explicit automation gate and clamps the scheduler cadence', () => {
    const env = {
      AUTOMATED_TRIGGERS_ENABLED: '1',
      PARTNER_SCREENING_AUTOMATION_INTERVAL_MINUTES: '2',
      PARTNER_SCREENING_CONFIG_JSON: JSON.stringify({ [AGENT_ID]: config }),
    } as Env;
    expect(automatedTriggersEnabled(env)).toBe(true);
    expect(automationIntervalMinutes(env)).toBe(5);
    expect(partnerScreeningAgentIds(env)).toEqual([AGENT_ID]);
    expect(automationIntervalMinutes({ PARTNER_SCREENING_AUTOMATION_INTERVAL_MINUTES: '9999' } as Env)).toBe(1_440);
    expect(automatedTriggersEnabled({ AUTOMATED_TRIGGERS_ENABLED: 'true' } as Env)).toBe(false);
  });
});

describe('GitHub organization discovery', () => {
  it('uses the official API, filters people, sanitizes evidence and records budgets/rates', async () => {
    const seen: Request[] = [];
    const result = await discoverGitHubOrganizations(config, {
      fetcher: scriptedFetch(seen), token: 'source-token', now: () => new Date('2026-09-15T00:00:00Z'),
    });
    expect(result.apiRequestsUsed).toBe(3);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ sourceKey: owner.node_id, displayName: owner.login });
    expect(result.candidates[0]?.priority.total).toBeGreaterThanOrEqual(config.minimum_priority);
    expect(result.artifacts.map((artifact) => artifact.kind)).toEqual([
      'search_result', 'organization_profile', 'repository_snapshot',
    ]);
    expect(JSON.stringify(result.artifacts)).not.toContain('not-retained@example.org');
    expect(result.rateLimits).toEqual(expect.arrayContaining([
      expect.objectContaining({ resource: 'search', remaining: 20 }),
      expect.objectContaining({ resource: 'core', remaining: 20 }),
    ]));
    expect(seen.every((request) => request.headers.get('authorization') === 'Bearer source-token')).toBe(true);
    expect(seen.every((request) => new URL(request.url).hostname === 'api.github.com')).toBe(true);
  });

  it('uses truthful search-only evidence when an unauthenticated core quota is shared', async () => {
    const seen: Request[] = [];
    const result = await discoverGitHubOrganizations(config, {
      fetcher: scriptedFetch(seen), now: () => new Date('2026-09-15T00:00:00Z'),
    });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]?.url ?? '').pathname).toBe('/search/repositories');
    expect(result.apiRequestsUsed).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      sourceKey: owner.node_id,
      displayName: owner.login,
      priority: {
        confidence: 'low',
        gaps: expect.arrayContaining([expect.stringContaining('repository-search evidence')]),
      },
    });
    expect(result.candidates[0]?.artifacts.map((artifact) => artifact.kind)).toEqual([
      'organization_profile', 'repository_snapshot',
    ]);
  });

  it('stops before another request when the provider reaches the configured reserve', async () => {
    const limited: PartnerFetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/search/repositories') {
        return json({ total_count: 1, incomplete_results: false, items: [repo()] }, 'search', 0);
      }
      return json({}, 'core', 0);
    };
    await expect(discoverGitHubOrganizations({
      ...config,
      search_queries: [...config.search_queries, 'open source agents in:name,description'],
    }, { fetcher: limited })).rejects.toMatchObject({
      reason: 'partner_source_rate_limited', status: 429,
    });
  });

  it('preserves GitHub retry guidance for the durable job scheduler', async () => {
    const limited: PartnerFetch = async () => new Response('{}', {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': '47',
        'x-ratelimit-resource': 'search',
        'x-ratelimit-remaining': '0',
      },
    });
    await expect(discoverGitHubOrganizations(config, { fetcher: limited })).rejects.toMatchObject({
      reason: 'partner_source_rate_limited', status: 429, retryAfterSeconds: 47,
    });
  });
});

describe('deterministic discovery priority', () => {
  it('is reproducible, weighted to 100, and keeps capacity/interest as explicit gaps', () => {
    const org: PublicOrganization = {
      id: 9, node_id: owner.node_id, login: owner.login, name: 'Example Org',
      description: 'Developer education and open source agents', html_url: 'https://github.com/ExampleOrg',
      blog: null, public_repos: 8, followers: 500,
      created_at: '2020-01-01T00:00:00Z', updated_at: '2026-09-11T00:00:00Z',
    };
    const repositories = [repo()].map(({ owner: _owner, ...value }) => value as PublicRepository);
    const score = deterministicDiscoveryPriority(org, repositories, config, {
      now: new Date('2026-09-15T00:00:00Z'), searchIncomplete: false, explicitOnly: false,
    });
    expect(score.criteria.reduce((sum, criterion) => sum + criterion.points_max, 0)).toBe(100);
    expect(score.total).toBe(score.criteria.reduce((sum, criterion) => sum + criterion.points, 0));
    expect(score.gaps.join(' ')).toContain('capacity');
    expect(score.gaps.join(' ')).toContain('consent');
  });
});
