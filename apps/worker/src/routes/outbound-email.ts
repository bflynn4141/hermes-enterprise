import type { Context } from 'hono';
import { mailboxDisconnectSchema, outboundEmailConnectionSchema, outboundEmailOAuthStartSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { enqueueJob, runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import { exchangeGmailCode, gmailProfile, type GmailTokenBundle } from '../outbound-email/gmail-api.js';
import { gmailAuthorizeUrl, gmailConfig, gmailFetcher } from '../outbound-email/gmail-config.js';
import { signGmailOAuthState, verifyGmailOAuthState } from '../outbound-email/gmail-security.js';
import { loadSendingAccount, storeSendingAccount, type SendingProvider } from '../outbound-email/gmail-store.js';
import { exchangeMicrosoftCode, microsoftProfile } from '../outbound-email/microsoft-api.js';
import { microsoftAuthorizeUrl, microsoftConfig, microsoftFetcher } from '../outbound-email/microsoft-config.js';
import { sha256Hex } from '../integrations/slack/security.js';
import { automatedTriggersEnabled, automationIntervalMinutes } from '../partner-screening/automation.js';
import { inWorkspace } from './tenant.js';
import { RouteError } from './errors.js';

const OAUTH_TTL_SECONDS = 10 * 60;
export async function getOutboundEmailConnection(c: Context<{ Bindings: Env }>): Promise<Response> {
  const providers = { gmail: gmailConfig(c.env) !== null, microsoft: microsoftConfig(c.env) !== null };
  const configured = providers.gmail || providers.microsoft;
  const result = await inWorkspace(c, async (work) => {
    const account = await loadSendingAccount(work.tx, work.workspaceId);
    const pending = await work.tx.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM outbound_email_outbox
        WHERE workspace_id=$1 AND state IN ('pending_connection','queued','sending','ambiguous')`,
      [work.workspaceId],
    );
    const admin = work.role === 'admin';
    return outboundEmailConnectionSchema.parse({
      configured,
      status: !configured ? 'unavailable' : account?.status === 'connected' ? 'connected' : account?.status === 'error' ? 'error' : 'disconnected',
      address: admin ? account?.address ?? null : null,
      provider: account && account.status !== 'disconnected' ? account.provider : null,
      providers,
      connected_at: admin && account?.status === 'connected' ? account.updated_at.toISOString() : null,
      pending_messages: admin ? pending.rows[0]?.count ?? 0 : 0,
      can_manage: admin,
      mode: c.env.PARTNER_OUTREACH_EMAIL_MODE === 'send_after_approval' ? 'send_after_approval' : 'draft_only',
      discovery_enabled: automatedTriggersEnabled(c.env),
      discovery_interval_minutes: automationIntervalMinutes(c.env),
    });
  });
  return c.json(result);
}

/** Begin connecting a sending account: a signed, single-use state tied to the Admin and the provider. */
async function startSendingOAuth(
  c: Context<{ Bindings: Env }>,
  provider: SendingProvider,
  config: { stateSecret: string; redirectUri: string } | null,
  authorizeUrl: (state: string) => string,
): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  if (!config) throw new RouteError(`${PROVIDER_NAME[provider]} sending is not configured for this deployment`, `${provider}_unavailable`, 503);
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
         (workspace_id,requested_by,state_digest,redirect_uri,expires_at,provider)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [work.workspaceId, work.userId, await sha256Hex(state), config.redirectUri, new Date(payload.expires_at * 1000), provider],
    );
    return outboundEmailOAuthStartSchema.parse({ authorize_url: authorizeUrl(state), expires_at: new Date(payload.expires_at * 1000).toISOString() });
  });
  return c.json(started, 201);
}

const PROVIDER_NAME = { gmail: 'Gmail', microsoft: 'Microsoft' } as const;

export async function startGmailOAuth(c: Context<{ Bindings: Env }>): Promise<Response> {
  const config = gmailConfig(c.env);
  return startSendingOAuth(c, 'gmail', config, (state) => gmailAuthorizeUrl(config!, state));
}

export async function startMicrosoftOAuth(c: Context<{ Bindings: Env }>): Promise<Response> {
  const config = microsoftConfig(c.env);
  return startSendingOAuth(c, 'microsoft', config, (state) => microsoftAuthorizeUrl(config!, state));
}

function callbackLocation(workspaceId: string, provider: SendingProvider, result: 'connected' | 'failed'): string {
  return `/workspace/${encodeURIComponent(workspaceId)}?${provider}=${result}#admin/Email`;
}

/**
 * Finish connecting a sending account: consume the provider's single-use state,
 * learn the mailbox's address, seal its token, then release the approved emails
 * that were waiting for that exact sender.
 */
async function completeSendingOAuth(
  c: Context<{ Bindings: Env }>,
  provider: SendingProvider,
  config: { stateSecret: string; redirectUri: string } | null,
  connect: (code: string) => Promise<{ token: GmailTokenBundle; address: string }>,
): Promise<Response> {
  const name = PROVIDER_NAME[provider];
  if (!config) throw new RouteError(`${name} sending is not configured for this deployment`, `${provider}_unavailable`, 503);
  const stateRaw = c.req.query('state') ?? '';
  const code = c.req.query('code') ?? '';
  const state = await verifyGmailOAuthState(stateRaw, config.stateSecret);
  if (!state || !code || state.redirect_uri !== config.redirectUri) {
    throw new RouteError(`the ${name} connection link is invalid or expired`, 'gmail_oauth_state_invalid', 400);
  }
  const digest = await sha256Hex(stateRaw);
  await withWorkspaceTransaction(c.env, state.workspace_id, async (tx) => {
    const match = await tx.query<{ id: string; role: string }>(
      `SELECT s.id,m.role FROM gmail_oauth_states s
        JOIN members m ON m.workspace_id=s.workspace_id AND m.user_id=s.requested_by
       WHERE s.workspace_id=$1 AND s.requested_by=$2 AND s.state_digest=$3
         AND s.consumed_at IS NULL AND s.expires_at>now() AND m.status='active'
         AND s.provider=$4
       FOR UPDATE`,
      [state.workspace_id, state.user_id, digest, provider],
    );
    if (match.rows[0]?.role !== 'admin') throw new RouteError(`the ${name} connection link is no longer valid`, 'gmail_oauth_state_invalid', 400);
    await tx.query(`UPDATE gmail_oauth_states SET consumed_at=now() WHERE workspace_id=$1 AND id=$2`, [state.workspace_id, match.rows[0].id]);
  });

  try {
    const { token, address } = await connect(code);
    const jobs = await withWorkspaceTransaction(c.env, state.workspace_id, async (tx) => {
      const account = await storeSendingAccount(tx, c.env, {
        workspaceId: state.workspace_id,
        connectedBy: state.user_id,
        address,
        token,
        provider,
      });
      const pending = await tx.query<{ id: string }>(
        `UPDATE outbound_email_outbox SET account_id=$3,state='queued',last_error=NULL
          WHERE workspace_id=$1 AND sender_address=$2
            AND (state='pending_connection' OR (state='queued' AND attempt_count=0 AND EXISTS (
              SELECT 1 FROM jobs j WHERE j.workspace_id=$1 AND j.kind='outbound_email_send'
                AND j.key='outbound-email:' || outbound_email_outbox.id AND j.done_at IS NOT NULL
            )))
          RETURNING id`,
        [state.workspace_id, address, account.id],
      );
      const jobIds: string[] = [];
      for (const row of pending.rows) {
        const jobId = await enqueueJob(tx, state.workspace_id, 'outbound_email_send', `outbound-email:${row.id}`, { outbox_id: row.id });
        if (jobId) {
          jobIds.push(jobId);
          continue;
        }
        // Older approvals consumed this key while waiting for a mailbox.
        // Revive only completed jobs for the unsent rows locked above. Keep
        // active jobs and sent/uncertain deliveries outside this recovery.
        const revived = await tx.query<{ id: string }>(
          `UPDATE jobs SET done_at=NULL, locked_until=NULL, last_error=NULL, next_at=now()
            WHERE workspace_id=$1 AND kind='outbound_email_send' AND key=$2 AND done_at IS NOT NULL
            RETURNING id`,
          [state.workspace_id, `outbound-email:${row.id}`],
        );
        for (const job of revived.rows) {
          await tx.query(
            `INSERT INTO job_ready (job_id,workspace_id,next_at) VALUES ($1,$2,now())
             ON CONFLICT (job_id) DO UPDATE SET next_at=EXCLUDED.next_at`,
            [job.id,state.workspace_id],
          );
          jobIds.push(job.id);
        }
      }
      await tx.query(
        `INSERT INTO events (workspace_id,actor_type,actor_user_id,kind)
         VALUES ($1,'user',$2,$3)`,
        [state.workspace_id, state.user_id, provider === 'microsoft' ? 'microsoft_mail.connected' : 'gmail.connected'],
      );
      return jobIds;
    });
    if (jobs.length) c.executionCtx.waitUntil(runJobsAfterCommit(c.env, state.workspace_id, jobs));
    return c.redirect(callbackLocation(state.workspace_id, provider, 'connected'), 302);
  } catch (error) {
    console.error(JSON.stringify({ at: `${provider}.oauth.callback`, ok: false, error: error instanceof Error ? error.message : 'upstream_failed' }));
    return c.redirect(callbackLocation(state.workspace_id, provider, 'failed'), 302);
  }
}

export async function gmailOAuthCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const config = gmailConfig(c.env);
  return completeSendingOAuth(c, 'gmail', config, async (code) => {
    const fetcher = gmailFetcher(c.env);
    const token = await exchangeGmailCode(config!, code, fetcher);
    return { token, address: await gmailProfile(token.access_token, fetcher) };
  });
}

export async function microsoftOAuthCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const config = microsoftConfig(c.env);
  return completeSendingOAuth(c, 'microsoft', config, async (code) => {
    const fetcher = microsoftFetcher(c.env);
    const token = await exchangeMicrosoftCode(config!, code, fetcher);
    return { token, address: await microsoftProfile(token.access_token, fetcher) };
  });
}

/**
 * Disconnect the sending account (docs/CONNECTORS.md). Hermes deletes its
 * stored access in this transaction. Approved emails that were only queued
 * go back to waiting for a mailbox, which is where the OAuth callback picks
 * them up if this address is connected again; a send already in progress
 * finishes or becomes uncertain on its own. Nothing is called at Google or
 * Microsoft: removing Hermes there is done in that account's settings.
 */
export async function disconnectOutboundEmail(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireCsrf(c);
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('disconnecting the sending account');
    requireStepUp(work.session);
    const account = await loadSendingAccount(work.tx, work.workspaceId);
    if (!account) return { status: 'disconnected' as const, waiting: 0 };
    await work.tx.query(
      `UPDATE outbound_email_accounts
          SET status='revoked', ciphertext=NULL, iv=NULL, wrapped_dek=NULL, wrap_iv=NULL,
              kek_version=NULL, token_expires_at=NULL, last_error='disconnected_by_admin'
        WHERE workspace_id=$1 AND id=$2`,
      [work.workspaceId, account.id],
    );
    const released = await work.tx.query(
      `UPDATE outbound_email_outbox SET state='pending_connection', account_id=NULL, last_error=NULL
        WHERE workspace_id=$1 AND account_id=$2 AND state='queued'`,
      [work.workspaceId, account.id],
    );
    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind)
       VALUES ($1,'user',$2,'outbound_email.disconnected')`,
      [work.workspaceId, work.userId],
    );
    return { status: 'disconnected' as const, waiting: released.rowCount ?? 0 };
  });
  return c.json(mailboxDisconnectSchema.parse(result));
}
