import { z } from 'zod';
import type { DiscoveryPriority, DiscoveryPriorityCriterion } from './score.js';

export const AGENTCASH_CREATOR_SEARCH_URL = 'https://stableenrich.dev/api/exa/search' as const;
export const AGENTCASH_CREATOR_SEARCH_ARGUMENTS = {
  url: AGENTCASH_CREATOR_SEARCH_URL,
  method: 'POST' as const,
  maxAmount: 0.01 as const,
  body: {
    query: '"Hermes Agent" "Nous Research" consultant creator tutorial implementation',
    includeDomains: ['linkedin.com', 'www.linkedin.com', 'youtube.com', 'www.youtube.com'],
    numResults: 10,
    type: 'auto',
    contents: {
      summary: {
        query: 'Identify the person or channel and concise public evidence that they teach, implement, advise on, or consult about Nous Research Hermes Agent.',
      },
      highlights: { query: 'Hermes Agent consulting implementation tutorial', maxCharacters: 600 },
      text: { maxCharacters: 1_500, verbosity: 'compact', includeSections: ['body', 'metadata'] },
      livecrawl: 'fallback',
      maxAgeHours: 72,
      extras: { links: 10 },
    },
  },
} as const;

const resultSchema = z.object({
  id: z.string().optional(),
  title: z.string().max(500).optional(),
  url: z.string().url().max(2048),
  publishedDate: z.string().nullable().optional(),
  author: z.string().max(300).nullable().optional(),
  score: z.number().nullable().optional(),
  text: z.string().max(50_000).optional(),
  highlights: z.array(z.string().max(5_000)).max(30).optional(),
  summary: z.string().max(10_000).optional(),
  extras: z.object({ links: z.array(z.string().max(2048)).max(100).optional() }).passthrough().optional(),
}).passthrough();

const responseSchema = z.object({ results: z.array(resultSchema).max(100) }).passthrough();

export interface AgentCashCreatorArtifact {
  readonly key: string;
  readonly kind: 'creator_profile' | 'creator_content';
  readonly url: string;
  readonly sourceUpdatedAt: string | null;
  readonly fetchedAt: string;
  readonly content: Record<string, unknown>;
}

export interface AgentCashCreatorCandidate {
  readonly sourceKey: string;
  readonly displayName: string;
  readonly profileUrl: string;
  readonly priority: DiscoveryPriority;
  readonly artifacts: readonly AgentCashCreatorArtifact[];
}

export interface AgentCashCreatorResult {
  readonly candidates: readonly AgentCashCreatorCandidate[];
  readonly artifacts: readonly AgentCashCreatorArtifact[];
  readonly apiRequestsUsed: 1;
  readonly rateLimits: readonly [];
  readonly monetaryCostUsd: 0.01;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unwrap(value: unknown, depth = 0): unknown {
  if (depth > 6) return value;
  if (typeof value === 'string') {
    try { return unwrap(JSON.parse(value), depth + 1); } catch {
      for (const line of value.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const parsed = unwrap(JSON.parse(line), depth + 1);
          if (object(parsed) && Array.isArray(parsed.results)) return parsed;
        } catch { /* An MCP text block may contain non-JSON metadata. */ }
      }
      return value;
    }
  }
  if (!object(value)) return value;
  if (Array.isArray(value.results)) return value;
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (object(item) && typeof item.text === 'string') {
        const parsed = unwrap(item.text, depth + 1);
        if (object(parsed) && Array.isArray(parsed.results)) return parsed;
      }
    }
  }
  for (const key of ['data', 'body', 'result', 'response']) {
    if (key in value) {
      const parsed = unwrap(value[key], depth + 1);
      if (object(parsed) && Array.isArray(parsed.results)) return parsed;
    }
  }
  return value;
}

export function trustedCreatorUrl(value: string): { platform: 'linkedin' | 'youtube'; url: string; profile: boolean } | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    url.search = '';
    url.hash = '';
    const clean = url.toString().replace(/\/$/, '');
    if (['linkedin.com', 'www.linkedin.com'].includes(host)) {
      return { platform: 'linkedin', url: clean, profile: /^\/in\/[^/]+\/?$/u.test(url.pathname) };
    }
    if (['youtube.com', 'www.youtube.com'].includes(host)) {
      return {
        platform: 'youtube',
        url: clean,
        profile: /^\/(?:@[^/]+|channel\/[^/]+|c\/[^/]+)\/?$/u.test(url.pathname),
      };
    }
    return null;
  } catch { return null; }
}

export function trustedLinkedInProfileUrl(value: string): string | null {
  const trusted = trustedCreatorUrl(value);
  return trusted?.platform === 'linkedin' && trusted.profile ? trusted.url : null;
}

function creatorProfile(result: z.infer<typeof resultSchema>): { platform: 'linkedin' | 'youtube'; profileUrl: string; resultUrl: string } | null {
  const resultUrl = trustedCreatorUrl(result.url);
  const links = result.extras?.links ?? [];
  const candidates = [
    ...(resultUrl?.profile ? [resultUrl] : []),
    ...links.flatMap((link) => {
      const trusted = trustedCreatorUrl(link);
      return trusted?.profile ? [trusted] : [];
    }),
  ];
  const profile = candidates.find((entry) => entry.platform === 'linkedin') ?? candidates[0];
  if (profile) return { platform: profile.platform, profileUrl: profile.url, resultUrl: resultUrl?.url ?? result.url };
  if (resultUrl) return { platform: resultUrl.platform, profileUrl: resultUrl.url, resultUrl: resultUrl.url };
  return null;
}

function compact(value: string | null | undefined, maximum: number): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized ? normalized.slice(0, maximum) : null;
}

function publicEvidenceText(value: string | null | undefined, maximum: number): string | null {
  const bounded = compact(value, maximum);
  if (!bounded) return null;
  return bounded
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[contact removed]')
    .replace(/(?:\+?\d[\d ().-]{6,}\d)/gu, '[contact removed]');
}

function displayName(result: z.infer<typeof resultSchema>, platform: 'linkedin' | 'youtube'): string {
  const author = compact(result.author, 200);
  if (author) return author;
  const title = compact(result.title, 200) ?? (platform === 'youtube' ? 'YouTube creator' : 'LinkedIn creator');
  return title.split(/\s+[|–—]\s+|\s+-\s+/u)[0]!.slice(0, 200);
}

function sourceKey(platform: 'linkedin' | 'youtube', profileUrl: string): string {
  const url = new URL(profileUrl);
  return `creator:${platform}:${url.pathname.replace(/^\/+|\/+$/gu, '').replace(/[^a-zA-Z0-9@._-]+/gu, '-').slice(0, 150)}`;
}

function publishedAt(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function priority(
  text: string,
  key: string,
  platform: 'linkedin' | 'youtube',
  isProfile: boolean,
  hasPublishedDate: boolean,
): DiscoveryPriority {
  const lower = text.toLowerCase();
  const hermes = lower.includes('hermes agent') || lower.includes('nous research');
  const consultingTerms = ['consultant', 'consulting', 'advisor', 'advisory', 'implement', 'deployment', 'integration'];
  const creatorTerms = ['creator', 'tutorial', 'guide', 'course', 'video', 'post', 'teach', 'youtube'];
  const consulting = consultingTerms.filter((term) => lower.includes(term));
  const creator = creatorTerms.filter((term) => lower.includes(term));
  const criteria: DiscoveryPriorityCriterion[] = [
    { id: 'relevance', label: 'Hermes Agent relevance', points: hermes ? 40 : 0, points_max: 40, evidence: hermes ? 'The indexed public result names Hermes Agent or Nous Research.' : 'The stored result did not clearly name Hermes Agent or Nous Research.', source_artifact_keys: [key] },
    { id: 'activity', label: 'Published creator activity', points: creator.length || hasPublishedDate ? 25 : 0, points_max: 25, evidence: creator.length ? `Creator signals in the result: ${creator.join(', ')}.` : hasPublishedDate ? 'The indexed result includes a publication date.' : 'No creator-activity signal was confirmed.', source_artifact_keys: [key] },
    { id: 'adoption', label: 'Consulting or implementation signal', points: consulting.length ? 20 : 0, points_max: 20, evidence: consulting.length ? `Consulting signals in the result: ${consulting.join(', ')}.` : 'No consulting or implementation signal was confirmed.', source_artifact_keys: [key] },
    { id: 'openness', label: 'Public professional profile', points: isProfile ? 15 : platform === 'youtube' ? 5 : 0, points_max: 15, evidence: isProfile ? `A public ${platform === 'linkedin' ? 'LinkedIn profile' : 'YouTube channel'} URL was found.` : 'Only a public content URL was found; a creator profile was not confirmed.', source_artifact_keys: [key] },
  ];
  return {
    total: criteria.reduce((sum, criterion) => sum + criterion.points, 0),
    criteria,
    confidence: hermes && consulting.length && isProfile ? 'high' : hermes && (consulting.length || creator.length) ? 'medium' : 'low',
    gaps: [
      'Audience size, follower or subscriber count, and engagement quality were not verified by this search.',
      'Interest, availability, consent, consulting capacity, and commercial fit were not evaluated.',
      ...(platform === 'youtube' ? ['A YouTube result does not establish a matching LinkedIn identity or professional contact channel.'] : []),
    ],
    sourceUpdatedAt: null,
  };
}

export function parseAgentCashCreatorSearch(value: unknown, fetchedAt = new Date()): AgentCashCreatorResult {
  const response = responseSchema.parse(unwrap(value));
  const candidates: AgentCashCreatorCandidate[] = [];
  const artifacts: AgentCashCreatorArtifact[] = [];
  const seen = new Set<string>();
  for (const result of response.results) {
    const profile = creatorProfile(result);
    if (!profile || seen.has(profile.profileUrl)) continue;
    const evidenceText = [result.title, result.author, result.summary, result.text, ...(result.highlights ?? [])]
      .filter((part): part is string => typeof part === 'string').join(' ');
    const lower = evidenceText.toLowerCase();
    if (!(lower.includes('hermes agent') || lower.includes('nous research'))) continue;
    if (!/(consult|advis|implement|deploy|integrat|tutorial|guide|teach|creator|video|course)/iu.test(evidenceText)) continue;
    seen.add(profile.profileUrl);
    const key = sourceKey(profile.platform, profile.profileUrl);
    const published = publishedAt(result.publishedDate);
    const artifact: AgentCashCreatorArtifact = {
      key,
      kind: trustedCreatorUrl(profile.resultUrl)?.profile ? 'creator_profile' : 'creator_content',
      url: profile.resultUrl,
      sourceUpdatedAt: published,
      fetchedAt: fetchedAt.toISOString(),
      content: {
        platform: profile.platform,
        creator_name: displayName(result, profile.platform),
        creator_profile_url: profile.profileUrl,
        result_url: profile.resultUrl,
        title: compact(result.title, 500),
        author: compact(result.author, 300),
        published_at: published,
        summary: publicEvidenceText(result.summary, 2_000),
        highlights: (result.highlights ?? []).map((item) => publicEvidenceText(item, 800)).filter(Boolean).slice(0, 8),
        excerpt: publicEvidenceText(result.text, 2_000),
        search_relevance_score: result.score ?? null,
      },
    };
    artifacts.push(artifact);
    candidates.push({
      sourceKey: key,
      displayName: displayName(result, profile.platform),
      profileUrl: profile.profileUrl,
      priority: priority(evidenceText, key, profile.platform, trustedCreatorUrl(profile.profileUrl)?.profile ?? false, Boolean(published)),
      artifacts: [artifact],
    });
    if (candidates.length >= 5) break;
  }
  return { candidates, artifacts, apiRequestsUsed: 1, rateLimits: [], monetaryCostUsd: 0.01 };
}
