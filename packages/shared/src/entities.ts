// Entity and REST payload shapes the client hydrates from.
//
// M1 defined the event contract and `bootstrap`; the client port (M2) needs the
// row shapes behind `entity.updated` as well, because a cache miss is answered
// by a `GET` for that one entity and the answer has to be validated before it
// reaches the reducer (CONVENTIONS: "Trust an event it did not validate against
// the contract" is the one thing apps/client may not do).
//
// Everything here is additive: no existing schema changes shape. The worker
// fills these in as the M2/M4 routes land; until then the client's mock mode and
// its tests are the only producers, and they parse through the same schemas, so
// a drift between mock and server is a test failure rather than a surprise.
import { z } from 'zod';
import { runErrorSchema, streamIdSchema, uuidSchema } from './events.js';
import { blockSchema } from './commands.js';
import { refSchema } from './refs.js';
import { approvalListProjectionSchema } from './approvals.js';
import { maskedProviderKeySchema, type MaskedProviderKey } from './provider-keys.js';
import {
  decisionSchema,
  effectKindSchema,
  effectStatusSchema,
  memberRoleSchema,
  messageRoleSchema,
  messageStatusSchema,
  requestKindSchema,
  requestStatusSchema,
  runStatusSchema,
  runStepStateSchema,
  sessionModeSchema,
} from './enums.js';

/** One page of a list endpoint. `before` is the cursor to ask for the next page. */
export const paginatedSchema = <T extends z.ZodType>(item: T) =>
  z
    .object({
      items: z.array(item),
      /** Opaque cursor for `?before=`; null when the list is exhausted. */
      cursor: z.string().nullable(),
      total: z.number().int().min(0).nullable(),
    })
    .strict();

export type Paginated<T> = { items: T[]; cursor: string | null; total: number | null };

// ---------------------------------------------------------------------------
// Sessions and messages
// ---------------------------------------------------------------------------

export const sessionSchema = z
  .object({
    id: uuidSchema,
    agent_id: uuidSchema,
    title: z.string().max(200),
    mode: sessionModeSchema,
    model_id: z.string().max(64),
    effort: z.string().max(32).nullable(),
    runtime: z.enum(['cloud', 'local']),
    pinned: z.boolean(),
    archived: z.boolean(),
    focus_ref: refSchema.nullable(),
    /** Derived by `v_session_status`; the client never computes it. */
    status: z.string().max(64),
    last_activity_at: z.iso.datetime({ offset: true }).nullable(),
    share: z
      .object({ id: uuidSchema, url: z.string().max(400).nullable(), audience: z.string().max(80), created_at: z.iso.datetime({ offset: true }), messages: z.number().int().min(0) })
      .strict()
      .nullable()
      .optional(),
    context: z.object({ label: z.string().max(120), ref: refSchema.nullable() }).strict().nullable().optional(),
    version: z.number().int().min(0).optional(),
  })
  .strict();
export type Session = z.infer<typeof sessionSchema>;

export const attachmentRefSchema = z
  .object({ id: z.string().max(128), label: z.string().max(200), kind: z.enum(['file', 'skill', 'source', 'line']).default('file'), status: z.enum(['pending', 'extracting', 'ready', 'failed']).default('ready'), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), source_kind: z.enum(['agent_file', 'library_source']).optional() })
  .strict();
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;

export const messageSchema = z
  .object({
    id: uuidSchema,
    session_id: uuidSchema,
    seq: z.number().int().min(0),
    role: messageRoleSchema,
    kind: z.string().max(32).nullable(),
    heading: z.string().max(300).nullable().optional(),
    text: z.string().max(200_000),
    blocks: z.array(blockSchema).max(20),
    status: messageStatusSchema,
    run_id: uuidSchema.nullable(),
    worked_ms: z.number().int().min(0).nullable().optional(),
    /** Step labels frozen at answer time, for the Worked disclosure. */
    steps: z.array(z.string().max(160)).max(50).optional(),
    guidance: z.string().max(4000).nullable().optional(),
    feedback: z.enum(['helpful', 'not-helpful']).nullable().optional(),
    attachments: z.array(attachmentRefSchema).max(20).optional(),
    incomplete: z.boolean().optional(),
    follow_ups: z.array(z.string().max(200)).max(6).optional(),
    at: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type Message = z.infer<typeof messageSchema>;

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

// Named `runStepEntitySchema` because `events.ts` already exports a
// `runStepSchema`: that one is the `run.step` *event*, this one is the step as
// the client caches it. Two different shapes with one name is an ambiguous
// re-export from the package index, which is a compile error rather than a
// judgement call.
export const runStepEntitySchema = z
  .object({
    id: z.string().max(64),
    label: z.string().max(160),
    state: runStepStateSchema,
    tool_call_id: z.string().max(128).nullable().optional(),
    /** Kept after a `message.reset`, collapsed under "Earlier attempt". */
    step_attempt: z.number().int().min(1).optional(),
    detail: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type RunStep = z.infer<typeof runStepEntitySchema>;

export const runQueueItemSchema = z
  .object({ id: uuidSchema, text: z.string().max(4000), status: z.enum(['queued', 'paused', 'sent', 'removed']), position: z.number().int().min(0) })
  .strict();
export type RunQueueItem = z.infer<typeof runQueueItemSchema>;

export const runSchema = z
  .object({
    id: uuidSchema,
    session_id: uuidSchema,
    agent_id: uuidSchema,
    status: runStatusSchema,
    attempt: z.number().int().min(1),
    title: z.string().max(200).nullable(),
    steps: z.array(runStepEntitySchema).max(100),
    queue: z.array(runQueueItemSchema).max(50).default([]),
    guidance: z.object({ id: uuidSchema, text: z.string().max(4000), status: z.enum(['pending', 'applied']) }).strict().nullable().optional(),
    waiting_for: z.string().max(64).nullable().optional(),
    waiting_label: z.string().max(200).nullable().optional(),
    /** Authoritative run-start event time; keeps live elapsed time stable across remounts. */
    started_at: z.iso.datetime({ offset: true }).optional(),
    active_ms: z.number().int().min(0).nullable().optional(),
    error: z
      .object({ class: z.string().max(32), retryable: z.boolean(), reason: z.string().max(64), message: z.string().max(500), step_id: z.string().max(64).nullable().optional() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type Run = z.infer<typeof runSchema>;

// ---------------------------------------------------------------------------
// Requests, decisions, effects, documents
// ---------------------------------------------------------------------------

export const requestSourceSchema = z.object({ id: z.string().max(64), name: z.string().max(200), note: z.string().max(400) }).strict();

export const requestPriorityBandSchema = z.enum(['urgent', 'high', 'normal', 'low', 'assessing']);
export const requestTriageSchema = z.object({
  status: z.enum(['pending', 'complete', 'abstained', 'failed', 'unavailable']),
  band: requestPriorityBandSchema,
  score: z.number().min(0).max(100).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  reason_codes: z.array(z.string().max(64)).max(8),
  assessed_at: z.iso.datetime({ offset: true }).nullable(),
  rubric_version: z.string().max(32),
  model_id: z.string().max(100),
}).strict();
export type RequestTriage = z.infer<typeof requestTriageSchema>;

export const requestDecisionSummarySchema = z.object({
  action: z.string().max(100),
  primary: z.string().max(280),
  facts: z.array(z.object({
    label: z.string().max(80),
    value: z.string().max(200),
    emphasis: z.enum(['default', 'attention', 'risk']),
  }).strict()).max(4),
  consequence: z.string().max(500).nullable(),
  approval_requirement: z.object({
    mode: z.enum(['single', 'sequential', 'parallel']),
    completed_steps: z.number().int().min(0),
    total_steps: z.number().int().min(1),
    remaining_approvals: z.number().int().min(0),
    current: z.array(z.object({
      label: z.string().max(200),
      approvals_recorded: z.number().int().min(0),
      quorum: z.number().int().min(1),
    }).strict()).max(25),
    pending_for_viewer: z.boolean(),
    waiting_on_others: z.boolean(),
    expires_at: z.iso.datetime({ offset: true }).nullable(),
  }).strict(),
}).strict();
export type RequestDecisionSummary = z.infer<typeof requestDecisionSummarySchema>;

export const requestEntitySchema = z
  .object({
    id: uuidSchema,
    kind: requestKindSchema,
    status: requestStatusSchema,
    label: z.string().max(200),
    subject: z.string().max(200).nullable(),
    title: z.string().max(200).nullable(),
    session_id: uuidSchema.nullable(),
    run_id: uuidSchema.nullable(),
    created_at: z.iso.datetime({ offset: true }),
    version: z.number().int().min(0),
    /** Kind-specific body; validated per kind by `documents.ts` when rendered. */
    payload: z.record(z.string(), z.unknown()).default({}),
    sources: z.array(requestSourceSchema).max(20).default([]),
    missing: z.array(z.string().max(200)).max(20).default([]),
    note: z.string().max(4000).nullable().optional(),
    decision_id: uuidSchema.nullable().optional(),
    decided_at: z.iso.datetime({ offset: true }).nullable().optional(),
    decided_by_name: z.string().max(120).nullable().optional(),
    approval: approvalListProjectionSchema.nullable().optional(),
    decision_summary: requestDecisionSummarySchema.optional(),
    triage: requestTriageSchema.optional(),
    provenance: z.object({
      kind: z.enum(['operational', 'sample', 'test', 'unknown']),
      source: z.string().max(80),
      recorded_at: z.iso.datetime({ offset: true }),
    }).strict().default({ kind: 'unknown', source: 'not_recorded', recorded_at: '1970-01-01T00:00:00.000Z' }),
    presentation: z.object({
      hidden: z.boolean(),
      hidden_at: z.iso.datetime({ offset: true }).nullable(),
      hidden_reason: z.string().max(500).nullable(),
    }).strict().default({ hidden: false, hidden_at: null, hidden_reason: null }),
  })
  .strict();
export type RequestEntity = z.infer<typeof requestEntitySchema>;

export const decisionEntitySchema = z
  .object({
    id: uuidSchema,
    request_id: uuidSchema,
    decision: decisionSchema,
    resulting_status: requestStatusSchema,
    decided_by: uuidSchema,
    decided_by_name: z.string().max(120),
    decided_at: z.iso.datetime({ offset: true }),
    note: z.string().max(4000).nullable(),
    effect_ids: z.array(uuidSchema).max(20).default([]),
  })
  .strict();
export type DecisionEntity = z.infer<typeof decisionEntitySchema>;

export const effectEntitySchema = z
  .object({
    id: uuidSchema,
    request_id: uuidSchema,
    kind: effectKindSchema,
    status: effectStatusSchema,
    required_role: z.string().max(32),
    label: z.string().max(200),
    /** The honest pilot copy: why nothing executed. */
    reason: z.string().max(200).nullable(),
  })
  .strict();
export type EffectEntity = z.infer<typeof effectEntitySchema>;

export const documentEntitySchema = z
  .object({
    id: uuidSchema,
    kind: z.enum(['invoice', 'agreement', 'reference']),
    number: z.string().max(64).nullable(),
    title: z.string().max(200),
    status: z.string().max(64),
    request_id: uuidSchema.nullable(),
    /** `pdf_status` drives "PDF is being prepared" / "Rendering failed: {reason}". */
    pdf_status: z.enum(['none', 'preparing', 'ready', 'failed']).default('none'),
    pdf_url: z.string().max(400).nullable(),
    pdf_error: z.string().max(200).nullable(),
    payload: z.record(z.string(), z.unknown()).default({}),
    version: z.number().int().min(0),
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type DocumentEntity = z.infer<typeof documentEntitySchema>;

// ---------------------------------------------------------------------------
// People, keys, usage
// ---------------------------------------------------------------------------

export const memberEntitySchema = z
  .object({
    id: uuidSchema,
    user_id: uuidSchema.nullable(),
    name: z.string().max(120),
    email: z.string().max(200),
    role: memberRoleSchema,
    status: z.enum(['active', 'invited', 'expired', 'inactive']),
    reviewer_roles: z.array(z.string().max(32)).max(8).default([]),
    joined_at: z.iso.datetime({ offset: true }).nullable(),
    version: z.number().int().min(0).default(0),
  })
  .strict();
export type MemberEntity = z.infer<typeof memberEntitySchema>;

export const invitationEntitySchema = z
  .object({
    id: uuidSchema,
    email: z.string().max(200),
    role: memberRoleSchema,
    status: z.enum(['pending', 'accepted', 'expired', 'withdrawn', 'bounced', 'resent']),
    invited_at: z.iso.datetime({ offset: true }),
    /** WorkOS email handoff state. Present on current servers; optional for older clients/fixtures. */
    delivery_status: z.enum(['not_required', 'queued', 'sending', 'delivered', 'failed']).optional(),
    /** Stable allowlisted failure category. Provider text never enters this contract. */
    delivery_reason: z.enum([
      'workos_invitation_delivery_not_configured',
      'workos_invitation_payload_invalid',
      'iris_capacity_reservation_missing',
      'workos_invitation_delivery_rejected',
      'workos_invitation_delivery_unavailable',
      'workos_invitation_delivery_outcome_unknown',
      'workos_invitation_local_commit_failed',
      'invitation_delivery_failed',
    ]).nullable().optional(),
    delivery_trace_id: uuidSchema.nullable().optional(),
    version: z.number().int().min(0).default(0),
  })
  .strict();
export type InvitationEntity = z.infer<typeof invitationEntitySchema>;

/**
 * Provider keys are already in the contract: `provider-keys.ts` (written for the
 * M2 key routes) owns `maskedProviderKeySchema`, and it is stricter than the
 * spec's sketch — `verified_models` is the list of model ids, not a count, and
 * `last4`/`fingerprint_prefix` have exact lengths. The client consumes that
 * shape; `ProviderKey` here is only the name the client-port spec uses for it.
 */
export type ProviderKey = MaskedProviderKey;

export const usageRowSchema = z
  .object({
    key: z.string().max(120),
    label: z.string().max(200),
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    /** Estimated from the catalog price; the screen always says so. */
    estimated_cost_usd: z.number().nonnegative(),
    model_id: z.string().max(64).nullable(),
  })
  .strict();

export const usageResponseSchema = z
  .object({
    group: z.enum(['day', 'session', 'key']),
    from: z.string().max(32),
    to: z.string().max(32),
    rows: z.array(usageRowSchema).max(400),
    daily_token_cap: z.number().int().min(0).nullable(),
    tokens_today: z.number().int().min(0),
  })
  .strict();
export type UsageResponse = z.infer<typeof usageResponseSchema>;

// ---------------------------------------------------------------------------
// Agent context, skills, traces, events
// ---------------------------------------------------------------------------

export const agentFileSchema = z
  .object({
    id: uuidSchema,
    name: z.string().max(200),
    subtitle: z.string().max(200),
    extraction: z.enum(['pending', 'extracting', 'ready', 'failed']),
    extraction_error: z.string().max(200).nullable(),
    body: z.string().max(200_000).nullable(),
    version: z.number().int().min(0).default(0),
  })
  .strict();
export type AgentFile = z.infer<typeof agentFileSchema>;

export const contextFieldSchema = z
  .object({ id: z.string().max(64), field: z.string().max(64), label: z.string().max(120), value: z.string().max(400).nullable(), scope: z.enum(['reply', 'future']).nullable(), version: z.number().int().min(0).default(0) })
  .strict();
export type ContextField = z.infer<typeof contextFieldSchema>;

export const instructionVersionSchema = z
  .object({
    id: uuidSchema,
    state: z.enum(['current', 'proposed', 'saved']),
    text: z.string().max(8000),
    before: z.string().max(8000).nullable(),
    provenance: z.string().max(200).nullable(),
    created_at: z.iso.datetime({ offset: true }),
    version: z.number().int().min(0).default(0),
  })
  .strict();
export type InstructionVersion = z.infer<typeof instructionVersionSchema>;

export const skillVersionSchema = z
  .object({
    id: z.string().max(64),
    name: z.string().max(120),
    version: z.string().max(32),
    shared_by: z.string().max(120),
    description: z.string().max(2000),
    detail: z.string().max(2000).nullable(),
    adopted: z.boolean(),
  })
  .strict();
export type SkillVersion = z.infer<typeof skillVersionSchema>;

export const eventRowSchema = z
  .object({
    id: z.string().max(40),
    kind: z.string().max(64),
    at: z.iso.datetime({ offset: true }),
    actor_name: z.string().max(120),
    actor_type: z.enum(['user', 'agent', 'system']),
    text: z.string().max(300),
    detail: z.string().max(300),
    status: z.string().max(64),
    ref: refSchema.nullable(),
    request_id: uuidSchema.nullable(),
  })
  .strict();
export type EventRow = z.infer<typeof eventRowSchema>;

export const traceEntitySchema = z
  .object({
    id: uuidSchema,
    run_id: uuidSchema,
    agent_id: uuidSchema,
    runtime_kind: z.enum(['legacy', 'hermes']).optional(),
    runtime_profile: z.string().max(100).nullable().optional(),
    runtime_run_id: z.string().max(200).nullable().optional(),
    runtime_session_id: z.string().max(200).nullable().optional(),
    name: z.string().max(200),
    type: z.string().max(120),
    status: z.string().max(64),
    sub: z.string().max(200),
    needs_you: z.boolean(),
    ref: refSchema.nullable(),
    steps: z.array(runStepEntitySchema).max(100).default([]),
    allowed_tools: z.array(z.string().max(64)).max(40).default([]),
    /**
     * The run's mode, model and worked time. Optional because the list route
     * fills them and an older server does not; the client renders without
     * them.
     */
    mode: sessionModeSchema.nullable().optional(),
    model_id: z.string().max(64).nullable().optional(),
    active_ms: z.number().int().min(0).nullable().optional(),
    step_count: z.number().int().min(0).optional(),
    /**
     * The detail half, filled only by `GET /w/:ws/traces/:runId`. Each of
     * these is already visible to a member through another route — the point
     * of the trace is that they are visible *together*, in one order, so a
     * reader can see what the agent read before it proposed something.
     *
     * A `result` here is the tool-result envelope the model saw, truncation
     * marker and all: a trace that showed the untruncated text would be a
     * trace of a run that did not happen.
     */
    tool_calls: z
      .array(
        z
          .object({
            tool_call_id: z.string().max(128),
            name: z.string().max(64),
            turn: z.number().int().min(0),
            arguments: z.string().max(20_000).nullable(),
            result: z.string().max(20_000).nullable(),
            truncated: z.boolean().default(false),
          })
          .strict(),
      )
      .max(200)
      .optional(),
    /** Every URL `fetch_url` actually retrieved, in order. */
    fetched_urls: z.array(z.string().max(2000)).max(100).optional(),
    /** `run.focus` events, so the reader can replay where the pane was sent. */
    focus: z
      .array(z.object({ at: z.iso.datetime({ offset: true }), ref: refSchema.nullable(), entity_type: z.string().max(32), entity_id: z.string().max(128) }).strict())
      .max(100)
      .optional(),
    /** Safe, fixed-copy terminal failure detail. Present on failed run detail. */
    error: runErrorSchema.nullable().optional(),
    version: z.number().int().min(0).default(0),
  })
  .strict();
export type TraceEntity = z.infer<typeof traceEntitySchema>;

// ---------------------------------------------------------------------------
// Auth, shares, turns
// ---------------------------------------------------------------------------

export const authSessionSchema = z
  .object({
    user: z.object({ id: uuidSchema, name: z.string().max(120), email: z.string().max(200), role: memberRoleSchema }).strict(),
    workspace: z.object({ id: uuidSchema, name: z.string().max(200) }).strict(),
    stream_heads: z.object({ workspace: streamIdSchema, session: streamIdSchema.optional() }).strict(),
    hub_ticket: z.string().max(400),
    expires_at: z.iso.datetime({ offset: true }),
    authenticated_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type AuthSessionResponse = z.infer<typeof authSessionSchema>;

/**
 * What `GET /auth/session` answers with no `?ws=`.
 *
 * A different shape rather than a looser `authSessionSchema`, because the two
 * answers mean different things: this one says "here is who you are and the
 * workspaces you are in", and it carries no stream heads and no hub ticket
 * because neither exists until a workspace is named. The client picks one and
 * asks again by id. See decision F7.
 */
export const authWorkspacesSchema = z
  .object({
    user: z.object({ id: uuidSchema, name: z.string().max(120), email: z.string().max(200) }).strict(),
    workspaces: z
      .array(
        z
          .object({
            id: uuidSchema,
            name: z.string().max(200),
            role: memberRoleSchema,
            /** A small, presentation-only sample. Full membership stays on `/members`. */
            members: z
              .array(
                z
                  .object({
                    id: uuidSchema,
                    name: z.string().max(200),
                    avatar_url: z.url().max(2048).nullable(),
                  })
                  .strict(),
              )
              .max(4)
              .default([]),
            member_count: z.number().int().min(0).max(100_000).default(0),
          })
          .strict(),
      )
      .max(200),
    authenticated_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type AuthWorkspacesResponse = z.infer<typeof authWorkspacesSchema>;

export const turnResponseSchema = z
  .object({ run_id: uuidSchema, client_turn_id: z.string().max(128), duplicate: z.boolean().default(false) })
  .strict();
export type TurnResponse = z.infer<typeof turnResponseSchema>;

export const decisionResultSchema = z
  .object({ decision_id: uuidSchema, request_id: uuidSchema, resulting_status: requestStatusSchema, effect_ids: z.array(uuidSchema).max(20).default([]) })
  .strict();
export type DecisionResult = z.infer<typeof decisionResultSchema>;

/**
 * A session share is a bearer capability: possession of the URL is the whole
 * authorization check. This label is deliberately shared by the API and UI so
 * neither can imply workspace- or recipient-bound access that does not exist.
 */
export const SHARE_AUDIENCE = 'Anyone with the link';

export const shareResponseSchema = z
  .object({
    id: uuidSchema,
    /** Returned once and never re-readable; the client shows it and forgets it. */
    url: z.string().max(400),
    audience: z.string().max(80),
    message_cutoff_seq: z.number().int().min(0),
    created_at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type ShareResponse = z.infer<typeof shareResponseSchema>;

export const sharedSessionSchema = z
  .object({
    session: z.object({ id: uuidSchema, title: z.string().max(200), workspace_name: z.string().max(200) }).strict(),
    messages: z.array(messageSchema).max(500),
    message_cutoff_seq: z.number().int().min(0),
    revoked: z.boolean().default(false),
  })
  .strict();
export type SharedSession = z.infer<typeof sharedSessionSchema>;

export const attachmentPresignSchema = z
  .object({ attachment_id: uuidSchema, url: z.string().max(1000), expires_at: z.iso.datetime({ offset: true }) })
  .strict();
export type AttachmentPresign = z.infer<typeof attachmentPresignSchema>;

/**
 * The full bootstrap the client hydrates from. `bootstrapSchema` in `api.ts` is
 * the M1 subset the worker serves today; this extends it with the entity lists
 * the ported client needs, every field optional so a worker that has not caught
 * up yet still parses.
 */
export const clientBootstrapSchema = z
  .object({
    members: z.array(memberEntitySchema).max(500).optional(),
    invitations: z.array(invitationEntitySchema).max(500).optional(),
    provider_keys: z.array(maskedProviderKeySchema).max(50).optional(),
    agent: z
      .object({ id: uuidSchema, name: z.string().max(80), email: z.string().max(200), summary: z.string().max(2000), setup_step: z.string().max(32).nullable() })
      .strict()
      .optional(),
    hub_ticket: z.string().max(400).optional(),
    csrf_token: z.string().max(200).optional(),
  })
  .strict();
export type ClientBootstrapExtra = z.infer<typeof clientBootstrapSchema>;
