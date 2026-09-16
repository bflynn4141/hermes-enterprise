import type { Env } from '../../env.js';
import { withWorkspaceTransaction, type Job } from '../../jobs.js';
import { callSlackWebApi, SlackApiError } from './api.js';
import { loadSlackInstallationById, resolveSlackAccessToken } from './store.js';

interface Delivery {
  readonly id: string;
  readonly installation_id: string;
  readonly run_id: string;
  readonly slack_channel_id: string;
  readonly slack_thread_ts: string;
  readonly status: 'pending' | 'queued' | 'sent' | 'failed' | 'cancelled';
  readonly approval_notified_at: Date | null;
  readonly approval_client_msg_id: string;
  readonly run_status: 'working' | 'waiting' | 'stopping' | 'stopped' | 'error' | 'completed';
  readonly waiting_for: string | null;
  readonly response_text: string | null;
}

/** A deliberate retry signal: the durable job remains pending while Hermes works. */
class SlackRunPendingError extends Error {
  constructor(readonly retryAfterSeconds = 30) {
    super('Slack delivery is waiting for the Hermes run');
  }
}

function finalText(delivery: Delivery): string {
  const response = delivery.response_text?.trim();
  if (response) return response.slice(0, 39_000);
  if (delivery.run_status === 'stopped') return 'This Hermes run was stopped.';
  if (delivery.run_status === 'error') return 'Hermes could not complete this run. Open Hermes for the run details.';
  return 'Hermes completed the run without a text response. Open Hermes for the full run details.';
}

const INSTALLATION_ERRORS = new Set(['invalid_auth', 'token_revoked', 'account_inactive', 'invalid_grant']);

async function recordPermanentFailure(
  env: Env,
  workspaceId: string,
  delivery: Delivery,
  error: SlackApiError,
): Promise<void> {
  await withWorkspaceTransaction(env, workspaceId, async (tx) => {
    await tx.query(
      `UPDATE slack_run_deliveries SET status='failed', attempts=attempts+1, last_error_code=$3
        WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, delivery.id, error.code],
    );
    if (INSTALLATION_ERRORS.has(error.code)) {
      await tx.query(
        `UPDATE slack_installations SET status='error', last_error_code=$3
          WHERE workspace_id=$1 AND id=$2 AND status <> 'revoked'`,
        [workspaceId, delivery.installation_id, error.code],
      );
    }
  });
}

async function slackWrite(
  env: Env,
  workspaceId: string,
  delivery: Delivery,
  token: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    return await callSlackWebApi('chat.postMessage', token, payload);
  } catch (error) {
    if (!(error instanceof SlackApiError) || error.status === 429 || error.status >= 500) throw error;
    await recordPermanentFailure(env, workspaceId, delivery, error);
    return null;
  }
}

export async function runSlackDeliverJob(env: Env, job: Job): Promise<void> {
  const payload = job.payload as { run_id?: unknown };
  if (typeof payload?.run_id !== 'string') throw new Error('slack_delivery_payload_invalid');

  const delivery = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const result = await tx.query<Delivery>(
      `SELECT d.id, d.installation_id, d.run_id, d.slack_channel_id, d.slack_thread_ts,
              d.status, d.approval_notified_at, d.approval_client_msg_id,
              r.status AS run_status, r.waiting_for,
              (SELECT m.text FROM messages m
                WHERE m.workspace_id=d.workspace_id AND m.run_id=d.run_id AND m.role='iris'
                  AND m.status='complete'
                ORDER BY m.turn DESC NULLS LAST, m.seq DESC LIMIT 1) AS response_text
         FROM slack_run_deliveries d
         JOIN runs r ON r.workspace_id=d.workspace_id AND r.id=d.run_id
        WHERE d.workspace_id=$1 AND d.run_id=$2
        FOR UPDATE OF d`,
      [job.workspace_id, payload.run_id],
    );
    return result.rows[0] ?? null;
  });
  if (!delivery || delivery.status === 'sent' || delivery.status === 'cancelled') return;
  if (delivery.run_status === 'working' || delivery.run_status === 'stopping') {
    throw new SlackRunPendingError();
  }

  let token: string;
  try {
    token = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
      const installation = await loadSlackInstallationById(tx, job.workspace_id, delivery.installation_id);
      if (!installation || installation.status !== 'connected') throw new Error('slack_installation_inactive');
      return resolveSlackAccessToken(tx, env, installation);
    });
  } catch (error) {
    if (error instanceof SlackApiError && error.status !== 429 && error.status < 500) {
      await recordPermanentFailure(env, job.workspace_id, delivery, error);
      return;
    }
    throw error;
  }

  if (delivery.run_status === 'waiting') {
    if (!delivery.approval_notified_at) {
      const posted = await slackWrite(env, job.workspace_id, delivery, token, {
        channel: delivery.slack_channel_id,
        thread_ts: delivery.slack_thread_ts,
        client_msg_id: delivery.approval_client_msg_id,
        text: 'Hermes needs your review before it can continue. Open the Hermes Inbox to approve, revise, or decline the request.',
      });
      if (!posted) return;
      await withWorkspaceTransaction(env, job.workspace_id, (tx) => tx.query(
        `UPDATE slack_run_deliveries SET approval_notified_at=now(), attempts=attempts+1,
                status='queued', last_error_code=NULL
          WHERE workspace_id=$1 AND id=$2 AND approval_notified_at IS NULL`,
        [job.workspace_id, delivery.id],
      ).then(() => undefined));
    }
    throw new SlackRunPendingError(60);
  }

  const response = await slackWrite(env, job.workspace_id, delivery, token, {
    channel: delivery.slack_channel_id,
    thread_ts: delivery.slack_thread_ts,
    client_msg_id: delivery.id,
    text: finalText(delivery),
  });
  if (!response) return;
  const messageTs = typeof response.ts === 'string' ? response.ts : null;
  await withWorkspaceTransaction(env, job.workspace_id, (tx) => tx.query(
    `UPDATE slack_run_deliveries
        SET status='sent', slack_message_ts=$3, delivered_at=now(), attempts=attempts+1,
            last_error_code=NULL
      WHERE workspace_id=$1 AND id=$2 AND status <> 'cancelled'`,
    [job.workspace_id, delivery.id, messageTs],
  ).then(() => undefined));
}
