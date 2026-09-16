import { z } from 'zod';

export const SLACK_CONNECTION_STATUSES = ['unavailable', 'disconnected', 'connected', 'error'] as const;
export const SLACK_INSTALLATION_KINDS = ['workspace', 'organization'] as const;

export const slackConnectionSchema = z.object({
  configured: z.boolean(),
  status: z.enum(SLACK_CONNECTION_STATUSES),
  installation_kind: z.enum(SLACK_INSTALLATION_KINDS).nullable(),
  team_name: z.string().max(200).nullable(),
  enterprise_name: z.string().max(200).nullable(),
  connected_at: z.iso.datetime().nullable(),
  granted_scopes: z.array(z.string().max(100)),
  agent: z.object({ id: z.uuid(), name: z.string().max(200) }).nullable(),
  can_manage: z.boolean(),
  reconnect_required: z.boolean(),
  behavior: z.object({
    direct_messages: z.literal('same_session'),
    channel_messages: z.literal('mention_required'),
    channel_replies: z.literal('threaded'),
    approvals: z.literal('hermes_inbox'),
  }).strict(),
}).strict();
export type SlackConnection = z.infer<typeof slackConnectionSchema>;

export const slackOAuthStartSchema = z.object({
  authorize_url: z.url(),
  expires_at: z.iso.datetime(),
}).strict();
export type SlackOAuthStart = z.infer<typeof slackOAuthStartSchema>;

export const slackDisconnectSchema = z.object({
  status: z.literal('disconnected'),
  remote_revocation: z.enum(['completed', 'pending', 'not_applicable']),
}).strict();
export type SlackDisconnect = z.infer<typeof slackDisconnectSchema>;

export const slackLinkCodeSchema = z.object({
  command: z.string().min(20).max(200),
  expires_at: z.iso.datetime(),
}).strict();
export type SlackLinkCode = z.infer<typeof slackLinkCodeSchema>;
