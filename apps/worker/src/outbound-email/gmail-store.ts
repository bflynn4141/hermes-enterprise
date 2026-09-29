import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';
import { openSecret, sealSecret, type StoredEnvelope } from '../keys/envelope.js';
import { refreshRotatingToken, type OwnTransaction } from '../keys/token-refresh.js';
import { gmailConfig, gmailFetcher } from './gmail-config.js';
import { GmailApiError, refreshGmailToken, type GmailTokenBundle } from './gmail-api.js';
import { microsoftConfig, microsoftFetcher } from './microsoft-config.js';
import { refreshMicrosoftToken } from './microsoft-api.js';

// The workspace's sending accounts, Gmail or Microsoft (C99). One row per
// address; the token is sealed the same way whichever provider issued it.
export type SendingProvider = 'gmail' | 'microsoft';

const TOKEN_NAMESPACE = 'hermes/outbound-email/v1';

const bytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  throw new Error('gmail_token_envelope_invalid');
};

export interface GmailAccountRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly provider: SendingProvider;
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

/** The workspace's current sending account, of either provider: the most recently changed one still in use. */
export async function loadSendingAccount(tx: Tx, workspaceId: string, accountId?: string): Promise<GmailAccountRow | null> {
  const result = accountId
    ? await tx.query<GmailAccountRow>(`SELECT ${COLUMNS} FROM outbound_email_accounts WHERE workspace_id=$1 AND id=$2`, [workspaceId, accountId])
    : await tx.query<GmailAccountRow>(`SELECT ${COLUMNS} FROM outbound_email_accounts WHERE workspace_id=$1 AND status<>'revoked' ORDER BY updated_at DESC LIMIT 1`, [workspaceId]);
  return result.rows[0] ?? null;
}

export async function storeSendingAccount(
  tx: Tx,
  env: Env,
  input: { workspaceId: string; connectedBy: string; address: string; token: GmailTokenBundle; provider: SendingProvider },
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
     VALUES ($1,$2,$12,$3,'connected',$4,$5,$6,$7,$8,$9,$10,$11,NULL)
     ON CONFLICT (workspace_id,address) DO UPDATE SET
       provider=EXCLUDED.provider, status='connected', ciphertext=EXCLUDED.ciphertext, iv=EXCLUDED.iv,
       wrapped_dek=EXCLUDED.wrapped_dek, wrap_iv=EXCLUDED.wrap_iv,
       kek_version=EXCLUDED.kek_version, scope=EXCLUDED.scope,
       token_expires_at=EXCLUDED.token_expires_at, connected_by=EXCLUDED.connected_by,
       last_error=NULL
     RETURNING ${COLUMNS}`,
    [
      id, input.workspaceId, input.address, Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv),
      Buffer.from(sealed.wrappedDek), Buffer.from(sealed.wrapIv), sealed.kekVersion,
      input.token.scope, new Date(input.token.expires_at), input.connectedBy, input.provider,
    ],
  );
  const row = stored.rows[0];
  if (!row) throw new Error('gmail_account_not_stored');
  return row;
}

/** A Gmail sender; kept for the callers that only ever connect Gmail. */
export const storeGmailAccount = (
  tx: Tx,
  env: Env,
  input: { workspaceId: string; connectedBy: string; address: string; token: GmailTokenBundle },
): Promise<GmailAccountRow> => storeSendingAccount(tx, env, { ...input, provider: 'gmail' });

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

/** The account, if connected. `lock` serializes refreshes without blocking foreign-key checks. */
async function loadConnectedAccount(tx: Tx, accountId: string, lock: boolean): Promise<GmailAccountRow> {
  const result = await tx.query<GmailAccountRow>(
    `SELECT ${COLUMNS} FROM outbound_email_accounts
      WHERE workspace_id=app_workspace_id() AND id=$1${lock ? ' FOR NO KEY UPDATE' : ''}`,
    [accountId],
  );
  const account = result.rows[0];
  if (!account || account.status !== 'connected') throw new SendingAccountUnavailable('gmail_account_not_connected');
  return account;
}

/**
 * The sending account can't send until a person reconnects it: it was
 * disconnected, or its provider refused the stored grant. Approved email
 * that needs it waits for a mailbox instead of retrying (docs/CONNECTORS.md).
 */
export class SendingAccountUnavailable extends Error {
  constructor(readonly code: 'gmail_account_not_connected' | 'refresh_grant_revoked') {
    super(code);
    this.name = 'SendingAccountUnavailable';
  }
}

const fresh = (token: GmailTokenBundle): boolean => Date.parse(token.expires_at) > Date.now() + 5 * 60_000;

function refresherFor(env: Env, provider: SendingProvider): (current: GmailTokenBundle) => Promise<GmailTokenBundle> {
  if (provider === 'microsoft') {
    const config = microsoftConfig(env);
    if (!config) throw new Error('microsoft_not_configured');
    return (current) => refreshMicrosoftToken(config, current, microsoftFetcher(env));
  }
  const config = gmailConfig(env);
  if (!config) throw new Error('gmail_not_configured');
  return (current) => refreshGmailToken(config, current, gmailFetcher(env));
}

interface OpenedAccount {
  readonly account: GmailAccountRow;
  readonly token: GmailTokenBundle;
}

/**
 * Resolve a sending account's token. Microsoft replaces the refresh token on
 * every refresh (Google may), so a refresh commits on its own connection
 * (`own`), under the row lock, before the caller's transaction can lose it.
 */
export async function resolveSendingAccessToken(
  tx: Tx,
  env: Env,
  accountId: string,
  own: OwnTransaction,
): Promise<{ token: string; account: GmailAccountRow }> {
  const account = await loadConnectedAccount(tx, accountId, false);
  const token = await openToken(env, account);
  if (fresh(token)) return { token: token.access_token, account };
  const exchange = refresherFor(env, account.provider);
  try {
    return await refreshSendingToken(env, account, accountId, own, exchange);
  } catch (error) {
    if (!(error instanceof GmailApiError && error.grantRevoked)) throw error;
    // The provider will never honour this grant again. Say so on the account,
    // in its own transaction so the caller's rollback can't undo it, and never
    // over a disconnect that already marked it revoked.
    await own((quarantine) => quarantine.query(
      `UPDATE outbound_email_accounts SET status='error', last_error='refresh_grant_revoked'
        WHERE workspace_id=app_workspace_id() AND id=$1 AND status='connected'`,
      [accountId],
    ));
    throw new SendingAccountUnavailable('refresh_grant_revoked');
  }
}

function refreshSendingToken(
  env: Env,
  account: GmailAccountRow,
  accountId: string,
  own: OwnTransaction,
  exchange: (current: GmailTokenBundle) => Promise<GmailTokenBundle>,
): Promise<{ token: string; account: GmailAccountRow }> {
  return refreshRotatingToken<OpenedAccount, { token: string; account: GmailAccountRow }>(own, {
    lock: async (locked) => {
      const current = await loadConnectedAccount(locked, accountId, true);
      return { account: current, token: await openToken(env, current) };
    },
    reuse: (current) => (fresh(current.token) ? { token: current.token.access_token, account: current.account } : null),
    exchange: async (current) => ({ account: current.account, token: await exchange(current.token) }),
    store: async (locked, next) => {
      const sealed = await sealSecret(
        env,
        { workspaceId: account.workspace_id, keyId: account.id, namespace: TOKEN_NAMESPACE },
        JSON.stringify(next.token),
      );
      const refreshed = await locked.query<GmailAccountRow>(
        `UPDATE outbound_email_accounts SET
           ciphertext=$2,iv=$3,wrapped_dek=$4,wrap_iv=$5,kek_version=$6,
           token_expires_at=$7,scope=$8,status='connected',last_error=NULL
          WHERE workspace_id=app_workspace_id() AND id=$1 RETURNING ${COLUMNS}`,
        [
          account.id, Buffer.from(sealed.ciphertext), Buffer.from(sealed.iv), Buffer.from(sealed.wrappedDek),
          Buffer.from(sealed.wrapIv), sealed.kekVersion, new Date(next.token.expires_at), next.token.scope,
        ],
      );
      return { token: next.token.access_token, account: refreshed.rows[0] ?? next.account };
    },
  });
}
