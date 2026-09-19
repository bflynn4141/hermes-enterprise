import type { ApprovalPayload } from '@hermes/shared';
import type { Tx } from '../db/client.js';

export interface QueuedEmailOutbox {
  readonly ids: readonly string[];
  readonly state: 'pending_connection' | 'queued';
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
    const suppressed = await tx.query(
      `SELECT 1 FROM contact_suppressions WHERE workspace_id=$1 AND address=$2 LIMIT 1`,
      [input.workspaceId, recipient.address.trim().toLowerCase()],
    );
    if (suppressed.rowCount === 1) throw new Error('approved_email_recipient_suppressed');
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO outbound_email_outbox
         (workspace_id,request_id,authorization_revision,authorization_hash,candidate_id,
          account_id,recipient_index,sender_address,recipient_name,recipient_address,
          subject,body,state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (workspace_id,request_id,authorization_revision,authorization_hash,recipient_index)
       DO UPDATE SET id=outbound_email_outbox.id
       RETURNING id`,
      [
        input.workspaceId, input.requestId, input.authorizationRevision, input.authorizationHash,
        recipient.candidate_id ?? null, accountId, recipientIndex, sender,
        recipient.name, recipient.address.trim().toLowerCase(),
        input.payload.details.subject ?? '', input.payload.details.body, state,
      ],
    );
    if (inserted.rows[0]) ids.push(inserted.rows[0].id);
  }
  return { ids, state };
}
