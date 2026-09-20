// Recovery is read separately from output: a provider can fail before there is
// a message or a tool step. Capability flags are computed by tenant admission.
import { z } from 'zod';
import { uuidSchema } from './events.js';

export const agentRecoveryViewSchema = z.object({
  state: z.enum(['idle', 'queued', 'working', 'waiting', 'retryable', 'retry_scheduled', 'blocked', 'stopped']),
  run_id: uuidSchema.nullable(),
  session_id: uuidSchema.nullable(),
  attempt: z.number().int().min(1).nullable(),
  model_id: z.string().max(128).nullable(),
  message: z.string().max(2000),
  next_retry_at: z.iso.datetime({ offset: true }).nullable(),
  can_retry: z.boolean(),
  can_run_now: z.boolean(),
  can_cancel: z.boolean(),
}).strict();

export type AgentRecoveryView = z.infer<typeof agentRecoveryViewSchema>;

export const agentWakeInputSchema = z.object({
  action: z.enum(['retry', 'run_now', 'cancel_retry']),
  run_id: uuidSchema.optional(),
  expected_attempt: z.number().int().min(1).optional(),
  idempotency_key: uuidSchema,
}).strict();

export type AgentWakeInput = z.infer<typeof agentWakeInputSchema>;
