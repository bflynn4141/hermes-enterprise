// The event contract.
//
// Every published event is a row in `stream_events` written in the same
// transaction as the change it describes, and every such row parses as one of
// the envelopes below. The client, the worker, the run engine and the tests all
// import these schemas, so "the contract" is a value that can be validated, not
// a paragraph in a document.
//
// Ids are decimal strings, not numbers: `stream_events.id` is a bigserial and
// JSON numbers lose integers past 2^53. The validator compares them as BigInt.
import { z } from 'zod';
import { refSchema } from './refs.js';
import { blockSchema } from './commands.js';
import {
  errorClassSchema,
  messageRoleSchema,
  messageStatusSchema,
  requestKindSchema,
  requestStatusSchema,
  runStatusSchema,
  runStepStateSchema,
  decisionSchema,
  sessionModeSchema,
} from './enums.js';

/** Bumped when a payload shape changes incompatibly; old rows keep their value. */
export const SCHEMA_VERSION = 1;

export const streamIdSchema = z.string().regex(/^\d{1,19}$/, 'expected a decimal stream id');
export const uuidSchema = z.uuid();

const base = {
  /** `stream_events.id`, the replay cursor. */
  id: streamIdSchema,
  workspace_id: uuidSchema,
  /** Null for workspace-scoped events; set for everything on the session socket. */
  session_id: uuidSchema.nullable(),
  schema_version: z.number().int().positive(),
  /** Correlates the event with logs, model calls and Workflow steps. */
  trace_id: z.string().min(1).max(64),
  at: z.iso.datetime({ offset: true }),
};

const event = <K extends string, P extends z.ZodType>(kind: K, payload: P) =>
  z.object({ ...base, kind: z.literal(kind), payload }).strict();

// ---------------------------------------------------------------------------
// Run events (session socket)
// ---------------------------------------------------------------------------

const runStepDescriptor = z
  .object({ id: z.string().min(1).max(64), label: z.string().min(1).max(160), state: runStepStateSchema })
  .strict();

export const runStartedSchema = event(
  'run.started',
  z
    .object({
      run_id: uuidSchema,
      session_id: uuidSchema,
      /** User-visible Retry counter; also the Workflow instance suffix. */
      attempt: z.number().int().min(1),
      engine_version: z.number().int().min(1),
      client_turn_id: z.string().min(1).max(128),
      mode: sessionModeSchema,
      model_id: z.string().min(1).max(64),
      effort: z.string().min(1).max(32).nullable(),
      title: z.string().max(200).nullable(),
      steps: z.array(runStepDescriptor).max(50),
    })
    .strict(),
);

export const runStepSchema = event(
  'run.step',
  z
    .object({
      run_id: uuidSchema,
      attempt: z.number().int().min(1),
      turn: z.number().int().min(0),
      step_id: z.string().min(1).max(64),
      label: z.string().min(1).max(160),
      state: runStepStateSchema,
      tool_call_id: z.string().min(1).max(128).nullable().optional(),
    })
    .strict(),
);

export const runErrorSchema = z
  .object({
    class: errorClassSchema,
    retryable: z.boolean(),
    reason: z.string().min(1).max(64),
    message: z.string().max(500),
    step_id: z.string().max(64).nullable().optional(),
  })
  .strict();

export const runStatusEventSchema = event(
  'run.status',
  z
    .object({
      run_id: uuidSchema,
      attempt: z.number().int().min(1),
      status: runStatusSchema,
      waiting_for: z.string().max(64).nullable().optional(),
      waiting_label: z.string().max(200).nullable().optional(),
      active_ms: z.number().int().min(0).nullable().optional(),
      error: runErrorSchema.nullable().optional(),
    })
    .strict(),
);

/**
 * Focus carries the entity id beside the ref because the session socket can
 * outrun the workspace socket: the client fetches on a cache miss and shows a
 * skeleton rather than "Request not found".
 */
export const runFocusSchema = event(
  'run.focus',
  z
    .object({
      run_id: uuidSchema.nullable(),
      session_id: uuidSchema,
      ref: refSchema,
      entity_type: z.enum(['request', 'document', 'session', 'agent', 'member', 'file']).nullable(),
      entity_id: z.string().max(128).nullable(),
    })
    .strict(),
);

export const runGuidanceAppliedSchema = event(
  'run.guidance.applied',
  z
    .object({ run_id: uuidSchema, guidance_id: uuidSchema, turn: z.number().int().min(0) })
    .strict(),
);

export const runQueueUpdatedSchema = event(
  'run.queue.updated',
  z
    .object({
      run_id: uuidSchema,
      items: z
        .array(
          z
            .object({
              id: uuidSchema,
              text: z.string().min(1).max(4000),
              status: z.enum(['queued', 'paused', 'sent', 'removed']),
              position: z.number().int().min(0),
            })
            .strict(),
        )
        .max(50),
    })
    .strict(),
);

// ---------------------------------------------------------------------------
// Message events (session socket)
// ---------------------------------------------------------------------------

export const messageAppendedSchema = event(
  'message.appended',
  z
    .object({
      message_id: uuidSchema,
      session_id: uuidSchema,
      seq: z.number().int().min(0),
      role: messageRoleSchema,
      kind: z.string().max(32).nullable(),
      text: z.string().max(100_000),
      blocks: z.array(blockSchema).max(20),
      status: messageStatusSchema,
      run_id: uuidSchema.nullable(),
    })
    .strict(),
);

/**
 * `step_attempt` is the Workflow step's own retry counter, distinct from the
 * user-visible `attempt`. Deltas from a failed step attempt stay in the outbox,
 * so the reducer discards any attempt superseded by a later `message.reset`.
 */
export const messageDeltaSchema = event(
  'message.delta',
  z
    .object({
      message_id: uuidSchema,
      run_id: uuidSchema,
      turn: z.number().int().min(0),
      attempt: z.number().int().min(1),
      step_attempt: z.number().int().min(1),
      /** Position of this delta within the turn; monotonic per (turn, step_attempt). */
      seq: z.number().int().min(0),
      delta: z.string().max(32_768),
    })
    .strict(),
);

export const messageResetSchema = event(
  'message.reset',
  z
    .object({
      run_id: uuidSchema,
      turn: z.number().int().min(0),
      attempt: z.number().int().min(1),
      step_attempt: z.number().int().min(1),
      message_id: uuidSchema.nullable(),
    })
    .strict(),
);

export const messageFinalSchema = event(
  'message.final',
  z
    .object({
      message_id: uuidSchema,
      session_id: uuidSchema,
      run_id: uuidSchema,
      turn: z.number().int().min(0),
      attempt: z.number().int().min(1),
      text: z.string().max(200_000),
      blocks: z.array(blockSchema).max(20),
      /** Values frozen at answer time so the transcript does not rewrite itself. */
      snapshots: z.record(z.string().max(64), z.unknown()).optional(),
      incomplete: z.boolean().optional(),
      worked_ms: z.number().int().min(0).nullable().optional(),
    })
    .strict(),
);

// ---------------------------------------------------------------------------
// Workspace events (workspace socket)
// ---------------------------------------------------------------------------

export const requestCreatedSchema = event(
  'request.created',
  z
    .object({
      request_id: uuidSchema,
      kind: requestKindSchema,
      status: requestStatusSchema,
      /** A label safe to show in a list; the payload itself is fetched under RLS. */
      label: z.string().max(200),
      run_id: uuidSchema.nullable(),
      session_id: uuidSchema.nullable(),
    })
    .strict(),
);

export const decisionRecordedSchema = event(
  'decision.recorded',
  z
    .object({
      request_id: uuidSchema,
      decision_id: uuidSchema,
      decision: decisionSchema,
      resulting_status: requestStatusSchema,
      decided_by: uuidSchema,
      decided_at: z.iso.datetime({ offset: true }),
      /** Effects the decision recorded as pending. None of them executed. */
      effect_ids: z.array(uuidSchema).max(20).default([]),
    })
    .strict(),
);

export const entityUpdatedSchema = event(
  'entity.updated',
  z
    .object({
      entity_type: z.enum([
        'request',
        'document',
        'session',
        'member',
        'invitation',
        'agent',
        'effect',
        'workspace_settings',
        'provider_key',
        'instruction_version',
      ]),
      entity_id: z.string().min(1).max(128),
      ref: refSchema.nullable(),
      /** Optimistic-concurrency hint; the client refetches on a newer version. */
      version: z.number().int().min(0).nullable(),
    })
    .strict(),
);

/**
 * The cursor cannot be replayed (older than the 90-day retention, or a schema
 * migration made the rows unreadable). The client refetches bootstrap.
 */
export const resyncSchema = event(
  'resync',
  z
    .object({
      stream: z.enum(['session', 'workspace']),
      reason: z.enum(['retention', 'schema', 'unknown_cursor', 'authorization_changed']),
      head: streamIdSchema,
    })
    .strict(),
);

// ---------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------

export const streamEventSchema = z.discriminatedUnion('kind', [
  runStartedSchema,
  runStepSchema,
  runStatusEventSchema,
  runFocusSchema,
  runGuidanceAppliedSchema,
  runQueueUpdatedSchema,
  messageAppendedSchema,
  messageDeltaSchema,
  messageResetSchema,
  messageFinalSchema,
  requestCreatedSchema,
  decisionRecordedSchema,
  entityUpdatedSchema,
  resyncSchema,
]);

export type StreamEvent = z.infer<typeof streamEventSchema>;
export type StreamEventKind = StreamEvent['kind'];

export const EVENT_KINDS_CONTRACT = [
  'run.started',
  'run.step',
  'run.status',
  'run.focus',
  'run.guidance.applied',
  'run.queue.updated',
  'message.appended',
  'message.delta',
  'message.reset',
  'message.final',
  'request.created',
  'decision.recorded',
  'entity.updated',
  'resync',
] as const satisfies readonly StreamEventKind[];

/**
 * Which socket carries a kind. The hub authorises per event: session-scoped
 * kinds reach only the session's owner and its share holders; workspace-scoped
 * kinds reach every member. Nothing derives this from the payload at runtime.
 */
export const EVENT_STREAM: Readonly<Record<StreamEventKind, 'session' | 'workspace' | 'either'>> = {
  'run.started': 'session',
  'run.step': 'session',
  'run.status': 'session',
  'run.focus': 'session',
  'run.guidance.applied': 'session',
  'run.queue.updated': 'session',
  'message.appended': 'session',
  'message.delta': 'session',
  'message.reset': 'session',
  'message.final': 'session',
  'request.created': 'workspace',
  'decision.recorded': 'workspace',
  'entity.updated': 'workspace',
  resync: 'either',
};

/**
 * Kinds the `agent` database role may write to `stream_events`. A Postgres
 * trigger enforces the same list; this constant exists so the CI grant test and
 * the trigger cannot silently disagree.
 */
export const AGENT_WRITABLE_EVENT_PREFIXES = ['message.', 'run.'] as const;

export const isAgentWritableKind = (kind: string): boolean =>
  AGENT_WRITABLE_EVENT_PREFIXES.some((prefix) => kind.startsWith(prefix));

export function parseStreamEvent(input: unknown): StreamEvent {
  return streamEventSchema.parse(input);
}

export function safeParseStreamEvent(input: unknown): ReturnType<typeof streamEventSchema.safeParse> {
  return streamEventSchema.safeParse(input);
}
