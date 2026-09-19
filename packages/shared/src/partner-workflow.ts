import { z } from 'zod';
import { invoicePayloadSchema } from './documents.js';
import { uuidSchema } from './events.js';
import { authorizationHashSchema } from './approvals.js';

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const shortText = z.string().trim().min(1).max(1000);

export const HERMES_BOT_MODE_PROTOCOL = 'hermes-bot-mode/v1' as const;
export const botModeProfileSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
const botModeDisplaySchema = z.string().trim().min(1).max(64).regex(/^[^:\n(]+$/);

// Kept byte-for-byte compatible with the Hermes 0.21.3 Bot Mode client. The
// legacy form remains readable, while Enterprise emits the emoji/profile form.
export const BOT_MODE_AGENT_MESSAGE_PATTERN = /^(?:Message from (?:🤖\s*)?([^:\n(]{1,64}?)(?:\s*\(@([a-z0-9][a-z0-9_-]{0,63})\))?:\s*|\[Message from agent '([^']{1,64})'\]\s*)([\s\S]*)$/u;

export interface BotModeAgentMessage {
  readonly display: string;
  readonly profile: string | null;
  readonly body: string;
}

export function formatBotModeAgentMessage(input: {
  readonly display: string;
  readonly profile: string;
  readonly body: string;
}): string {
  const display = botModeDisplaySchema.parse(input.display);
  const profile = botModeProfileSchema.parse(input.profile);
  const body = z.string().min(1).max(8000).parse(input.body);
  return `Message from 🤖 ${display} (@${profile}): ${body}`;
}

export function parseBotModeAgentMessage(text: string): BotModeAgentMessage | null {
  const match = BOT_MODE_AGENT_MESSAGE_PATTERN.exec(text);
  if (!match) return null;
  return {
    display: (match[1] ?? match[3] ?? '').trim(),
    profile: match[2] ?? null,
    body: match[4] ?? '',
  };
}

export const partnerTeamSchema = z.object({
  id: uuidSchema,
  slug: z.enum(['partnerships', 'finance']),
  name: z.enum(['Partnerships', 'Finance']),
}).strict();
export type PartnerTeam = z.infer<typeof partnerTeamSchema>;

export const partnerWorkflowAgentSchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(120),
  principal_user_id: uuidSchema,
  principal_name: z.string().min(1).max(120),
  team: partnerTeamSchema,
  role_template: z.object({
    key: z.enum(['partnerships-agent', 'finance-agent']),
    name: z.enum(['Partnerships agent', 'Finance agent']),
    version: z.string().min(1).max(32),
  }).strict(),
  skill_key: z.enum(['partner-program-screening', 'partner-invoice-review']),
  skill_name: z.string().min(1).max(120),
  skill_version: z.string().min(1).max(32),
  assignment_id: uuidSchema,
  assignment_revision: z.number().int().positive(),
  assignment_state: z.enum(['active', 'paused']),
  schedule_enabled: z.boolean(),
  capabilities: z.array(z.string().min(1).max(120)).max(64),
}).strict();

export const partnerWorkflowHandoffSchema = z.object({
  id: uuidSchema,
  status: z.enum(['queued', 'processing', 'completed', 'needs_information', 'failed', 'stale']),
  partner_id: uuidSchema,
  partner_name: z.string().min(1).max(200),
  engagement_reference: z.string().min(1).max(200),
  source_session_id: uuidSchema,
  finance_session_id: uuidSchema.nullable(),
  invoice_request_id: uuidSchema.nullable(),
  delivery_protocol: z.literal(HERMES_BOT_MODE_PROTOCOL).nullable(),
  message_status: z.enum(['queued', 'delivered', 'failed']).nullable(),
  result_reason: z.string().max(1000).nullable(),
  simulated: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
  completed_at: z.iso.datetime({ offset: true }).nullable(),
}).strict();

export const partnerWorkflowViewSchema = z.object({
  configured: z.boolean(),
  teams: z.array(partnerTeamSchema).max(2),
  agents: z.array(partnerWorkflowAgentSchema).max(2),
  handoffs: z.array(partnerWorkflowHandoffSchema).max(25),
  connector: z.object({
    name: z.literal('enterprise-partner-records'),
    shared_code: z.literal(true),
    enforcement: z.literal('server'),
    summary: z.literal('Shared identity and approved engagement evidence only; private research and invoice data stay team-scoped.'),
  }).strict(),
}).strict();
export type PartnerWorkflowView = z.infer<typeof partnerWorkflowViewSchema>;

export const partnerWorkflowSetupSchema = z.object({
  partnerships: z.object({ agent_id: uuidSchema, principal_user_id: uuidSchema }).strict(),
  finance: z.object({ agent_id: uuidSchema, principal_user_id: uuidSchema }).strict(),
}).strict().refine((value) => value.partnerships.agent_id !== value.finance.agent_id, {
  message: 'each employee needs a distinct agent', path: ['finance', 'agent_id'],
}).refine((value) => value.partnerships.principal_user_id !== value.finance.principal_user_id, {
  message: 'Partnerships and Finance need distinct human principals', path: ['finance', 'principal_user_id'],
});
export type PartnerWorkflowSetup = z.infer<typeof partnerWorkflowSetupSchema>;

export const partnerQualificationInputSchema = z.object({
  candidate_id: uuidSchema,
  outcome: z.enum(['qualified', 'not_qualified', 'needs_information']),
  summary: shortText,
  strengths: z.array(shortText).max(20).default([]),
  gaps: z.array(shortText).max(20).default([]),
  evidence_ids: z.array(uuidSchema).min(1).max(50),
  confidence: z.enum(['high', 'medium', 'low']),
  source_session_id: uuidSchema,
  source_run_id: uuidSchema,
  idempotency_key: identifier,
}).strict();
export type PartnerQualificationInput = z.infer<typeof partnerQualificationInputSchema>;

/**
 * An authenticated business event, not a model inference. The invoice remains
 * Finance-private. Only the allowlisted shared projection below crosses teams.
 */
export const partnerInvoiceReviewHandoffInputSchema = z.object({
  partner: z.object({
    id: uuidSchema,
    name: z.string().trim().min(1).max(200),
  }).strict(),
  engagement: z.object({
    reference: z.string().trim().min(1).max(200),
    summary: shortText,
    currency: z.string().regex(/^[A-Z]{3}$/),
    authorized_total_minor: z.number().int().min(0).max(1_000_000_000),
    evidence_ids: z.array(z.string().min(1).max(128)).min(1).max(50),
  }).strict(),
  invoice: invoicePayloadSchema,
  source_session_id: uuidSchema,
  source_run_id: uuidSchema,
  simulated: z.boolean().default(false),
  idempotency_key: identifier,
}).strict();
export type PartnerInvoiceReviewHandoffInput = z.infer<typeof partnerInvoiceReviewHandoffInputSchema>;

export const partnerRecordKindSchema = z.enum([
  'qualification',
  'outreach_draft',
  'engagement',
  'invoice',
  'invoice_review',
  'needs_information',
]);

export const partnerRecordSchema = z.object({
  id: uuidSchema,
  team_id: uuidSchema,
  owner_agent_id: uuidSchema,
  kind: partnerRecordKindSchema,
  partner_id: uuidSchema,
  revision: z.number().int().positive(),
  data: z.record(z.string(), z.unknown()),
  evidence_ids: z.array(z.string().min(1).max(128)).max(50),
  source_session_id: uuidSchema,
  source_run_id: uuidSchema,
  created_at: z.iso.datetime({ offset: true }),
}).strict();
export type PartnerRecord = z.infer<typeof partnerRecordSchema>;

/** The complete and exclusive cross-team field allowlist. */
export const partnerInvoiceHandoffProjectionSchema = z.object({
  partner: z.object({ id: uuidSchema, name: z.string().min(1).max(200) }).strict(),
  engagement: z.object({
    reference: z.string().min(1).max(200),
    summary: shortText,
    currency: z.string().regex(/^[A-Z]{3}$/),
    authorized_total_minor: z.number().int().min(0).max(1_000_000_000),
    evidence_ids: z.array(z.string().min(1).max(128)).min(1).max(50),
    source_record_id: uuidSchema,
    source_record_revision: z.number().int().positive(),
  }).strict(),
  invoice_record_id: uuidSchema,
  invoice_record_revision: z.number().int().positive(),
  source_session: z.object({ id: uuidSchema, excerpt: z.string().min(1).max(2000) }).strict(),
}).strict();
export type PartnerInvoiceHandoffProjection = z.infer<typeof partnerInvoiceHandoffProjectionSchema>;

// Multi-party invoice workflow v2. The public inputs contain business ids and
// optimistic bindings only. Workspace, employee, agent, session/run ownership,
// recipient and provenance are always filled from authenticated server state.
export const sha256DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const isoDateSchema = z.iso.date();

export const partnerSourceBindingInputSchema = z.object({
  attachment_id: uuidSchema,
  expected_sha256: sha256DigestSchema,
}).strict();
export type PartnerSourceBindingInput = z.infer<typeof partnerSourceBindingInputSchema>;

export const partnerEngagementAuthorizationInputSchema = z.object({
  partner: z.object({ id: uuidSchema, name: z.string().trim().min(1).max(200) }).strict(),
  reference: z.string().trim().min(1).max(200),
  purpose: shortText,
  currency: z.string().regex(/^[A-Z]{3}$/),
  authorized_total_minor: z.number().int().min(0).max(1_000_000_000),
  valid_from: isoDateSchema,
  valid_until: isoDateSchema,
  one_invoice: z.literal(true),
  permitted_evidence_excerpt: z.string().trim().min(1).max(2000),
  source: partnerSourceBindingInputSchema,
  idempotency_key: identifier,
}).strict().refine((value) => value.valid_until >= value.valid_from, {
  message: 'valid_until cannot precede valid_from', path: ['valid_until'],
});
export type PartnerEngagementAuthorizationInput = z.infer<typeof partnerEngagementAuthorizationInputSchema>;

export const partnerEngagementAuthorizationResultSchema = z.object({
  approval_request_id: uuidSchema,
  authorization_revision: z.number().int().positive(),
  authorization_hash: authorizationHashSchema,
  engagement_record_id: uuidSchema.nullable(),
  status: z.enum(['pending', 'authorized', 'declined', 'expired', 'superseded', 'withdrawn']),
  created: z.boolean(),
}).strict();
export type PartnerEngagementAuthorizationResult = z.infer<typeof partnerEngagementAuthorizationResultSchema>;

export const partnerInvoiceInputSchema = invoicePayloadSchema.superRefine((value, context) => {
  if (value.workflow_provenance !== undefined) {
    context.addIssue({ code: 'custom', path: ['workflow_provenance'], message: 'workflow provenance is server-owned' });
  }
});

export const partnerInvoiceIntakeInputSchema = z.object({
  engagement_record_id: uuidSchema,
  expected_engagement_revision: z.number().int().positive(),
  expected_authorization_hash: authorizationHashSchema,
  invoice_source: partnerSourceBindingInputSchema,
  invoice: partnerInvoiceInputSchema,
  idempotency_key: identifier,
}).strict();
export type PartnerInvoiceIntakeInput = z.infer<typeof partnerInvoiceIntakeInputSchema>;

export const partnerInvoiceIntakeResultSchema = z.object({
  intake_event_id: uuidSchema,
  payload_hash: authorizationHashSchema,
  handoff_id: uuidSchema,
  handoff_revision: z.number().int().positive(),
  source_run_id: uuidSchema,
  finance_run_id: uuidSchema.nullable(),
  created: z.boolean(),
}).strict();
export type PartnerInvoiceIntakeResult = z.infer<typeof partnerInvoiceIntakeResultSchema>;

export const publishPartnerInvoiceReviewInputSchema = z.object({
  intake_event_id: uuidSchema,
  expected_payload_hash: authorizationHashSchema,
}).strict();
export type PublishPartnerInvoiceReviewInput = z.infer<typeof publishPartnerInvoiceReviewInputSchema>;

export const partnerInvoiceCorrectionInputSchema = z.object({
  expected_handoff_revision: z.number().int().positive(),
  engagement_record_id: uuidSchema,
  expected_engagement_revision: z.number().int().positive(),
  expected_authorization_hash: authorizationHashSchema,
  invoice_source: partnerSourceBindingInputSchema,
  invoice: partnerInvoiceInputSchema,
  idempotency_key: identifier,
}).strict();
export type PartnerInvoiceCorrectionInput = z.infer<typeof partnerInvoiceCorrectionInputSchema>;

export const partnerInvoiceCorrectionResultSchema = z.object({
  superseded_handoff_id: uuidSchema,
  handoff_id: uuidSchema,
  handoff_revision: z.number().int().positive(),
  intake_event_id: uuidSchema,
  payload_hash: authorizationHashSchema,
  source_run_id: uuidSchema,
  finance_run_id: uuidSchema.nullable(),
  created: z.boolean(),
}).strict();
export type PartnerInvoiceCorrectionResult = z.infer<typeof partnerInvoiceCorrectionResultSchema>;

export const partnerHandoffCheckSchema = z.object({
  code: z.enum([
    'duplicate', 'currency', 'amount', 'engagement_authorization',
    'engagement_validity', 'invoice_source', 'engagement_source',
  ]),
  status: z.enum(['passed', 'needs_information', 'stale', 'failed']),
  message: z.string().trim().min(1).max(1000),
}).strict();
export type PartnerHandoffCheck = z.infer<typeof partnerHandoffCheckSchema>;

export const partnerWorkflowOutcomeSchema = z.object({
  delivery: z.enum(['queued', 'delivered', 'failed']),
  validation: z.enum(['queued', 'checking', 'passed', 'needs_information', 'stale', 'failed']),
  agent_explanation: z.enum(['queued', 'running', 'completed', 'failed', 'stopped']),
  human_decision: z.enum(['not_ready', 'pending', 'approved', 'declined', 'superseded']),
  acknowledgment: z.enum(['pending', 'delivered']),
}).strict();
export type PartnerWorkflowOutcome = z.infer<typeof partnerWorkflowOutcomeSchema>;

export const partnerFrozenSourceSchema = z.object({
  attachment_id: uuidSchema,
  name: z.string().min(1).max(255),
  sha256: sha256DigestSchema,
  created_at: z.iso.datetime({ offset: true }),
  author_name: z.string().min(1).max(200).nullable(),
  excerpt: z.string().min(1).max(2000),
}).strict();

const partnerHandoffResultBaseSchema = z.object({
  handoff_id: uuidSchema,
  handoff_revision: z.number().int().positive(),
  supersedes_handoff_id: uuidSchema.nullable(),
  engagement_record_id: uuidSchema,
  engagement_revision: z.number().int().positive(),
  authorization_hash: authorizationHashSchema,
  request_id: uuidSchema.nullable(),
  source_versions: z.object({
    engagement: partnerFrozenSourceSchema,
    invoice: partnerFrozenSourceSchema,
  }).strict(),
  checks: z.array(partnerHandoffCheckSchema).max(16),
  outcome: partnerWorkflowOutcomeSchema,
});

export const partnerHandoffResultSchema = z.discriminatedUnion('kind', [
  partnerHandoffResultBaseSchema.extend({ kind: z.literal('pending_checks') }).strict(),
  partnerHandoffResultBaseSchema.extend({ kind: z.literal('checks_passed') }).strict(),
  partnerHandoffResultBaseSchema.extend({ kind: z.literal('needs_information') }).strict(),
  partnerHandoffResultBaseSchema.extend({ kind: z.literal('stale_source') }).strict(),
  partnerHandoffResultBaseSchema.extend({
    kind: z.literal('failed_processing'),
    failure_code: z.string().min(1).max(128),
  }).strict(),
]);
export type PartnerHandoffResult = z.infer<typeof partnerHandoffResultSchema>;

export const getPartnerHandoffResultInputSchema = z.object({ handoff_id: uuidSchema }).strict();
export type GetPartnerHandoffResultInput = z.infer<typeof getPartnerHandoffResultInputSchema>;

export const partnerDecisionAcknowledgmentSchema = z.object({
  handoff_id: uuidSchema,
  partner_id: uuidSchema,
  partner_name: z.string().min(1).max(200),
  engagement_reference: z.string().min(1).max(200),
  outcome: z.enum(['invoice_draft_saved', 'declined']),
  result_code: z.enum(['approved', 'declined']),
  finance_reviewer_display: z.string().min(1).max(120),
  recorded_at: z.iso.datetime({ offset: true }),
  delivery_status: z.enum(['pending', 'delivered']),
}).strict();
export type PartnerDecisionAcknowledgment = z.infer<typeof partnerDecisionAcknowledgmentSchema>;

export const partnerWorkflowViewerRoleSchema = z.enum(['admin', 'partnerships', 'finance', 'unrelated']);
export type PartnerWorkflowViewerRole = z.infer<typeof partnerWorkflowViewerRoleSchema>;

export const partnerRoleReadinessSchema = z.object({
  role: z.enum(['partnerships', 'finance']),
  configured: z.boolean(),
  assignment_state: z.enum(['active', 'paused', 'missing']),
  native_status: z.enum(['ready', 'not_ready', 'unknown']),
  skill_key: z.enum(['partner-program-screening', 'partner-invoice-review']),
  skill_version: z.string().min(1).max(32).nullable(),
  artifact_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable(),
  missing: z.array(z.enum(['principal', 'agent', 'assignment', 'skill', 'tools', 'provider'])).max(6),
}).strict();
export type PartnerRoleReadiness = z.infer<typeof partnerRoleReadinessSchema>;

export const partnerEngagementSummarySchema = z.object({
  id: uuidSchema,
  revision: z.number().int().positive(),
  authorization_hash: authorizationHashSchema,
  authorization_status: z.enum(['authorized', 'revoked', 'expired', 'superseded', 'consumed']),
  partner: z.object({ id: uuidSchema, name: z.string().min(1).max(200) }).strict(),
  reference: z.string().min(1).max(200),
  purpose: z.string().min(1).max(1000),
  currency: z.string().regex(/^[A-Z]{3}$/),
  authorized_total_minor: z.number().int().min(0).max(1_000_000_000),
  valid_from: isoDateSchema,
  valid_until: isoDateSchema,
  one_invoice: z.literal(true),
  source: partnerFrozenSourceSchema,
}).strict();
export type PartnerEngagementSummary = z.infer<typeof partnerEngagementSummarySchema>;

export const partnerWorkflowHandoffV2Schema = z.object({
  id: uuidSchema,
  revision: z.number().int().positive(),
  supersedes_handoff_id: uuidSchema.nullable(),
  superseded_by_handoff_id: uuidSchema.nullable(),
  current: z.boolean(),
  partner_id: uuidSchema,
  partner_name: z.string().min(1).max(200),
  engagement_reference: z.string().min(1).max(200),
  invoice_number: z.string().min(1).max(64),
  invoice_currency: z.string().regex(/^[A-Z]{3}$/),
  invoice_total_minor: z.number().int().min(0).max(1_000_000_000),
  source_session_id: uuidSchema.nullable(),
  finance_session_id: uuidSchema.nullable(),
  request_id: uuidSchema.nullable(),
  outcome: partnerWorkflowOutcomeSchema,
  result_kind: z.enum(['pending_checks', 'checks_passed', 'needs_information', 'stale_source', 'failed_processing']),
  result_reason: z.string().max(1000).nullable(),
  checks: z.array(partnerHandoffCheckSchema).max(16),
  acknowledgment: partnerDecisionAcknowledgmentSchema.nullable(),
  simulated: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
  decided_at: z.iso.datetime({ offset: true }).nullable(),
}).strict();
export type PartnerWorkflowHandoffV2 = z.infer<typeof partnerWorkflowHandoffV2Schema>;

export const partnerWorkflowViewV2Schema = z.object({
  configured: z.boolean(),
  viewer_role: partnerWorkflowViewerRoleSchema,
  actions: z.object({
    configure: z.boolean(),
    propose_engagement: z.boolean(),
    submit_invoice: z.boolean(),
    correct_invoice: z.boolean(),
    view_finance_review: z.boolean(),
  }).strict(),
  teams: z.array(partnerTeamSchema).max(2),
  agents: z.array(partnerWorkflowAgentSchema).max(2),
  readiness: z.array(partnerRoleReadinessSchema).length(2),
  engagements: z.array(partnerEngagementSummarySchema).max(25),
  handoffs: z.array(partnerWorkflowHandoffV2Schema).max(25),
  connector: z.object({
    name: z.literal('enterprise-partner-records'),
    shared_code: z.literal(true),
    enforcement: z.literal('server'),
    summary: z.literal('Shared identity and approved engagement evidence only; private research and invoice data stay team-scoped.'),
  }).strict(),
}).strict();
export type PartnerWorkflowViewV2 = z.infer<typeof partnerWorkflowViewV2Schema>;

export const PARTNER_WORKFLOW_ERROR_REASONS = [
  'bad_engagement_authorization', 'bad_invoice_intake', 'bad_invoice_correction',
  'forbidden_partner_workflow_action', 'partnerships_principal_required', 'finance_recipient_unavailable',
  'attachment_not_ready', 'attachment_not_accessible', 'source_workspace_mismatch', 'source_digest_mismatch',
  'engagement_not_authorized', 'engagement_revision_mismatch', 'authorization_hash_mismatch',
  'authorization_revoked', 'authorization_expired', 'authorization_superseded', 'authorization_consumed',
  'handoff_not_found', 'handoff_revision_mismatch', 'handoff_superseded', 'handoff_already_decided',
  'idempotency_conflict', 'correction_successor_exists', 'request_binding_stale', 'run_grant_missing',
] as const;
export const partnerWorkflowErrorReasonSchema = z.enum(PARTNER_WORKFLOW_ERROR_REASONS);
export type PartnerWorkflowErrorReason = z.infer<typeof partnerWorkflowErrorReasonSchema>;
