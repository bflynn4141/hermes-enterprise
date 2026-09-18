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

export const AGENTCASH_X_CREATOR_SEARCH_URL =
  'https://fetcher.sh/api/twitter/search?query=%22Hermes%20Agent%22&sort=Top' as const;
export const AGENTCASH_X_CREATOR_SEARCH_ARGUMENTS = {
  url: AGENTCASH_X_CREATOR_SEARCH_URL,
  method: 'GET' as const,
  maxAmount: 0.005 as const,
} as const;

export type AgentCashCreatorSearchKind = 'linkedin_youtube' | 'x';

const ACTION_INTENT = /\b(?:search|find|discover|identify|look\s*up|run|test)\b/iu;
const CREATOR_INTENT = /\b(?:consult(?:ants?|ing)?|influenc(?:er|ers)?|creators?|teachers?|tutorials?|implement(?:ers?|ations?)?)\b/iu;

/** Paid creator discovery is only attached to an explicit, imperative user request. */
export function requestedCreatorSearchKinds(prompt: string | null | undefined): readonly AgentCashCreatorSearchKind[] {
  const value = prompt ?? '';
  if (!/\bhermes\b/iu.test(value) || !ACTION_INTENT.test(value) || !CREATOR_INTENT.test(value)) return [];
  const kinds: AgentCashCreatorSearchKind[] = [];
  if (/\b(?:linkedin|youtube)\b/iu.test(value)) kinds.push('linkedin_youtube');
  if (/\b(?:x|twitter)\b/iu.test(value)) kinds.push('x');
  return kinds;
}

/**
 * The native runtime receives the exact governed call instead of being asked
 * to rediscover a hidden constant from natural language. The original user
 * text remains first and is still the authority checked by the Worker lease.
 */
export function governedCreatorSearchInput(prompt: string): string {
  const kinds = requestedCreatorSearchKinds(prompt);
  if (kinds.length === 0) return prompt;
  const calls = kinds.map((kind, index) => {
    const argumentsValue = kind === 'x'
      ? AGENTCASH_X_CREATOR_SEARCH_ARGUMENTS
      : AGENTCASH_CREATOR_SEARCH_ARGUMENTS;
    const label = kind === 'x' ? 'X/Twitter public-post search' : 'LinkedIn/YouTube public creator search';
    return `${index + 1}. For the ${label}, call mcp__agentcash__fetch exactly once with ${JSON.stringify(argumentsValue)}.`;
  });
  return `${prompt}\n\nGoverned enterprise procedure (required):\n${calls.join('\n')}\nAfter each paid call, use list_partner_candidates and get_partner_candidate to inspect only imported evidence. Report a channel as empty when it imports no candidate. Do not substitute another source, repeat a paid call, contact anyone, or create/send a message.`;
}

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

const xAuthorSchema = z.object({
  userName: z.string().min(1).max(100),
  url: z.string().url().max(2048),
  name: z.string().min(1).max(300),
  description: z.string().max(5_000).optional(),
  followers: z.number().int().nonnegative().optional(),
  following: z.number().int().nonnegative().optional(),
  isVerified: z.boolean().optional(),
  isBlueVerified: z.boolean().optional(),
  professional: z.object({
    professional_type: z.string().max(100).optional(),
    category: z.array(z.object({ name: z.string().max(200).optional() }).passthrough()).max(20).optional(),
  }).passthrough().optional(),
}).passthrough();

const xTweetSchema = z.object({
  id: z.string().min(1).max(100),
  url: z.string().url().max(2048),
  text: z.string().max(20_000).optional(),
  fullText: z.string().max(20_000).optional(),
  createdAt: z.string().max(200).optional(),
  lang: z.string().max(30).optional(),
  retweetCount: z.number().int().nonnegative().optional(),
  replyCount: z.number().int().nonnegative().optional(),
  likeCount: z.number().int().nonnegative().optional(),
  quoteCount: z.number().int().nonnegative().optional(),
  viewCount: z.number().int().nonnegative().optional(),
  author: xAuthorSchema,
}).passthrough();

const xResponseSchema = z.object({ tweets: z.array(xTweetSchema).max(100) }).passthrough();

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
  readonly monetaryCostUsd: 0.01 | 0.005;
}

type CreatorPlatform = 'linkedin' | 'youtube' | 'x';

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

function unwrapTweets(value: unknown, depth = 0): unknown {
  if (depth > 7) return value;
  if (typeof value === 'string') {
    try { return unwrapTweets(JSON.parse(value), depth + 1); } catch {
      for (const line of value.split(/\r?\n/u)) {
        if (!line.trim()) continue;
        try {
          const parsed = unwrapTweets(JSON.parse(line), depth + 1);
          if (object(parsed) && Array.isArray(parsed.tweets)) return parsed;
        } catch { /* AgentCash may append payment metadata as another JSON line. */ }
      }
      return value;
    }
  }
  if (!object(value)) return value;
  if (Array.isArray(value.tweets)) return value;
  if (object(value.data) && Array.isArray(value.data.tweets)) return value.data;
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (!object(item) || typeof item.text !== 'string') continue;
      const parsed = unwrapTweets(item.text, depth + 1);
      if (object(parsed) && Array.isArray(parsed.tweets)) return parsed;
    }
  }
  for (const key of ['data', 'body', 'result', 'response']) {
    if (!(key in value)) continue;
    const parsed = unwrapTweets(value[key], depth + 1);
    if (object(parsed) && Array.isArray(parsed.tweets)) return parsed;
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

function sourceKey(platform: CreatorPlatform, profileUrl: string): string {
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
  platform: CreatorPlatform,
  isProfile: boolean,
  hasPublishedDate: boolean,
  audienceVerified = false,
): DiscoveryPriority {
  const lower = text.toLowerCase();
  const hermes = lower.includes('hermes agent') || lower.includes('nous research');
  const consultingTerms = ['consultant', 'consulting', 'advisor', 'advisory', 'implement', 'deployment', 'integration', 'build', 'managed'];
  const creatorTerms = ['creator', 'tutorial', 'guide', 'course', 'video', 'post', 'teach', 'youtube', 'covering'];
  const consulting = consultingTerms.filter((term) => lower.includes(term));
  const creator = creatorTerms.filter((term) => lower.includes(term));
  const criteria: DiscoveryPriorityCriterion[] = [
    { id: 'relevance', label: 'Hermes Agent relevance', points: hermes ? 40 : 0, points_max: 40, evidence: hermes ? 'The indexed public result names Hermes Agent or Nous Research.' : 'The stored result did not clearly name Hermes Agent or Nous Research.', source_artifact_keys: [key] },
    { id: 'activity', label: 'Published creator activity', points: creator.length || hasPublishedDate ? 25 : 0, points_max: 25, evidence: creator.length ? `Creator signals in the result: ${creator.join(', ')}.` : hasPublishedDate ? 'The indexed result includes a publication date.' : 'No creator-activity signal was confirmed.', source_artifact_keys: [key] },
    { id: 'adoption', label: 'Consulting or implementation signal', points: consulting.length ? 20 : 0, points_max: 20, evidence: consulting.length ? `Consulting signals in the result: ${consulting.join(', ')}.` : 'No consulting or implementation signal was confirmed.', source_artifact_keys: [key] },
    { id: 'openness', label: 'Public professional profile', points: isProfile ? 15 : platform === 'youtube' ? 5 : 0, points_max: 15, evidence: isProfile ? `A public ${platform === 'linkedin' ? 'LinkedIn profile' : platform === 'youtube' ? 'YouTube channel' : 'X profile'} URL was found.` : 'Only a public content URL was found; a creator profile was not confirmed.', source_artifact_keys: [key] },
  ];
  return {
    total: criteria.reduce((sum, criterion) => sum + criterion.points, 0),
    criteria,
    confidence: hermes && consulting.length && isProfile ? 'high' : hermes && (consulting.length || creator.length) ? 'medium' : 'low',
    gaps: [
      audienceVerified
        ? 'Follower count is a point-in-time public metric and does not establish engagement quality or influence.'
        : 'Audience size, follower or subscriber count, and engagement quality were not verified by this search.',
      'Interest, availability, consent, consulting capacity, and commercial fit were not evaluated.',
      ...(platform === 'youtube' ? ['A YouTube result does not establish a matching LinkedIn identity or professional contact channel.'] : []),
      ...(platform === 'x' ? ['An X result does not establish a matching LinkedIn identity, professional email, availability, or consent.'] : []),
    ],
    sourceUpdatedAt: null,
  };
}

function trustedXUrl(value: string, kind: 'profile' | 'post'): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (!/^[A-Za-z0-9_]{1,30}$/u.test(parts[0] ?? '')) return null;
    if (kind === 'profile' && parts.length !== 1) return null;
    if (kind === 'post' && (parts.length !== 3 || parts[1] !== 'status' || !/^\d{1,30}$/u.test(parts[2] ?? ''))) return null;
    return `https://x.com/${parts.join('/')}`;
  } catch { return null; }
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

/** Parse one paid public X search without retaining payment metadata or private/contact fields. */
export function parseAgentCashXCreatorSearch(value: unknown, fetchedAt = new Date()): AgentCashCreatorResult {
  const response = xResponseSchema.parse(unwrapTweets(value));
  const candidates: AgentCashCreatorCandidate[] = [];
  const artifacts: AgentCashCreatorArtifact[] = [];
  const seen = new Set<string>();
  for (const tweet of response.tweets) {
    const profileUrl = trustedXUrl(tweet.author.url, 'profile');
    const resultUrl = trustedXUrl(tweet.url, 'post');
    if (!profileUrl || !resultUrl || seen.has(profileUrl)) continue;
    const evidenceText = [tweet.fullText, tweet.text, tweet.author.description,
      tweet.author.professional?.professional_type,
      ...(tweet.author.professional?.category ?? []).map((item) => item.name)]
      .filter((part): part is string => typeof part === 'string').join(' ');
    const lower = evidenceText.toLowerCase();
    if (!(lower.includes('hermes agent') || lower.includes('nous research'))) continue;
    seen.add(profileUrl);
    const key = sourceKey('x', profileUrl);
    const published = publishedAt(tweet.createdAt);
    const followerCount = tweet.author.followers ?? null;
    const artifact: AgentCashCreatorArtifact = {
      key,
      kind: 'creator_content',
      url: resultUrl,
      sourceUpdatedAt: published,
      fetchedAt: fetchedAt.toISOString(),
      content: {
        platform: 'x',
        creator_name: compact(tweet.author.name, 200),
        creator_profile_url: profileUrl,
        handle: compact(tweet.author.userName, 100),
        result_url: resultUrl,
        published_at: published,
        language: compact(tweet.lang, 30),
        excerpt: publicEvidenceText(tweet.fullText ?? tweet.text, 2_000),
        public_bio: publicEvidenceText(tweet.author.description, 1_000),
        is_verified: tweet.author.isVerified === true || tweet.author.isBlueVerified === true,
        followers: followerCount,
        following: tweet.author.following ?? null,
        public_engagement: {
          likes: tweet.likeCount ?? null,
          replies: tweet.replyCount ?? null,
          reposts: tweet.retweetCount ?? null,
          quotes: tweet.quoteCount ?? null,
          views: tweet.viewCount ?? null,
        },
      },
    };
    artifacts.push(artifact);
    candidates.push({
      sourceKey: key,
      displayName: compact(tweet.author.name, 200) ?? tweet.author.userName,
      profileUrl,
      priority: priority(evidenceText, key, 'x', true, Boolean(published), followerCount !== null),
      artifacts: [artifact],
    });
    if (candidates.length >= 5) break;
  }
  return { candidates, artifacts, apiRequestsUsed: 1, rateLimits: [], monetaryCostUsd: 0.005 };
}
