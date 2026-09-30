import { z } from 'zod';

// One description per outside connection (docs/CONNECTORS.md). The client
// renders what each connection can read and do from `operations`, so the
// sentences here are what an Admin reads: plain, specific, and true of the
// code. A connection's executor stays in its own module; this says what it does.

export const CONNECTOR_KEYS = ['gmail_sending', 'microsoft_sending', 'agent_address', 'slack', 'gmail_evidence'] as const;
export type ConnectorKey = (typeof CONNECTOR_KEYS)[number];

export interface ConnectorOperation {
  readonly key: string;
  readonly kind: 'read' | 'write';
  /** One sentence an Admin can check against what they expect. */
  readonly plain: string;
  /** Who lets it happen: the item's own approval policy, or nobody (it runs by itself). */
  readonly gate: 'approval_policy' | 'automatic';
}

export interface ConnectorDefinition {
  readonly key: ConnectorKey;
  readonly label: string;
  readonly owner: 'workspace' | 'agent' | 'workspace_and_member';
  readonly connect: 'admin_oauth' | 'automatic';
  readonly operations: readonly ConnectorOperation[];
  /** Whether a send can end uncertain, and who settles it (Quest audit H1). */
  readonly settle: 'person' | null;
  /** How it is disconnected: at the provider too, only here, or not yet possible. */
  readonly revoke: 'remote' | 'local' | null;
}

const SEND_APPROVED_EMAIL: ConnectorOperation = {
  key: 'send_approved_email',
  kind: 'write',
  plain: 'Sends an email only after its reviewers approve the exact text',
  gate: 'approval_policy',
};

export const CONNECTORS: readonly ConnectorDefinition[] = [
  {
    key: 'gmail_sending',
    label: 'Gmail sending account',
    owner: 'workspace',
    connect: 'admin_oauth',
    operations: [SEND_APPROVED_EMAIL],
    settle: 'person',
    revoke: 'local',
  },
  {
    key: 'microsoft_sending',
    label: 'Microsoft 365 sending account',
    owner: 'workspace',
    connect: 'admin_oauth',
    operations: [SEND_APPROVED_EMAIL],
    settle: 'person',
    revoke: 'local',
  },
  {
    key: 'agent_address',
    label: 'Agent email addresses',
    owner: 'agent',
    connect: 'automatic',
    operations: [
      { key: 'receive_email', kind: 'read', plain: 'Receives mail sent to each agent’s own address', gate: 'automatic' },
      { key: 'send_approved_reply', kind: 'write', plain: 'Replies from the agent’s address only after its reviewers approve the exact text', gate: 'approval_policy' },
    ],
    settle: 'person',
    revoke: 'local',
  },
  {
    key: 'slack',
    label: 'Slack',
    owner: 'workspace_and_member',
    connect: 'admin_oauth',
    operations: [
      { key: 'read_mentions', kind: 'read', plain: 'Reads direct messages and messages that mention the agent', gate: 'automatic' },
      { key: 'post_replies', kind: 'write', plain: 'Replies in the same thread, by itself; decisions still go to the Hermes Inbox', gate: 'automatic' },
    ],
    settle: null,
    revoke: 'remote',
  },
  {
    key: 'gmail_evidence',
    label: 'Gmail (read-only)',
    owner: 'workspace',
    connect: 'admin_oauth',
    operations: [
      { key: 'import_thread', kind: 'read', plain: 'Reads one email thread at a time, when a person imports it as evidence', gate: 'automatic' },
    ],
    settle: null,
    revoke: 'local',
  },
];

export const connectorDefinition = (key: ConnectorKey): ConnectorDefinition => {
  const found = CONNECTORS.find((connector) => connector.key === key);
  if (!found) throw new Error(`unknown connector ${key}`);
  return found;
};

export const CONNECTOR_STATES = ['not_configured', 'not_connected', 'connected', 'needs_attention', 'paused'] as const;
export type ConnectorState = (typeof CONNECTOR_STATES)[number];

/** What a connection is doing now, read from Hermes's own records; no provider is called. */
export const connectorStatusSchema = z.object({
  key: z.enum(CONNECTOR_KEYS),
  state: z.enum(CONNECTOR_STATES),
  /** One plain sentence whenever the state is not simply `connected`. */
  reason: z.string().max(300).nullable(),
  /** The address or Slack workspace it acts as. Admins only. */
  identity: z.string().max(320).nullable(),
  /** Approved work this connection is holding back. Admins only; 0 otherwise. */
  waiting: z.number().int().nonnegative(),
  /** Where its own settings live: an Admin page, or Library → Connections for read-only Gmail. */
  detail_view: z.enum(['Email', 'Slack', 'Library']),
}).strict();
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;

export const connectorListSchema = z.object({
  connections: z.array(connectorStatusSchema).max(CONNECTOR_KEYS.length),
  can_manage: z.boolean(),
}).strict();
export type ConnectorList = z.infer<typeof connectorListSchema>;
