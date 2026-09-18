import { z } from 'zod';
import { uuidSchema } from './events.js';

export const APPROVAL_TYPES = [
  'run_plan',
  'team_commitment',
  'access',
  'communication',
  'shared_learning',
  'deliverable',
  'data_disclosure',
  'record_change',
  'exception',
  'agent_governance',
] as const;
export const approvalTypeSchema = z.enum(APPROVAL_TYPES);
export type ApprovalType = z.infer<typeof approvalTypeSchema>;

const shortText = z.string().trim().min(1).max(200);
const longText = z.string().trim().min(1).max(20_000);
const identifier = z.string().trim().min(1).max(128);
const isoDateTime = z.iso.datetime({ offset: true });
const currency = z.string().regex(/^[A-Z]{3}$/, 'expected an ISO 4217 currency code');

export const authorizationHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected a sha256 authorization hash');

export const approvalIdempotencyKeySchema = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const approvalEvidenceSchema = z
  .object({
    id: identifier,
    kind: z.enum(['source', 'document', 'artifact', 'request', 'run']),
    label: shortText,
    ref: z.string().trim().min(1).max(500).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
export type ApprovalEvidence = z.infer<typeof approvalEvidenceSchema>;

const planStepSchema = z
  .object({
    id: identifier,
    label: shortText,
    agent_id: uuidSchema.optional(),
    output: z.string().trim().min(1).max(1000),
  })
  .strict();

export const runPlanDetailsSchema = z
  .object({
    goal: longText,
    steps: z.array(planStepSchema).min(1).max(50),
    participating_agents: z
      .array(z.object({ agent_id: uuidSchema, role: shortText }).strict())
      .min(1)
      .max(25),
    deliverables: z.array(shortText).min(1).max(25),
    schedule: z.string().trim().min(1).max(1000),
    budget: z
      .object({
        currency,
        estimated_min_minor: z.number().int().min(0),
        estimated_max_minor: z.number().int().min(0),
        cap_minor: z.number().int().min(0),
        estimated_input_tokens: z.number().int().min(0).optional(),
        estimated_output_tokens: z.number().int().min(0).optional(),
        total_token_cap: z.number().int().positive(),
        call_cap: z.number().int().positive().max(10_000),
        max_output_tokens_per_call: z.number().int().positive(),
        max_parallel_calls: z.number().int().positive().max(100),
        model_ids: z.array(identifier).min(1).max(25),
        metered_tools: z.array(identifier).max(25).default([]),
        retries_included: z.number().int().min(0).max(20).default(0),
        illustrative: z.boolean(),
      })
      .strict()
      .refine((value) => value.estimated_min_minor <= value.estimated_max_minor, {
        message: 'estimated_min_minor must not exceed estimated_max_minor',
      })
      .refine((value) => value.estimated_max_minor <= value.cap_minor, {
        message: 'estimated_max_minor must not exceed cap_minor',
      }),
  })
  .strict();

export const teamCommitmentDetailsSchema = z
  .object({
    requester_agent_id: uuidSchema,
    recipient_agent_id: uuidSchema,
    receiving_owner_member_id: uuidSchema,
    workload: longText,
    due_at: isoDateTime,
    dependencies: z.array(shortText).max(25).default([]),
    acceptance_criteria: z.array(shortText).min(1).max(25),
  })
  .strict();

export const accessDetailsSchema = z
  .object({
    resource_id: identifier,
    resource_label: shortText,
    requested_agent_id: uuidSchema,
    operations: z.array(z.enum(['read', 'write', 'admin'])).min(1).max(3),
    purpose: longText,
    access_expires_at: isoDateTime,
  })
  .strict();

export const communicationDetailsSchema = z
  .object({
    channel: z.enum(['email', 'message', 'social']),
    draft_only: z.boolean().default(false),
    sender: z.object({ member_id: uuidSchema, address: z.string().trim().min(1).max(320) }).strict(),
    recipients: z
      .array(z.object({
        name: shortText,
        address: z.string().trim().min(1).max(320).nullable(),
        candidate_id: uuidSchema.optional(),
        phone_numbers: z.array(z.object({
          number: z.string().trim().min(7).max(40),
          type: z.string().trim().min(1).max(40).nullable().optional(),
        }).strict()).max(5).optional(),
        social_profiles: z.array(z.object({
          network: z.enum(['linkedin', 'twitter', 'facebook']),
          url: z.url().max(500),
        }).strict()).max(3).optional(),
      }).strict())
      .min(1)
      .max(100),
    subject: z.string().trim().max(500).optional(),
    body: longText,
    attachments: z.array(z.object({ id: identifier, label: shortText }).strict()).max(25).default([]),
    scheduled_for: isoDateTime.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.draft_only && value.recipients.some((recipient) => recipient.address === null)) {
      context.addIssue({ code: 'custom', path: ['recipients'], message: 'a sendable communication requires every recipient address' });
    }
    if (value.draft_only && value.scheduled_for) {
      context.addIssue({ code: 'custom', path: ['scheduled_for'], message: 'a draft-only communication cannot be scheduled' });
    }
  });

export const sharedLearningDetailsSchema = z
  .object({
    skill_id: identifier,
    title: shortText,
    current_version: identifier.nullable(),
    proposed_version: identifier,
    diff: longText,
    source_evidence_ids: z.array(identifier).min(1).max(100),
    reuse_audience: z.array(shortText).min(1).max(50),
    excluded_private_data: z.array(shortText).min(1).max(50),
  })
  .strict();

export const deliverableDetailsSchema = z
  .object({
    artifact_id: identifier,
    title: shortText,
    version: identifier,
    content: longText,
    evidence_ids: z.array(identifier).max(100).default([]),
    missing_information: z.array(shortText).max(50).default([]),
    releases_dependent_request_ids: z.array(uuidSchema).max(50).default([]),
  })
  .strict();

export const dataDisclosureDetailsSchema = z
  .object({
    recipient: z.object({ organization: shortText, contact: shortText.optional() }).strict(),
    purpose: longText,
    items: z
      .array(z.object({ resource_id: identifier, fields: z.array(identifier).min(1).max(100) }).strict())
      .min(1)
      .max(50),
    redactions: z.array(shortText).max(100).default([]),
    retention_until: isoDateTime,
  })
  .strict();

const boundedJsonValueSchema = z.union([z.string().max(4000), z.number(), z.boolean(), z.null()]);

export const recordChangeDetailsSchema = z
  .object({
    system_id: identifier,
    system_label: shortText,
    changes: z
      .array(
        z
          .object({
            record_id: identifier,
            field: identifier,
            before: boundedJsonValueSchema,
            after: boundedJsonValueSchema,
          })
          .strict(),
      )
      .min(1)
      .max(200),
    validation: z.array(shortText).min(1).max(50),
    rollback: longText,
  })
  .strict();

export const exceptionDetailsSchema = z
  .object({
    rule_id: identifier,
    rule_label: shortText,
    reason: longText,
    scope: longText,
    compensating_controls: z.array(shortText).min(1).max(50),
    exception_expires_at: isoDateTime,
  })
  .strict();

export const agentGovernanceDetailsSchema = z
  .object({
    agent_id: uuidSchema,
    current_schedule: z.string().trim().max(1000).nullable(),
    proposed_schedule: z.string().trim().max(1000).nullable(),
    current_tools: z.array(identifier).max(100),
    proposed_tools: z.array(identifier).max(100),
    setting_changes: z
      .array(z.object({ key: identifier, before: boundedJsonValueSchema, after: boundedJsonValueSchema }).strict())
      .max(100),
    affected_permissions: z.array(shortText).max(100),
  })
  .strict()
  .refine(
    (value) =>
      value.current_schedule !== value.proposed_schedule ||
      JSON.stringify(value.current_tools) !== JSON.stringify(value.proposed_tools) ||
      value.setting_changes.length > 0,
    { message: 'the proposal must change a schedule, tool, or setting' },
  );

const proposalBase = {
  kind: z.literal('approval'),
  summary: z.string().trim().min(1).max(1000),
  consequence: z.string().trim().min(1).max(2000),
  evidence: z.array(approvalEvidenceSchema).max(100).default([]),
  illustrative: z.boolean(),
} as const;

const typedProposal = <T extends ApprovalType, S extends z.ZodType>(approvalType: T, details: S) =>
  z.object({ ...proposalBase, approval_type: z.literal(approvalType), details }).strict();

export const runPlanApprovalSchema = typedProposal('run_plan', runPlanDetailsSchema);
export const teamCommitmentApprovalSchema = typedProposal('team_commitment', teamCommitmentDetailsSchema);
export const accessApprovalSchema = typedProposal('access', accessDetailsSchema);
export const communicationApprovalSchema = typedProposal('communication', communicationDetailsSchema);
export const sharedLearningApprovalSchema = typedProposal('shared_learning', sharedLearningDetailsSchema);
export const deliverableApprovalSchema = typedProposal('deliverable', deliverableDetailsSchema);
export const dataDisclosureApprovalSchema = typedProposal('data_disclosure', dataDisclosureDetailsSchema);
export const recordChangeApprovalSchema = typedProposal('record_change', recordChangeDetailsSchema);
export const exceptionApprovalSchema = typedProposal('exception', exceptionDetailsSchema);
export const agentGovernanceApprovalSchema = typedProposal('agent_governance', agentGovernanceDetailsSchema);

export const approvalProposalSchema = z.discriminatedUnion('approval_type', [
  runPlanApprovalSchema,
  teamCommitmentApprovalSchema,
  accessApprovalSchema,
  communicationApprovalSchema,
  sharedLearningApprovalSchema,
  deliverableApprovalSchema,
  dataDisclosureApprovalSchema,
  recordChangeApprovalSchema,
  exceptionApprovalSchema,
  agentGovernanceApprovalSchema,
]);
export type ApprovalProposal = z.infer<typeof approvalProposalSchema>;

export const approvalReviewerSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('member'), member_id: uuidSchema }).strict(),
  z
    .object({
      kind: z.literal('role'),
      role: identifier,
      minimum_distinct_members: z.number().int().min(1).max(25).default(1),
    })
    .strict(),
]);
export type ApprovalReviewerSelector = z.infer<typeof approvalReviewerSelectorSchema>;

export const approvalPolicyStepSchema = z
  .object({
    id: identifier,
    label: shortText,
    order: z.number().int().min(0).max(100),
    reviewers: z.array(approvalReviewerSelectorSchema).min(1).max(50),
    quorum: z.number().int().min(1).max(25),
  })
  .strict();

export const approvalPolicySchema = z
  .object({
    id: uuidSchema,
    key: identifier,
    version: z.number().int().min(1),
    mode: z.enum(['sequential', 'parallel']),
    prevent_self_review: z.boolean(),
    require_distinct_reviewers: z.literal(true),
    steps: z.array(approvalPolicyStepSchema).min(1).max(25),
  })
  .strict()
  .refine((policy) => new Set(policy.steps.map((step) => step.id)).size === policy.steps.length, {
    message: 'policy step ids must be unique',
  })
  .refine((policy) => new Set(policy.steps.map((step) => step.order)).size === policy.steps.length, {
    message: 'policy step order values must be unique',
  });
export type ApprovalPolicy = z.infer<typeof approvalPolicySchema>;

export const approvalServerContextSchema = z
  .object({
    requester: z
      .object({ agent_id: uuidSchema, member_id: uuidSchema.nullable(), user_id: uuidSchema.nullable() })
      .strict(),
    target_agent_ids: z.array(uuidSchema).max(50).default([]),
    target_member_ids: z.array(uuidSchema).max(50).default([]),
    target_resource_ids: z.array(identifier).max(100).default([]),
    source: z
      .object({
        session_id: uuidSchema.nullable(),
        run_id: uuidSchema.nullable(),
        dependent_request_ids: z.array(uuidSchema).max(50).default([]),
        trigger: z
          .object({
            kind: z.literal('member_agent_joined'),
            invitation_id: uuidSchema,
            member_id: uuidSchema,
            agent_id: uuidSchema,
          })
          .strict()
          .nullable()
          .optional(),
      })
      .strict(),
  })
  .strict();

export const approvalAuthorizationBindingSchema = z
  .object({
    revision: z.number().int().min(1),
    hash: authorizationHashSchema,
    expires_at: isoDateTime,
  })
  .strict();

export const approvalResourceBindingSchema = z
  .object({
    kind: z.enum(['attachment', 'agent_file', 'document', 'artifact', 'request', 'run', 'skill', 'resource']),
    id: identifier,
    version: z.string().trim().min(1).max(128).nullable(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    immutable: z.boolean(),
    executor_available: z.boolean(),
    reason: z.string().trim().max(1000).nullable(),
  })
  .strict();
export type ApprovalResourceBinding = z.infer<typeof approvalResourceBindingSchema>;

const storedApprovalFields = {
  context: approvalServerContextSchema,
  authorization: approvalAuthorizationBindingSchema,
  policy: approvalPolicySchema,
  resource_bindings: z.array(approvalResourceBindingSchema).max(250),
} as const;

export const approvalPayloadSchema = z.discriminatedUnion('approval_type', [
  runPlanApprovalSchema.extend(storedApprovalFields),
  teamCommitmentApprovalSchema.extend(storedApprovalFields),
  accessApprovalSchema.extend(storedApprovalFields),
  communicationApprovalSchema.extend(storedApprovalFields),
  sharedLearningApprovalSchema.extend(storedApprovalFields),
  deliverableApprovalSchema.extend(storedApprovalFields),
  dataDisclosureApprovalSchema.extend(storedApprovalFields),
  recordChangeApprovalSchema.extend(storedApprovalFields),
  exceptionApprovalSchema.extend(storedApprovalFields),
  agentGovernanceApprovalSchema.extend(storedApprovalFields),
]);
export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;

export const APPROVAL_AUTHORIZATION_STATUSES = [
  'pending',
  'approved',
  'declined',
  'changes_requested',
  'expired',
  'superseded',
  'withdrawn',
] as const;
export const approvalAuthorizationStatusSchema = z.enum(APPROVAL_AUTHORIZATION_STATUSES);
export type ApprovalAuthorizationStatus = z.infer<typeof approvalAuthorizationStatusSchema>;

export const APPROVAL_VOTE_DECISIONS = ['approve', 'decline', 'request_changes'] as const;
export const approvalVoteDecisionSchema = z.enum(APPROVAL_VOTE_DECISIONS);
export type ApprovalVoteDecision = z.infer<typeof approvalVoteDecisionSchema>;

export const approvalVoteSchema = z
  .object({
    id: uuidSchema,
    step_id: identifier,
    decision: approvalVoteDecisionSchema,
    authorization_revision: z.number().int().min(1),
    authorization_hash: authorizationHashSchema,
    reviewer_member_id: uuidSchema,
    reviewer_user_id: uuidSchema,
    reviewer_name: shortText,
    note: z.string().trim().max(4000).nullable(),
    idempotency_key: approvalIdempotencyKeySchema,
    recorded_at: isoDateTime,
  })
  .strict();
export type ApprovalVote = z.infer<typeof approvalVoteSchema>;

export const approvalViewerCapabilitiesSchema = z
  .object({
    allowed_decisions: z.array(approvalVoteDecisionSchema).max(3),
    eligible_step_ids: z.array(identifier).max(25),
    can_route: z.boolean(),
    can_submit_revision: z.boolean(),
    reason: z.string().trim().max(500).nullable(),
  })
  .strict();

export const approvalEffectOutcomeSchema = z
  .object({
    kind: z.enum([
      'none',
      'access',
      'communication',
      'shared_learning_publish',
      'data_disclosure',
      'record_change',
      'agent_governance_change',
    ]),
    status: z.enum(['not_required', 'waiting', 'unavailable', 'executed', 'failed', 'cancelled']),
    effect_id: uuidSchema.nullable(),
    reason: z.string().trim().max(1000).nullable(),
  })
  .strict();

export const approvalWorkOutcomeSchema = z
  .object({
    status: z.enum(['waiting', 'ready', 'admitted', 'completed', 'cancelled']),
    continuation_id: uuidSchema.nullable(),
    reason: z.string().trim().max(1000).nullable(),
  })
  .strict();

export const approvalStepProgressSchema = z
  .object({
    step_id: identifier,
    label: shortText,
    order: z.number().int().min(0),
    status: z.enum(['blocked', 'current', 'approved', 'declined', 'changes_requested']),
    approvals_recorded: z.number().int().min(0),
    quorum: z.number().int().min(1),
    current_reviewer_member_ids: z.array(uuidSchema).max(100),
  })
  .strict();

export const approvalListProjectionSchema = z
  .object({
    approval_type: approvalTypeSchema,
    authorization_status: approvalAuthorizationStatusSchema,
    authorization_revision: z.number().int().min(1),
    expires_at: isoDateTime,
    pending_for_viewer: z.boolean(),
    waiting_on_others: z.boolean(),
    current_reviewer_names: z.array(shortText).max(25),
    effect_status: approvalEffectOutcomeSchema.shape.status,
    work_status: approvalWorkOutcomeSchema.shape.status,
  })
  .strict();
export type ApprovalListProjection = z.infer<typeof approvalListProjectionSchema>;

export const approvalIdentityProjectionSchema = z
  .object({
    requester_agent: z
      .object({ id: uuidSchema, name: shortText, email: z.email().max(320).nullable() })
      .strict(),
    target_agents: z
      .array(
        z
          .object({
            id: uuidSchema,
            name: shortText,
            email: z.email().max(320).nullable(),
            responsible_member_id: uuidSchema.nullable(),
            responsible_member_name: shortText.nullable(),
          })
          .strict(),
      )
      .max(50),
    reviewers: z
      .array(
        z
          .object({
            member_id: uuidSchema,
            user_id: uuidSchema.nullable(),
            name: shortText,
            authority_roles: z.array(identifier).max(25),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
export type ApprovalIdentityProjection = z.infer<typeof approvalIdentityProjectionSchema>;

export const approvalViewSchema = z
  .object({
    request_id: uuidSchema,
    workspace_id: uuidSchema,
    status: approvalAuthorizationStatusSchema,
    payload: approvalPayloadSchema,
    identities: approvalIdentityProjectionSchema,
    votes: z.array(approvalVoteSchema).max(500),
    steps: z.array(approvalStepProgressSchema).max(25),
    capabilities: approvalViewerCapabilitiesSchema,
    effect: approvalEffectOutcomeSchema,
    work: approvalWorkOutcomeSchema,
    finalized_at: isoDateTime.nullable(),
  })
  .strict();
export type ApprovalView = z.infer<typeof approvalViewSchema>;

/** Agent/runtime input. The server resolves identity and the immutable policy from its own context/key. */
export const proposeApprovalInputSchema = z
  .object({
    label: shortText,
    policy_key: identifier,
    proposal: approvalProposalSchema,
    target_agent_ids: z.array(uuidSchema).max(50).default([]),
    target_member_ids: z.array(uuidSchema).max(50).default([]),
    target_resource_ids: z.array(identifier).max(100).default([]),
    dependent_request_ids: z.array(uuidSchema).max(50).default([]),
    requested_expires_at: isoDateTime.optional(),
    idempotency_key: approvalIdempotencyKeySchema,
  })
  .strict();
export type ProposeApprovalInput = z.infer<typeof proposeApprovalInputSchema>;

const optimisticBinding = {
  expected_authorization_revision: z.number().int().min(1),
  expected_authorization_hash: authorizationHashSchema,
  idempotency_key: approvalIdempotencyKeySchema,
} as const;

export const decideApprovalInputSchema = z
  .object({
    ...optimisticBinding,
    decision: approvalVoteDecisionSchema,
    note: z.string().trim().max(4000).nullable().default(null),
  })
  .strict();
export type DecideApprovalInput = z.infer<typeof decideApprovalInputSchema>;

export const reviseApprovalInputSchema = z
  .object({
    ...optimisticBinding,
    proposal: approvalProposalSchema,
    change_summary: z.string().trim().min(1).max(2000),
    requested_expires_at: isoDateTime.optional(),
  })
  .strict();
export type ReviseApprovalInput = z.infer<typeof reviseApprovalInputSchema>;

export const routeApprovalInputSchema = z
  .object({
    ...optimisticBinding,
    step_id: identifier,
    reviewer_member_id: uuidSchema,
    reason: z.string().trim().min(1).max(1000),
  })
  .strict();
export type RouteApprovalInput = z.infer<typeof routeApprovalInputSchema>;

export const approvalFinalizedHookSchema = z
  .object({
    event: z.literal('approval.finalized'),
    request_id: uuidSchema,
    workspace_id: uuidSchema,
    approval_type: approvalTypeSchema,
    authorization_revision: z.number().int().min(1),
    authorization_hash: authorizationHashSchema,
    expires_at: isoDateTime,
    requester_agent_id: uuidSchema,
    requester_member_id: uuidSchema.nullable(),
    source_session_id: uuidSchema.nullable(),
    source_run_id: uuidSchema.nullable(),
    dependent_request_ids: z.array(uuidSchema).max(50),
    run_plan_budget: runPlanDetailsSchema.shape.budget.nullable(),
    resource_bindings: z.array(approvalResourceBindingSchema).max(250),
    finalized_at: isoDateTime,
  })
  .strict();
export type ApprovalFinalizedHook = z.infer<typeof approvalFinalizedHookSchema>;
