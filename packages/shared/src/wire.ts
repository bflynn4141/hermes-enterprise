// The shapes the Worker actually answers with, as built.
//
// `entities.ts` describes the objects; this file describes the few *envelopes*
// the M2/M3 routes wrap them in, plus the WebSocket frame. They live here
// rather than in the client because the contract is the place a shape is
// agreed, and because the run-engine tests assert against the same schemas.
//
// Everything here was read off `apps/worker/src/routes/*.ts` and
// `apps/worker/src/hubs.ts` during the client integration; where a planned
// shape and the built one differ, the built one wins and the difference is
// recorded in docs/DECISIONS.md (C series).
import { z } from 'zod';
import { streamEventSchema, streamIdSchema, uuidSchema } from './events.js';
import { runQueueItemSchema } from './entities.js';
import { maskedProviderKeySchema } from './provider-keys.js';
import { runStatusSchema } from './enums.js';

/**
 * What every run control answers: `POST turns`, `stop`, `retry`.
 *
 * The planned `turnResponseSchema` carried `client_turn_id` and `duplicate`;
 * the Worker answers `runView(run)` instead, and the duplicate case is a 200
 * rather than a 201, which the client reads off the status code.
 */
export const runViewSchema = z
  .object({ run_id: uuidSchema, status: runStatusSchema, attempt: z.number().int().min(1) })
  .strict();
export type RunView = z.infer<typeof runViewSchema>;

/** `POST /w/:ws/sessions/:id/runs/:runId/guide`. */
export const guidanceAcceptedSchema = z
  .object({ guidance_id: uuidSchema, status: z.string().max(32) })
  .strict();
export type GuidanceAccepted = z.infer<typeof guidanceAcceptedSchema>;

/** Every queue mutation answers the whole queue, not a delta. */
export const queueStateSchema = z.object({ items: z.array(runQueueItemSchema).max(50) }).strict();
export type QueueState = z.infer<typeof queueStateSchema>;

/** `POST /w/:ws/sessions/:id/runs/:runId/context`. */
export const contextAnsweredSchema = z.object({ ok: z.boolean(), key: z.string().max(64) }).strict();

const verificationSchema = z.object({ status: z.string().max(32), reason: z.string().max(64) }).strict();

/** `POST /w/:ws/provider-keys` and `POST .../rotate`. */
export const providerKeyMutationSchema = z
  .object({
    key: maskedProviderKeySchema,
    verification: verificationSchema,
    replaces_key_id: uuidSchema.nullable().optional(),
  })
  .strict();
export type ProviderKeyMutation = z.infer<typeof providerKeyMutationSchema>;

/** `POST /w/:ws/provider-keys/:id/verify`. */
export const providerKeyVerifySchema = z
  .object({
    key_id: uuidSchema,
    status: z.string().max(32),
    reason: z.string().max(64),
    /**
     * Present only for a provider whose verification also syncs a model list
     * (brokered model gateways). `count` is how many catalog rows the sync wrote.
     */
    synced: z
      .object({ count: z.number().int().nonnegative(), at: z.iso.datetime() })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();

/** `DELETE /w/:ws/provider-keys/:id`. */
export const providerKeyRemovedSchema = z
  .object({ key: maskedProviderKeySchema, stopped_runs: z.array(uuidSchema).max(200) })
  .strict();

/** `PUT /w/:ws/attachments/:id/upload` — the dev-only direct route. */
export const directUploadResultSchema = z.object({ ok: z.boolean(), size: z.number().int().min(0) }).strict();

// ---------------------------------------------------------------------------
// The WebSocket frame
// ---------------------------------------------------------------------------

/**
 * A hub frame.
 *
 * The plan described one event per frame; the hubs batch, because `publish`
 * fans one committed batch out to every socket and sending N frames for N
 * events in one transaction costs N wakeups. `ticket.accepted` is the reply to
 * the four-minute re-ticket. `pong` is not here: the Durable Object's
 * auto-response pair answers it as a bare string without waking the object.
 */
export const hubFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('events'), events: z.array(streamEventSchema).max(500) }).strict(),
  z.object({ type: z.literal('ticket.accepted'), authorized_until: z.number() }).strict(),
]);
export type HubFrame = z.infer<typeof hubFrameSchema>;

/** What the client may send a hub. The key is `ticket`, not `value`. */
export const hubClientMessageSchema = z
  .object({ type: z.literal('ticket'), ticket: z.string().max(400) })
  .strict();

/**
 * The replay stream selector the Worker accepts.
 *
 * `GET /w/:ws/events?stream=` reads `session` or `workspace` and filters the
 * session stream to what the caller may see; it takes no session id, so a
 * client watching one session replays every session it owns and drops the rows
 * for the others by `session_id`.
 */
export const replayStreamSchema = z.enum(['session', 'workspace']);
export type ReplayStream = z.infer<typeof replayStreamSchema>;

export const streamHeadsSchema = z
  .object({ workspace: streamIdSchema, session: streamIdSchema.optional() })
  .strict();
