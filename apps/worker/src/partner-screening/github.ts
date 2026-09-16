import { z } from 'zod';
import type { PartnerAgentConfig } from './config.js';
import {
  deterministicDiscoveryPriority,
  type DiscoveryPriority,
  type PublicOrganization,
  type PublicRepository,
} from './score.js';

export type PartnerFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class PartnerSourceError extends Error {
  constructor(
    message: string,
    readonly reason: string,
    readonly status: 429 | 503 = 503,
  ) {
    super(message);
    this.name = 'PartnerSourceError';
  }
}

const ownerSchema = z.object({ login: z.string(), node_id: z.string(), type: z.string() }).passthrough();
const licenseSchema = z.object({ spdx_id: z.string().nullable() }).passthrough().nullable();
const repositorySchema = z.object({
  id: z.number().int(), node_id: z.string(), name: z.string(), full_name: z.string(), html_url: z.url(),
  description: z.string().nullable(), topics: z.array(z.string()).default([]), language: z.string().nullable(),
  stargazers_count: z.number().int().min(0), forks_count: z.number().int().min(0),
  open_issues_count: z.number().int().min(0), fork: z.boolean(), archived: z.boolean(), disabled: z.boolean(),
  has_issues: z.boolean(), license: licenseSchema, pushed_at: z.string().nullable(), updated_at: z.string(), owner: ownerSchema,
}).passthrough();
const searchSchema = z.object({
  total_count: z.number().int().min(0), incomplete_results: z.boolean(), items: z.array(repositorySchema),
}).passthrough();
const organizationSchema = z.object({
  id: z.number().int(), node_id: z.string(), login: z.string(), name: z.string().nullable(),
  description: z.string().nullable(), html_url: z.url(), blog: z.string().nullable(),
  public_repos: z.number().int().min(0), followers: z.number().int().min(0),
  created_at: z.string(), updated_at: z.string(),
}).passthrough();

export interface RateLimitSnapshot {
  readonly resource: string;
  readonly limit: number | null;
  readonly remaining: number | null;
  readonly reset_at: string | null;
}

export interface SourceArtifactInput {
  readonly key: string;
  readonly kind: 'search_result' | 'organization_profile' | 'repository_snapshot';
  readonly url: string;
  readonly sourceUpdatedAt: string | null;
  readonly fetchedAt: string;
  readonly content: Record<string, unknown>;
}

export interface DiscoveredOrganization {
  readonly sourceKey: string;
  readonly displayName: string;
  readonly profileUrl: string;
  readonly priority: DiscoveryPriority;
  readonly artifacts: readonly SourceArtifactInput[];
}

export interface GitHubDiscoveryResult {
  readonly candidates: readonly DiscoveredOrganization[];
  readonly artifacts: readonly SourceArtifactInput[];
  readonly apiRequestsUsed: number;
  readonly rateLimits: readonly RateLimitSnapshot[];
}

interface GitHubClientOptions {
  readonly fetcher: PartnerFetch;
  readonly token?: string;
  readonly maxRequests: number;
  readonly minimumRateRemaining: number;
  readonly now: () => Date;
}

function asInt(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function publicRepository(repo: z.infer<typeof repositorySchema>): PublicRepository {
  return {
    id: repo.id, node_id: repo.node_id, name: repo.name, full_name: repo.full_name, html_url: repo.html_url,
    description: repo.description, topics: repo.topics, language: repo.language,
    stargazers_count: repo.stargazers_count, forks_count: repo.forks_count,
    open_issues_count: repo.open_issues_count, fork: repo.fork, archived: repo.archived,
    disabled: repo.disabled, has_issues: repo.has_issues, license: repo.license,
    pushed_at: repo.pushed_at, updated_at: repo.updated_at,
  };
}

function publicOrganization(org: z.infer<typeof organizationSchema>): PublicOrganization {
  return {
    id: org.id, node_id: org.node_id, login: org.login, name: org.name,
    description: org.description, html_url: org.html_url, blog: org.blog,
    public_repos: org.public_repos, followers: org.followers,
    created_at: org.created_at, updated_at: org.updated_at,
  };
}

export class GitHubPublicApi {
  private requests = 0;
  private readonly rates = new Map<string, RateLimitSnapshot>();

  constructor(private readonly options: GitHubClientOptions) {}

  get requestsUsed(): number { return this.requests; }
  get rateLimits(): RateLimitSnapshot[] { return [...this.rates.values()]; }

  private expectedResource(path: string): string { return path.startsWith('/search/') ? 'search' : 'core'; }

  async json(path: string): Promise<{ data: unknown; url: string; fetchedAt: string }> {
    if (this.requests >= this.options.maxRequests) {
      throw new PartnerSourceError('The configured GitHub request budget was exhausted.', 'partner_source_budget_exhausted');
    }
    const expected = this.rates.get(this.expectedResource(path));
    if (expected?.remaining !== null && expected?.remaining !== undefined && expected.remaining <= this.options.minimumRateRemaining) {
      throw new PartnerSourceError(
        `GitHub ${expected.resource} rate budget is at its configured reserve; retry after ${expected.reset_at ?? 'the reset window'}.`,
        'partner_source_rate_limited',
        429,
      );
    }
    const url = `https://api.github.com${path}`;
    const headers = new Headers({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
      'User-Agent': 'Hermes-Partner-Screening/0.1',
    });
    if (this.options.token?.trim()) headers.set('Authorization', `Bearer ${this.options.token.trim()}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort('timeout'), 10_000);
    let response: Response;
    try {
      this.requests += 1;
      response = await this.options.fetcher(url, { method: 'GET', headers, signal: controller.signal });
    } catch (error) {
      throw new PartnerSourceError(
        error instanceof Error && error.name === 'AbortError' ? 'GitHub API request timed out.' : 'GitHub API request failed.',
        'partner_source_unavailable',
      );
    } finally {
      clearTimeout(timeout);
    }

    const resource = response.headers.get('x-ratelimit-resource') ?? this.expectedResource(path);
    const reset = asInt(response.headers.get('x-ratelimit-reset'));
    this.rates.set(resource, {
      resource,
      limit: asInt(response.headers.get('x-ratelimit-limit')),
      remaining: asInt(response.headers.get('x-ratelimit-remaining')),
      reset_at: reset === null ? null : new Date(reset * 1000).toISOString(),
    });
    if (response.status === 403 || response.status === 429) {
      throw new PartnerSourceError(
        `GitHub refused the request due to a rate or abuse limit; retry after ${response.headers.get('retry-after') ?? this.rates.get(resource)?.reset_at ?? 'the reset window'}.`,
        'partner_source_rate_limited',
        429,
      );
    }
    if (!response.ok) {
      throw new PartnerSourceError(`GitHub API returned HTTP ${response.status}.`, 'partner_source_unavailable');
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > 1_048_576) {
      throw new PartnerSourceError('GitHub API response exceeded 1 MB.', 'partner_source_response_too_large');
    }
    try {
      return { data: JSON.parse(text), url, fetchedAt: this.options.now().toISOString() };
    } catch {
      throw new PartnerSourceError('GitHub API returned invalid JSON.', 'partner_source_invalid_response');
    }
  }
}

const RESERVED_PATHS = new Set(['about', 'account', 'apps', 'collections', 'contact', 'enterprise', 'events', 'features', 'issues', 'login', 'marketplace', 'new', 'notifications', 'orgs', 'organizations', 'pricing', 'pulls', 'search', 'security', 'settings', 'sponsors', 'topics', 'trending']);

export function organizationFromIntakeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(url.hostname.toLowerCase())) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    const login = segments[0] ?? '';
    if (segments.length > 2 || RESERVED_PATHS.has(login.toLowerCase()) || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(login)) return null;
    return login;
  } catch {
    return null;
  }
}

const searchArtifactContent = (query: string, parsed: z.infer<typeof searchSchema>): Record<string, unknown> => ({
  query,
  total_count: parsed.total_count,
  incomplete_results: parsed.incomplete_results,
  organization_repositories: parsed.items
    .filter((repo) => repo.owner.type === 'Organization')
    .slice(0, 50)
    .map((repo) => ({
      owner_login: repo.owner.login, owner_node_id: repo.owner.node_id,
      repository: repo.full_name, url: repo.html_url, description: repo.description,
      stars: repo.stargazers_count, pushed_at: repo.pushed_at, updated_at: repo.updated_at,
    })),
});

export async function discoverGitHubOrganizations(
  config: PartnerAgentConfig,
  options: { fetcher: PartnerFetch; token?: string; now?: () => Date },
): Promise<GitHubDiscoveryResult> {
  const now = options.now ?? (() => new Date());
  const client = new GitHubPublicApi({
    fetcher: options.fetcher,
    token: options.token,
    maxRequests: config.max_api_requests,
    minimumRateRemaining: config.minimum_rate_remaining,
    now,
  });
  const artifacts: SourceArtifactInput[] = [];
  const organizations = new Map<string, { matched: PublicRepository[]; explicit: boolean; incomplete: boolean }>();

  for (let index = 0; index < config.search_queries.length; index += 1) {
    const query = config.search_queries[index] ?? '';
    const response = await client.json(`/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=50`);
    const parsed = searchSchema.safeParse(response.data);
    if (!parsed.success) throw new PartnerSourceError('GitHub search response did not match the documented schema.', 'partner_source_invalid_response');
    artifacts.push({
      key: `search:${index + 1}`, kind: 'search_result', url: response.url,
      sourceUpdatedAt: null, fetchedAt: response.fetchedAt, content: searchArtifactContent(query, parsed.data),
    });
    for (const repo of parsed.data.items) {
      if (repo.owner.type !== 'Organization') continue;
      const existing = organizations.get(repo.owner.login) ?? { matched: [], explicit: false, incomplete: false };
      existing.matched.push(publicRepository(repo));
      existing.incomplete ||= parsed.data.incomplete_results;
      organizations.set(repo.owner.login, existing);
    }
  }
  for (const rawUrl of config.intake_urls) {
    const login = organizationFromIntakeUrl(rawUrl);
    if (!login) throw new PartnerSourceError(`Explicit intake URL is not a supported GitHub organization or repository URL: ${rawUrl}`, 'partner_source_bad_intake');
    const existing = organizations.get(login) ?? { matched: [], explicit: true, incomplete: false };
    existing.explicit = true;
    organizations.set(login, existing);
  }

  // Enrich the most promising unique organization owners. Search matches are
  // only a discovery signal; the profile and repository-list calls are the
  // authoritative artifacts used for deterministic priority.
  const shortlist = [...organizations.entries()]
    .sort((a, b) => b[1].matched.reduce((sum, repo) => sum + repo.stargazers_count, 0) - a[1].matched.reduce((sum, repo) => sum + repo.stargazers_count, 0))
    .slice(0, config.max_candidates);
  const candidates: DiscoveredOrganization[] = [];
  for (const [login, discovery] of shortlist) {
    const profileResponse = await client.json(`/orgs/${encodeURIComponent(login)}`);
    const profile = organizationSchema.safeParse(profileResponse.data);
    if (!profile.success) throw new PartnerSourceError('GitHub organization response did not match the documented schema.', 'partner_source_invalid_response');
    const org = publicOrganization(profile.data);
    const reposResponse = await client.json(`/orgs/${encodeURIComponent(login)}/repos?type=public&sort=pushed&direction=desc&per_page=10`);
    const reposParsed = z.array(repositorySchema).safeParse(reposResponse.data);
    if (!reposParsed.success) throw new PartnerSourceError('GitHub repository-list response did not match the documented schema.', 'partner_source_invalid_response');
    const repositories = reposParsed.data.filter((repo) => repo.owner.type === 'Organization').map(publicRepository);
    const orgArtifact: SourceArtifactInput = {
      key: `org:${org.node_id}`, kind: 'organization_profile', url: profileResponse.url,
      sourceUpdatedAt: org.updated_at, fetchedAt: profileResponse.fetchedAt, content: { ...org },
    };
    const repoArtifact: SourceArtifactInput = {
      key: `repos:${org.node_id}`, kind: 'repository_snapshot', url: reposResponse.url,
      sourceUpdatedAt: repositories.map((repo) => repo.updated_at).sort().at(-1) ?? null,
      fetchedAt: reposResponse.fetchedAt, content: {
        organization_login: org.login,
        repositories: repositories.map((repo) => ({ ...repo })),
      },
    };
    artifacts.push(orgArtifact, repoArtifact);
    candidates.push({
      sourceKey: org.node_id,
      displayName: org.name?.trim() || org.login,
      profileUrl: org.html_url,
      priority: deterministicDiscoveryPriority(org, repositories, config, {
        now: now(), searchIncomplete: discovery.incomplete, explicitOnly: discovery.explicit && discovery.matched.length === 0,
      }),
      artifacts: [orgArtifact, repoArtifact],
    });
  }

  return {
    candidates: candidates.sort((a, b) => b.priority.total - a.priority.total || a.displayName.localeCompare(b.displayName)),
    artifacts,
    apiRequestsUsed: client.requestsUsed,
    rateLimits: client.rateLimits,
  };
}
