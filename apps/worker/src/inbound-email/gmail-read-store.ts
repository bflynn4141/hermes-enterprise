import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';
import { openSecret, sealSecret, type StoredEnvelope } from '../keys/envelope.js';
import {
  refreshGmailEvidenceToken,
  type GmailEvidenceTokenBundle,
} from './gmail-read-api.js';
import {
  GMAIL_EVIDENCE_READ_SCOPE,
  gmailEvidenceConfig,
  gmailEvidenceFetcher,
} from './gmail-read-config.js';

const TOKEN_NAMESPACE = 'hermes/inbound-email-evidence/v1';

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  throw new Error('gmail_evidence_token_envelope_invalid');
};

export interface GmailEvidenceAccountRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly provider: 'gmail';
  readonly address: string;
  readonly status: 'connected' | 'error' | 'revoked';
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly wrapped_dek: Uint8Array;
  readonly wrap_iv: Uint8Array;
  readonly kek_version: number;
  readonly scope: typeof GMAIL_EVIDENCE_READ_SCOPE;
  readonly token_expires_at: Date;
  readonly connected_by: string | null;
  readonly last_error: string | null;
  readonly connected_at: Date;
  readonly updated_at: Date;
}

const COLUMNS = `id,workspace_id,provider,address,status,ciphertext,iv,wrapped_dek,
  wrap_iv,kek_version,scope,token_expires_at,connected_by,last_error,connected_at,updated_at`;

const envelope = (row: GmailEvidenceAccountRow): StoredEnvelope => ({
  ciphertext: bytes(row.ciphertext), iv: bytes(row.iv), wrappedDek: bytes(row.wrapped_dek),
  wrapIv: bytes(row.wrap_iv), kekVersion: row.kek_version,
});

export async function loadGmailEvidenceAccount(
  tx: Tx,
  workspaceId: string,
  accountId?: string,
): Promise<GmailEvidenceAccountRow | null> {
  const result = accountId
    ? await tx.query<GmailEvidenceAccountRow>(
      `SELECT ${COLUMNS} FROM gmail_evidence_accounts
        WHERE workspace_id=$1 AND id=$2 AND provider='gmail'`, [workspaceId, accountId],
    )
    : await tx.query<GmailEvidenceAccountRow>(
      `SELECT ${COLUMNS} FROM gmail_evidence_accounts
        WHERE workspace_id=$1 AND provider='gmail' AND status<>'revoked'
        ORDER BY updated_at DESC LIMIT 1`, [workspaceId],
    );
  return result.rows[0] ?? null;
}

export async function storeGmailEvidenceAccount(
  tx: Tx,
  env: Env,
  input: { workspaceId: string; connectedBy: string; address: string; token: GmailEvidenceTokenBundle },
): Promise<GmailEvidenceAccountRow> {
  if (input.token.scope !== GMAIL_EVIDENCE_READ_SCOPE) throw new Error('gmail_evidence_scope_not_readonly');
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM gmail_evidence_accounts WHERE workspace_id=$1 AND address=$2 FOR UPDATE`,
    [input.workspaceId, input.address],
  );
  const id = existing.rows[0]?.id ?? crypto.randomUUID();
  const sealed = await sealSecret(
    env,
    { workspaceId: input.workspaceId, keyId: id, namespace: TOKEN_NAMESPACE },
    JSON.stringify(input.token),
  );
  // An explicit reconnect may replace the selected read mailbox. Old read
  // tokens are erased locally and can never become sender credentials.
  await tx.query(
    `UPDATE gmail_evidence_accounts SET status='revoked',ciphertext='\\x00'::bytea,
       iv='\\x00'::bytea,wrapped_dek='\\x00'::bytea,wrap_iv='\\x00'::bytea,
       last_error='replaced_by_explicit_connection'
      WHERE workspace_id=$1 AND id<>$2 AND status<>'revoked'`,
    [input.workspaceId, id],
  );
  const stored = await tx.query<GmailEvidenceAccountRow>(
    `INSERT INTO gmail_evidence_accounts
       (id,workspace_id,provider,address,status,ciphertext,iv,wrapped_dek,wrap_iv,
        kek_version,scope,token_expires_at,connected_by,last_error)
     VALUES ($1,$2,'gmail',$3,'connected',$4,$5,$6,$7,$8,$9,$10,$11,NULL)
     ON CONFLICT (workspace_id,address) DO UPDATE SET
       status='connected',ciphertext=EXCLUDED.ciphertext,iv=EXCLUDED.iv,
       wrapped_dek=EXCLUDED.wrapped_dek,wrap_iv=EXCLUDED.wrap_iv,
       kek_version=EXCLUDED.kek_version,scope=EXCLUDED.scope,
       token_expires_at=EXCLUDED.token_expires_at,connected_by=EXCLUDED.connected_by,
       last_error=NULL,connected_at=now()
     RETURNING ${COLUMNS}`,
    [
      id, input.workspaceId, input.address, Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv),
      Buffer.from(sealed.wrappedDek), Buffer.from(sealed.wrapIv), sealed.kekVersion,
      input.token.scope, new Date(input.token.expires_at), input.connectedBy,
    ],
  );
  const row = stored.rows[0];
  if (!row) throw new Error('gmail_evidence_account_not_stored');
  return row;
}

async function openToken(env: Env, row: GmailEvidenceAccountRow): Promise<GmailEvidenceTokenBundle> {
  const plaintext = await openSecret(
    env,
    { workspaceId: row.workspace_id, keyId: row.id, namespace: TOKEN_NAMESPACE },
    envelope(row),
  );
  const parsed = JSON.parse(plaintext) as Partial<GmailEvidenceTokenBundle>;
  if (typeof parsed.access_token !== 'string' || typeof parsed.refresh_token !== 'string'
      || typeof parsed.expires_at !== 'string' || parsed.scope !== GMAIL_EVIDENCE_READ_SCOPE) {
    throw new Error('gmail_evidence_token_bundle_invalid');
  }
  return {
    access_token: parsed.access_token, refresh_token: parsed.refresh_token,
    expires_at: parsed.expires_at, scope: GMAIL_EVIDENCE_READ_SCOPE,
    token_type: typeof parsed.token_type === 'string' ? parsed.token_type : 'Bearer',
  };
}

/** Resolve and atomically refresh the dedicated read token under its row lock. */
export async function resolveGmailEvidenceAccessToken(
  tx: Tx,
  env: Env,
  accountId: string,
): Promise<{ token: string; account: GmailEvidenceAccountRow }> {
  const locked = await tx.query<GmailEvidenceAccountRow>(
    `SELECT ${COLUMNS} FROM gmail_evidence_accounts
      WHERE workspace_id=app_workspace_id() AND id=$1 AND provider='gmail' FOR UPDATE`, [accountId],
  );
  const account = locked.rows[0];
  if (!account || account.status !== 'connected') throw new Error('gmail_evidence_account_not_connected');
  let token = await openToken(env, account);
  if (Date.parse(token.expires_at) > Date.now() + 5 * 60_000) return { token: token.access_token, account };
  const config = gmailEvidenceConfig(env);
  if (!config) throw new Error('gmail_evidence_not_configured');
  token = await refreshGmailEvidenceToken(config, token, gmailEvidenceFetcher(env));
  const sealed = await sealSecret(
    env,
    { workspaceId: account.workspace_id, keyId: account.id, namespace: TOKEN_NAMESPACE },
    JSON.stringify(token),
  );
  const refreshed = await tx.query<GmailEvidenceAccountRow>(
    `UPDATE gmail_evidence_accounts SET ciphertext=$2,iv=$3,wrapped_dek=$4,wrap_iv=$5,
       kek_version=$6,token_expires_at=$7,scope=$8,status='connected',last_error=NULL
      WHERE workspace_id=app_workspace_id() AND id=$1 RETURNING ${COLUMNS}`,
    [
      account.id, Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv), Buffer.from(sealed.wrappedDek),
      Buffer.from(sealed.wrapIv), sealed.kekVersion, new Date(token.expires_at), token.scope,
    ],
  );
  return { token: token.access_token, account: refreshed.rows[0] ?? account };
}
