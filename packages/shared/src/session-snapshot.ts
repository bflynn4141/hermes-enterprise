// One committed boundary for selected-session hydration and subsequent replay.
// This is durable application state; reading it never resumes a provider run.
import { z } from 'zod';
import { messageSchema, paginatedSchema, runSchema, sessionSchema } from './entities.js';
import { streamIdSchema, uuidSchema } from './events.js';

export const sessionSettingsSchema = z.object({
  model_id: z.string().min(1).max(64),
  effort: z.string().min(1).max(32).nullable(),
}).strict();
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;

export const sessionSnapshotRunSchema = runSchema.extend({
  model_id: z.string().min(1).max(64),
  effort: z.string().max(32).nullable(),
  /** Admission origin for this attempt, also exposed as Run.started_at. */
  admitted_at: z.iso.datetime({ offset: true }),
  /** Null until this attempt has entered execution; never the old retry's clock. */
  execution_started_at: z.iso.datetime({ offset: true }).nullable(),
  ended_at: z.iso.datetime({ offset: true }).nullable(),
});

export const sessionSnapshotStreamSchema = z.object({
  run_id: uuidSchema,
  attempt: z.number().int().positive(),
  turn: z.number().int().nonnegative(),
  step_attempt: z.number().int().positive(),
  message_id: uuidSchema.nullable(),
  /** Cumulative committed text, excluding best-effort previews. */
  text: z.string().max(200_000),
  /** Last contiguous durable delta; -1 immediately after a reset. */
  seq: z.number().int().min(-1),
  status: z.enum(['streaming', 'final']),
}).strict();

export const sessionSnapshotSchema = z.object({
  workspace_id: uuidSchema,
  session: sessionSchema,
  messages: paginatedSchema(messageSchema),
  run: sessionSnapshotRunSchema.nullable(),
  stream: sessionSnapshotStreamSchema.nullable(),
  /** Retry admission remains authoritative for eligibility and safety checks. */
  recovery: z.object({
    next_retry_at: z.iso.datetime({ offset: true }).nullable(),
    not_before: z.iso.datetime({ offset: true }).nullable(),
    cancelled: z.boolean(),
    blocked_reason: z.string().max(128).nullable(),
  }).strict().nullable(),
  /** Apply the snapshot atomically, then apply only events beyond this id. */
  watermark: streamIdSchema,
}).strict().superRefine((snapshot, context) => {
  if (snapshot.run && (snapshot.run.session_id !== snapshot.session.id || snapshot.run.agent_id !== snapshot.session.agent_id)) {
    context.addIssue({ code: 'custom', path: ['run'], message: 'Run must belong to the selected session and agent' });
  }
  if (snapshot.stream && (!snapshot.run || snapshot.stream.run_id !== snapshot.run.id || snapshot.stream.attempt !== snapshot.run.attempt)) {
    context.addIssue({ code: 'custom', path: ['stream'], message: 'Stream must belong to the selected run attempt' });
  }
  if (snapshot.messages.items.some((message) => message.session_id !== snapshot.session.id)) {
    context.addIssue({ code: 'custom', path: ['messages'], message: 'Messages must belong to the selected session' });
  }
});
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;
export type SessionSnapshotStream = z.infer<typeof sessionSnapshotStreamSchema>;
