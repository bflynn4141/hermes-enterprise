import type { Context } from 'hono';
import { outboundEmailConnectionSchema, outboundEmailOAuthStartSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { enqueueJob, runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import { exchangeGmailCode, gmailProfile } from '../outbound-email/gmail-api.js';
import { gmailAuthorizeUrl, gmailConfig, gmailFetcher } from '../outbound-email/gmail-config.js';
import { signGmailOAuthState, verifyGmailOAuthState } from '../outbound-email/gmail-security.js';
import { loadGmailAccount, storeGmailAccount } from '../outbound-email/gmail-store.js';
import { sha256Hex } from '../integrations/slack/security.js';
import { automatedTriggersEnabled, automationIntervalMinutes } from '../partner-screening/automation.js';
import { inWorkspace, RouteError } from './tenant.js';

const OAUTH_TTL_SECONDS = 10 * 60;
export async function getOutboundEmailConnection(c: Context<{ Bindings: Env }>): Promise<Response> {
  const configured = gmailConfig(c.env) !== null;
  const result = await inWorkspace(c, async (work) => {
    const account = await loadGmailAccount(work.tx, work.workspaceId);
    const pending = await work.tx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM outbound_email_outbox
        WHERE workspace_id=$1 AND state IN ('pending_connection','queued','sending','ambiguous')`,
      [work.workspaceId],
    );
    return outboundEmailConnectionSchema.parse({
      configured,
      status: !configured ? 'unavailable' : account?.status === 'connected' ? 'connected' : account?.status === 'error' ? 'error' : 'disconnected',
      address: account?.address ?? null,
      connected_at: account?.status === 'connected' ? account.updated_at.toISOString() : null,
      pending_messages: pending.rows[0]?.count ?? 0,
      can_manage: work.role === 'admin',
      mode: c.env.PARTNER_OUTREACH_EMAIL_MODE === 'send_after_approval' ? 'send_after_approval' : 'draft_only',
      discovery_enabled: automatedTriggersEnabled(c.env),
      discovery_interval_minutes: automationIntervalMinutes(c.env),
    });
  });
  return c.json(result);
}

export async function startGmailOAuth(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const config = gmailConfig(c.env);
  if (!config) throw new RouteError('Gmail outreach is not configured for this deployment', 'gmail_unavailable', 503);
  const started = await inWorkspace(c, async (work) => {
    work.requireAdmin('connecting an outreach mailbox');
    requireStepUp(work.session);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1 as const,
      workspace_id: work.workspaceId,
      user_id: work.userId,
      nonce: crypto.randomUUID(),
      expires_at: now + OAUTH_TTL_SECONDS,
      redirect_uri: config.redirectUri,
    };
    const state = await signGmailOAuthState(payload, config.stateSecret);
    await work.tx.query(
      `INSERT INTO gmail_oauth_states
         (workspace_id,requested_by,state_digest,redirect_uri,expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [work.workspaceId, work.userId, await sha256Hex(state), config.redirectUri, new Date(payload.expires_at * 1000)],
    );
    return outboundEmailOAuthStartSchema.parse({ authorize_url: gmailAuthorizeUrl(config, state), expires_at: new Date(payload.expires_at * 1000).toISOString() });
  });
  return c.json(started, 201);
}

function callbackLocation(workspaceId: string, result: 'connected' | 'failed'): string {
  return `/workspace/${encodeURIComponent(workspaceId)}?gmail=${result}#settings/Email`;
}

export async function gmailOAuthCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const config = gmailConfig(c.env);
  if (!config) throw new RouteError('Gmail outreach is not configured for this deployment', 'gmail_unavailable', 503);
  const stateRaw = c.req.query('state') ?? '';
  const code = c.req.query('code') ?? '';
  const state = await verifyGmailOAuthState(stateRaw, config.stateSecret);
  if (!state || !code || state.redirect_uri !== config.redirectUri) {
    throw new RouteError('the Gmail connection link is invalid or expired', 'gmail_oauth_state_invalid', 400);
  }
  const digest = await sha256Hex(stateRaw);
  await withWorkspaceTransaction(c.env, state.workspace_id, async (tx) => {
    const match = await tx.query<{ id: string; role: string }>(
      `SELECT s.id,m.role FROM gmail_oauth_states s
        JOIN members m ON m.workspace_id=s.workspace_id AND m.user_id=s.requested_by
       WHERE s.workspace_id=$1 AND s.requested_by=$2 AND s.state_digest=$3
         AND s.consumed_at IS NULL AND s.expires_at>now() AND m.status='active'
       FOR UPDATE`,
      [state.workspace_id, state.user_id, digest],
    );
    if (match.rows[0]?.role !== 'admin') throw new RouteError('the Gmail connection link is no longer valid', 'gmail_oauth_state_invalid', 400);
    await tx.query(`UPDATE gmail_oauth_states SET consumed_at=now() WHERE workspace_id=$1 AND id=$2`, [state.workspace_id, match.rows[0].id]);
  });

  try {
    const fetcher = gmailFetcher(c.env);
    const token = await exchangeGmailCode(config, code, fetcher);
    const address = await gmailProfile(token.access_token, fetcher);
    const jobs = await withWorkspaceTransaction(c.env, state.workspace_id, async (tx) => {
      const account = await storeGmailAccount(tx, c.env, {
        workspaceId: state.workspace_id,
        connectedBy: state.user_id,
        address,
        token,
      });
      const pending = await tx.query<{ id: string }>(
        `UPDATE outbound_email_outbox SET account_id=$3,state='queued',last_error=NULL
          WHERE workspace_id=$1 AND sender_address=$2 AND state='pending_connection'
          RETURNING id`,
        [state.workspace_id, address, account.id],
      );
      const jobIds: string[] = [];
      for (const row of pending.rows) {
        const jobId = await enqueueJob(tx, state.workspace_id, 'outbound_email_send', `outbound-email:${row.id}`, { outbox_id: row.id });
        if (jobId) jobIds.push(jobId);
      }
      await tx.query(
        `INSERT INTO events (workspace_id,actor_type,actor_user_id,kind)
         VALUES ($1,'user',$2,'gmail.connected')`,
        [state.workspace_id, state.user_id],
      );
      return jobIds;
    });
    if (jobs.length) c.executionCtx.waitUntil(runJobsAfterCommit(c.env, state.workspace_id, jobs));
    return c.redirect(callbackLocation(state.workspace_id, 'connected'), 302);
  } catch (error) {
    console.error(JSON.stringify({ at: 'gmail.oauth.callback', ok: false, error: error instanceof Error ? error.message : 'upstream_failed' }));
    return c.redirect(callbackLocation(state.workspace_id, 'failed'), 302);
  }
}
