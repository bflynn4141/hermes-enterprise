import { z } from 'zod';
import { streamIdSchema, uuidSchema } from './events.js';

export const onboardingSampleRunStateSchema = z.enum(['running', 'completed']);
export const onboardingSampleApplicationStateSchema = z.enum([
  'received',
  'researching',
  'screened',
  'needs_review',
]);
export type OnboardingSampleApplicationState = z.infer<typeof onboardingSampleApplicationStateSchema>;
export const onboardingSampleEventKindSchema = z.enum([
  'run.started',
  'application.received',
  'application.researching',
  'application.screened',
  'application.needs_review',
  'run.completed',
]);

export const onboardingSampleStartInputSchema = z
  .object({
    agent_id: uuidSchema,
    setup_attempt_id: uuidSchema,
  })
  .strict();
export type OnboardingSampleStartInput = z.infer<typeof onboardingSampleStartInputSchema>;

export const onboardingSampleApplicationSchema = z
  .object({
    id: uuidSchema,
    sample_key: z.enum(['owen', 'leah']),
    display_name: z.string().min(1).max(200),
    state: onboardingSampleApplicationStateSchema,
    sample: z.literal(true),
    score: z.number().int().min(0).max(100).nullable(),
    takeaway: z.string().max(400).nullable(),
    evidence: z.array(z.object({ label: z.string().max(120), summary: z.string().max(500) }).strict()).max(10),
    sources: z.array(z.object({ id: z.string().max(64), name: z.string().max(200), note: z.string().max(500), sample: z.literal(true) }).strict()).max(10),
    request_id: uuidSchema.nullable(),
    received_at: z.iso.datetime({ offset: true }),
    researching_at: z.iso.datetime({ offset: true }).nullable(),
    screened_at: z.iso.datetime({ offset: true }).nullable(),
    needs_review_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type OnboardingSampleApplication = z.infer<typeof onboardingSampleApplicationSchema>;

export const onboardingSampleEventSchema = z
  .object({
    id: streamIdSchema,
    run_id: uuidSchema,
    application_id: uuidSchema.nullable(),
    kind: onboardingSampleEventKindSchema,
    state: onboardingSampleApplicationStateSchema.nullable(),
    request_id: uuidSchema.nullable(),
    detail: z.string().max(500),
    at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type OnboardingSampleEvent = z.infer<typeof onboardingSampleEventSchema>;

export const onboardingSampleSnapshotSchema = z
  .object({
    run: z
      .object({
        id: uuidSchema,
        agent_id: uuidSchema,
        session_id: uuidSchema.nullable(),
        setup_attempt_id: uuidSchema,
        status: onboardingSampleRunStateSchema,
        simulation: z.literal(true),
        disclosure: z.literal('Sample data and deterministic timing. No provider, web search, outreach, or external action was used.'),
        started_at: z.iso.datetime({ offset: true }),
        completed_at: z.iso.datetime({ offset: true }).nullable(),
      })
      .strict(),
    /** Empty at first, then Owen and Leah arrive on the server timeline. */
    applications: z.array(onboardingSampleApplicationSchema).max(2),
    events: z.array(onboardingSampleEventSchema).max(100),
    cursor: z
      .object({
        after: streamIdSchema,
        head: streamIdSchema,
      })
      .strict(),
    next_poll_ms: z.number().int().min(0).max(10_000).nullable(),
  })
  .strict();
export type OnboardingSampleSnapshot = z.infer<typeof onboardingSampleSnapshotSchema>;
