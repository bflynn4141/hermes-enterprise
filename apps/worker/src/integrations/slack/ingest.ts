import type { Env } from '../../env.js';
import type { Tx } from '../../db/client.js';
import { enqueueJob, runJobsAfterCommit, withWorkspaceTransaction, type Job } from '../../jobs.js';
import { runtimeBinding } from '../../runtime/config.js';
import { createRunInstance, submitTurn, type RunInstanceParams, type TurnSession } from '../../runs/submit.js';
import { loadSlackInstallationById } from './store.js';
import { resolveSlackAccessToken } from './store.js';
import { callSlackWebApi } from './api.js';
import { resolveLinkedSlackPrincipal, resolveSlackAgent } from './principal.js';
import { sha256Hex } from './security.js';

export interface SlackMessageEventPayload {
  readonly installation_id: string;
  readonly slack_event_row_id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly user_id: string;
  readonly channel_id: string;
  readonly channel_type: string | null;
  readonly text: string;
  readonly ts: string;
  readonly thread_ts: string | null;
  readonly subtype: string | null;
  readonly bot_id: string | null;
}

function cleanSlackText(text: string, botUserId: string): string {
  return text.replace(new RegExp(`<@${botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, 'g'), '').trim();
}

async function sessionForEvent(
  tx: Tx,
  env: Env,
  workspaceId: string,
  input: SlackMessageEventPayload,
  principal: { user_id: string; agent_id: string; agent_name: string },
): Promise<TurnSession> {
  const kind = input.channel_type === 'im' ? 'direct_message' : 'channel_thread';
  const conversationKey = kind === 'direct_message' ? 'dm' : (input.thread_ts ?? input.ts);
  const existing = await tx.query<{ session_id: string; owner_id: string; agent_id: string }>(
    `SELECT session_id, owner_id, agent_id FROM slack_conversations
      WHERE workspace_id=$1 AND installation_id=$2 AND slack_channel_id=$3 AND conversation_key=$4
      FOR UPDATE`,
    [workspaceId, input.installation_id, input.channel_id, conversationKey],
  );
  const mapped = existing.rows[0];
  if (mapped && (mapped.owner_id !== principal.user_id || mapped.agent_id !== principal.agent_id)) {
    throw new Error('slack_thread_owned_by_another_member');
  }
  let sessionId = mapped?.session_id ?? null;
  if (!sessionId) {
    const settings = await tx.query<{ default_model_id: string; default_effort: string | null; default_runtime: string }>(
      `SELECT default_model_id, default_effort, default_runtime FROM workspace_settings WHERE workspace_id=$1`,
      [workspaceId],
    );
    const defaults = settings.rows[0];
    if (!defaults) throw new Error('workspace_settings_missing');
    const runtime = env.AGENT_RUNTIME === 'hermes'
      ? (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/])/.test(runtimeBinding(env, workspaceId, principal.agent_id).baseUrl) ? 'local' : 'cloud')
      : defaults.default_runtime;
    const title = kind === 'direct_message' ? `Slack · ${principal.agent_name}` : `Slack thread · ${input.channel_id}`;
    const created = await tx.query<{ id: string }>(
      `INSERT INTO sessions (workspace_id, owner_id, agent_id, title, mode, model_id, effort, runtime)
       VALUES ($1,$2,$3,$4,'work',$5,$6,$7) RETURNING id`,
      [workspaceId, principal.user_id, principal.agent_id, title.slice(0, 120), defaults.default_model_id, defaults.default_effort, runtime],
    );
    sessionId = created.rows[0]?.id ?? null;
    if (!sessionId) throw new Error('slack_session_create_failed');
    await tx.query(
      `INSERT INTO slack_conversations
         (workspace_id, installation_id, slack_channel_id, conversation_key, conversation_kind,
          agent_id, session_id, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [workspaceId, input.installation_id, input.channel_id, conversationKey, kind,
       principal.agent_id, sessionId, principal.user_id],
    );
  }
  const loaded = await tx.query<TurnSession>(
    `SELECT id, agent_id, owner_id, read_only, mode, model_id, effort
       FROM sessions WHERE workspace_id=$1 AND id=$2 AND owner_id=$3 AND agent_id=$4`,
    [workspaceId, sessionId, principal.user_id, principal.agent_id],
  );
  const session = loaded.rows[0];
  if (!session || session.read_only) throw new Error('slack_session_unavailable');
  return session;
}

export async function runSlackIngestJob(env: Env, job: Job): Promise<void> {
  const input = job.payload as Partial<SlackMessageEventPayload>;
  if (
    typeof input.installation_id !== 'string' || typeof input.slack_event_row_id !== 'string'
    || typeof input.event_id !== 'string' || typeof input.user_id !== 'string'
    || typeof input.channel_id !== 'string' || typeof input.text !== 'string' || typeof input.ts !== 'string'
  ) throw new Error('slack_ingest_payload_invalid');
  const payload = input as SlackMessageEventPayload;

  const jobIds: string[] = [];
  let create: RunInstanceParams | null = null;
  const linkedConfirmation: { value: null | { installationId: string; channel: string; thread: string; clientMessageId: string } } = { value: null };
  await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const installation = await loadSlackInstallationById(tx, job.workspace_id, payload.installation_id);
    if (!installation || installation.status !== 'connected') {
      await tx.query(
        `UPDATE slack_events SET status='ignored', error_code='installation_inactive', processed_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [job.workspace_id, input.slack_event_row_id],
      );
      return;
    }
    const supported = payload.event_type === 'app_mention'
      || (payload.event_type === 'message' && payload.channel_type === 'im');
    if (!supported || payload.subtype || payload.bot_id || payload.user_id === installation.slack_bot_user_id) {
      await tx.query(
        `UPDATE slack_events SET status='ignored', error_code='event_not_actionable', processed_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [job.workspace_id, input.slack_event_row_id],
      );
      return;
    }
    const linkMatch = payload.channel_type === 'im' ? /^link\s+(hmx_[a-f0-9]{32})$/i.exec(payload.text.trim()) : null;
    if (linkMatch?.[1]) {
      const code = await tx.query<{ id: string; user_id: string }>(
        `SELECT c.id, c.user_id
           FROM slack_link_codes c
           JOIN members m ON m.workspace_id=c.workspace_id AND m.user_id=c.user_id AND m.status='active'
          WHERE c.workspace_id=$1 AND c.installation_id=$2 AND c.code_digest=$3
            AND c.consumed_at IS NULL AND c.expires_at > now()
          FOR UPDATE OF c`,
        [job.workspace_id, payload.installation_id, await sha256Hex(linkMatch[1].toLowerCase())],
      );
      const match = code.rows[0];
      if (match && await resolveSlackAgent(tx, job.workspace_id, match.user_id)) {
        await tx.query(
          `UPDATE slack_user_links SET revoked_at=now()
            WHERE workspace_id=$1 AND installation_id=$2 AND user_id=$3
              AND slack_user_id <> $4 AND revoked_at IS NULL`,
          [job.workspace_id, payload.installation_id, match.user_id, payload.user_id],
        );
        await tx.query(
          `INSERT INTO slack_user_links (workspace_id, installation_id, slack_user_id, user_id, linked_by)
           VALUES ($1,$2,$3,$4,$4)
           ON CONFLICT (installation_id, slack_user_id)
           DO UPDATE SET user_id=EXCLUDED.user_id, linked_by=EXCLUDED.linked_by, revoked_at=NULL, linked_at=now()`,
          [job.workspace_id, payload.installation_id, payload.user_id, match.user_id],
        );
        await tx.query(
          `UPDATE slack_link_codes SET consumed_at=now(), consumed_by_slack_user=$3
            WHERE workspace_id=$1 AND id=$2`,
          [job.workspace_id, match.id, payload.user_id],
        );
        await tx.query(
          `UPDATE slack_events SET status='ignored', error_code='slack_user_linked', processed_at=now()
            WHERE workspace_id=$1 AND id=$2`,
          [job.workspace_id, payload.slack_event_row_id],
        );
        linkedConfirmation.value = {
          installationId: payload.installation_id,
          channel: payload.channel_id,
          thread: payload.thread_ts ?? payload.ts,
          clientMessageId: payload.slack_event_row_id,
        };
        return;
      }
    }
    const principal = await resolveLinkedSlackPrincipal(
      tx,
      job.workspace_id,
      payload.installation_id,
      payload.user_id,
    );
    if (!principal) {
      await tx.query(
        `UPDATE slack_events SET status='unlinked', error_code='slack_user_unlinked', processed_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [job.workspace_id, input.slack_event_row_id],
      );
      return;
    }
    const text = cleanSlackText(payload.text, installation.slack_bot_user_id).slice(0, 20_000);
    if (!text) {
      await tx.query(
        `UPDATE slack_events SET status='ignored', error_code='empty_message', processed_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [job.workspace_id, input.slack_event_row_id],
      );
      return;
    }
    let session: TurnSession;
    try {
      session = await sessionForEvent(tx, env, job.workspace_id, payload, principal);
    } catch (error) {
      if (String(error).includes('slack_thread_owned_by_another_member')) {
        await tx.query(
          `UPDATE slack_events SET status='ignored', error_code='thread_private_to_initiator', processed_at=now()
            WHERE workspace_id=$1 AND id=$2`,
          [job.workspace_id, input.slack_event_row_id],
        );
        return;
      }
      throw error;
    }
    const result = await submitTurn({
      tx, env, workspaceId: job.workspace_id, userId: principal.user_id, session,
      clientTurnId: `slack:${payload.event_id}`, text, jobIds,
    });
    if (!result.duplicate) create = result.create;
    await tx.query(
      `UPDATE slack_events SET status='submitted', run_id=$3, processed_at=now(), error_code=NULL
        WHERE workspace_id=$1 AND id=$2`,
      [job.workspace_id, input.slack_event_row_id, result.run.id],
    );
    await tx.query(
      `INSERT INTO slack_run_deliveries
         (workspace_id, installation_id, source_event_id, run_id, slack_channel_id, slack_thread_ts)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (source_event_id) DO NOTHING`,
      [job.workspace_id, payload.installation_id, payload.slack_event_row_id, result.run.id,
       payload.channel_id, payload.thread_ts ?? payload.ts],
    );
    const deliveryJob = await enqueueJob(
      tx,
      job.workspace_id,
      'slack_deliver',
      `slack-deliver:${result.run.id}`,
      { run_id: result.run.id },
    );
    if (deliveryJob) jobIds.push(deliveryJob);
  });
  if (linkedConfirmation.value) {
    const confirmation = linkedConfirmation.value;
    try {
      const token = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
        const installation = await loadSlackInstallationById(tx, job.workspace_id, confirmation.installationId);
        if (!installation) throw new Error('slack_installation_inactive');
        return resolveSlackAccessToken(tx, env, installation);
      });
      await callSlackWebApi('chat.postMessage', token, {
        channel: confirmation.channel,
        thread_ts: confirmation.thread,
        client_msg_id: confirmation.clientMessageId,
        text: 'Your Slack account is linked. Send your next message here to use your private Hermes agent and skills.',
      });
    } catch (error) {
      // The link is already authoritative in Hermes. A failed courtesy reply
      // must not replay the consumed link command as an agent prompt.
      console.log(JSON.stringify({ at: 'slack.link.confirmation', ok: false, error: String(error) }));
    }
    return;
  }
  if (jobIds.length > 0) await runJobsAfterCommit(env, job.workspace_id, jobIds);
  if (create) await createRunInstance(env, create);
}

export async function enqueueSlackIngest(
  tx: Tx,
  workspaceId: string,
  payload: SlackMessageEventPayload,
): Promise<string | null> {
  return enqueueJob(tx, workspaceId, 'slack_ingest', `slack-ingest:${payload.installation_id}:${payload.event_id}`, payload);
}
