import { z } from 'zod';
import { uuidSchema } from './events.js';

const shortText = z.string().trim().min(1).max(200);
const bodyText = z.string().trim().min(1).max(4_000);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const dateTimeSchema = z.iso.datetime({ offset: true });

export const sharedIntelligenceTeamSchema = z.object({
  id: uuidSchema,
  slug: z.enum(['partnerships', 'finance']),
  name: z.enum(['Partnerships', 'Finance']),
}).strict();
export type SharedIntelligenceTeam = z.infer<typeof sharedIntelligenceTeamSchema>;

export const sharedIntelligenceRunSchema = z.object({
  id: uuidSchema,
  agent_id: uuidSchema,
  agent_name: shortText,
  session_id: uuidSchema,
  session_title: shortText,
  ended_at: dateTimeSchema,
  model_id: z.string().max(100),
  active_ms: z.number().int().min(0),
  tool_names: z.array(z.string().max(64)).max(40),
  step_labels: z.array(z.string().max(160)).max(50),
  output_preview: z.string().max(1_000),
}).strict();
export type SharedIntelligenceRun = z.infer<typeof sharedIntelligenceRunSchema>;

export const sharedIntelligenceDiscoverySchema = z.object({
  id: sha256Schema,
  suggested_title: shortText,
  suggested_goal: z.string().trim().min(1).max(1_000),
  suggested_lesson: bodyText,
  suggested_rationale: bodyText,
  source_run_ids: z.array(uuidSchema).min(1).max(5),
  approved_excerpts: z.array(z.object({
    run_id: uuidSchema,
    approved_excerpt: z.string().trim().min(1).max(1_000),
    provenance: z.literal('verified_quote'),
  }).strict()).min(1).max(5),
  evidence_strength: z.literal('unassessed'),
  warnings: z.array(z.string().max(300)).max(10),
}).strict();
export type SharedIntelligenceDiscovery = z.infer<typeof sharedIntelligenceDiscoverySchema>;

export const sharedIntelligenceAxisSchema = z.object({
  score: z.number().min(0).max(3),
  confidence: z.number().min(0).max(1),
}).strict();

export const sharedIntelligenceAssessmentSchema = z.object({
  status: z.enum(['complete', 'unavailable', 'failed']),
  composite_score: z.number().min(0).max(100).nullable(),
  route: z.enum(['standard_review', 'heightened_review', 'unavailable']),
  axes: z.object({
    usefulness: sharedIntelligenceAxisSchema,
    novelty: sharedIntelligenceAxisSchema,
    corroboration: sharedIntelligenceAxisSchema,
    urgency: sharedIntelligenceAxisSchema,
    uncertainty: sharedIntelligenceAxisSchema,
  }).strict().nullable(),
  evidence_count: z.number().int().min(0).max(5),
  rubric_version: z.string().max(32),
  model_id: z.string().max(100),
  model_version: z.string().max(100).nullable(),
  state_sha256: sha256Schema,
  latency_ms: z.number().int().min(0).nullable(),
  failure_class: z.string().max(100).nullable(),
  warnings: z.array(z.string().max(300)).max(10),
}).strict();
export type SharedIntelligenceAssessment = z.infer<typeof sharedIntelligenceAssessmentSchema>;

export const sharedIntelligenceTriageStatusSchema = z.enum(['private', 'queued', 'included', 'excluded']);
export type SharedIntelligenceTriageStatus = z.infer<typeof sharedIntelligenceTriageStatusSchema>;

export const sharedIntelligenceGoalSchema = z.object({
  id: uuidSchema,
  scope: z.enum(['workspace', 'team']),
  team_id: uuidSchema.nullable(),
  team_name: shortText.nullable(),
  title: shortText,
  detail: z.string().trim().min(1).max(1_000),
  revision: z.number().int().min(1),
  content_sha256: sha256Schema,
  active: z.boolean(),
  created_at: dateTimeSchema,
}).strict();
export type SharedIntelligenceGoal = z.infer<typeof sharedIntelligenceGoalSchema>;

export const sharedIntelligenceTriageReasonSchema = z.enum([
  'goal_aligned',
  'high_impact',
  'novel_signal',
  'corroborated',
  'urgent',
  'high_uncertainty',
  'sensitivity_review',
  'single_source',
  'low_goal_fit',
  'low_confidence',
]);

export const sharedIntelligenceTriageAssessmentSchema = z.object({
  status: z.enum(['complete', 'unavailable', 'failed']),
  priority_score: z.number().min(0).max(100).nullable(),
  recommendation: z.enum(['include', 'review', 'exclude', 'unavailable']),
  confidence: z.number().min(0).max(1).nullable(),
  axes: z.object({
    relevance: sharedIntelligenceAxisSchema,
    impact: sharedIntelligenceAxisSchema,
    novelty: sharedIntelligenceAxisSchema,
    corroboration: sharedIntelligenceAxisSchema,
    urgency: sharedIntelligenceAxisSchema,
    uncertainty: sharedIntelligenceAxisSchema,
    sensitivity: sharedIntelligenceAxisSchema,
  }).strict().nullable(),
  reason_codes: z.array(sharedIntelligenceTriageReasonSchema).max(10),
  goal_snapshot: sharedIntelligenceGoalSchema,
  comparison_snapshot: z.array(z.object({
    source_id: uuidSchema,
    version_id: uuidSchema,
    version_sha256: sha256Schema,
    presentation_sha256: sha256Schema,
  }).strict()).max(100),
  evidence_count: z.number().int().min(0).max(5),
  rubric_version: z.string().max(32),
  model_id: z.string().max(100),
  model_version: z.string().max(100).nullable(),
  state_sha256: sha256Schema,
  latency_ms: z.number().int().min(0).nullable(),
  failure_class: z.string().max(100).nullable(),
  assessed_at: dateTimeSchema,
  warnings: z.array(z.string().max(300)).max(10),
}).strict();
export type SharedIntelligenceTriageAssessment = z.infer<typeof sharedIntelligenceTriageAssessmentSchema>;

export const sharedIntelligenceEvidenceSchema = z.object({
  id: uuidSchema,
  run_id: uuidSchema.nullable(),
  session_id: uuidSchema.nullable(),
  source_message_id: uuidSchema,
  source_message_role: z.enum(['user', 'iris']),
  session_title: shortText,
  run_ended_at: dateTimeSchema,
  source_sha256: sha256Schema,
  approved_excerpt: z.string().min(1).max(1_000),
  excerpt_sha256: sha256Schema,
  provenance: z.literal('verified_quote'),
  tool_names: z.array(z.string().max(64)).max(40),
  step_labels: z.array(z.string().max(160)).max(50),
  outcome: z.literal('runtime_completed'),
  revoked_at: dateTimeSchema.nullable(),
}).strict();
export type SharedIntelligenceEvidence = z.infer<typeof sharedIntelligenceEvidenceSchema>;

export const sharedIntelligenceProposalSchema = z.object({
  id: uuidSchema,
  title: shortText,
  goal: z.string().trim().min(1).max(1_000),
  lesson: bodyText,
  rationale: bodyText,
  agent_id: uuidSchema,
  agent_name: shortText,
  audiences: z.array(sharedIntelligenceTeamSchema).min(1).max(2),
  evidence: z.array(sharedIntelligenceEvidenceSchema).min(1).max(5),
  assessment: sharedIntelligenceAssessmentSchema,
  status: z.enum(['needs_review', 'ready_for_review', 'pending_review', 'published', 'revoked', 'declined']),
  approval_request_id: uuidSchema.nullable(),
  library_source_id: uuidSchema.nullable(),
  library_version_id: uuidSchema.nullable(),
  created_at: dateTimeSchema,
  published_at: dateTimeSchema.nullable(),
  revoked_at: dateTimeSchema.nullable(),
  triage_status: sharedIntelligenceTriageStatusSchema.optional().default('private'),
  triage_goal_id: uuidSchema.nullable().optional().default(null),
  triage_assessment: sharedIntelligenceTriageAssessmentSchema.nullable().optional().default(null),
  triage_submitted_at: dateTimeSchema.nullable().optional().default(null),
  triage_decided_at: dateTimeSchema.nullable().optional().default(null),
}).strict();
export type SharedIntelligenceProposal = z.infer<typeof sharedIntelligenceProposalSchema>;

export const createSharedIntelligenceProposalSchema = z.object({
  agent_id: uuidSchema,
  title: shortText,
  goal: z.string().trim().min(1).max(1_000),
  lesson: bodyText,
  rationale: bodyText,
  team_ids: z.array(uuidSchema).min(1).max(2).refine((ids) => new Set(ids).size === ids.length, 'team_ids must be unique'),
  evidence: z.array(z.object({
    run_id: uuidSchema,
    approved_excerpt: z.string().trim().min(1).max(1_000),
  }).strict()).min(1).max(5).refine((items) => new Set(items.map((item) => item.run_id)).size === items.length, 'run_id must be unique'),
}).strict();
export type CreateSharedIntelligenceProposal = z.infer<typeof createSharedIntelligenceProposalSchema>;

export const sharedIntelligenceWorkspaceSchema = z.object({
  teams: z.array(sharedIntelligenceTeamSchema).max(2),
  goals: z.array(sharedIntelligenceGoalSchema).max(100).optional().default([]),
  eligible_runs: z.array(sharedIntelligenceRunSchema).max(50),
  discoveries: z.array(sharedIntelligenceDiscoverySchema).max(20),
  proposals: z.array(sharedIntelligenceProposalSchema).max(100),
  data_boundary: z.string().max(1_000),
}).strict();
export type SharedIntelligenceWorkspace = z.infer<typeof sharedIntelligenceWorkspaceSchema>;

export const sharedIntelligenceSubmitResultSchema = z.object({
  proposal: sharedIntelligenceProposalSchema,
  approval_request_id: uuidSchema,
}).strict();

export const createSharedIntelligenceGoalSchema = z.object({
  scope: z.enum(['workspace', 'team']),
  team_id: uuidSchema.nullable().optional().default(null),
  title: shortText,
  detail: z.string().trim().min(1).max(1_000),
}).strict().superRefine((value, context) => {
  if (value.scope === 'workspace' && value.team_id !== null) context.addIssue({ code: 'custom', path: ['team_id'], message: 'workspace goals cannot select a team' });
  if (value.scope === 'team' && value.team_id === null) context.addIssue({ code: 'custom', path: ['team_id'], message: 'team goals require a team' });
});
export type CreateSharedIntelligenceGoal = z.infer<typeof createSharedIntelligenceGoalSchema>;

export const queueSharedIntelligenceProposalSchema = z.object({ goal_id: uuidSchema }).strict();

export const sharedIntelligenceAdminCandidateSchema = z.object({
  proposal: sharedIntelligenceProposalSchema,
  goal: sharedIntelligenceGoalSchema,
  submitted_by: z.object({ id: uuidSchema, name: shortText }).strict(),
  library_comparisons: z.array(z.object({
    source_id: uuidSchema,
    version_id: uuidSchema,
    version_sha256: sha256Schema,
    title: shortText.nullable(),
    summary: z.string().max(500).nullable(),
    access: z.enum(['available', 'withdrawn']),
  }).strict()).max(100),
  assessment_stale: z.boolean(),
  stale_reason: z.enum(['goal_inactive', 'goal_changed', 'audience_changed', 'library_changed']).nullable(),
  decision_note: z.string().max(1_000).nullable(),
}).strict();
export type SharedIntelligenceAdminCandidate = z.infer<typeof sharedIntelligenceAdminCandidateSchema>;

export const sharedIntelligenceAdminWorkspaceSchema = z.object({
  teams: z.array(sharedIntelligenceTeamSchema).max(20),
  goals: z.array(sharedIntelligenceGoalSchema).max(100),
  candidates: z.array(sharedIntelligenceAdminCandidateSchema).max(200),
  data_boundary: z.string().max(1_000),
}).strict();
export type SharedIntelligenceAdminWorkspace = z.infer<typeof sharedIntelligenceAdminWorkspaceSchema>;

export const sharedIntelligenceTriageDecisionSchema = z.object({
  decision: z.enum(['include', 'exclude', 'reopen']),
  note: z.string().trim().max(1_000).optional().default(''),
}).strict();
export type SharedIntelligenceTriageDecision = z.infer<typeof sharedIntelligenceTriageDecisionSchema>;

export const sharedIntelligenceTriageDecisionResultSchema = z.object({
  candidate: sharedIntelligenceAdminCandidateSchema,
  approval_request_id: uuidSchema.nullable(),
}).strict();
