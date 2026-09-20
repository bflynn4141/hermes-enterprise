import { z } from 'zod';

export const outboundEmailConnectionSchema = z.object({
  configured: z.boolean(),
  status: z.enum(['unavailable', 'disconnected', 'connected', 'error']),
  address: z.string().max(320).nullable(),
  connected_at: z.iso.datetime().nullable(),
  pending_messages: z.number().int().nonnegative(),
  can_manage: z.boolean(),
  mode: z.enum(['draft_only', 'send_after_approval']),
  discovery_enabled: z.boolean(),
  discovery_interval_minutes: z.number().int().min(5).max(1440),
}).strict();
export type OutboundEmailConnection = z.infer<typeof outboundEmailConnectionSchema>;

export const outboundEmailOAuthStartSchema = z.object({
  authorize_url: z.url(),
  expires_at: z.iso.datetime(),
}).strict();
export type OutboundEmailOAuthStart = z.infer<typeof outboundEmailOAuthStartSchema>;
