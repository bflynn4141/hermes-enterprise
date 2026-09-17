import { z } from 'zod';
import type { PartnerAgentConfig } from './config.js';
import type { DiscoveryPriority, DiscoveryPriorityCriterion } from './score.js';

export const AGENTCASH_PEOPLE_SEARCH_URL = 'https://stableenrich.dev/api/fullenrich/people-search' as const;

const professionalNetworkSchema = z.object({
  url: z.string().optional(),
  handle: z.string().optional(),
}).passthrough();
const currentEmploymentSchema = z.object({
  title: z.string().optional(),
  seniority: z.string().optional(),
  company_id: z.string().optional(),
  description: z.string().optional(),
}).passthrough();
const personSchema = z.object({
  id: z.union([z.string(), z.number()]),
  full_name: z.string().min(1).max(200),
  headline: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  location: z.unknown().optional(),
  skills: z.array(z.string()).max(200).optional(),
  social_profiles: z.object({ professional_network: professionalNetworkSchema.optional() }).passthrough().optional(),
  employment: z.object({
    current: z.union([currentEmploymentSchema, z.array(currentEmploymentSchema)]).optional(),
  }).passthrough().optional(),
}).passthrough();
const companySchema = z.object({
  id: z.string().optional(),
  name: z.string().max(200).optional(),
  domain: z.string().max(253).optional(),
  description: z.string().max(2000).optional(),
  headcount: z.number().int().min(0).optional(),
  headcount_range: z.string().max(80).optional(),
  company_type: z.string().max(120).optional(),
  specialties: z.array(z.string()).max(50).optional(),
  industry: z.object({ main_industry: z.string().max(160).optional() }).passthrough().optional(),
}).passthrough();
const responseSchema = z.object({
  people: z.array(personSchema).max(100),
  companies: z.record(z.string(), companySchema).default({}),
  metadata: z.object({
    total: z.number().optional(),
    credits: z.number().optional(),
    offset: z.number().optional(),
    search_after: z.string().nullable().optional(),
  }).passthrough().default({}),
}).passthrough();

export interface AgentCashPeopleArtifact {
  readonly key: string;
  readonly kind: 'person_profile';
  readonly url: string;
  readonly sourceUpdatedAt: null;
  readonly fetchedAt: string;
  readonly content: Record<string, unknown>;
}

export interface AgentCashPersonCandidate {
  readonly sourceKey: string;
  readonly displayName: string;
  readonly profileUrl: string;
  readonly priority: DiscoveryPriority;
  readonly artifacts: readonly AgentCashPeopleArtifact[];
}

export interface AgentCashPeopleResult {
  readonly candidates: readonly AgentCashPersonCandidate[];
  readonly artifacts: readonly AgentCashPeopleArtifact[];
  readonly apiRequestsUsed: 1;
  readonly rateLimits: readonly [];
  readonly monetaryCostUsd: 0 | 0.15;
}

function peopleConfig(config: PartnerAgentConfig) {
  if (config.source !== 'agentcash_people' || !config.people_search) {
    throw new Error('AgentCash People Search policy is not configured.');
  }
  return config.people_search;
}

export function agentCashPeopleSearchArguments(config: PartnerAgentConfig): {
  url: typeof AGENTCASH_PEOPLE_SEARCH_URL;
  method: 'POST';
  maxAmount: 0.15;
  body: Record<string, unknown>;
} {
  const policy = peopleConfig(config);
  const body: Record<string, unknown> = {};
  if (policy.current_position_seniority_level.length) body.current_position_seniority_level = policy.current_position_seniority_level;
  if (policy.person_skills.length) body.person_skills = policy.person_skills;
  if (policy.current_position_titles.length) body.current_position_titles = policy.current_position_titles;
  if (policy.person_locations.length) body.person_locations = policy.person_locations;
  Object.assign(body, {
    excludeFields: ['educations', 'languages'],
    include_employment_history: false,
    verbose: false,
    offset: 0,
  });
  return { url: AGENTCASH_PEOPLE_SEARCH_URL, method: 'POST', maxAmount: 0.15, body };
}

function unwrap(value: unknown, depth = 0): unknown {
  if (depth > 5) return value;
  if (typeof value === 'string') {
    try { return unwrap(JSON.parse(value), depth + 1); } catch { return value; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.people)) return object;
  if (Array.isArray(object.content)) {
    for (const item of object.content) {
      if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string') {
        const candidate = unwrap((item as Record<string, unknown>).text, depth + 1);
        if (candidate && typeof candidate === 'object' && Array.isArray((candidate as Record<string, unknown>).people)) return candidate;
      }
    }
  }
  for (const key of ['data', 'body', 'result', 'response']) {
    if (key in object) {
      const candidate = unwrap(object[key], depth + 1);
      if (candidate && typeof candidate === 'object' && Array.isArray((candidate as Record<string, unknown>).people)) return candidate;
    }
  }
  return value;
}

function linkedInProfile(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['linkedin.com', 'www.linkedin.com'].includes(url.hostname.toLowerCase()) || !url.pathname.startsWith('/in/')) return null;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch { return null; }
}

function locationText(value: unknown): string | null {
  if (typeof value === 'string') return value.slice(0, 300);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const parts = ['city', 'region', 'country'].flatMap((key) => typeof record[key] === 'string' ? [record[key] as string] : []);
  return parts.length ? parts.join(', ').slice(0, 300) : null;
}

function currentEmployment(person: z.infer<typeof personSchema>): z.infer<typeof currentEmploymentSchema> | null {
  const current = person.employment?.current;
  return Array.isArray(current) ? current[0] ?? null : current ?? null;
}

const weighted = (matched: boolean, maximum: number): number => matched ? maximum : 0;

function priority(person: z.infer<typeof personSchema>, config: PartnerAgentConfig, companyName: string | null): DiscoveryPriority {
  const policy = peopleConfig(config);
  const current = currentEmployment(person);
  const skills = (person.skills ?? []).map((skill) => skill.toLowerCase());
  const text = [person.full_name, person.headline, person.description, current?.title, current?.seniority, current?.description, companyName, ...skills]
    .filter((value): value is string => Boolean(value)).join(' ').toLowerCase();
  const terms = [...config.keywords, ...policy.person_skills, ...policy.current_position_titles];
  const uniqueTerms = [...new Set(terms.map((term) => term.toLowerCase()))];
  const matches = [...new Set(terms.filter((term) => text.includes(term.toLowerCase())))];
  const relevancePoints = uniqueTerms.length ? Math.round((matches.length / uniqueTerms.length) * config.ranking_weights.relevance) : 0;
  const seniorityMatched = Boolean(current?.seniority && policy.current_position_seniority_level.some((value) => value.toLowerCase() === current.seniority?.toLowerCase()));
  const profile = linkedInProfile(person.social_profiles?.professional_network?.url);
  const key = `person:${String(person.id)}`;
  const criteria: DiscoveryPriorityCriterion[] = [
    { id: 'relevance', label: 'Configured role and skill relevance', points: Math.min(config.ranking_weights.relevance, relevancePoints), points_max: config.ranking_weights.relevance, evidence: matches.length ? `Matched configured terms: ${matches.join(', ')}.` : 'No configured role or skill term matched the returned public profile.', source_artifact_keys: [key] },
    { id: 'activity', label: 'Current professional role present', points: weighted(Boolean(current?.title), config.ranking_weights.activity), points_max: config.ranking_weights.activity, evidence: current?.title ? `Current role returned as ${current.title}.` : 'The response did not include a current role.', source_artifact_keys: [key] },
    { id: 'adoption', label: 'Configured seniority match', points: weighted(seniorityMatched, config.ranking_weights.adoption), points_max: config.ranking_weights.adoption, evidence: seniorityMatched ? `Current seniority matched ${current?.seniority}.` : 'Current seniority did not match the configured filter list.', source_artifact_keys: [key] },
    { id: 'openness', label: 'Verifiable professional profile', points: weighted(Boolean(profile), config.ranking_weights.openness), points_max: config.ranking_weights.openness, evidence: profile ? 'A public LinkedIn profile URL was returned.' : 'No usable public LinkedIn profile URL was returned.', source_artifact_keys: [key] },
  ];
  const gaps = [
    ...(!current?.title ? ['Current role was not returned.'] : []),
    ...(!companyName ? ['Current company details were not returned.'] : []),
    'Interest, availability, consent, and contact details were not evaluated.',
  ];
  return { total: criteria.reduce((sum, criterion) => sum + criterion.points, 0), criteria, confidence: current?.title && skills.length > 0 ? 'high' : current?.title ? 'medium' : 'low', gaps, sourceUpdatedAt: null };
}

export function parseAgentCashPeopleSearch(value: unknown, config: PartnerAgentConfig, fetchedAt = new Date()): AgentCashPeopleResult {
  const response = responseSchema.parse(unwrap(value));
  const artifacts: AgentCashPeopleArtifact[] = [];
  const candidates: AgentCashPersonCandidate[] = [];
  for (const person of response.people.slice(0, config.max_candidates)) {
    const profileUrl = linkedInProfile(person.social_profiles?.professional_network?.url);
    if (!profileUrl) continue;
    const current = currentEmployment(person);
    const company = current?.company_id ? response.companies[current.company_id] : undefined;
    const key = `person:${String(person.id)}`;
    const artifact: AgentCashPeopleArtifact = {
      key, kind: 'person_profile', url: profileUrl, sourceUpdatedAt: null, fetchedAt: fetchedAt.toISOString(),
      content: {
        id: String(person.id), full_name: person.full_name, headline: person.headline ?? null,
        description: person.description ?? null, location: locationText(person.location),
        skills: (person.skills ?? []).slice(0, 50),
        professional_profile: { url: profileUrl, handle: person.social_profiles?.professional_network?.handle?.slice(0, 120) ?? null },
        current_employment: current ? { title: current.title?.slice(0, 200) ?? null, seniority: current.seniority?.slice(0, 120) ?? null, description: current.description?.slice(0, 2000) ?? null, company_id: current.company_id ?? null } : null,
        company: company ? { id: company.id ?? current?.company_id ?? null, name: company.name ?? null, domain: company.domain ?? null, description: company.description ?? null, headcount: company.headcount ?? null, headcount_range: company.headcount_range ?? null, company_type: company.company_type ?? null, specialties: (company.specialties ?? []).slice(0, 30), industry: company.industry?.main_industry ?? null } : null,
      },
    };
    artifacts.push(artifact);
    candidates.push({ sourceKey: String(person.id), displayName: person.full_name, profileUrl, priority: priority(person, config, company?.name ?? null), artifacts: [artifact] });
  }
  if (response.people.length > 0 && candidates.length === 0) throw new Error('AgentCash returned no usable people with a trustworthy professional profile URL.');
  return { candidates, artifacts, apiRequestsUsed: 1, rateLimits: [], monetaryCostUsd: response.people.length > 0 ? 0.15 : 0 };
}
