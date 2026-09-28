// Email intake: role inboxes that receive forwarded mail, and the server-owned
// facts a reviewer sees next to an agent's suggestion.
//
// The authority split is the point of this contract. The server decides what is
// true about a message (who sent it, whether the sender's domain signed it,
// whether this workspace has heard from them before, what was hidden in the
// HTML) and the agent only decides what to suggest. Nothing in an email body
// can change a fact below, and no fact below unlocks an action on its own: a
// caution only ever adds reviewers.
import { z } from 'zod';
import { uuidSchema } from './events.js';
import { roleSlugSchema } from './roles.js';

const isoDateTime = z.iso.datetime({ offset: true });
const address = z.string().trim().min(3).max(320);

/** RFC 8601 result words, plus `unknown` when our receiver recorded none. */
export const EMAIL_AUTH_RESULTS = ['pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'policy', 'unknown'] as const;
export const emailAuthResultSchema = z.enum(EMAIL_AUTH_RESULTS);
export type EmailAuthResult = z.infer<typeof emailAuthResultSchema>;

export const senderAuthenticationSchema = z.object({
  spf: emailAuthResultSchema,
  dkim: emailAuthResultSchema,
  dmarc: emailAuthResultSchema,
  /** The receiver whose Authentication-Results header we trusted, or null when none matched. */
  authserv_id: z.string().max(200).nullable(),
}).strict();
export type SenderAuthentication = z.infer<typeof senderAuthenticationSchema>;

/**
 * How this workspace knows the sender. `internal` means the sender's address
 * belongs to an active member; `known_contact` means the workspace has already
 * received mail from this exact address or sent it an approved email.
 */
export const SENDER_RELATIONSHIPS = ['internal', 'known_contact', 'new_sender'] as const;
export const senderRelationshipSchema = z.enum(SENDER_RELATIONSHIPS);
export type SenderRelationship = z.infer<typeof senderRelationshipSchema>;

/**
 * Everything the server may flag. A `caution` warning moves a suggestion onto
 * the stricter approval policy; an `info` warning is shown and changes nothing.
 */
export const EMAIL_WARNING_CODES = [
  'authentication_failed',
  'reply_to_differs',
  'lookalike_domain',
  'display_name_impersonation',
  'payment_details_change',
  'hidden_text_removed',
  'link_text_mismatch',
  'remote_images_blocked',
  'attachments_not_opened',
  'attachments_read',
] as const;
export const emailWarningCodeSchema = z.enum(EMAIL_WARNING_CODES);
export type EmailWarningCode = z.infer<typeof emailWarningCodeSchema>;

export const CAUTION_WARNING_CODES: ReadonlySet<EmailWarningCode> = new Set<EmailWarningCode>([
  'authentication_failed',
  'reply_to_differs',
  'lookalike_domain',
  'display_name_impersonation',
  'payment_details_change',
  'hidden_text_removed',
  'link_text_mismatch',
]);

export const emailWarningSchema = z.object({
  code: emailWarningCodeSchema,
  severity: z.enum(['caution', 'info']),
  detail: z.string().min(1).max(500),
}).strict();
export type EmailWarning = z.infer<typeof emailWarningSchema>;

export const senderFactsSchema = z.object({
  address,
  name: z.string().max(200).nullable(),
  domain: z.string().min(1).max(253),
  relationship: senderRelationshipSchema,
  authentication: senderAuthenticationSchema,
  reply_to: address.nullable(),
  warnings: z.array(emailWarningSchema).max(20),
}).strict();
export type SenderFacts = z.infer<typeof senderFactsSchema>;

export const hasCaution = (facts: Pick<SenderFacts, 'warnings'>): boolean =>
  facts.warnings.some((warning) => warning.severity === 'caution');

/** A link as it appeared in the message: the reviewer always sees the real destination. */
export const emailLinkSchema = z.object({
  href: z.string().max(2000),
  text: z.string().max(500),
  mismatch: z.boolean(),
}).strict();

export const emailBodySchema = z.object({
  /** Sanitized HTML: allowlisted tags, no scripts, styles, forms or remote loads. Null for plain-text mail. */
  html: z.string().max(500_000).nullable(),
  /** The visible text a person would read, which is also exactly what the agent receives. */
  text: z.string().max(200_000),
  hidden_text_removed_chars: z.number().int().nonnegative(),
  remote_images_blocked: z.number().int().nonnegative(),
  links: z.array(emailLinkSchema).max(200),
}).strict();
export type EmailBody = z.infer<typeof emailBodySchema>;

/** Why an attachment's text was not read. */
export const ATTACHMENT_UNREAD_REASONS = ['type_not_supported', 'too_large', 'no_text', 'unreadable', 'limit_reached'] as const;

export const emailAttachmentSchema = z.object({
  filename: z.string().max(255),
  content_type: z.string().max(200),
  size: z.number().int().nonnegative(),
  /**
   * The text the agent read, capped, or null. The reviewer can open exactly
   * this; the agent receives it as untrusted, like the email body.
   */
  text: z.string().max(20_000).nullable().default(null),
  unread_reason: z.enum(ATTACHMENT_UNREAD_REASONS).nullable().default(null),
}).strict();

/**
 * What the agent took from an email: a short summary and the action items in
 * it (C100). `owner` says whose move it is: `us`, the team that received it,
 * or `them`, the sender. A due date only when the email gives one. It is the
 * agent's reading of untrusted text, shown as such; it never acts by itself.
 */
export const emailActionItemSchema = z.object({
  text: z.string().trim().min(1).max(300),
  owner: z.enum(['us', 'them']),
  due: z.string().trim().min(1).max(80).nullable().optional(),
}).strict();
export const emailBriefSchema = z.object({
  summary: z.string().trim().min(1).max(600),
  action_items: z.array(emailActionItemSchema).max(12),
}).strict();
export type EmailBrief = z.infer<typeof emailBriefSchema>;

export const INBOUND_EMAIL_STATUSES = ['received', 'triaging', 'suggested', 'no_action', 'failed'] as const;

export const inboundEmailViewSchema = z.object({
  id: uuidSchema,
  inbox: z.object({
    id: uuidSchema,
    address,
    label: z.string().min(1).max(120),
    /** Null for an agent's own address while the agent has no role (C100). */
    role_slug: roleSlugSchema.nullable(),
  }).strict(),
  received_at: isoDateTime,
  subject: z.string().max(998),
  message_id: z.string().max(998).nullable(),
  to: z.array(address).max(100),
  cc: z.array(address).max(100),
  sender: senderFactsSchema,
  body: emailBodySchema,
  attachments: z.array(emailAttachmentSchema).max(50),
  status: z.enum(INBOUND_EMAIL_STATUSES),
  request_ids: z.array(uuidSchema).max(10),
  /** The agent's summary and action items, once it has read the email. */
  brief: emailBriefSchema.nullable().default(null),
}).strict();
export type InboundEmailView = z.infer<typeof inboundEmailViewSchema>;

export const emailInboxSchema = z.object({
  id: uuidSchema,
  address,
  label: z.string().min(1).max(120),
  /**
   * `agent`: the agent's own address, created with it, which its approved
   * replies are sent from (C100). `role`: an address an Admin made for a role
   * under C98, still working as before.
   */
  kind: z.enum(['agent', 'role']),
  /** For an agent's address, the agent's role; null while it has none. */
  role_slug: roleSlugSchema.nullable(),
  agent: z.object({ id: uuidSchema, name: z.string().max(200) }).strict(),
  status: z.enum(['active', 'paused']),
  created_at: isoDateTime,
  message_count: z.number().int().nonnegative(),
  latest_received_at: isoDateTime.nullable(),
}).strict();
export type EmailInbox = z.infer<typeof emailInboxSchema>;

export const emailInboxListSchema = z.object({
  /** Null when this deployment has no receiving domain configured. */
  domain: z.string().max(253).nullable(),
  inboxes: z.array(emailInboxSchema).max(100),
  can_manage: z.boolean(),
}).strict();
export type EmailInboxList = z.infer<typeof emailInboxListSchema>;

export const createEmailInboxInputSchema = z.object({
  role_slug: roleSlugSchema,
  agent_id: uuidSchema,
  label: z.string().trim().min(1).max(120),
}).strict();
export type CreateEmailInboxInput = z.infer<typeof createEmailInboxInputSchema>;

/**
 * One row of an inbox's recent mail. `can_retry` is the server's answer to
 * whether Try again would do anything: the agent's run failed before it
 * suggested anything, or its job stopped before starting one.
 */
export const inboundEmailListItemSchema = inboundEmailViewSchema.pick({
  id: true, received_at: true, subject: true, sender: true, status: true, request_ids: true, brief: true,
}).extend({
  can_retry: z.boolean(),
  /** Hermes will try again by itself shortly (a provider was busy). */
  retrying: z.boolean().default(false),
  /** `daily_limit`: the agent read its daily number of emails; a person can have it read this one now (C100). */
  problem: z.enum(['provider_busy', 'needs_setup', 'no_owner', 'inbox_paused', 'daily_limit', 'other']).nullable().default(null),
});
export type InboundEmailListItem = z.infer<typeof inboundEmailListItemSchema>;

export const inboundEmailListSchema = z.object({
  messages: z.array(inboundEmailListItemSchema).max(100),
}).strict();
export type InboundEmailList = z.infer<typeof inboundEmailListSchema>;

/**
 * What the agent may say when it suggests a reply. Recipients, sender, subject
 * and threading headers are not here on purpose: the server copies them from the
 * message it verified, so an instruction hidden in an email cannot redirect a
 * reply to a new address.
 */
export const suggestEmailReplyInputSchema = z.object({
  summary: z.string().trim().min(1).max(1000),
  body: z.string().trim().min(1).max(10_000),
  /** What the email says and asks, for the person reviewing it. */
  brief: emailBriefSchema.optional(),
}).strict();
export type SuggestEmailReplyInput = z.infer<typeof suggestEmailReplyInputSchema>;

/** Hand the message to another role's queue. The receiving people are server-selected. */
export const suggestEmailHandoffInputSchema = z.object({
  role_slug: roleSlugSchema,
  summary: z.string().trim().min(1).max(1000),
  note: z.string().trim().min(1).max(4000),
  /** What the email says and asks, for the people it is handed to. */
  brief: emailBriefSchema.optional(),
}).strict();
export type SuggestEmailHandoffInput = z.infer<typeof suggestEmailHandoffInputSchema>;

/**
 * Approval resources a reply binds (C98). Registered by the server when an
 * inbox is created and when a message is triaged, owned by the inbox agent's
 * principal, so the approval engine can tell a reply from other email.
 */
export const emailInboxResourceKey = (inboxId: string): string => `email-inbox:${inboxId}`;
export const emailCautionResourceKey = (inboxId: string): string => `email-inbox:${inboxId}:caution`;
export const emailMessageResourceKey = (messageId: string): string => `email-message:${messageId}`;

/**
 * The only tools a run reading a received email may call (C98), and the only
 * tools a hosted bridge may accept beyond its pinned role binding. The bridge
 * mirrors this list in runtime/hermes/enterprise_bridge/cloud_managed.py.
 */
export const EMAIL_INTAKE_TOOL_NAMES = ['suggest_reply', 'suggest_handoff', 'get_workspace_context'] as const;

/** Sent by a bridge revision that accepts the intake tools: `GET /tools?features=email-intake`. */
export const EMAIL_INTAKE_RUNTIME_FEATURE = 'email-intake';
