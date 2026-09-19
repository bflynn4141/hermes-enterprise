import { z } from 'zod';
import { invoicePayloadSchema } from './documents.js';
import { uuidSchema } from './events.js';

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
