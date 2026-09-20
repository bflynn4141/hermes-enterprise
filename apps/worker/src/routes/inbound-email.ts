import {
  inboundEmailConnectionSchema,
  inboundEmailOAuthStartSchema,
  inboundEmailThreadImportInputSchema,
  inboundEmailThreadImportSchema,
} from '@hermes/shared';
import type { Context } from 'hono';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import type { Env } from '../env.js';
import { sha256Hex } from '../integrations/slack/security.js';
import {
  exchangeGmailEvidenceCode,
  gmailEvidenceProfile,
} from '../inbound-email/gmail-read-api.js';
import {
  gmailEvidenceAuthorizeUrl,
  gmailEvidenceConfig,
  gmailEvidenceFetcher,
} from '../inbound-email/gmail-read-config.js';
import { loadGmailEvidenceAccount, storeGmailEvidenceAccount } from '../inbound-email/gmail-read-store.js';
import { importSelectedGmailThread } from '../inbound-email/service.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { signGmailOAuthState, verifyGmailOAuthState } from '../outbound-email/gmail-security.js';
import { inWorkspace, RouteError } from './tenant.js';

const OAUTH_TTL_SECONDS = 10 * 60;

export async function getInboundEmailConnection(c: Context<{ Bindings: Env }>): Promise<Response> {
  const configured = gmailEvidenceConfig(c.env) !== null;
  const result = await inWorkspace(c, async (work) => {
    const account = await loadGmailEvidenceAccount(work.tx, work.workspaceId);
    const imports = await work.tx.query<{ count: number; latest: Date | string | null }>(
      `SELECT count(*)::int AS count,max(imported_at) AS latest
         FROM mailbox_thread_snapshots WHERE workspace_id=$1`,
      [work.workspaceId],
    );
    const summary = imports.rows[0];
    const admin = work.role === 'admin';
    return inboundEmailConnectionSchema.parse({
      configured,
      status: !configured ? 'unavailable'
        : account?.status === 'connected' ? 'connected'
          : account?.status === 'error' ? 'error' : 'disconnected',
      address: admin ? account?.address ?? null : null,
      connected_at: admin && account?.status === 'connected' ? new Date(account.connected_at).toISOString() : null,
      latest_import_at: admin && summary?.latest ? new Date(summary.latest).toISOString() : null,
      imported_threads: admin ? summary?.count ?? 0 : 0,
      can_manage: admin,
      authorization: 'separate_read_only',
      scope: 'gmail.readonly',
      selection: 'one_thread_per_import',
    });
  });
  return c.json(result);
}

export async function startGmailEvidenceOAuth(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const config = gmailEvidenceConfig(c.env);
  if (!config) throw new RouteError('Read-only Gmail evidence is not configured', 'gmail_evidence_unavailable', 503);
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('connecting a read-only evidence mailbox');
    requireStepUp(work.session);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1 as const, workspace_id: work.workspaceId, user_id: work.userId,
      nonce: crypto.randomUUID(), expires_at: now + OAUTH_TTL_SECONDS,
      redirect_uri: config.redirectUri,
    };
    const state = await signGmailOAuthState(payload, config.stateSecret);
    await work.tx.query(
      `INSERT INTO gmail_evidence_oauth_states
         (workspace_id,requested_by,state_digest,redirect_uri,expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [work.workspaceId, work.userId, await sha256Hex(state), config.redirectUri,
        new Date(payload.expires_at * 1000)],
    );
    return inboundEmailOAuthStartSchema.parse({
      authorize_url: gmailEvidenceAuthorizeUrl(config, state),
      expires_at: new Date(payload.expires_at * 1000).toISOString(),
    });
  });
  return c.json(result, 201);
}

const callbackLocation = (workspaceId: string, result: 'connected' | 'failed'): string =>
  `/workspace/${encodeURIComponent(workspaceId)}?gmail_evidence=${result}#library/Connections`;

export async function gmailEvidenceOAuthCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const config = gmailEvidenceConfig(c.env);
  if (!config) throw new RouteError('Read-only Gmail evidence is not configured', 'gmail_evidence_unavailable', 503);
  const stateRaw = c.req.query('state') ?? '';
  const code = c.req.query('code') ?? '';
  const state = await verifyGmailOAuthState(stateRaw, config.stateSecret);
  if (!state || !code || state.redirect_uri !== config.redirectUri) {
    throw new RouteError('The read-only Gmail connection link is invalid or expired', 'gmail_evidence_oauth_state_invalid', 400);
  }
  const digest = await sha256Hex(stateRaw);
  await withWorkspaceTransaction(c.env, state.workspace_id, async (tx) => {
    const match = await tx.query<{ id: string; role: string }>(
      `SELECT s.id,m.role FROM gmail_evidence_oauth_states s
        JOIN members m ON m.workspace_id=s.workspace_id AND m.user_id=s.requested_by
       WHERE s.workspace_id=$1 AND s.requested_by=$2 AND s.state_digest=$3
         AND s.consumed_at IS NULL AND s.expires_at>now() AND m.status='active'
       FOR UPDATE`,
      [state.workspace_id, state.user_id, digest],
    );
    if (match.rows[0]?.role !== 'admin') {
      throw new RouteError('The read-only Gmail connection link is no longer valid', 'gmail_evidence_oauth_state_invalid', 400);
    }
    await tx.query(
      `UPDATE gmail_evidence_oauth_states SET consumed_at=now() WHERE workspace_id=$1 AND id=$2`,
      [state.workspace_id, match.rows[0].id],
    );
  });
  try {
    const fetcher = gmailEvidenceFetcher(c.env);
    const token = await exchangeGmailEvidenceCode(config, code, fetcher);
    const address = await gmailEvidenceProfile(token.access_token, fetcher);
    await withWorkspaceTransaction(c.env, state.workspace_id, async (tx) => {
      await storeGmailEvidenceAccount(tx, c.env, {
        workspaceId: state.workspace_id, connectedBy: state.user_id, address, token,
      });
      await tx.query(
        `INSERT INTO events (workspace_id,actor_type,actor_user_id,kind)
         VALUES ($1,'user',$2,'gmail_evidence.connected')`,
        [state.workspace_id, state.user_id],
      );
    });
    return c.redirect(callbackLocation(state.workspace_id, 'connected'), 302);
  } catch (error) {
    console.error(JSON.stringify({ at: 'gmail_evidence.oauth.callback', ok: false,
      error: error instanceof Error ? error.message : 'upstream_failed' }));
    return c.redirect(callbackLocation(state.workspace_id, 'failed'), 302);
  }
}

export async function importGmailEvidenceThread(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const parsed = inboundEmailThreadImportInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new RouteError('Choose an agent and enter one exact Gmail thread ID', 'invalid_input', 422);
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('importing mailbox evidence');
    requireStepUp(work.session);
    return inboundEmailThreadImportSchema.parse(await importSelectedGmailThread(work, c.env, parsed.data));
  });
  return c.json(result, result.created ? 201 : 200);
}
