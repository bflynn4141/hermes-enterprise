import { hasCaution, senderFactsSchema, type ApprovalPayload } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { RouteError } from '../routes/errors.js';

export interface QueuedEmailOutbox {
  readonly ids: readonly string[];
  readonly state: 'pending_connection' | 'queued';
  /** A reply to a role inbox, which the send job may simulate outside production (D12, C98). */
  readonly reply: boolean;
}

/**
 * Persist the exact approved communication before any provider is called.
 *
 * Provider delivery is intentionally a later seam. A connected account makes
 * the row queueable; without one, the approved email remains visibly waiting
 * for that sender's mailbox instead of falling back to a different identity.
 */
export async function queueApprovedEmail(
  tx: Tx,
  input: {
    workspaceId: string;
    requestId: string;
    authorizationRevision: number;
    authorizationHash: string;
    payload: ApprovalPayload;
  },
): Promise<QueuedEmailOutbox | null> {
  if (input.payload.approval_type !== 'communication' || input.payload.details.draft_only) return null;
  if (input.payload.details.channel !== 'email') return null;

  const thread = await replyThread(tx, input.workspaceId, input.payload);
  const sender = input.payload.details.sender.address.trim().toLowerCase();
  const account = await tx.query<{ id: string }>(
    `SELECT id FROM outbound_email_accounts
      WHERE workspace_id=$1 AND address=$2 AND provider='gmail' AND status='connected'
      LIMIT 1`,
    [input.workspaceId, sender],
  );
  const accountId = account.rows[0]?.id ?? null;
  const state = accountId ? 'queued' as const : 'pending_connection' as const;
  const ids: string[] = [];

  for (const [recipientIndex, recipient] of input.payload.details.recipients.entries()) {
    if (!recipient.address) throw new Error('approved_email_recipient_missing');
    if (recipient.candidate_id) {
      const stopped = await tx.query<{ stage: string }>(
        `SELECT stage FROM partner_engagements
          WHERE workspace_id=$1 AND candidate_id=$2 AND stage IN ('replied','suppressed')
          LIMIT 1`,
        [input.workspaceId, recipient.candidate_id],
      );
      if (stopped.rows[0]?.stage === 'replied') throw new Error('approved_email_recipient_replied');
      if (stopped.rows[0]?.stage === 'suppressed') throw new Error('approved_email_recipient_suppressed');
    }
    const suppressed = await tx.query(
      `SELECT 1 FROM contact_suppressions WHERE workspace_id=$1 AND address=$2 LIMIT 1`,
      [input.workspaceId, recipient.address.trim().toLowerCase()],
    );
    if (suppressed.rowCount === 1) throw new Error('approved_email_recipient_suppressed');
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO outbound_email_outbox
         (workspace_id,request_id,authorization_revision,authorization_hash,candidate_id,
          account_id,recipient_index,sender_address,recipient_name,recipient_address,
          subject,body,state,inbound_message_id,in_reply_to,references_header)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (workspace_id,request_id,authorization_revision,authorization_hash,recipient_index)
       DO UPDATE SET id=outbound_email_outbox.id
       RETURNING id`,
      [
        input.workspaceId, input.requestId, input.authorizationRevision, input.authorizationHash,
        recipient.candidate_id ?? null, accountId, recipientIndex, sender,
        recipient.name, recipient.address.trim().toLowerCase(),
        input.payload.details.subject ?? '', input.payload.details.body, state,
        thread?.messageId ?? null, thread?.inReplyTo ?? null, thread?.references ?? null,
      ],
    );
    if (inserted.rows[0]) ids.push(inserted.rows[0].id);
  }
  return { ids, state, reply: thread !== null };
}

interface ReplyThread {
  readonly messageId: string;
  readonly inReplyTo: string | null;
  readonly references: string | null;
}

/**
 * The received message an approved reply answers (C98), re-read at the moment
 * of approval. Two properties are checked again here rather than trusted from
 * the proposal: the reply still goes only to the address that sent the
 * message, so a revision cannot redirect it, and a flagged sender's reply was
 * approved under the stricter policy.
 */
async function replyThread(tx: Tx, workspaceId: string, payload: ApprovalPayload): Promise<ReplyThread | null> {
  if (payload.approval_type !== 'communication' || !payload.details.reply_to) return null;
  const reply = payload.details.reply_to;
  const found = await tx.query<{ id: string; from_address: string; message_id: string | null; references_header: string | null; sender_facts: unknown }>(
    `SELECT id, from_address, message_id, references_header, sender_facts
       FROM inbound_email_messages
      WHERE workspace_id=$1 AND id=$2 AND inbox_id=$3`,
    [workspaceId, reply.message_id, reply.inbox_id],
  );
  const message = found.rows[0];
  if (!message) throw new RouteError('The email this reply answers is no longer stored, so the reply was not queued.', 'reply_source_missing', 409);
  const recipients = payload.details.recipients;
  if (recipients.length !== 1 || recipients[0]?.address?.trim().toLowerCase() !== message.from_address) {
    throw new RouteError('A reply can only go to the address that sent the email. Change the recipient back or write a new message.', 'reply_recipient_changed', 409);
  }
  const facts = senderFactsSchema.safeParse(message.sender_facts);
  if (!facts.success || hasCaution(facts.data) !== reply.caution) {
    throw new RouteError('This reply was reviewed under the wrong rule for its sender. Ask the agent for a new suggestion.', 'reply_caution_mismatch', 409);
  }
  const references = [...(message.references_header?.split(/\s+/u) ?? []), ...(message.message_id ? [message.message_id] : [])]
    .filter((id) => id.length > 0)
    .slice(-50)
    .join(' ');
  return { messageId: message.id, inReplyTo: message.message_id, references: references || null };
}
