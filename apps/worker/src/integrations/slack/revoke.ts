import type { Env } from '../../env.js';
import { withWorkspaceTransaction, type Job } from '../../jobs.js';
import { callSlackWebApi, SlackApiError } from './api.js';
import { slackConfig } from './config.js';
import { loadSlackInstallationById, openSlackAccessTokenForRevocation } from './store.js';

const ALREADY_REVOKED = new Set(['invalid_auth', 'token_revoked', 'account_inactive', 'invalid_grant']);

/** Durably uninstall a locally revoked Slack target, then erase its token. */
export async function runSlackRevokeJob(env: Env, job: Job): Promise<void> {
  const payload = job.payload as { installation_id?: unknown };
  if (typeof payload?.installation_id !== 'string') throw new Error('slack_revoke_payload_invalid');
  const config = slackConfig(env);
  if (!config) throw new Error('slack_not_configured');

  await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    // Keep the row lock through uninstall so a same-target reauthorization
    // cannot race an old cleanup job and get uninstalled after it commits.
    const row = await loadSlackInstallationById(
      tx,
      job.workspace_id,
      payload.installation_id as string,
      true,
    );
    if (!row || row.status !== 'revoked' || !row.remote_revocation_pending) return;

    const token = await openSlackAccessTokenForRevocation(env, row);
    try {
      await callSlackWebApi('apps.uninstall', token, {
        client_id: config.clientId,
        client_secret: config.clientSecret,
      });
    } catch (error) {
      if (!(error instanceof SlackApiError) || !ALREADY_REVOKED.has(error.code)) throw error;
    }
    await tx.query(
      `UPDATE slack_installations
          SET remote_revocation_pending=false, ciphertext='\\x00'::bytea, iv='\\x00'::bytea,
              wrapped_dek='\\x00'::bytea, wrap_iv='\\x00'::bytea, token_expires_at=NULL,
              last_error_code=NULL
        WHERE workspace_id=$1 AND id=$2 AND status='revoked'`,
      [job.workspace_id, row.id],
    );
  });
}
