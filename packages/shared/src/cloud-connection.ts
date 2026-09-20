import { z } from 'zod';

/** Safe Settings projection: no provider identifiers, tokens, or raw errors. */
export const cloudConnectionStatusSchema = z.object({
  status: z.enum(['not_connected', 'connecting', 'connected', 'reconnect_required', 'verification_required']),
  organization_name: z.string().trim().min(1).max(200).nullable(),
  automatic_setup_ready: z.boolean(),
}).strict();
export type CloudConnectionStatus = z.infer<typeof cloudConnectionStatusSchema>;
export const cloudConnectionResponseSchema = cloudConnectionStatusSchema.extend({ available: z.boolean() });
export const cloudConnectionStartSchema = z.object({ authorization_url: z.string().url() }).strict();
