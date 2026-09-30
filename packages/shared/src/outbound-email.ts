import { z } from 'zod';

export const outboundEmailConnectionSchema = z.object({
  configured: z.boolean(),
  status: z.enum(['unavailable', 'disconnected', 'connected', 'error']),
  address: z.string().max(320).nullable(),
  /** Which service the current sending account belongs to (C99); null while none is connected. */
  provider: z.enum(['gmail', 'microsoft']).nullable(),
  /** Which services this deployment can connect: each needs its own OAuth app. */
  providers: z.object({ gmail: z.boolean(), microsoft: z.boolean() }).strict(),
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

/**
 * One recipient's delivery of an approved email, as a reviewer sees it. An
 * `ambiguous` send is one the provider never confirmed or refused: a person
 * checks the mailbox and settles it (Quest audit H1).
 */
export const emailSendSchema = z.object({
  id: z.uuid(),
  authorization_revision: z.number().int().positive(),
  recipient_name: z.string().max(200),
  recipient_address: z.string().max(320),
  sender_address: z.string().max(320),
  state: z.enum(['pending_connection', 'queued', 'sending', 'sent', 'simulated', 'failed', 'ambiguous', 'cancelled']),
  sent_at: z.iso.datetime().nullable(),
  /** Set when a person, not the provider, settled an uncertain send. */
  settled: z.object({
    outcome: z.enum(['sent', 'not_sent']),
    by_name: z.string().max(200).nullable(),
    at: z.iso.datetime(),
  }).strict().nullable(),
}).strict();
export type EmailSend = z.infer<typeof emailSendSchema>;

export const emailSendListSchema = z.object({
  sends: z.array(emailSendSchema).max(100),
  /** Whether this viewer may settle the uncertain ones. */
  can_settle: z.boolean(),
}).strict();
export type EmailSendList = z.infer<typeof emailSendListSchema>;

/**
 * A person's answer after checking the mailbox. `not_sent` does not send
 * anything: it reopens the approval so the email's reviewers approve it again.
 */
export const settleEmailSendInputSchema = z.object({
  outcome: z.enum(['sent', 'not_sent']),
  idempotency_key: z.string().min(8).max(200),
}).strict();
export type SettleEmailSendInput = z.infer<typeof settleEmailSendInputSchema>;

/**
 * After an Admin disconnects a mailbox (docs/CONNECTORS.md). Hermes deletes
 * its stored access; `waiting` approved emails had not gone out and now wait
 * for a sending account again. Removing Hermes from the Google or Microsoft
 * account itself is done in that account's own security settings.
 */
export const mailboxDisconnectSchema = z.object({
  status: z.literal('disconnected'),
  waiting: z.number().int().nonnegative(),
}).strict();
export type MailboxDisconnect = z.infer<typeof mailboxDisconnectSchema>;
