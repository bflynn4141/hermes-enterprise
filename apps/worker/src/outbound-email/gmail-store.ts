import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';
import { openSecret, sealSecret, type StoredEnvelope } from '../keys/envelope.js';
import { gmailConfig, gmailFetcher } from './gmail-config.js';
import { refreshGmailToken, type GmailTokenBundle } from './gmail-api.js';

const TOKEN_NAMESPACE = 'hermes/outbound-email/v1';

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  throw new Error('gmail_token_envelope_invalid');
};

export interface GmailAccountRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly provider: 'gmail';
  readonly address: string;
  readonly status: 'disconnected' | 'connected' | 'error' | 'revoked';
  readonly ciphertext: Uint8Array | null;
  readonly iv: Uint8Array | null;
  readonly wrapped_dek: Uint8Array | null;
  readonly wrap_iv: Uint8Array | null;
  readonly kek_version: number | null;
  readonly scope: string | null;
  readonly token_expires_at: Date | null;
  readonly connected_by: string | null;
  readonly last_error: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

const COLUMNS = `id, workspace_id, provider, address, status, ciphertext, iv,
  wrapped_dek, wrap_iv, kek_version, scope, token_expires_at, connected_by,
  last_error, created_at, updated_at`;

function envelope(row: GmailAccountRow): StoredEnvelope {
  return {
    ciphertext: bytes(row.ciphertext),
    iv: bytes(row.iv),
    wrappedDek: bytes(row.wrapped_dek),
    wrapIv: bytes(row.wrap_iv),
    kekVersion: row.kek_version ?? 0,
  };
}

export async function loadGmailAccount(tx: Tx, workspaceId: string, accountId?: string): Promise<GmailAccountRow | null> {
  const result = accountId
    ? await tx.query<GmailAccountRow>(`SELECT ${COLUMNS} FROM outbound_email_accounts WHERE workspace_id=$1 AND id=$2 AND provider='gmail'`, [workspaceId, accountId])
    : await tx.query<GmailAccountRow>(`SELECT ${COLUMNS} FROM outbound_email_accounts WHERE workspace_id=$1 AND provider='gmail' AND status<>'revoked' ORDER BY updated_at DESC LIMIT 1`, [workspaceId]);
  return result.rows[0] ?? null;
}

export async function storeGmailAccount(
  tx: Tx,
  env: Env,
  input: { workspaceId: string; connectedBy: string; address: string; token: GmailTokenBundle },
): Promise<GmailAccountRow> {
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM outbound_email_accounts WHERE workspace_id=$1 AND address=$2 FOR UPDATE`,
    [input.workspaceId, input.address],
  );
  const id = existing.rows[0]?.id ?? crypto.randomUUID();
  const sealed = await sealSecret(
    env,
    { workspaceId: input.workspaceId, keyId: id, namespace: TOKEN_NAMESPACE },
    JSON.stringify(input.token),
  );
  const stored = await tx.query<GmailAccountRow>(
    `INSERT INTO outbound_email_accounts
       (id,workspace_id,provider,address,status,ciphertext,iv,wrapped_dek,wrap_iv,
        kek_version,scope,token_expires_at,connected_by,last_error)
     VALUES ($1,$2,'gmail',$3,'connected',$4,$5,$6,$7,$8,$9,$10,$11,NULL)
     ON CONFLICT (workspace_id,address) DO UPDATE SET
       status='connected', ciphertext=EXCLUDED.ciphertext, iv=EXCLUDED.iv,
       wrapped_dek=EXCLUDED.wrapped_dek, wrap_iv=EXCLUDED.wrap_iv,
       kek_version=EXCLUDED.kek_version, scope=EXCLUDED.scope,
       token_expires_at=EXCLUDED.token_expires_at, connected_by=EXCLUDED.connected_by,
       last_error=NULL
     RETURNING ${COLUMNS}`,
    [
      id, input.workspaceId, input.address, Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv),
      Buffer.from(sealed.wrappedDek), Buffer.from(sealed.wrapIv), sealed.kekVersion,
      input.token.scope, new Date(input.token.expires_at), input.connectedBy,
    ],
  );
  const row = stored.rows[0];
  if (!row) throw new Error('gmail_account_not_stored');
  return row;
}

async function openToken(env: Env, row: GmailAccountRow): Promise<GmailTokenBundle> {
  const plaintext = await openSecret(
    env,
    { workspaceId: row.workspace_id, keyId: row.id, namespace: TOKEN_NAMESPACE },
    envelope(row),
  );
  const parsed = JSON.parse(plaintext) as Partial<GmailTokenBundle>;
  if (typeof parsed.access_token !== 'string' || typeof parsed.refresh_token !== 'string'
    || typeof parsed.expires_at !== 'string' || typeof parsed.scope !== 'string') {
    throw new Error('gmail_token_bundle_invalid');
  }
  return {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    expires_at: parsed.expires_at,
    scope: parsed.scope,
    token_type: typeof parsed.token_type === 'string' ? parsed.token_type : 'Bearer',
  };
}

/** Resolve and atomically refresh a dedicated sender token under its row lock. */
export async function resolveGmailAccessToken(tx: Tx, env: Env, accountId: string): Promise<{ token: string; account: GmailAccountRow }> {
  const locked = await tx.query<GmailAccountRow>(
    `SELECT ${COLUMNS} FROM outbound_email_accounts
      WHERE workspace_id=app_workspace_id() AND id=$1 AND provider='gmail' FOR UPDATE`,
    [accountId],
  );
  const account = locked.rows[0];
  if (!account || account.status !== 'connected') throw new Error('gmail_account_not_connected');
  let token = await openToken(env, account);
  if (Date.parse(token.expires_at) > Date.now() + 5 * 60_000) return { token: token.access_token, account };
  const config = gmailConfig(env);
  if (!config) throw new Error('gmail_not_configured');
  token = await refreshGmailToken(config, token, gmailFetcher(env));
  const sealed = await sealSecret(
    env,
    { workspaceId: account.workspace_id, keyId: account.id, namespace: TOKEN_NAMESPACE },
    JSON.stringify(token),
  );
  const refreshed = await tx.query<GmailAccountRow>(
    `UPDATE outbound_email_accounts SET
       ciphertext=$2,iv=$3,wrapped_dek=$4,wrap_iv=$5,kek_version=$6,
       token_expires_at=$7,scope=$8,status='connected',last_error=NULL
      WHERE workspace_id=app_workspace_id() AND id=$1 RETURNING ${COLUMNS}`,
    [
      account.id, Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv), Buffer.from(sealed.wrappedDek),
      Buffer.from(sealed.wrapIv), sealed.kekVersion, new Date(token.expires_at), token.scope,
    ],
  );
  return { token: token.access_token, account: refreshed.rows[0] ?? account };
}
