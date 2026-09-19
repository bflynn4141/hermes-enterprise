import type { EnterpriseSkillConfigField } from '@hermes/shared';
import { z } from 'zod';
import { partnerAgentConfigSchema } from '../partner-screening/config.js';

export const PARTNER_PROGRAM_SKILL = {
  name: 'enterprise_bridge:partner-program-screening',
  key: 'partner-program-screening',
  version: '1.7.0',
  title: 'Partner program screening',
  description: 'Screen public partner prospects and prepare cited outreach drafts for human review.',
} as const;

export const PARTNER_PROGRAM_CAPABILITY_GRANTS = [
  'partner.discovery.read',
  'partner.review.prepare',
  'partner.outreach.draft',
  'partner.records.qualification.write',
  'partner.handoff.publish',
] as const;

export const PARTNER_INVOICE_REVIEW_SKILL = {
  name: 'enterprise_bridge:partner-invoice-review',
  key: 'partner-invoice-review',
  version: '1.0.0',
  title: 'Partner invoice review',
  description: 'Check authorized partner invoices and prepare a human payment decision. It cannot approve or pay.',
} as const;

export const PARTNER_INVOICE_REVIEW_CAPABILITY_GRANTS = [
  'partner.shared.read',
  'partner.invoice.read',
  'partner.invoice.review.prepare',
] as const;

const CAPABILITY_TO_TOOLS: Readonly<Record<string, readonly string[]>> = {
  'partner.discovery.read': ['list_partner_candidates', 'get_partner_candidate'],
  'partner.review.prepare': [
    'list_requests', 'get_request', 'get_approval_status', 'get_document_text',
    'save_review_note', 'set_context_field', 'ask_for_context', 'set_focus',
  ],
  'partner.outreach.draft': ['propose_request', 'propose_approval', 'propose_instruction'],
  // The server prepares the invoice decision deterministically. The Finance
  // model can inspect and explain it, but cannot create or mutate a request.
  'partner.invoice.review.prepare': ['list_requests', 'get_request'],
};

export const PARTNER_PROGRAM_TOOLS = [...new Set(
  PARTNER_PROGRAM_CAPABILITY_GRANTS.flatMap((grant) => CAPABILITY_TO_TOOLS[grant] ?? []),
)];

export interface EnterpriseSkillDefinition<TConfig extends Record<string, unknown>> {
  readonly key: string;
  readonly runtimeName: string;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly configSchema: z.ZodType<TConfig>;
  readonly configFields: readonly EnterpriseSkillConfigField[];
  readonly defaultCapabilityGrants: readonly string[];
  readonly humanReviewRequired: true;
  readonly artifactDigest: `sha256:${string}`;
  readonly roleTemplateKey: 'partnerships-agent' | 'finance-agent';
}

const PARTNER_CONFIG_FIELDS = [
  { path: 'program_name', label: 'Program name', description: 'The name Iris uses in prospect briefs and drafts.', kind: 'text', required: true, minimum: null, maximum: null, options: [] },
  { path: 'role_label', label: 'Partner profile', description: 'A short description of the partner role Iris is screening for.', kind: 'text', required: true, minimum: null, maximum: null, options: [] },
  { path: 'keywords', label: 'Signals and keywords', description: 'Evidence Iris should look for when ranking candidates.', kind: 'string_list', required: true, minimum: null, maximum: null, options: [] },
  { path: 'people_search.current_position_titles', label: 'Target titles', description: 'Professional titles used to bound people search.', kind: 'string_list', required: false, minimum: null, maximum: null, options: [] },
  { path: 'people_search.person_skills', label: 'Target skills', description: 'Skills used to bound people search.', kind: 'string_list', required: false, minimum: null, maximum: null, options: [] },
  { path: 'people_search.person_locations', label: 'Locations', description: 'Optional locations used to narrow discovery.', kind: 'string_list', required: false, minimum: null, maximum: null, options: [] },
  { path: 'minimum_priority', label: 'Minimum priority', description: 'Only candidates at or above this score enter the review queue.', kind: 'integer', required: true, minimum: 0, maximum: 100, options: [] },
  { path: 'max_candidates', label: 'Candidates per run', description: 'The maximum number Iris may add in one discovery run.', kind: 'integer', required: true, minimum: 1, maximum: 10, options: [] },
] as const satisfies readonly EnterpriseSkillConfigField[];

export const PARTNER_PROGRAM_DEFINITION: EnterpriseSkillDefinition<Record<string, unknown>> = {
  key: PARTNER_PROGRAM_SKILL.key,
  runtimeName: PARTNER_PROGRAM_SKILL.name,
  version: PARTNER_PROGRAM_SKILL.version,
  name: PARTNER_PROGRAM_SKILL.title,
  description: PARTNER_PROGRAM_SKILL.description,
  configSchema: partnerAgentConfigSchema as z.ZodType<Record<string, unknown>>,
  configFields: PARTNER_CONFIG_FIELDS,
  defaultCapabilityGrants: PARTNER_PROGRAM_CAPABILITY_GRANTS,
  humanReviewRequired: true,
  artifactDigest: 'sha256:9f124ce44aa318b13e9f8ccfd92072d8b3ba6a22030eaad31cfafbfda3a1e2a9',
  roleTemplateKey: 'partnerships-agent',
};

const FINANCE_CONFIG_SCHEMA = z.object({
  duplicate_window_days: z.number().int().min(1).max(3650).default(365),
  require_engagement_evidence: z.literal(true).default(true),
}).strict();

const FINANCE_CONFIG_FIELDS = [
  { path: 'duplicate_window_days', label: 'Duplicate window', description: 'How many days of Finance records are checked for the same invoice number, payee and amount.', kind: 'integer', required: true, minimum: 1, maximum: 3650, options: [] },
] as const satisfies readonly EnterpriseSkillConfigField[];

export const PARTNER_INVOICE_REVIEW_DEFINITION: EnterpriseSkillDefinition<Record<string, unknown>> = {
  key: PARTNER_INVOICE_REVIEW_SKILL.key,
  runtimeName: PARTNER_INVOICE_REVIEW_SKILL.name,
  version: PARTNER_INVOICE_REVIEW_SKILL.version,
  name: PARTNER_INVOICE_REVIEW_SKILL.title,
  description: PARTNER_INVOICE_REVIEW_SKILL.description,
  configSchema: FINANCE_CONFIG_SCHEMA as z.ZodType<Record<string, unknown>>,
  configFields: FINANCE_CONFIG_FIELDS,
  defaultCapabilityGrants: PARTNER_INVOICE_REVIEW_CAPABILITY_GRANTS,
  humanReviewRequired: true,
  artifactDigest: 'sha256:f0f6c637aa48293825b6282cdda542577c5ce965996ebbbdacc7ad3b691f7ae5',
  roleTemplateKey: 'finance-agent',
};

export const ENTERPRISE_SKILL_REGISTRY = new Map<string, EnterpriseSkillDefinition<Record<string, unknown>>>([
  [PARTNER_PROGRAM_DEFINITION.key, PARTNER_PROGRAM_DEFINITION],
  [PARTNER_INVOICE_REVIEW_DEFINITION.key, PARTNER_INVOICE_REVIEW_DEFINITION],
]);

export function toolsForCapabilityGrants(grants: readonly string[]): string[] {
  return [...new Set(grants.flatMap((grant) => CAPABILITY_TO_TOOLS[grant] ?? []))];
}
