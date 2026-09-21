import type { Context } from 'hono';
import { slackConnectionSchema, slackDisconnectSchema, slackLinkCodeSchema, slackOAuthStartSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { connect } from '../db/client.js';
import { enqueueJob, runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import { exchangeSlackCode } from '../integrations/slack/api.js';
import { SLACK_BOT_SCOPES, slackAuthorizeUrl, slackConfig } from '../integrations/slack/config.js';
import { resolveSlackAgent } from '../integrations/slack/principal.js';
import { sha256Hex, signSlackOAuthState, verifySlackOAuthState } from '../integrations/slack/security.js';
import { loadSlackInstallation, storeSlackInstallation } from '../integrations/slack/store.js';
import { inWorkspace } from './tenant.js';
import { RouteError } from './errors.js';

const OAUTH_STATE_TTL_SECONDS = 10 * 60;

export async function getSlackConnection(c: Context<{ Bindings: Env }>): Promise<Response> {
  const configured = slackConfig(c.env) !== null;
  const result = await inWorkspace(c, async (work) => {
    const [installation, agent] = await Promise.all([
      loadSlackInstallation(work.tx, work.workspaceId),
      resolveSlackAgent(work.tx, work.workspaceId, work.userId),
    ]);
    const status = !configured
      ? 'unavailable'
      : installation?.status === 'connected'
        ? 'connected'
        : installation?.status === 'error'
          ? 'error'
          : 'disconnected';
    const admin = work.role === 'admin';
    return slackConnectionSchema.parse({
      configured,
      status,
      installation_kind: admin && installation ? (installation.is_enterprise_install ? 'organization' : 'workspace') : null,
      team_name: admin ? installation?.slack_team_name ?? null : null,
      enterprise_name: admin ? installation?.slack_enterprise_name ?? null : null,
      connected_at: admin ? installation?.connected_at.toISOString() ?? null : null,
      granted_scopes: admin ? installation?.granted_scopes ?? [] : [],
      agent: agent ? { id: agent.agent_id, name: agent.agent_name } : null,
      can_manage: admin,
      reconnect_required: admin && installation?.status === 'error',
      behavior: {
        direct_messages: 'same_session',
        channel_messages: 'mention_required',
        channel_replies: 'threaded',
        approvals: 'hermes_inbox',
      },
    });
  });
  return c.json(result);
}

export async function startSlackOAuth(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const config = slackConfig(c.env);
  if (!config) throw new RouteError('Slack is not configured for this deployment', 'slack_unavailable', 503);
  const started = await inWorkspace(c, async (work) => {
    work.requireAdmin('connecting Slack');
    requireStepUp(work.session);
    if (!(await resolveSlackAgent(work.tx, work.workspaceId, work.userId))) {
      throw new RouteError('your Hermes agent is not ready yet', 'agent_unavailable', 409);
    }
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      v: 1 as const,
      workspace_id: work.workspaceId,
      user_id: work.userId,
      nonce: crypto.randomUUID(),
      expires_at: now + OAUTH_STATE_TTL_SECONDS,
      redirect_uri: config.redirectUri,
    };
    const state = await signSlackOAuthState(payload, config.stateSecret);
    await work.tx.query(
      `INSERT INTO slack_oauth_states
         (workspace_id, requested_by, state_digest, redirect_uri, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [work.workspaceId, work.userId, await sha256Hex(state), config.redirectUri, new Date(payload.expires_at * 1000)],
    );
    return slackOAuthStartSchema.parse({
      authorize_url: slackAuthorizeUrl(config, state),
      expires_at: new Date(payload.expires_at * 1000).toISOString(),
    });
  });
  return c.json(started, 201);
}

export async function createSlackLinkCode(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const linked = await inWorkspace(c, async (work) => {
    requireStepUp(work.session);
    const installation = await loadSlackInstallation(work.tx, work.workspaceId);
    if (!installation || installation.status !== 'connected') {
      throw new RouteError('connect this workspace to Slack first', 'slack_not_connected', 409);
    }
    if (!(await resolveSlackAgent(work.tx, work.workspaceId, work.userId))) {
      throw new RouteError('your Hermes agent is not ready yet', 'agent_unavailable', 409);
    }
    const code = `hmx_${crypto.randomUUID().replaceAll('-', '')}`;
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    await work.tx.query(
      `UPDATE slack_link_codes SET consumed_at=now()
        WHERE workspace_id=$1 AND user_id=$2 AND consumed_at IS NULL`,
      [work.workspaceId, work.userId],
    );
    await work.tx.query(
      `INSERT INTO slack_link_codes
         (workspace_id, installation_id, user_id, code_digest, expires_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [work.workspaceId, installation.id, work.userId, await sha256Hex(code), expiresAt],
    );
    return slackLinkCodeSchema.parse({ command: `link ${code}`, expires_at: expiresAt.toISOString() });
  });
  return c.json(linked, 201);
}

function callbackLocation(workspaceId: string, result: 'connected' | 'failed'): string {
  return `/workspace/${encodeURIComponent(workspaceId)}?slack=${result}#admin/Slack`;
}

export async function slackOAuthCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const config = slackConfig(c.env);
  if (!config) throw new RouteError('Slack is not configured for this deployment', 'slack_unavailable', 503);
  const stateRaw = c.req.query('state') ?? '';
  const code = c.req.query('code') ?? '';
  const state = await verifySlackOAuthState(stateRaw, config.stateSecret);
  if (!state || !code || state.redirect_uri !== config.redirectUri) {
    throw new RouteError('the Slack installation link is invalid or expired', 'slack_oauth_state_invalid', 400);
  }
  const digest = await sha256Hex(stateRaw);
  await withWorkspaceTransaction(c.env, state.workspace_id, async (tx) => {
    const { rows } = await tx.query<{ id: string; role: string }>(
      `SELECT s.id, m.role
         FROM slack_oauth_states s
         JOIN members m ON m.workspace_id=s.workspace_id AND m.user_id=s.requested_by
        WHERE s.workspace_id=$1 AND s.requested_by=$2 AND s.state_digest=$3
          AND s.consumed_at IS NULL AND s.expires_at > now() AND m.status='active'
        FOR UPDATE`,
      [state.workspace_id, state.user_id, digest],
    );
    const match = rows[0];
    if (!match || match.role !== 'admin') throw new RouteError('the Slack installation link is no longer valid', 'slack_oauth_state_invalid', 400);
    await tx.query(`UPDATE slack_oauth_states SET consumed_at=now() WHERE workspace_id=$1 AND id=$2`, [state.workspace_id, match.id]);
  });

  try {
    const grant = await exchangeSlackCode(config, code);
    const missing = SLACK_BOT_SCOPES.filter((scope) => !grant.scope.includes(scope));
    if (missing.length > 0) throw new RouteError(`Slack did not grant required scopes: ${missing.join(', ')}`, 'slack_scope_missing', 409);
    const jobs = await withWorkspaceTransaction(c.env, state.workspace_id, async (tx) => {
      const stored = await storeSlackInstallation(tx, c.env, { workspaceId: state.workspace_id, installedBy: state.user_id, grant });
      const jobIds: string[] = [];
      for (const installationId of stored.revokedInstallationIds) {
        const jobId = await enqueueJob(
          tx,
          state.workspace_id,
          'slack_revoke',
          `slack-revoke:${installationId}`,
          { installation_id: installationId },
        );
        if (jobId) jobIds.push(jobId);
      }
      await tx.query(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind)
         VALUES ($1,'user',$2,'slack.connected')`,
        [state.workspace_id, state.user_id],
      );
      return jobIds;
    });
    if (jobs.length > 0) c.executionCtx.waitUntil(runJobsAfterCommit(c.env, state.workspace_id, jobs));
    return c.redirect(callbackLocation(state.workspace_id, 'connected'), 302);
  } catch (error) {
    console.error(JSON.stringify({ at: 'slack.oauth.callback', ok: false, error: error instanceof RouteError ? error.reason : 'upstream_failed' }));
    return c.redirect(callbackLocation(state.workspace_id, 'failed'), 302);
  }
}

export async function disconnectSlack(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const prepared = await inWorkspace(c, async (work) => {
    work.requireAdmin('disconnecting Slack');
    requireStepUp(work.session);
    const row = await loadSlackInstallation(work.tx, work.workspaceId);
    if (!row) return null;
    await work.tx.query(
      `UPDATE slack_installations
          SET status='revoked', revoked_at=now(), remote_revocation_pending=true,
              last_error_code=NULL
        WHERE workspace_id=$1 AND id=$2`,
      [work.workspaceId, row.id],
    );
    await work.tx.query(`UPDATE slack_user_links SET revoked_at=now() WHERE workspace_id=$1 AND installation_id=$2`, [work.workspaceId, row.id]);
    await work.tx.query(`UPDATE slack_run_deliveries SET status='cancelled' WHERE workspace_id=$1 AND installation_id=$2 AND status IN ('pending','queued')`, [work.workspaceId, row.id]);
    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind)
       VALUES ($1,'user',$2,'slack.disconnected')`,
      [work.workspaceId, work.userId],
    );
    const jobId = await enqueueJob(
      work.tx,
      work.workspaceId,
      'slack_revoke',
      `slack-revoke:${row.id}`,
      { installation_id: row.id },
    );
    return { workspaceId: work.workspaceId, jobId };
  });
  if (!prepared) return c.json(slackDisconnectSchema.parse({ status: 'disconnected', remote_revocation: 'not_applicable' }));
  if (prepared.jobId) {
    c.executionCtx.waitUntil(runJobsAfterCommit(c.env, prepared.workspaceId, [prepared.jobId]));
  }
  return c.json(slackDisconnectSchema.parse({ status: 'disconnected', remote_revocation: 'pending' }));
}

/** Platform directory lookup after (and only after) Slack signature verification. */
export async function lookupSlackWorkspace(
  env: Env,
  installKey: string,
): Promise<{ workspaceId: string; installationId: string } | null> {
  const client = await connect(env, 'app');
  try {
    const { rows } = await client.query<{ target_workspace_id: string; installation_id: string }>(
      `SELECT target_workspace_id, installation_id
         FROM slack_installation_directory WHERE slack_install_key=$1`,
      [installKey],
    );
    const row = rows[0];
    return row ? { workspaceId: row.target_workspace_id, installationId: row.installation_id } : null;
  } finally {
    await client.end();
  }
}
