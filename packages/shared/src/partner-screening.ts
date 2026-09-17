import { z } from 'zod';
import { uuidSchema } from './events.js';

export const partnerScreeningStartInputSchema = z
  .object({
    agent_id: uuidSchema,
    idempotency_key: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  })
  .strict();
export type PartnerScreeningStartInput = z.infer<typeof partnerScreeningStartInputSchema>;

export const partnerPriorityCriterionSchema = z
  .object({
    id: z.enum(['relevance', 'activity', 'adoption', 'openness']),
    label: z.string().min(1).max(120),
    points: z.number().int().min(0).max(100),
    points_max: z.number().int().min(1).max(100),
    evidence: z.string().max(1000),
    source_artifact_ids: z.array(uuidSchema).max(20),
  })
  .strict();

export const partnerCandidateSummarySchema = z
  .object({
    id: uuidSchema,
    source: z.enum(['github', 'agentcash_people']),
    source_key: z.string().min(1).max(200),
    display_name: z.string().min(1).max(200),
    profile_url: z.url().max(2048),
    deterministic_priority: z.number().int().min(0).max(100),
    priority_max: z.literal(100),
    confidence: z.enum(['high', 'medium', 'low']),
    evidence_gaps: z.array(z.string().min(1).max(300)).max(20),
    source_updated_at: z.iso.datetime({ offset: true }).nullable(),
    last_seen_at: z.iso.datetime({ offset: true }),
    existing_request_id: uuidSchema.nullable(),
  })
  .strict();
export type PartnerCandidateSummary = z.infer<typeof partnerCandidateSummarySchema>;

const rateLimitSchema = z
  .object({
    resource: z.string().min(1).max(64),
    limit: z.number().int().min(0).nullable(),
    remaining: z.number().int().min(0).nullable(),
    reset_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export const partnerScreeningSnapshotSchema = z
  .object({
    run: z
      .object({
        id: uuidSchema,
        agent_id: uuidSchema,
        status: z.enum(['running', 'completed', 'failed']),
        mode: z.literal('live'),
        source: z.enum(['github', 'agentcash_people']),
        authentication: z.enum(['authenticated', 'unauthenticated', 'wallet']),
        started_at: z.iso.datetime({ offset: true }),
        completed_at: z.iso.datetime({ offset: true }).nullable(),
        error_code: z.string().max(100).nullable(),
        error_detail: z.string().max(500).nullable(),
      })
      .strict(),
    budget: z
      .object({
        api_requests_used: z.number().int().min(0),
        api_requests_max: z.number().int().min(1).max(30),
        monetary_cost_usd: z.number().min(0).max(0.2),
      })
      .strict(),
    rate_limits: z.array(rateLimitSchema).max(10),
    ranking: z
      .object({
        kind: z.literal('deterministic_discovery_priority'),
        note: z.literal('This is connector-side triage, not an Iris or Hermes decision.'),
        weights: z.record(z.string(), z.number().int().min(0).max(100)),
        minimum_priority: z.number().int().min(0).max(100),
      })
      .strict(),
    candidates: z.array(partnerCandidateSummarySchema).max(10),
    handoff: z
      .object({
        kind: z.literal('ask_iris_to_screen'),
        prompt: z.string().min(1).max(2000),
        candidate_ids: z.array(uuidSchema).max(10),
        agent_run: z.object({
          id: uuidSchema,
          session_id: uuidSchema,
          status: z.enum(['working', 'waiting', 'stopping', 'stopped', 'error', 'completed']),
        }).strict().nullable(),
      })
      .strict(),
    disclosure: z.enum([
      'Public organization evidence was fetched through the official GitHub REST API. No person was contacted and no application, admission, message, payment, signature, or external write was performed.',
      'Public professional evidence was fetched through AgentCash People Search using one capped wallet payment. No person was contacted and no application, admission, message, signature, or other external write was performed.',
    ]),
  })
  .strict();
export type PartnerScreeningSnapshot = z.infer<typeof partnerScreeningSnapshotSchema>;

export const partnerSourceMatrixSchema = z
  .object({
    agent_id: uuidSchema,
    configured: z.boolean(),
    sources: z.array(
      z.object({
        id: z.enum(['github', 'agentcash_people', 'youtube', 'x', 'linkedin']),
        state: z.enum(['live', 'unconfigured', 'unsupported_policy']),
        authentication: z.enum(['authenticated', 'unauthenticated', 'not_applicable']),
        note: z.string().max(500),
      }).strict(),
    ).length(5),
    onboarding_live_search: z
      .object({
        available: z.boolean(),
        endpoint: z.literal('/w/:workspace/partner-screening/runs'),
        source: z.enum(['github', 'agentcash_people']),
        disclosure: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();
export type PartnerSourceMatrix = z.infer<typeof partnerSourceMatrixSchema>;
