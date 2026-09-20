import { z } from 'zod';

const isoDateTime = z.iso.datetime({ offset: true });

/**
 * A Gmail connection used only to fetch a thread an Admin explicitly selects.
 * It is deliberately a different contract from the outbound sender connection.
 */
export const inboundEmailConnectionSchema = z.object({
  configured: z.boolean(),
  status: z.enum(['unavailable', 'disconnected', 'connected', 'error']),
  address: z.string().max(320).nullable(),
  connected_at: isoDateTime.nullable(),
  latest_import_at: isoDateTime.nullable(),
  imported_threads: z.number().int().nonnegative(),
  can_manage: z.boolean(),
  authorization: z.literal('separate_read_only'),
  scope: z.literal('gmail.readonly'),
  selection: z.literal('one_thread_per_import'),
}).strict();
export type InboundEmailConnection = z.infer<typeof inboundEmailConnectionSchema>;

export const inboundEmailOAuthStartSchema = z.object({
  authorize_url: z.url(),
  expires_at: isoDateTime,
}).strict();
export type InboundEmailOAuthStart = z.infer<typeof inboundEmailOAuthStartSchema>;

export const inboundEmailThreadImportInputSchema = z.object({
  agent_id: z.uuid(),
  thread_id: z.string().trim().min(4).max(256).regex(/^[A-Za-z0-9_-]+$/),
  title: z.string().trim().min(1).max(200).optional(),
}).strict();
export type InboundEmailThreadImportInput = z.infer<typeof inboundEmailThreadImportInputSchema>;

export const inboundEmailThreadImportSchema = z.object({
  kind: z.literal('mailbox_thread_snapshot'),
  snapshot_id: z.uuid(),
  source_id: z.uuid(),
  version_id: z.uuid(),
  version: z.number().int().positive(),
  team_id: z.uuid(),
  team_name: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
  provider_thread_id: z.string().min(1).max(256),
  message_count: z.number().int().positive().max(250),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  imported_at: isoDateTime,
  created: z.boolean(),
  events: z.object({
    replies: z.number().int().nonnegative(),
    bounces: z.number().int().nonnegative(),
    unsubscribes: z.number().int().nonnegative(),
    sends_enqueued: z.literal(0),
  }).strict(),
}).strict();
export type InboundEmailThreadImport = z.infer<typeof inboundEmailThreadImportSchema>;

/** Evidence that a person says an access/signature action happened elsewhere.
 * The receipt never claims that Hermes or the external provider executed it. */
export const externalEffectEvidenceInputSchema = z.object({
  snapshot_id: z.uuid(),
  occurred_at: isoDateTime,
  note: z.string().trim().min(1).max(2000),
}).strict();
export type ExternalEffectEvidenceInput = z.infer<typeof externalEffectEvidenceInputSchema>;

export const externalEffectEvidenceReceiptSchema = z.object({
  id: z.uuid(),
  effect_id: z.uuid(),
  effect_kind: z.enum(['access_grant', 'signature']),
  snapshot_id: z.uuid(),
  snapshot_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  claimed_outcome: z.literal('completed_outside_hermes'),
  verification: z.literal('evidence_recorded_not_provider_verified'),
  provider_execution_by_hermes: z.literal(false),
  occurred_at: isoDateTime,
  note: z.string().min(1).max(2000),
  recorded_by: z.uuid(),
  recorded_at: isoDateTime,
}).strict();
export type ExternalEffectEvidenceReceipt = z.infer<typeof externalEffectEvidenceReceiptSchema>;
