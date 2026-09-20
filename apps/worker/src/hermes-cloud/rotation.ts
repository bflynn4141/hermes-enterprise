import type { Tx } from '../db/client.js';
import { rewrapSecretDek, type KekEnv } from '../keys/envelope.js';
import { cloudCredentialIdentity, type CloudCredentialKind } from './credential-envelope.js';

export type { CloudCredentialKind } from './credential-envelope.js';
// Identifiers and predicates are fixed here; callers cannot supply SQL.
const targets = {
  cloud_connection: { table: 'cloud_connections', live: "status IN ('verification_required','connected','reconnect_required')" },
  cloud_connection_attempt: { table: 'cloud_connection_attempts', live: "status='pending' AND expires_at>now()" },
} as const;

/** Tenant-scoped, row-locked DEK rotation; never decrypt the credential payload. */
export async function rewrapCloudCredential(tx: Tx, env: KekEnv, workspaceId: string, keyId: string,
  toVersion: number, kind: CloudCredentialKind): Promise<boolean> {
  const { table, live } = targets[kind];
  const { rows } = await tx.query<{ wrapped_dek: Uint8Array; wrap_iv: Uint8Array; kek_version: number }>(
    `SELECT wrapped_dek, wrap_iv, kek_version FROM ${table}
      WHERE workspace_id=$1 AND id=$2 AND ${live} FOR UPDATE`, [workspaceId, keyId]);
  const row = rows[0];
  // An attempt may have been consumed/erased since enumeration.
  if (!row || row.kek_version === toVersion) return false;
  const wrapped = await rewrapSecretDek(env, cloudCredentialIdentity(kind, workspaceId, keyId), {
    // rewrapSecretDek uses only the wrapped DEK; payload bytes are not fetched.
    ciphertext: new Uint8Array(), iv: new Uint8Array(),
    wrappedDek: new Uint8Array(row.wrapped_dek), wrapIv: new Uint8Array(row.wrap_iv), kekVersion: row.kek_version,
  }, toVersion);
  const result = await tx.query(`UPDATE ${table} SET wrapped_dek=$3, wrap_iv=$4, kek_version=$5
    WHERE workspace_id=$1 AND id=$2 AND kek_version=$6 AND ${live}`,
  [workspaceId, keyId, Buffer.from(wrapped.wrappedDek), Buffer.from(wrapped.wrapIv), wrapped.kekVersion, row.kek_version]);
  return result.rowCount === 1;
}
