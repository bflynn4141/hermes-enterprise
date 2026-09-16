import type { Tx } from '../../db/client.js';
import type { Env } from '../../env.js';
import { openSecret, rewrapSecretDek, sealSecret, type KekEnv, type StoredEnvelope } from '../../keys/envelope.js';
import { refreshSlackToken, type SlackOAuthGrant, type SlackTokenBundle } from './api.js';
import { slackConfig, slackInstallKey } from './config.js';

const TOKEN_NAMESPACE = 'hermes/slack-installation/v1';

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  throw new Error('expected Slack token envelope bytes');
};

export interface SlackInstallationRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly installed_by: string;
  readonly slack_install_key: string;
  readonly slack_app_id: string;
  readonly slack_enterprise_id: string | null;
  readonly slack_enterprise_name: string | null;
  readonly slack_team_id: string | null;
  readonly slack_team_name: string | null;
  readonly is_enterprise_install: boolean;
  readonly slack_bot_user_id: string;
  readonly slack_authed_user_id: string | null;
  readonly granted_scopes: string[];
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly wrapped_dek: Uint8Array;
  readonly wrap_iv: Uint8Array;
  readonly kek_version: number;
  readonly token_expires_at: Date | null;
  readonly status: 'connected' | 'error' | 'revoked';
  readonly last_error_code: string | null;
  readonly remote_revocation_pending: boolean;
  readonly connected_at: Date;
  readonly revoked_at: Date | null;
}

const COLUMNS = `id, workspace_id, installed_by, slack_install_key, slack_app_id,
  slack_enterprise_id, slack_enterprise_name, slack_team_id, slack_team_name,
  is_enterprise_install, slack_bot_user_id, slack_authed_user_id, granted_scopes,
  ciphertext, iv, wrapped_dek, wrap_iv, kek_version, token_expires_at, status,
  last_error_code, remote_revocation_pending, connected_at, revoked_at`;

function envelope(row: SlackInstallationRow): StoredEnvelope {
  return {
    ciphertext: bytes(row.ciphertext),
    iv: bytes(row.iv),
    wrappedDek: bytes(row.wrapped_dek),
    wrapIv: bytes(row.wrap_iv),
    kekVersion: row.kek_version,
  };
}

export async function loadSlackInstallation(tx: Tx, workspaceId: string): Promise<SlackInstallationRow | null> {
  const { rows } = await tx.query<SlackInstallationRow>(
    `SELECT ${COLUMNS} FROM slack_installations
      WHERE workspace_id=$1 AND status <> 'revoked'
      ORDER BY connected_at DESC LIMIT 1`,
    [workspaceId],
  );
  return rows[0] ?? null;
}

export async function loadSlackInstallationById(
  tx: Tx,
  workspaceId: string,
  installationId: string,
  forUpdate = false,
): Promise<SlackInstallationRow | null> {
  const { rows } = await tx.query<SlackInstallationRow>(
    `SELECT ${COLUMNS} FROM slack_installations WHERE workspace_id=$1 AND id=$2${forUpdate ? ' FOR UPDATE' : ''}`,
    [workspaceId, installationId],
  );
  return rows[0] ?? null;
}

export async function storeSlackInstallation(
  tx: Tx,
  env: Env,
  input: { workspaceId: string; installedBy: string; grant: SlackOAuthGrant },
): Promise<{ installation: SlackInstallationRow; revokedInstallationIds: string[] }> {
  const installKey = slackInstallKey({
    isEnterpriseInstall: input.grant.is_enterprise_install,
    enterpriseId: input.grant.enterprise?.id,
    teamId: input.grant.team?.id,
  });
  if (!installKey || !input.grant.authed_user_id) throw new Error('slack_oauth_identity_incomplete');
  const id = crypto.randomUUID();
  const sealed = await sealSecret(
    env,
    { workspaceId: input.workspaceId, keyId: id, namespace: TOKEN_NAMESPACE },
    JSON.stringify(input.grant.token),
  );
  const previous = await tx.query<{ id: string; slack_install_key: string }>(
    `SELECT id, slack_install_key FROM slack_installations
      WHERE workspace_id=$1 AND (status <> 'revoked' OR remote_revocation_pending) FOR UPDATE`,
    [input.workspaceId],
  );
  const sameTargetIds = previous.rows.filter((row) => row.slack_install_key === installKey).map((row) => row.id);
  const revokedInstallationIds = previous.rows.filter((row) => row.slack_install_key !== installKey).map((row) => row.id);
  if (sameTargetIds.length > 0) {
    await tx.query(
      `UPDATE slack_installations SET status='revoked', revoked_at=now(), remote_revocation_pending=false,
          ciphertext='\\x00'::bytea, iv='\\x00'::bytea, wrapped_dek='\\x00'::bytea, wrap_iv='\\x00'::bytea,
          token_expires_at=NULL
        WHERE workspace_id=$1 AND id = ANY($2::uuid[])`,
      [input.workspaceId, sameTargetIds],
    );
  }
  if (revokedInstallationIds.length > 0) {
    await tx.query(
      `UPDATE slack_installations SET status='revoked', revoked_at=now(), remote_revocation_pending=true
        WHERE workspace_id=$1 AND id = ANY($2::uuid[])`,
      [input.workspaceId, revokedInstallationIds],
    );
  }
  const previousIds = previous.rows.map((row) => row.id);
  if (previousIds.length > 0) {
    await tx.query(
      `UPDATE slack_user_links SET revoked_at=now()
        WHERE workspace_id=$1 AND installation_id = ANY($2::uuid[]) AND revoked_at IS NULL`,
      [input.workspaceId, previousIds],
    );
    await tx.query(
      `UPDATE slack_run_deliveries SET status='cancelled'
        WHERE workspace_id=$1 AND installation_id = ANY($2::uuid[]) AND status IN ('pending','queued')`,
      [input.workspaceId, previousIds],
    );
  }
  const { rows } = await tx.query<SlackInstallationRow>(
    `INSERT INTO slack_installations
       (id, workspace_id, installed_by, slack_install_key, slack_app_id,
        slack_enterprise_id, slack_enterprise_name, slack_team_id, slack_team_name,
        is_enterprise_install, slack_bot_user_id, slack_authed_user_id, granted_scopes,
        ciphertext, iv, wrapped_dek, wrap_iv, kek_version, token_expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING ${COLUMNS}`,
    [
      id, input.workspaceId, input.installedBy, installKey, input.grant.app_id,
      input.grant.enterprise?.id ?? null, input.grant.enterprise?.name ?? null,
      input.grant.team?.id ?? null, input.grant.team?.name ?? null,
      input.grant.is_enterprise_install, input.grant.bot_user_id, input.grant.authed_user_id,
      input.grant.scope, Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv),
      Buffer.from(sealed.wrappedDek), Buffer.from(sealed.wrapIv), sealed.kekVersion,
      input.grant.token.expires_at ? new Date(input.grant.token.expires_at) : null,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('slack_installation_not_stored');
  await tx.query(
    `INSERT INTO slack_user_links (workspace_id, installation_id, slack_user_id, user_id, linked_by)
     VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (installation_id, slack_user_id)
     DO UPDATE SET user_id=EXCLUDED.user_id, linked_by=EXCLUDED.linked_by, revoked_at=NULL, linked_at=now()`,
    [input.workspaceId, row.id, input.grant.authed_user_id, input.installedBy],
  );
  return { installation: row, revokedInstallationIds };
}

async function openToken(env: Env, row: SlackInstallationRow): Promise<SlackTokenBundle> {
  const plaintext = await openSecret(
    env,
    { workspaceId: row.workspace_id, keyId: row.id, namespace: TOKEN_NAMESPACE },
    envelope(row),
  );
  const parsed = JSON.parse(plaintext) as Partial<SlackTokenBundle>;
  if (typeof parsed.access_token !== 'string') throw new Error('slack_token_bundle_invalid');
  return {
    access_token: parsed.access_token,
    refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : null,
    token_type: typeof parsed.token_type === 'string' ? parsed.token_type : 'bot',
    expires_at: typeof parsed.expires_at === 'string' ? parsed.expires_at : null,
  };
}

/** Read a revoked installation token only for its durable Slack-side uninstall job. */
export async function openSlackAccessTokenForRevocation(env: Env, row: SlackInstallationRow): Promise<string> {
  return (await openToken(env, row)).access_token;
}

/** Resolve and, under the row lock, atomically rotate a 12-hour Slack token. */
export async function resolveSlackAccessToken(tx: Tx, env: Env, row: SlackInstallationRow): Promise<string> {
  const locked = await tx.query<SlackInstallationRow>(
    `SELECT ${COLUMNS} FROM slack_installations WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
    [row.workspace_id, row.id],
  );
  const current = locked.rows[0];
  if (!current || current.status === 'revoked') throw new Error('slack_installation_revoked');
  let token = await openToken(env, current);
  const expiresAt = token.expires_at ? Date.parse(token.expires_at) : Number.POSITIVE_INFINITY;
  if (expiresAt > Date.now() + 5 * 60_000) return token.access_token;
  if (!token.refresh_token) throw new Error('slack_refresh_token_missing');
  const config = slackConfig(env);
  if (!config) throw new Error('slack_not_configured');
  token = await refreshSlackToken(config, token.refresh_token);
  const sealed = await sealSecret(
    env,
    { workspaceId: current.workspace_id, keyId: current.id, namespace: TOKEN_NAMESPACE },
    JSON.stringify(token),
  );
  await tx.query(
    `UPDATE slack_installations SET ciphertext=$3, iv=$4, wrapped_dek=$5, wrap_iv=$6,
       kek_version=$7, token_expires_at=$8, status='connected', last_error_code=NULL
      WHERE workspace_id=$1 AND id=$2`,
    [
      current.workspace_id, current.id, Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv),
      Buffer.from(sealed.wrappedDek), Buffer.from(sealed.wrapIv), sealed.kekVersion,
      token.expires_at ? new Date(token.expires_at) : null,
    ],
  );
  return token.access_token;
}

export async function rewrapSlackInstallation(
  tx: Tx,
  env: KekEnv,
  workspaceId: string,
  installationId: string,
  toVersion: number,
): Promise<boolean> {
  const { rows } = await tx.query<SlackInstallationRow>(
    `SELECT ${COLUMNS} FROM slack_installations
      WHERE workspace_id=$1 AND id=$2
        AND (status <> 'revoked' OR remote_revocation_pending) FOR UPDATE`,
    [workspaceId, installationId],
  );
  const row = rows[0];
  if (!row) throw new Error('slack_installation_not_found');
  if (row.kek_version === toVersion) return false;
  const rewrapped = await rewrapSecretDek(
    env,
    { workspaceId, keyId: installationId, namespace: TOKEN_NAMESPACE },
    envelope(row),
    toVersion,
  );
  const updated = await tx.query(
    `UPDATE slack_installations SET wrapped_dek=$3, wrap_iv=$4, kek_version=$5
      WHERE workspace_id=$1 AND id=$2 AND kek_version=$6`,
    [workspaceId, installationId, Buffer.from(rewrapped.wrappedDek), Buffer.from(rewrapped.wrapIv),
     rewrapped.kekVersion, row.kek_version],
  );
  return updated.rowCount === 1;
}
