import type { Env } from '../env.js';
import { withWorkspaceTransaction, type Job } from '../jobs.js';
import { GmailApiError, rawGmailMessage, sendGmailMessage } from './gmail-api.js';
import { resolveGmailAccessToken } from './gmail-store.js';
import { gmailFetcher } from './gmail-config.js';

interface OutboxRow {
  readonly id: string;
  readonly request_id: string;
  readonly authorization_revision: number;
  readonly authorization_hash: string;
  readonly candidate_id: string | null;
  readonly account_id: string | null;
  readonly recipient_index: number;
  readonly sender_address: string;
  readonly recipient_name: string;
  readonly recipient_address: string;
  readonly subject: string;
  readonly body: string;
  readonly state: 'pending_connection' | 'queued' | 'sending' | 'sent' | 'failed' | 'ambiguous' | 'cancelled';
}

const OUTBOX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Send one exact approved outbox row. Uncertain provider outcomes never retry. */
export async function runOutboundEmailSendJob(env: Env, job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as { outbox_id?: string };
  if (!payload.outbox_id || !OUTBOX_ID.test(payload.outbox_id)) throw new Error('outbound_email_job_invalid');

  const prepared = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const result = await tx.query<OutboxRow>(
      `SELECT o.id,o.request_id,o.authorization_revision,o.authorization_hash,o.candidate_id,
              o.account_id,o.recipient_index,o.sender_address,o.recipient_name,o.recipient_address,
              o.subject,o.body,o.state
         FROM outbound_email_outbox o
        WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE`,
      [job.workspace_id, payload.outbox_id],
    );
    const row = result.rows[0];
    if (!row || ['sent', 'ambiguous', 'cancelled'].includes(row.state)) return null;
    if (row.state === 'pending_connection' || !row.account_id) return null;
    const authorization = await tx.query(
      `SELECT 1 FROM approval_requests
        WHERE workspace_id=$1 AND request_id=$2 AND status='approved'
          AND authorization_revision=$3 AND authorization_hash=$4`,
      [job.workspace_id, row.request_id, row.authorization_revision, row.authorization_hash],
    );
    if (authorization.rowCount !== 1) {
      await tx.query(`UPDATE outbound_email_outbox SET state='cancelled',last_error='authorization_no_longer_valid' WHERE id=$1`, [row.id]);
      return null;
    }
    const suppression = await tx.query(
      `SELECT 1 FROM contact_suppressions WHERE workspace_id=$1 AND address=$2`,
      [job.workspace_id, row.recipient_address],
    );
    if (suppression.rowCount === 1) {
      await tx.query(`UPDATE outbound_email_outbox SET state='cancelled',last_error='recipient_suppressed' WHERE id=$1`, [row.id]);
      return null;
    }
    const resolved = await resolveGmailAccessToken(tx, env, row.account_id);
    if (resolved.account.address !== row.sender_address) {
      await tx.query(`UPDATE outbound_email_outbox SET state='cancelled',last_error='sender_account_mismatch' WHERE id=$1`, [row.id]);
      return null;
    }
    await tx.query(
      `UPDATE outbound_email_outbox SET state='sending',attempt_count=attempt_count+1,last_error=NULL WHERE id=$1`,
      [row.id],
    );
    return {
      row,
      accessToken: resolved.token,
      raw: rawGmailMessage({
        senderAddress: row.sender_address,
        recipientName: row.recipient_name,
        recipientAddress: row.recipient_address,
        subject: row.subject,
        body: row.body,
      }),
    };
  });
  if (!prepared) return;

  try {
    const sent = await sendGmailMessage(prepared.accessToken, prepared.raw, gmailFetcher(env));
    await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
      const changed = await tx.query(
        `UPDATE outbound_email_outbox SET state='sent',provider_message_id=$3,provider_thread_id=$4,
            provider_response=$5::jsonb,sent_at=now(),last_error=NULL
          WHERE workspace_id=$1 AND id=$2 AND state='sending'`,
        [job.workspace_id, prepared.row.id, sent.id, sent.threadId, JSON.stringify(sent)],
      );
      if (changed.rowCount !== 1) return;
      if (prepared.row.candidate_id) {
        await tx.query(
          `UPDATE partner_engagements SET stage='sent',last_outreach_at=now()
            WHERE workspace_id=$1 AND candidate_id=$2 AND request_id=$3`,
          [job.workspace_id, prepared.row.candidate_id, prepared.row.request_id],
        );
      }
      await tx.query(
        `UPDATE approval_requests SET effect_status='executed',effect_reason='The approved email was sent.',
             work_status='completed',work_reason=NULL
          WHERE workspace_id=$1 AND request_id=$2`,
        [job.workspace_id, prepared.row.request_id],
      );
      await tx.query(
        `INSERT INTO events (workspace_id,actor_type,kind,request_id)
         VALUES ($1,'system','outbound_email.sent',$2)`,
        [job.workspace_id, prepared.row.request_id],
      );
    });
  } catch (error) {
    const retryable = error instanceof GmailApiError && error.status === 429;
    const ambiguous = !(error instanceof GmailApiError) || error.status >= 500;
    await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
      await tx.query(
        `UPDATE outbound_email_outbox SET state=$3,last_error=$4
          WHERE workspace_id=$1 AND id=$2 AND state='sending'`,
        [
          job.workspace_id,
          prepared.row.id,
          retryable ? 'queued' : ambiguous ? 'ambiguous' : 'failed',
          error instanceof Error ? error.message.slice(0, 500) : 'gmail_send_failed',
        ],
      );
      if (!retryable) {
        await tx.query(
          `UPDATE approval_requests SET effect_status='failed',effect_reason=$3,work_status='completed'
            WHERE workspace_id=$1 AND request_id=$2`,
          [
            job.workspace_id,
            prepared.row.request_id,
            ambiguous
              ? 'Gmail did not confirm whether the approved email was sent. Review the mailbox before retrying.'
              : 'Gmail rejected the approved email.',
          ],
        );
      }
    });
    if (retryable) throw error;
  }
}
