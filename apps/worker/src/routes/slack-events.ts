import type { Context } from 'hono';
import type { Env } from '../env.js';
import { runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import { enqueueSlackIngest, type SlackMessageEventPayload } from '../integrations/slack/ingest.js';
import { slackConfig, slackInstallKey } from '../integrations/slack/config.js';
import { sha256Hex, verifySlackRequest } from '../integrations/slack/security.js';
import { RouteError } from './tenant.js';
import { lookupSlackWorkspace } from './slack.js';

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export async function slackEvents(c: Context<{ Bindings: Env }>): Promise<Response> {
  const config = slackConfig(c.env);
  if (!config) throw new RouteError('Slack is not configured for this deployment', 'slack_unavailable', 503);
  const rawBody = await c.req.text();
  const verified = await verifySlackRequest(c.req.raw.headers, rawBody, config.signingSecret);
  if (!verified.ok) throw new RouteError('the Slack request signature is invalid', verified.reason, 403);
  let body: Record<string, unknown> | null = null;
  try { body = record(JSON.parse(rawBody)); } catch { /* handled below */ }
  if (!body) throw new RouteError('the Slack request body is invalid', 'bad_body', 400);
  if (body.type === 'url_verification' && typeof body.challenge === 'string') {
    return c.json({ challenge: body.challenge });
  }
  if (body.type !== 'event_callback' || typeof body.event_id !== 'string') return c.json({ ok: true });

  const authorizations = Array.isArray(body.authorizations) ? body.authorizations.map(record).filter(Boolean) : [];
  const authorization = authorizations[0] ?? null;
  const enterpriseId = typeof body.enterprise_id === 'string'
    ? body.enterprise_id
    : typeof authorization?.enterprise_id === 'string' ? authorization.enterprise_id : null;
  const teamId = typeof body.team_id === 'string'
    ? body.team_id
    : typeof authorization?.team_id === 'string' ? authorization.team_id : null;
  const isEnterpriseInstall = authorization?.is_enterprise_install === true;
  const installKey = slackInstallKey({ isEnterpriseInstall, enterpriseId, teamId });
  if (!installKey) return c.json({ ok: true });
  const target = await lookupSlackWorkspace(c.env, installKey);
  if (!target) return c.json({ ok: true });

  const event = record(body.event);
  if (!event) return c.json({ ok: true });
  const eventType = typeof event.type === 'string' ? event.type : 'unknown';
  const eventRowAndJob = await withWorkspaceTransaction(c.env, target.workspaceId, async (tx) => {
    const app = await tx.query<{ slack_app_id: string; status: string }>(
      `SELECT slack_app_id, status FROM slack_installations
        WHERE workspace_id=$1 AND id=$2`,
      [target.workspaceId, target.installationId],
    );
    const bound = app.rows[0];
    if (!bound || bound.status !== 'connected' || typeof body!.api_app_id !== 'string'
        || body!.api_app_id !== bound.slack_app_id) {
      return { duplicate: false, jobId: null };
    }
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO slack_events
         (workspace_id, installation_id, slack_event_id, event_type, payload_sha256, retry_num)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (slack_event_id) DO NOTHING
       RETURNING id`,
      [target.workspaceId, target.installationId, body!.event_id, eventType,
       await sha256Hex(rawBody), Number(c.req.header('x-slack-retry-num') ?? '') || null],
    );
    const eventRowId = inserted.rows[0]?.id;
    if (!eventRowId) return { duplicate: true, jobId: null };
    const payload: SlackMessageEventPayload = {
      installation_id: target.installationId,
      slack_event_row_id: eventRowId,
      event_id: body!.event_id as string,
      event_type: eventType,
      user_id: typeof event.user === 'string' ? event.user : '',
      channel_id: typeof event.channel === 'string' ? event.channel : '',
      channel_type: typeof event.channel_type === 'string' ? event.channel_type : null,
      text: typeof event.text === 'string' ? event.text : '',
      ts: typeof event.ts === 'string' ? event.ts : '',
      thread_ts: typeof event.thread_ts === 'string' ? event.thread_ts : null,
      subtype: typeof event.subtype === 'string' ? event.subtype : null,
      bot_id: typeof event.bot_id === 'string' ? event.bot_id : null,
    };
    const jobId = await enqueueSlackIngest(tx, target.workspaceId, payload);
    return { duplicate: false, jobId };
  });
  if (eventRowAndJob.jobId) {
    c.executionCtx.waitUntil(runJobsAfterCommit(c.env, target.workspaceId, [eventRowAndJob.jobId]));
  }
  return c.json({ ok: true, duplicate: eventRowAndJob.duplicate });
}
