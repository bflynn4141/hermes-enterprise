import { z } from 'zod';
import { uuidSchema } from './events.js';

export const partnerWatchBudgetSchema = z.object({
  max_cost_usd_per_run: z.number().min(0.01).max(0.25),
  max_cost_usd_per_day: z.number().min(0.01).max(1),
  max_model_calls: z.number().int().min(1).max(8),
}).strict();

export const partnerWatchSettingsSchema = partnerWatchBudgetSchema.extend({
  enabled: z.boolean(),
  source_id: z.string().regex(/^(query|url):[0-9]$/),
}).strict();
export type PartnerWatchSettings = z.infer<typeof partnerWatchSettingsSchema>;

export const partnerWatchUpdateSchema = partnerWatchSettingsSchema.extend({
  revision: z.number().int().positive(),
  interval_minutes: z.number().int().min(60).max(1440),
}).strict().refine((value) => value.max_cost_usd_per_day >= value.max_cost_usd_per_run, {
  message: 'The daily budget must cover one run.',
});
export type PartnerWatchUpdate = z.infer<typeof partnerWatchUpdateSchema>;

const source = z.object({ id: z.string(), label: z.string().max(300) }).strict();
export const partnerWatchSchema = z.object({
  agent_id: uuidSchema,
  assignment_id: uuidSchema.nullable(),
  revision: z.number().int().positive().nullable(),
  enabled: z.boolean(),
  execution_mode: z.enum(['live', 'simulated']),
  interval_minutes: z.number().int(),
  selected_source: source.nullable(),
  source_options: z.array(source).max(13),
  max_api_requests: z.number().int(),
  budget: partnerWatchBudgetSchema,
  state: z.enum(['unconfigured', 'paused', 'ready', 'checking', 'working', 'needs_attention']),
  may_configure: z.boolean(),
  may_run: z.boolean(),
  blocked_reason: z.string().max(500).nullable(),
  next_check_at: z.iso.datetime({ offset: true }).nullable(),
  latest_review: z.object({id:uuidSchema,created_at:z.iso.datetime({offset:true})}).strict().nullable(),
  last_check: z.object({
    id: uuidSchema,
    checked_at: z.iso.datetime({ offset: true }),
    status: z.enum(['checking', 'baseline', 'unchanged', 'changed', 'failed', 'cancelled']),
    candidates_checked: z.number().int(),
    changed_candidates: z.number().int(),
    run_id: uuidSchema.nullable(),
    session_id: uuidSchema.nullable(),
    review_id: uuidSchema.nullable(),
    error_code: z.string().nullable(),
  }).strict().nullable(),
}).strict();
export type PartnerWatch = z.infer<typeof partnerWatchSchema>;
