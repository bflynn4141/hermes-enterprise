// What each outside connection is doing now (docs/CONNECTORS.md), read from
// Hermes's own records. Nothing here calls a provider: a page load must not
// spend a rate limit or refresh a token. Each function reuses the loader its
// connection's own screen already uses, so the two can't disagree.
import { CONNECTOR_KEYS, connectorListSchema, type ConnectorKey, type ConnectorList, type ConnectorStatus } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';
import { gmailEvidenceConfig } from '../inbound-email/gmail-read-config.js';
import { loadGmailEvidenceAccount } from '../inbound-email/gmail-read-store.js';
import { slackConfig } from '../integrations/slack/config.js';
import { loadSlackInstallation } from '../integrations/slack/store.js';
import { gmailConfig } from '../outbound-email/gmail-config.js';
import { loadSendingAccount } from '../outbound-email/gmail-store.js';
import { microsoftConfig } from '../outbound-email/microsoft-config.js';

/** How long an approved email may wait in the queue before the account is suspect. */
export const STUCK_QUEUE_MINUTES = 30;

interface Viewer {
  readonly workspaceId: string;
  readonly admin: boolean;
}

interface OutboxCounts {
  readonly held: number;
  readonly ambiguous: number;
  readonly stuck: number;
}

async function outboxCounts(tx: Tx, workspaceId: string, where: string, params: readonly unknown[]): Promise<OutboxCounts> {
  const { rows } = await tx.query<OutboxCounts>(
    `SELECT count(*) FILTER (WHERE state IN ('pending_connection','queued','sending','ambiguous'))::int AS held,
            count(*) FILTER (WHERE state='ambiguous')::int AS ambiguous,
            count(*) FILTER (WHERE state='queued' AND updated_at < now() - ($2 || ' minutes')::interval)::int AS stuck
       FROM outbound_email_outbox
      WHERE workspace_id=$1 AND ${where}`,
    [workspaceId, String(STUCK_QUEUE_MINUTES), ...params],
  );
  return rows[0] ?? { held: 0, ambiguous: 0, stuck: 0 };
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/**
 * A sending account's state from its own row and the email it is holding.
 * The row's `error` is the provider's word; an uncertain send or a queue
 * that stopped moving is Hermes noticing before the provider says anything.
 */
export function sendingAccountState(
  accountStatus: 'disconnected' | 'connected' | 'error' | 'revoked',
  counts: OutboxCounts,
): Pick<ConnectorStatus, 'state' | 'reason'> {
  if (accountStatus === 'error') return { state: 'needs_attention', reason: 'The provider stopped accepting Hermes’s access. Reconnect the account.' };
  if (counts.ambiguous > 0) {
    return { state: 'needs_attention', reason: `${plural(counts.ambiguous, 'approved email', 'approved emails')} may or may not have gone out. A reviewer needs to check the mailbox.` };
  }
  if (counts.stuck > 0) {
    return { state: 'needs_attention', reason: `${plural(counts.stuck, 'approved email has', 'approved emails have')} waited over ${STUCK_QUEUE_MINUTES} minutes to send.` };
  }
  return { state: 'connected', reason: null };
}

async function sendingAccountStatus(tx: Tx, env: Env, viewer: Viewer, key: 'gmail_sending' | 'microsoft_sending'): Promise<ConnectorStatus> {
  const provider = key === 'gmail_sending' ? 'gmail' : 'microsoft';
  const configured = provider === 'gmail' ? gmailConfig(env) !== null : microsoftConfig(env) !== null;
  const base = { key, identity: null, waiting: 0, detail_view: 'Email' as const };
  if (!configured) return { ...base, state: 'not_configured', reason: 'This deployment has no app registered for it.' };
  const account = await loadSendingAccount(tx, viewer.workspaceId);
  if (!account || account.provider !== provider || account.status === 'revoked' || account.status === 'disconnected') {
    const other = account && account.provider !== provider && account.status !== 'revoked'
      ? `${account.provider === 'gmail' ? 'Gmail' : 'Microsoft 365'} is the sending account.`
      : null;
    return { ...base, state: 'not_connected', reason: other };
  }
  const counts = await outboxCounts(tx, viewer.workspaceId, 'account_id=$3', [account.id]);
  return {
    ...base,
    ...sendingAccountState(account.status, counts),
    identity: viewer.admin ? account.address : null,
    waiting: viewer.admin ? counts.held : 0,
  };
}

async function agentAddressStatus(tx: Tx, env: Env, viewer: Viewer): Promise<ConnectorStatus> {
  const base = { key: 'agent_address' as const, identity: null, waiting: 0, detail_view: 'Email' as const };
  const domain = env.EMAIL_INTAKE_DOMAIN?.trim();
  if (!domain) return { ...base, state: 'not_configured', reason: 'This deployment has no receiving domain for agent addresses.' };
  const { rows } = await tx.query<{ active: number; paused: number }>(
    `SELECT count(*) FILTER (WHERE status='active')::int AS active, count(*) FILTER (WHERE status='paused')::int AS paused
       FROM email_inboxes WHERE workspace_id=$1 AND kind='agent'`,
    [viewer.workspaceId],
  );
  const inboxes = rows[0] ?? { active: 0, paused: 0 };
  const identity = viewer.admin ? `@${domain}` : null;
  if (inboxes.active + inboxes.paused === 0) return { ...base, identity, state: 'not_connected', reason: 'No agent has an address yet. An agent gets one once someone owns it.' };
  if (inboxes.active === 0) return { ...base, identity, state: 'paused', reason: `${plural(inboxes.paused, 'address is', 'addresses are')} paused, so no mail is received.` };
  const counts = await outboxCounts(tx, viewer.workspaceId, 'sender_inbox_id IS NOT NULL AND account_id IS NULL', []);
  const waiting = viewer.admin ? counts.held : 0;
  // Approved replies need Cloudflare's send binding. Without it they wait,
  // or are simulated where effects are simulated; say so instead of "connected".
  if (env.EMAIL_REPLY_MODE === 'send_after_approval' && env.EMAIL === undefined) {
    return { ...base, identity, waiting, state: 'needs_attention', reason: 'Replies can be approved, but this deployment has no sending binding, so none go out.' };
  }
  if (counts.ambiguous > 0) {
    return { ...base, identity, waiting, state: 'needs_attention', reason: `${plural(counts.ambiguous, 'approved reply', 'approved replies')} may or may not have gone out. A reviewer needs to check.` };
  }
  const note = env.EMAIL_REPLY_MODE === 'send_after_approval' ? null : 'Approved replies are kept as drafts on this deployment.';
  const pausedNote = inboxes.paused > 0 ? `${plural(inboxes.paused, 'address is', 'addresses are')} paused.` : null;
  return { ...base, identity, waiting, state: 'connected', reason: [note, pausedNote].filter(Boolean).join(' ') || null };
}

async function slackStatus(tx: Tx, env: Env, viewer: Viewer): Promise<ConnectorStatus> {
  const base = { key: 'slack' as const, identity: null, waiting: 0, detail_view: 'Slack' as const };
  if (!slackConfig(env)) return { ...base, state: 'not_configured', reason: 'This deployment has no Slack app registered.' };
  const installation = await loadSlackInstallation(tx, viewer.workspaceId);
  if (!installation) return { ...base, state: 'not_connected', reason: null };
  const identity = viewer.admin ? installation.slack_enterprise_name ?? installation.slack_team_name : null;
  if (installation.status === 'error') return { ...base, identity, state: 'needs_attention', reason: 'Slack stopped accepting Hermes’s access. Reconnect it.' };
  return { ...base, identity, state: 'connected', reason: null };
}

async function gmailEvidenceStatus(tx: Tx, env: Env, viewer: Viewer): Promise<ConnectorStatus> {
  const base = { key: 'gmail_evidence' as const, identity: null, waiting: 0, detail_view: 'Email' as const };
  if (!gmailEvidenceConfig(env)) return { ...base, state: 'not_configured', reason: 'This deployment has no app registered for it.' };
  const account = await loadGmailEvidenceAccount(tx, viewer.workspaceId);
  if (!account || account.status === 'revoked') return { ...base, state: 'not_connected', reason: null };
  const identity = viewer.admin ? account.address : null;
  if (account.status === 'error') return { ...base, identity, state: 'needs_attention', reason: 'Gmail stopped accepting Hermes’s access. Reconnect it.' };
  return { ...base, identity, state: 'connected', reason: null };
}

const STATUS: Record<ConnectorKey, (tx: Tx, env: Env, viewer: Viewer) => Promise<ConnectorStatus>> = {
  gmail_sending: (tx, env, viewer) => sendingAccountStatus(tx, env, viewer, 'gmail_sending'),
  microsoft_sending: (tx, env, viewer) => sendingAccountStatus(tx, env, viewer, 'microsoft_sending'),
  agent_address: agentAddressStatus,
  slack: slackStatus,
  gmail_evidence: gmailEvidenceStatus,
};

/** Every connection, in the catalog's order. Members see states; Admins also see identities and counts. */
export async function listConnectorStatuses(tx: Tx, env: Env, viewer: Viewer): Promise<ConnectorList> {
  const connections: ConnectorStatus[] = [];
  for (const key of CONNECTOR_KEYS) connections.push(await STATUS[key](tx, env, viewer));
  return connectorListSchema.parse({ connections, can_manage: viewer.admin });
}
