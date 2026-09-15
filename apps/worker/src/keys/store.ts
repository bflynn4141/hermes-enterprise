// The provider-key store: the rows, and the only ways they change.
//
// Every function here takes a `Tx` that is already inside a tenant transaction,
// so row-level security is the outer guard and the AAD is the inner one. Both
// have to agree for a decrypt to succeed, which means a bug in one is not
// enough to leak a key across workspaces — the point of having two.
//
// Nothing in this file returns key material except `resolveKey`, which returns
// it to exactly one caller for exactly one request and never writes it
// anywhere. There is no "get key" that a future route could call by accident.
import { USABLE_KEY_STATUSES, type KeyStatus, type MaskedProviderKey } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import {
  fingerprint as computeFingerprint,
  fingerprintPrefix,
  last4 as computeLast4,
  openKey,
  rewrapDek,
  sealKey,
  type KekEnv,
  type StoredEnvelope,
} from './envelope.js';

/** Postgres `bytea` arrives as a Buffer; the crypto layer speaks Uint8Array. */
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error('expected bytea to arrive as bytes');
}

export class KeyStoreError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'not_found'
      | 'duplicate_key'
      | 'no_usable_key'
      | 'key_invalid'
      | 'already_revoked'
      | 'unknown_provider',
  ) {
    super(message);
    this.name = 'KeyStoreError';
  }
}

interface KeyRow {
  id: string;
  provider: string;
  label: string;
  last4: string;
  fingerprint: string;
  status: string;
  verified_models: string[];
  added_by: string | null;
  created_at: Date;
  verified_at: Date | null;
  rotated_at: Date | null;
  revoked_at: Date | null;
  replaces_key_id: string | null;
  synced_model_count: number | null;
  models_synced_at: Date | null;
}

const MASKED_COLUMNS = `id, provider, label, last4, fingerprint, status, verified_models,
                        added_by, created_at, verified_at, rotated_at, revoked_at, replaces_key_id,
                        synced_model_count, models_synced_at`;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/** The only projection the API ever sees. Ciphertext columns are not in it. */
function mask(row: KeyRow): MaskedProviderKey {
  return {
    id: row.id,
    provider: row.provider as MaskedProviderKey['provider'],
    label: row.label,
    last4: row.last4,
    fingerprint_prefix: fingerprintPrefix(row.fingerprint),
    status: row.status as KeyStatus,
    verified_models: row.verified_models,
    added_by: row.added_by,
    created_at: row.created_at.toISOString(),
    verified_at: iso(row.verified_at),
    rotated_at: iso(row.rotated_at),
    revoked_at: iso(row.revoked_at),
    replaces_key_id: row.replaces_key_id,
    // OpenRouter only: hundreds of ids do not fit in `verified_models`, so the
    // row carries how many were synced and when (decision R7).
    synced_model_count: row.synced_model_count,
    models_synced_at: iso(row.models_synced_at),
  };
}

/**
 * Every key this workspace has ever held, live first.
 *
 * Revoked rows stay: `model_calls` references them by id, and a Usage screen
 * that cannot say which key paid for a run in March is a Usage screen that
 * cannot answer the question an invoice raises.
 */
export async function listProviderKeys(tx: Tx, workspaceId: string): Promise<MaskedProviderKey[]> {
  const { rows } = await tx.query<KeyRow>(
    `SELECT ${MASKED_COLUMNS} FROM workspace_provider_keys
      WHERE workspace_id = $1
      ORDER BY (revoked_at IS NULL) DESC, created_at DESC`,
    [workspaceId],
  );
  return rows.map(mask);
}

export async function getProviderKey(tx: Tx, workspaceId: string, keyId: string): Promise<MaskedProviderKey | null> {
  const { rows } = await tx.query<KeyRow>(
    `SELECT ${MASKED_COLUMNS} FROM workspace_provider_keys WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, keyId],
  );
  const row = rows[0];
  return row ? mask(row) : null;
}

export interface AddKeyInput {
  readonly workspaceId: string;
  readonly provider: string;
  readonly label: string;
  readonly plaintext: string;
  readonly addedBy: string;
  /** Set when this row replaces another: a rotation. */
  readonly replacesKeyId?: string | null;
}

/**
 * Store a key.
 *
 * The id is generated here, before the encryption, because it is part of the
 * AAD: the ciphertext has to be bound to the row it will live in, and a
 * database-generated id would arrive too late to bind. That is the whole reason
 * this is not `INSERT ... RETURNING id`.
 */
export async function addProviderKey(
  tx: Tx,
  env: KekEnv,
  input: AddKeyInput,
): Promise<MaskedProviderKey> {
  const keyId = crypto.randomUUID();
  const sealed = await sealKey(env, { workspaceId: input.workspaceId, keyId }, input.plaintext);
  const fingerprint = await computeFingerprint(input.plaintext);

  const { rows } = await tx.query<KeyRow>(
    `INSERT INTO workspace_provider_keys
       (id, workspace_id, provider, label, ciphertext, iv, wrapped_dek, wrap_iv, kek_version,
        fingerprint, last4, status, added_by, replaces_key_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'unverified', $12, $13)
     RETURNING ${MASKED_COLUMNS}`,
    [
      keyId,
      input.workspaceId,
      input.provider,
      input.label,
      Buffer.from(sealed.ciphertext),
      Buffer.from(sealed.iv),
      Buffer.from(sealed.wrappedDek),
      Buffer.from(sealed.wrapIv),
      sealed.kekVersion,
      fingerprint,
      computeLast4(input.plaintext),
      input.addedBy,
      input.replacesKeyId ?? null,
    ],
  );
  const row = rows[0];
  if (!row) throw new KeyStoreError('the key row did not come back from the insert', 'not_found');
  return mask(row);
}

/** True when this workspace already holds this exact key, live. */
export async function findByFingerprint(
  tx: Tx,
  workspaceId: string,
  plaintext: string,
): Promise<MaskedProviderKey | null> {
  const fingerprint = await computeFingerprint(plaintext);
  const { rows } = await tx.query<KeyRow>(
    `SELECT ${MASKED_COLUMNS} FROM workspace_provider_keys
      WHERE workspace_id = $1 AND fingerprint = $2 AND revoked_at IS NULL`,
    [workspaceId, fingerprint],
  );
  const row = rows[0];
  return row ? mask(row) : null;
}

export interface ResolvedKey {
  readonly keyId: string;
  readonly provider: string;
  readonly apiKey: string;
  readonly status: KeyStatus;
}

/**
 * The plaintext, for one caller, for one request.
 *
 * Called inside every provider step rather than once per run, so a rotation
 * mid-run is picked up at the next step and a removal takes effect at the next
 * step too. The plaintext therefore lives for the duration of one fetch and is
 * never persisted, cached or returned upward past the adapter.
 *
 * `workspaceId` is passed separately from the transaction's tenant key on
 * purpose: it goes into the AAD, so if a caller ever managed to read another
 * workspace's row (a policy regression, a query run outside the transaction)
 * the decrypt still fails. Row-level security and the AAD are independent
 * checks of the same claim, which is what makes either one failing survivable.
 */
export async function resolveKey(
  tx: Tx,
  env: KekEnv,
  workspaceId: string,
  provider: string,
): Promise<ResolvedKey> {
  const { rows } = await tx.query<{
    id: string;
    provider: string;
    status: string;
    ciphertext: Uint8Array;
    iv: Uint8Array;
    wrapped_dek: Uint8Array;
    wrap_iv: Uint8Array;
    kek_version: number;
  }>(
    `SELECT id, provider, status, ciphertext, iv, wrapped_dek, wrap_iv, kek_version
       FROM workspace_provider_keys
      WHERE workspace_id = $1 AND provider = $2 AND revoked_at IS NULL
      LIMIT 1`,
    [workspaceId, provider],
  );

  const row = rows[0];
  if (!row) throw new KeyStoreError(`no ${provider} key in this workspace`, 'no_usable_key');
  if (row.status === 'invalid') {
    throw new KeyStoreError(`the ${provider} key was rejected by the provider`, 'key_invalid');
  }
  if (!(USABLE_KEY_STATUSES as readonly string[]).includes(row.status)) {
    throw new KeyStoreError(`the ${provider} key is not verified`, 'no_usable_key');
  }

  const stored: StoredEnvelope = {
    ciphertext: bytes(row.ciphertext),
    iv: bytes(row.iv),
    wrappedDek: bytes(row.wrapped_dek),
    wrapIv: bytes(row.wrap_iv),
    kekVersion: row.kek_version,
  };
  const apiKey = await openKey(env, { workspaceId, keyId: row.id }, stored);
  return { keyId: row.id, provider: row.provider, apiKey, status: row.status as KeyStatus };
}

/**
 * The plaintext of one row by id, whatever its status.
 *
 * `resolveKey` refuses anything but a usable key, which is right for a run and
 * wrong for Verify: the row Verify exists to fix is precisely the `unverified`
 * or `invalid` one. So the status check is lifted here and nowhere else, and
 * the row is addressed by id rather than by provider so that this cannot become
 * a second way to resolve a key for a run.
 */
export async function openKeyForVerification(
  tx: Tx,
  env: KekEnv,
  workspaceId: string,
  keyId: string,
): Promise<string> {
  const stored = await readEnvelope(tx, workspaceId, keyId);
  if (!stored) throw new KeyStoreError('no such key in this workspace', 'not_found');
  return openKey(env, { workspaceId, keyId }, stored);
}

/** Read one row's envelope, for rotation. Never decrypts the key material. */
export async function readEnvelope(
  tx: Tx,
  workspaceId: string,
  keyId: string,
): Promise<StoredEnvelope | null> {
  const { rows } = await tx.query<{
    ciphertext: Uint8Array;
    iv: Uint8Array;
    wrapped_dek: Uint8Array;
    wrap_iv: Uint8Array;
    kek_version: number;
  }>(
    `SELECT ciphertext, iv, wrapped_dek, wrap_iv, kek_version
       FROM workspace_provider_keys WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, keyId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    ciphertext: bytes(row.ciphertext),
    iv: bytes(row.iv),
    wrappedDek: bytes(row.wrapped_dek),
    wrapIv: bytes(row.wrap_iv),
    kekVersion: row.kek_version,
  };
}

/**
 * Record that a provider's model list was synced for this key.
 *
 * Separate from `setKeyStatus` because it is a different fact with a different
 * lifetime: a key can verify without a sync (the sync failed, or the provider
 * has no list), and a sync count that survived a later failed verification
 * would claim models the workspace can no longer reach.
 */
export async function recordModelSync(
  tx: Tx,
  workspaceId: string,
  keyId: string,
  count: number,
): Promise<void> {
  await tx.query(
    `UPDATE workspace_provider_keys
        SET synced_model_count = $3, models_synced_at = now()
      WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, keyId, count],
  );
}

/** Record what a verification probe learned. */
export async function setKeyStatus(
  tx: Tx,
  workspaceId: string,
  keyId: string,
  status: KeyStatus,
  verifiedModels: readonly string[] = [],
): Promise<MaskedProviderKey> {
  const verified = status === 'verified' || status === 'verified_scoped';
  const { rows } = await tx.query<KeyRow>(
    `UPDATE workspace_provider_keys
        SET status = $3,
            verified_models = $4::text[],
            verified_at = CASE WHEN $5 THEN now() ELSE verified_at END
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${MASKED_COLUMNS}`,
    [workspaceId, keyId, status, [...verifiedModels], verified],
  );
  const row = rows[0];
  if (!row) throw new KeyStoreError('no such key in this workspace', 'not_found');
  return mask(row);
}

/**
 * Stop every working run that is using this provider's key, and say why.
 *
 * Used by both removal and a 401: in each case the run cannot continue and the
 * honest thing is to stop it at the next step boundary rather than let it fail
 * on its own at the next provider call with a message about the provider.
 *
 * `stop_requested` is a flag, not an abort: the engine reads it from every
 * delta batch and before every tool, so the run stops with a persisted partial
 * answer instead of vanishing.
 */
export async function requestStopForKey(tx: Tx, workspaceId: string, keyId: string): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    // The id set is collected first: `UPDATE ... FROM model_calls` would match
    // a run once per call it made, and `RETURNING DISTINCT` is not valid SQL.
    `UPDATE runs
        SET stop_requested = true
      WHERE workspace_id = $1
        AND status IN ('working', 'waiting')
        AND stop_requested = false
        AND id IN (SELECT run_id FROM model_calls WHERE workspace_id = $1 AND key_id = $2 AND run_id IS NOT NULL)
      RETURNING id`,
    [workspaceId, keyId],
  );
  return rows.map((row) => row.id);
}

/**
 * Remove a key.
 *
 * Three things, in one transaction: stop the runs using it, zero the
 * ciphertext, mark it revoked. Zeroing rather than deleting the row keeps
 * `model_calls.key_id` meaningful, and zeroing rather than leaving the
 * ciphertext means a later backup restore cannot resurrect a key the Admin
 * deliberately removed — which is the case the plan's KEK-compromise runbook
 * turns on.
 *
 * The columns are NOT NULL, so "zeroed" is a single zero byte: there is no
 * ciphertext to decrypt and the AAD would not authenticate it anyway.
 */
export async function removeProviderKey(
  tx: Tx,
  workspaceId: string,
  keyId: string,
): Promise<{ key: MaskedProviderKey; stoppedRuns: string[] }> {
  const existing = await getProviderKey(tx, workspaceId, keyId);
  if (!existing) throw new KeyStoreError('no such key in this workspace', 'not_found');
  if (existing.revoked_at !== null) throw new KeyStoreError('this key is already revoked', 'already_revoked');

  const stoppedRuns = await requestStopForKey(tx, workspaceId, keyId);

  const { rows } = await tx.query<KeyRow>(
    `UPDATE workspace_provider_keys
        SET status = 'revoked',
            revoked_at = now(),
            ciphertext = '\\x00'::bytea,
            wrapped_dek = '\\x00'::bytea,
            verified_models = '{}'::text[]
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${MASKED_COLUMNS}`,
    [workspaceId, keyId],
  );
  const row = rows[0];
  if (!row) throw new KeyStoreError('no such key in this workspace', 'not_found');
  return { key: mask(row), stoppedRuns };
}

/**
 * Rotate: a new row that names the old one, and the old one revoked.
 *
 * The order matters. The old row is revoked first, because the partial unique
 * index allows only one live row per (workspace, provider) — inserting first
 * would fail the constraint. Both happen in one transaction, so there is no
 * moment when the workspace has no key and no moment when it has two.
 */
export async function rotateProviderKey(
  tx: Tx,
  env: KekEnv,
  input: AddKeyInput & { readonly previousKeyId: string },
): Promise<{ key: MaskedProviderKey; previous: MaskedProviderKey }> {
  const previousRow = await getProviderKey(tx, input.workspaceId, input.previousKeyId);
  if (!previousRow) throw new KeyStoreError('no such key in this workspace', 'not_found');
  if (previousRow.revoked_at !== null) throw new KeyStoreError('this key is already revoked', 'already_revoked');

  const { rows } = await tx.query<KeyRow>(
    `UPDATE workspace_provider_keys
        SET status = 'revoked', revoked_at = now(), rotated_at = now(),
            ciphertext = '\\x00'::bytea, wrapped_dek = '\\x00'::bytea
      WHERE workspace_id = $1 AND id = $2
      RETURNING ${MASKED_COLUMNS}`,
    [input.workspaceId, input.previousKeyId],
  );
  const previous = rows[0];
  if (!previous) throw new KeyStoreError('no such key in this workspace', 'not_found');

  const key = await addProviderKey(tx, env, { ...input, replacesKeyId: input.previousKeyId });
  return { key, previous: mask(previous) };
}

/**
 * Re-wrap one row's DEK under a new KEK version.
 *
 * Returns false when the row is already on the target version, so a rotation
 * that is re-run (a retried job, a resumed Workflow) does no work rather than
 * generating a fresh wrap for no reason.
 */
export async function rewrapProviderKey(
  tx: Tx,
  env: KekEnv,
  workspaceId: string,
  keyId: string,
  toVersion: number,
): Promise<boolean> {
  const stored = await readEnvelope(tx, workspaceId, keyId);
  if (!stored) throw new KeyStoreError('no such key in this workspace', 'not_found');
  if (stored.kekVersion === toVersion) return false;

  const rewrapped = await rewrapDek(env, { workspaceId, keyId }, stored, toVersion);
  // The rowcount is read, not discarded: the UPDATE is guarded on the version
  // this call read, so a concurrent rotation of the same row makes it write
  // nothing — and returning `true` anyway inflated `RotationReport.rewrapped`,
  // which is the number an operator reads before deciding it is safe to delete
  // the old KEK. Overcounting there is how a key becomes unreadable.
  const updated = await tx.query(
    `UPDATE workspace_provider_keys
        SET wrapped_dek = $3, wrap_iv = $4, kek_version = $5
      WHERE workspace_id = $1 AND id = $2 AND kek_version = $6`,
    [
      workspaceId,
      keyId,
      Buffer.from(rewrapped.wrappedDek),
      Buffer.from(rewrapped.wrapIv),
      rewrapped.kekVersion,
      stored.kekVersion,
    ],
  );
  return updated.rowCount === 1;
}
