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
    program_name: z.string().min(1).max(120).default('Hermes Partner Program'),
    source_purpose: z.literal('organization_partner_research'),
    organization_only: z.literal(true),
    no_outreach: z.literal(true),
    role_label: z.string().min(1).max(120),
    search_queries: z.array(z.string().min(1).max(256)).max(3).default([]),
    intake_urls: z.array(z.url().max(2048)).max(10).default([]),
    keywords: z.array(z.string().min(2).max(80)).min(1).max(20),
    ranking_weights: weightsSchema,
    minimum_priority: z.number().int().min(0).max(100).default(50),
    lookback_days: z.number().int().min(1).max(3650).default(365),
    max_candidates: z.number().int().min(1).max(10).default(5),
    max_api_requests: z.number().int().min(3).max(30).default(12),
    minimum_rate_remaining: z.number().int().min(0).max(1000).default(5),
  })
  .strict()
  .refine((config) => config.search_queries.length > 0 || config.intake_urls.length > 0, {
    message: 'at least one search query or explicit intake URL is required',
  });
export type PartnerAgentConfig = z.infer<typeof partnerAgentConfigSchema>;

const configMapSchema = z.record(z.string(), partnerAgentConfigSchema);

export interface ConfigResult {
  readonly config: PartnerAgentConfig | null;
  readonly problem: string | null;
}

/** Parse one agent's non-secret source policy. Source credentials are separate. */
export function partnerAgentConfig(env: Env, agentId: string): ConfigResult {
  const raw = env.PARTNER_SCREENING_CONFIG_JSON?.trim();
  if (!raw) return { config: null, problem: 'PARTNER_SCREENING_CONFIG_JSON is not set.' };
  try {
    const parsed = configMapSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || 'root'))].slice(0, 5);
      return { config: null, problem: `Partner screening config is invalid at ${paths.join(', ')}.` };
    }
    const config = parsed.data[agentId];
    if (!config) return { config: null, problem: `No partner screening config exists for agent ${agentId}.` };
    return { config, problem: null };
  } catch {
    return { config: null, problem: 'PARTNER_SCREENING_CONFIG_JSON is not valid JSON.' };
  }
}

export function partnerSourceMatrix(env: Env, agentId: string): PartnerSourceMatrix {
  const config = partnerAgentConfig(env, agentId);
  const githubAuth = env.PARTNER_GITHUB_TOKEN?.trim() ? 'authenticated' : 'unauthenticated';
  return partnerSourceMatrixSchema.parse({
    agent_id: agentId,
    configured: Boolean(config.config),
    sources: [
      {
        id: 'github',
        state: config.config ? 'live' : 'unconfigured',
        authentication: githubAuth,
        note: config.config
          ? 'Live official REST API connector for public organizations and repositories. Public email and individual prospect discovery are excluded.'
          : config.problem,
      },
      {
        id: 'youtube',
        state: 'unconfigured',
        authentication: env.PARTNER_YOUTUBE_API_KEY?.trim() ? 'authenticated' : 'not_applicable',
        note: 'Requires a Google Cloud project/API key and a separate approved connector. No YouTube calls are made by this build.',
      },
      {
        id: 'x',
        state: 'unconfigured',
        authentication: env.PARTNER_X_BEARER_TOKEN?.trim() ? 'authenticated' : 'not_applicable',
        note: 'Requires an approved X developer app, bearer token, and pay-per-use budget. No X calls are made by this build.',
      },
      {
        id: 'linkedin',
        state: 'unsupported_policy',
        authentication: 'not_applicable',
        note: 'LinkedIn member prospect discovery is not supported. Applicant-supplied URLs may be treated only as explicit references under an approved integration.',
      },
    ],
    simulation_fallback: {
      available: true,
      endpoint: `/w/:workspace/onboarding/sample-runs`,
      disclosure: 'The existing onboarding simulation remains separately labeled and never appears as live evidence.',
    },
  });
}

/** Exact non-secret config persisted on a run for reproducible priority scores. */
export function configSnapshot(config: PartnerAgentConfig): Record<string, unknown> {
  return {
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
  };
}
