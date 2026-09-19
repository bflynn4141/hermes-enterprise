import { z } from 'zod';
import { partnerSourceMatrixSchema, type PartnerSourceMatrix } from '@hermes/shared';
import type { Env } from '../env.js';

const weightsSchema = z
  .object({
    relevance: z.number().int().min(0).max(100).default(40),
    activity: z.number().int().min(0).max(100).default(25),
    adoption: z.number().int().min(0).max(100).default(20),
    openness: z.number().int().min(0).max(100).default(15),
  })
  .strict()
  .default({ relevance: 40, activity: 25, adoption: 20, openness: 15 })
  .refine((weights) => Object.values(weights).reduce((sum, value) => sum + value, 0) === 100, {
    message: 'ranking weights must total 100',
  });

export const partnerAgentConfigSchema = z
  .object({
    source: z.enum(['github', 'agentcash_people']).default('github'),
    program_name: z.string().min(1).max(120).default('Hermes Partner Program'),
    source_purpose: z.enum(['organization_partner_research', 'person_partner_research']),
    organization_only: z.boolean(),
    no_outreach: z.literal(true),
    role_label: z.string().min(1).max(120),
    search_queries: z.array(z.string().min(1).max(256)).max(3).default([]),
    intake_urls: z.array(z.url().max(2048)).max(10).default([]),
    keywords: z.array(z.string().min(2).max(80)).min(1).max(20),
    ranking_weights: weightsSchema,
    minimum_priority: z.number().int().min(0).max(100).default(50),
    lookback_days: z.number().int().min(1).max(3650).default(365),
    max_candidates: z.number().int().min(1).max(10).default(5),
    max_api_requests: z.number().int().min(1).max(30).default(12),
    minimum_rate_remaining: z.number().int().min(0).max(1000).default(5),
    max_spend_usd: z.number().min(0).max(0.2).default(0),
    people_search: z
      .object({
        current_position_seniority_level: z
          .array(z.enum(['Owner', 'Founder', 'C-level', 'Partner', 'VP', 'Head', 'Director', 'Manager', 'Senior']))
          .max(8)
          .default([]),
        person_skills: z.array(z.string().min(1).max(120)).max(10).default([]),
        current_position_titles: z.array(z.string().min(1).max(120)).max(10).default([]),
        person_locations: z.array(z.string().min(1).max(120)).max(10).default([]),
        // Automation injects the durable page position into the per-run
        // snapshot. Deployment policy may omit both values and starts at the
        // first page. search_after takes precedence when the provider returns
        // one; offset remains the bounded fallback.
        offset: z.number().int().min(0).max(10_000).default(0),
        search_after: z.string().min(1).max(2048).nullable().default(null),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((config) => config.source === 'agentcash_people' || config.search_queries.length > 0 || config.intake_urls.length > 0, {
    message: 'at least one search query or explicit intake URL is required',
  })
  .superRefine((config, context) => {
    if (config.source === 'github') {
      if (config.source_purpose !== 'organization_partner_research' || !config.organization_only) {
        context.addIssue({ code: 'custom', message: 'GitHub discovery must remain organization-only.' });
      }
      if (config.max_spend_usd !== 0) {
        context.addIssue({ code: 'custom', message: 'GitHub discovery must not have a paid-source budget.' });
      }
      return;
    }
    if (config.source_purpose !== 'person_partner_research' || config.organization_only) {
      context.addIssue({ code: 'custom', message: 'AgentCash People Search must use the approved person-research purpose.' });
    }
    if (!config.people_search || [
      config.people_search.current_position_seniority_level,
      config.people_search.person_skills,
      config.people_search.current_position_titles,
      config.people_search.person_locations,
    ].every((values) => values.length === 0)) {
      context.addIssue({ code: 'custom', message: 'AgentCash People Search requires at least one bounded filter.' });
    }
    if (config.search_queries.length > 0 || config.intake_urls.length > 0 || config.max_api_requests !== 1 || config.max_spend_usd !== 0.15) {
      context.addIssue({ code: 'custom', message: 'AgentCash People Search is limited to one $0.15 filtered request.' });
    }
  });
export type PartnerAgentConfig = z.infer<typeof partnerAgentConfigSchema>;

const configMapSchema = z.record(z.uuid(), partnerAgentConfigSchema);

function parsedDefaultConfig(env: Env): PartnerAgentConfig | null {
  const raw = env.PARTNER_SCREENING_DEFAULT_CONFIG_JSON?.trim();
  if (!raw) return null;
  try {
    const parsed = partnerAgentConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parsedConfigMap(env: Env): z.infer<typeof configMapSchema> | null {
  const raw = env.PARTNER_SCREENING_CONFIG_JSON?.trim();
  if (!raw) return null;
  try {
    const parsed = configMapSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Configured agent ids are the scheduler's allowlist; an unknown agent is never auto-run. */
export function partnerScreeningAgentIds(env: Env): string[] {
  return Object.keys(parsedConfigMap(env) ?? {}).sort();
}

export interface ConfigResult {
  readonly config: PartnerAgentConfig | null;
  readonly problem: string | null;
}

/** Parse one agent's non-secret source policy. Source credentials are separate. */
export function partnerAgentConfig(env: Env, agentId: string): ConfigResult {
  const raw = env.PARTNER_SCREENING_CONFIG_JSON?.trim();
  if (!raw) {
    const fallback = parsedDefaultConfig(env);
    return fallback
      ? { config: fallback, problem: null }
      : { config: null, problem: 'Neither an agent-specific nor onboarding partner-screening policy is set.' };
  }
  try {
    const parsed = configMapSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'root'))].slice(0, 5);
      return { config: null, problem: `Partner screening config is invalid at ${paths.join(', ')}.` };
    }
    const config = parsed.data[agentId] ?? parsedDefaultConfig(env);
    if (!config) return { config: null, problem: `No partner screening policy exists for agent ${agentId}.` };
    return { config, problem: null };
  } catch {
    return { config: null, problem: 'PARTNER_SCREENING_CONFIG_JSON is not valid JSON.' };
  }
}

export function partnerSourceMatrix(env: Env, agentId: string, resolved?: ConfigResult): PartnerSourceMatrix {
  const config = resolved ?? partnerAgentConfig(env, agentId);
  const githubAuth = env.PARTNER_GITHUB_TOKEN?.trim() ? 'authenticated' : 'unauthenticated';
  const source = config.config?.source ?? 'github';
  return partnerSourceMatrixSchema.parse({
    agent_id: agentId,
    configured: Boolean(config.config),
    sources: [
      {
        id: 'github',
        state: config.config?.source === 'github' ? 'live' : 'unconfigured',
        authentication: githubAuth,
        note: config.config?.source === 'github'
          ? 'Live official REST API connector for public organizations and repositories. Public email and individual prospect discovery are excluded.'
          : config.config ? 'This agent is configured to use AgentCash People Search instead.' : config.problem,
      },
      {
        id: 'agentcash_people',
        state: config.config?.source === 'agentcash_people' ? 'live' : 'unconfigured',
        authentication: config.config?.source === 'agentcash_people' ? 'authenticated' : 'not_applicable',
        note: config.config?.source === 'agentcash_people'
          ? 'One filtered StableEnrich People Search call per run, capped at $0.15 and imported as sanitized professional evidence.'
          : 'Requires the bounded AgentCash People Search policy and a funded runtime wallet.',
      },
      {
        id: 'youtube',
        state: config.config ? 'live' : 'unconfigured',
        authentication: config.config ? 'wallet' : 'not_applicable',
        note: config.config
          ? 'Explicit-request creator discovery can search public YouTube evidence through one fixed $0.01 AgentCash call; it does not claim subscriber scale or identity matches.'
          : config.problem,
      },
      {
        id: 'x',
        state: config.config ? 'live' : 'unconfigured',
        authentication: config.config ? 'wallet' : 'not_applicable',
        note: config.config
          ? 'Explicit-request creator discovery can search public X posts through one fixed $0.005 AgentCash call; public metrics are point-in-time evidence, not proof of influence or availability.'
          : config.problem,
      },
      {
        id: 'linkedin',
        state: config.config ? 'live' : 'unconfigured',
        authentication: config.config ? 'wallet' : 'not_applicable',
        note: config.config
          ? 'Explicit-request creator discovery can search public LinkedIn evidence through one fixed $0.01 AgentCash call; stored profiles remain prospects and require human review.'
          : config.problem,
      },
    ],
    onboarding_live_search: {
      available: Boolean(config.config),
      endpoint: '/w/:workspace/partner-screening/runs',
      source,
      disclosure: config.config?.source === 'agentcash_people'
        ? 'Onboarding asks Iris to perform one capped AgentCash People Search and stops before outreach or a decision.'
        : config.config
          ? 'Onboarding performs a bounded live search of public GitHub organization evidence and stops before outreach or a decision.'
        : 'Live onboarding search is unavailable until an approved partner-screening policy is configured.',
    },
  });
}

/** Exact non-secret config persisted on a run for reproducible priority scores. */
export function configSnapshot(config: PartnerAgentConfig): Record<string, unknown> {
  return {
    source: config.source,
    program_name: config.program_name,
    source_purpose: config.source_purpose,
    organization_only: config.organization_only,
    no_outreach: config.no_outreach,
    role_label: config.role_label,
    search_queries: config.search_queries,
    intake_urls: config.intake_urls,
    keywords: config.keywords,
    ranking_weights: config.ranking_weights,
    minimum_priority: config.minimum_priority,
    lookback_days: config.lookback_days,
    max_candidates: config.max_candidates,
    max_api_requests: config.max_api_requests,
    minimum_rate_remaining: config.minimum_rate_remaining,
    max_spend_usd: config.max_spend_usd,
    people_search: config.people_search,
  };
}
