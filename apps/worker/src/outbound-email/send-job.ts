import { effectExecutorMode, simulationReference } from '../domain/effects.js';
import type { Env } from '../env.js';
import { publishEvents, runJobsAfterCommit, withWorkspaceTransaction, type Job } from '../jobs.js';
import { GmailApiError, rawGmailMessage, sendGmailMessage } from './gmail-api.js';
import { resolveSendingAccessToken } from './gmail-store.js';
import { gmailFetcher } from './gmail-config.js';
import { sendMicrosoftMessage } from './microsoft-api.js';
import { microsoftFetcher } from './microsoft-config.js';

const PROVIDER_NAME = { gmail: 'Gmail', microsoft: 'Microsoft' } as const;

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
  readonly state: 'pending_connection' | 'queued' | 'sending' | 'sent' | 'simulated' | 'failed' | 'ambiguous' | 'cancelled';
  readonly inbound_message_id: string | null;
  readonly in_reply_to: string | null;
  readonly references_header: string | null;
}

const OUTBOX_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Send one exact approved outbox row. Uncertain provider outcomes never retry. */
export async function runOutboundEmailSendJob(env: Env, job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as { outbox_id?: string };
  if (!payload.outbox_id || !OUTBOX_ID.test(payload.outbox_id)) throw new Error('outbound_email_job_invalid');

  const published: string[] = [];
  const prepared = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const result = await tx.query<OutboxRow>(
      `SELECT o.id,o.request_id,o.authorization_revision,o.authorization_hash,o.candidate_id,
              o.account_id,o.recipient_index,o.sender_address,o.recipient_name,o.recipient_address,
              o.subject,o.body,o.state,o.inbound_message_id,o.in_reply_to,o.references_header
         FROM outbound_email_outbox o
        WHERE o.workspace_id=$1 AND o.id=$2 FOR UPDATE`,
      [job.workspace_id, payload.outbox_id],
    );
    const row = result.rows[0];
    if (!row || ['sent', 'simulated', 'ambiguous', 'cancelled'].includes(row.state)) return null;
    // A reply to a role inbox with no connected sender is recorded as a
    // simulated delivery where the effect executor is simulated (D12, C98).
    // Production pins that mode to `unavailable`, so there it waits for a
    // mailbox like any other approved email.
    const simulate = row.inbound_message_id !== null && !row.account_id
      && (row.state === 'pending_connection' || row.state === 'queued')
      && effectExecutorMode(env) === 'simulated';
    if (!simulate && (row.state === 'pending_connection' || !row.account_id)) return null;
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
    if (simulate) {
      published.push(...await recordSimulatedReply(tx, job.workspace_id, row));
      return null;
    }
    if (!row.account_id) return null;
    const resolved = await resolveSendingAccessToken(tx, env, row.account_id);
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
      provider: resolved.account.provider,
      accessToken: resolved.token,
      raw: rawGmailMessage({
        senderAddress: row.sender_address,
        recipientName: row.recipient_name,
        recipientAddress: row.recipient_address,
        subject: row.subject,
        body: row.body,
        inReplyTo: row.in_reply_to,
        references: row.references_header,
      }),
    };
  });
  if (published.length > 0) await runJobsAfterCommit(env, job.workspace_id, published);
  if (!prepared) return;

  try {
    // The same approved bytes either way (C99); only the transport differs.
    const sent = prepared.provider === 'microsoft'
      ? await sendMicrosoftMessage(prepared.accessToken, prepared.raw, microsoftFetcher(env))
      : await sendGmailMessage(prepared.accessToken, prepared.raw, gmailFetcher(env));
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
              ? `${PROVIDER_NAME[prepared.provider]} did not confirm whether the approved email was sent. Review the mailbox before retrying.`
              : `${PROVIDER_NAME[prepared.provider]} rejected the approved email.`,
          ],
        );
      }
    });
    if (retryable) throw error;
  }
}

/**
 * Everything a real send records, marked simulated: nothing left this system.
 * The reference is what a reviewer can quote; `simulated` is never `executed`.
 */
async function recordSimulatedReply(
  tx: import('../db/client.js').Tx,
  workspaceId: string,
  row: OutboxRow,
): Promise<string[]> {
  const reference = simulationReference('email_send');
  await tx.query(
    `UPDATE outbound_email_outbox SET state='simulated',provider_message_id=$3,
        provider_response=$4::jsonb,sent_at=now(),last_error=NULL
      WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, row.id, reference, JSON.stringify({ simulated: true, reference, in_reply_to: row.in_reply_to })],
  );
  await tx.query(
    `UPDATE approval_requests SET effect_status='simulated',
         effect_reason=$3, work_status='completed', work_reason=NULL
      WHERE workspace_id=$1 AND request_id=$2`,
    [workspaceId, row.request_id, `Simulated delivery ${reference}. Nothing was sent: this environment has no connected sender and simulates email.`],
  );
  await tx.query(
    `INSERT INTO events (workspace_id,actor_type,kind,request_id)
     VALUES ($1,'system','outbound_email.simulated',$2)`,
    [workspaceId, row.request_id],
  );
  // An open approval card shows the delivery state; tell it to re-read.
  return publishEvents(tx, workspaceId, [
    { kind: 'entity.updated', payload: { entity_type: 'request', entity_id: row.request_id, ref: { section: 'inbox', view: 'request', id: row.request_id }, version: null } },
  ]);
}
