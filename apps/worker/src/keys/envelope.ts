// Envelope encryption for provider keys, on Web Crypto.
//
// Each key gets its own data-encryption key (DEK). The DEK encrypts the key
// material; a key-encryption key (KEK) held as a Worker secret encrypts the
// DEK. Two layers, because rotating one master secret across every tenant row
// must not mean decrypting and re-encrypting every tenant's key material: a KEK
// rotation re-wraps DEKs only, which is a few hundred bytes per row and never
// exposes a provider key's plaintext.
//
// The AAD split is what makes that true, and it is the part worth reading:
//
//   data ciphertext  binds (workspace_id, key_id)
//   DEK wrap         binds (workspace_id, key_id, kek_version)
//
// The data ciphertext deliberately does *not* bind the KEK version, because if
// it did, a rotation would have to rewrite it. The wrap does bind it, so a
// wrapped DEK cannot be replayed under a different KEK version. Both bind the
// workspace and the row, so moving a ciphertext to another row or another
// tenant fails to decrypt rather than succeeding quietly — which is the failure
// mode that matters, because a cross-tenant read is the thing this table exists
// to prevent.
//
// AES-GCM with a 96-bit IV and a fresh random IV per operation. Nothing here
// ever logs, returns or stringifies plaintext.

/** AES-GCM's nonce size. 96 bits is the size the construction is defined for. */
const IV_BYTES = 12;
const DEK_BYTES = 32;

export class KeyCryptoError extends Error {
  constructor(
    message: string,
    readonly reason:
      | 'kek_missing'
      | 'kek_malformed'
      | 'kek_version_unknown'
      | 'decrypt_failed'
      | 'plaintext_empty',
  ) {
    // The message is written by us and never carries key material: every caller
    // here passes a constant plus an id or a version number.
    super(message);
    this.name = 'KeyCryptoError';
  }
}

/**
 * The secrets this module reads. `Env` names `KEK_V1` explicitly; later
 * versions are added as secrets without a code change, so they are read through
 * a string map rather than a typed field. That is the one place a cast is
 * justified: the set of KEK versions is an operational fact, not a compile-time
 * one.
 */
export interface KekEnv {
  /** Which version new material is encrypted under. Defaults to the highest. */
  readonly KEK_CURRENT?: string | undefined;
  readonly KEK_V1?: string | undefined;
}

const KEK_NAME = /^KEK_V(\d+)$/;

/** Every KEK version this environment actually holds, ascending. */
export function kekVersions(env: KekEnv): number[] {
  const bag = env as unknown as Record<string, unknown>;
  const versions: number[] = [];
  for (const [name, value] of Object.entries(bag)) {
    const match = KEK_NAME.exec(name);
    if (match && typeof value === 'string' && value.length > 0) versions.push(Number(match[1]));
  }
  return versions.sort((a, b) => a - b);
}

/**
 * The version new material is encrypted under.
 *
 * `KEK_CURRENT` exists so that a rotation is two deploys, not one: add `KEK_V2`
 * as a secret, deploy, then flip `KEK_CURRENT` to 2. Between the two, a Worker
 * that has the new secret but not the new setting keeps writing v1, which is
 * readable by every instance. Without it, the highest available version would
 * become current the instant the secret landed, and an older instance still
 * serving requests could not read what a newer one had just written.
 *
 * Which is why the unset default is the *lowest* version present, not the
 * highest. `KEK_CURRENT` is optional, so "unset" is the state every
 * single-version deployment is in and therefore the state a rotation starts
 * from — and defaulting to the highest handed back exactly the one-deploy race
 * this setting was introduced to remove: `wrangler secret put KEK_V2` alone
 * would have made v2 current on every instance that had restarted, while the
 * instances that had not could not decrypt what those had just written
 * (`kek_version_unknown`, surfaced as a 503 on every key read). With one
 * version present the two rules agree; with two, the lowest is the one every
 * instance can read, which is the property the two-deploy dance is for.
 */
export function currentKekVersion(env: KekEnv): number {
  const available = kekVersions(env);
  if (available.length === 0) {
    throw new KeyCryptoError('no KEK_V{n} secret is set in this environment', 'kek_missing');
  }
  const declared = (env.KEK_CURRENT ?? '').trim();
  if (declared === '') return available[0] as number;
  const version = Number(declared);
  if (!Number.isInteger(version) || !available.includes(version)) {
    throw new KeyCryptoError(`KEK_CURRENT names version ${declared}, which has no secret`, 'kek_version_unknown');
  }
  return version;
}

function kekMaterial(env: KekEnv, version: number): string {
  const raw = (env as unknown as Record<string, unknown>)[`KEK_V${version}`];
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new KeyCryptoError(`KEK_V${version} is not set in this environment`, 'kek_version_unknown');
  }
  return raw;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.trim());
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importKek(env: KekEnv, version: number): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = decodeBase64(kekMaterial(env, version));
  } catch (error) {
    if (error instanceof KeyCryptoError) throw error;
    throw new KeyCryptoError(`KEK_V${version} is not valid base64`, 'kek_malformed');
  }
  if (raw.byteLength !== 32) {
    // Said as a length, never as a value: a message that echoed the secret
    // would put it in a log line the moment a deploy was misconfigured.
    throw new KeyCryptoError(`KEK_V${version} must decode to 32 bytes, got ${raw.byteLength}`, 'kek_malformed');
  }
  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The AAD the key material is sealed under. Rotation must not change this. */
export function dataAad(workspaceId: string, keyId: string): Uint8Array {
  return encoder.encode(`hermes/provider-key/v1|${workspaceId}|${keyId}`);
}

/** The AAD the wrapped DEK is sealed under. Rotation *does* change this. */
export function wrapAad(workspaceId: string, keyId: string, kekVersion: number): Uint8Array {
  return encoder.encode(`hermes/provider-dek/v1|${workspaceId}|${keyId}|${kekVersion}`);
}

const randomBytes = (length: number): Uint8Array => crypto.getRandomValues(new Uint8Array(length));

/** What one row stores. Every field is bytes or a version; none is a secret. */
export interface StoredEnvelope {
  readonly ciphertext: Uint8Array;
  readonly iv: Uint8Array;
  readonly wrappedDek: Uint8Array;
  readonly wrapIv: Uint8Array;
  readonly kekVersion: number;
}

export interface EnvelopeIdentity {
  readonly workspaceId: string;
  readonly keyId: string;
}

export interface SecretEnvelopeIdentity extends EnvelopeIdentity {
  /** Stable, non-secret domain separator such as `hermes/slack-installation/v1`. */
  readonly namespace: string;
}

function secretDataAad(id: SecretEnvelopeIdentity): Uint8Array {
  return encoder.encode(`${id.namespace}|data|${id.workspaceId}|${id.keyId}`);
}

function secretWrapAad(id: SecretEnvelopeIdentity, kekVersion: number): Uint8Array {
  return encoder.encode(`${id.namespace}|dek|${id.workspaceId}|${id.keyId}|${kekVersion}`);
}

async function aesEncrypt(key: CryptoKey, iv: Uint8Array, aad: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const out = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
    key,
    data as BufferSource,
  );
  return new Uint8Array(out);
}

async function aesDecrypt(
  key: CryptoKey,
  iv: Uint8Array,
  aad: Uint8Array,
  data: Uint8Array,
  what: string,
): Promise<Uint8Array> {
  try {
    const out = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource, additionalData: aad as BufferSource },
      key,
      data as BufferSource,
    );
    return new Uint8Array(out);
  } catch {
    // AES-GCM does not distinguish "wrong key" from "wrong AAD" from "tampered
    // ciphertext", and neither do we: all three mean this row does not belong
    // to this caller, and telling them apart would only help an attacker.
    throw new KeyCryptoError(`${what} did not authenticate`, 'decrypt_failed');
  }
}

/** Encrypt one provider key under a fresh DEK, wrapped by the current KEK. */
export async function sealKey(env: KekEnv, id: EnvelopeIdentity, plaintext: string): Promise<StoredEnvelope> {
  if (plaintext.length === 0) throw new KeyCryptoError('a provider key cannot be empty', 'plaintext_empty');

  const kekVersion = currentKekVersion(env);
  const kek = await importKek(env, kekVersion);

  const dekBytes = randomBytes(DEK_BYTES);
  const dek = await crypto.subtle.importKey('raw', dekBytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);

  const iv = randomBytes(IV_BYTES);
  const ciphertext = await aesEncrypt(dek, iv, dataAad(id.workspaceId, id.keyId), encoder.encode(plaintext));

  // The DEK is wrapped as raw bytes with AES-GCM rather than through
  // `wrapKey`, because `wrapKey` on a non-extractable key is not available and
  // making the DEK extractable to wrap it buys nothing: either way the 32 bytes
  // pass through the encrypt call. Doing it explicitly keeps the AAD visible.
  const wrapIv = randomBytes(IV_BYTES);
  const wrappedDek = await aesEncrypt(kek, wrapIv, wrapAad(id.workspaceId, id.keyId, kekVersion), dekBytes);
  dekBytes.fill(0);

  return { ciphertext, iv, wrappedDek, wrapIv, kekVersion };
}

/**
 * Encrypt non-provider integration material under its own AAD namespace.
 * This shares the KEK/DEK boundary and rotation mechanics without allowing a
 * Slack token envelope to authenticate as a provider credential (or vice versa).
 */
export async function sealSecret(
  env: KekEnv,
  id: SecretEnvelopeIdentity,
  plaintext: string,
): Promise<StoredEnvelope> {
  if (plaintext.length === 0) throw new KeyCryptoError('a secret cannot be empty', 'plaintext_empty');
  if (!/^hermes\/[a-z0-9-]+\/v\d+$/.test(id.namespace)) {
    throw new KeyCryptoError('the secret namespace is invalid', 'decrypt_failed');
  }
  const kekVersion = currentKekVersion(env);
  const kek = await importKek(env, kekVersion);
  const dekBytes = randomBytes(DEK_BYTES);
  const dek = await crypto.subtle.importKey('raw', dekBytes as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await aesEncrypt(dek, iv, secretDataAad(id), encoder.encode(plaintext));
  const wrapIv = randomBytes(IV_BYTES);
  const wrappedDek = await aesEncrypt(kek, wrapIv, secretWrapAad(id, kekVersion), dekBytes);
  dekBytes.fill(0);
  return { ciphertext, iv, wrappedDek, wrapIv, kekVersion };
}

/** Recover the plaintext. Only for the workspace and row it was sealed under. */
export async function openKey(env: KekEnv, id: EnvelopeIdentity, stored: StoredEnvelope): Promise<string> {
  const kek = await importKek(env, stored.kekVersion);
  const dekBytes = await aesDecrypt(
    kek,
    stored.wrapIv,
    wrapAad(id.workspaceId, id.keyId, stored.kekVersion),
    stored.wrappedDek,
    'the wrapped data key',
  );
  const dek = await crypto.subtle.importKey('raw', dekBytes as BufferSource, 'AES-GCM', false, ['decrypt']);
  dekBytes.fill(0);

  const plaintext = await aesDecrypt(
    dek,
    stored.iv,
    dataAad(id.workspaceId, id.keyId),
    stored.ciphertext,
    'the key ciphertext',
  );
  return decoder.decode(plaintext);
}

/** Recover integration material only under the namespace and row it was sealed for. */
export async function openSecret(
  env: KekEnv,
  id: SecretEnvelopeIdentity,
  stored: StoredEnvelope,
): Promise<string> {
  const kek = await importKek(env, stored.kekVersion);
  const dekBytes = await aesDecrypt(
    kek,
    stored.wrapIv,
    secretWrapAad(id, stored.kekVersion),
    stored.wrappedDek,
    'the wrapped data key',
  );
  const dek = await crypto.subtle.importKey('raw', dekBytes as BufferSource, 'AES-GCM', false, ['decrypt']);
  dekBytes.fill(0);
  const plaintext = await aesDecrypt(
    dek,
    stored.iv,
    secretDataAad(id),
    stored.ciphertext,
    'the secret ciphertext',
  );
  return decoder.decode(plaintext);
}

/**
 * Re-wrap a DEK under a different KEK version.
 *
 * This is the whole of a KEK rotation. The data ciphertext and its IV are
 * untouched, so the provider key's plaintext is never re-encrypted and — more
 * to the point — never materialises as a string anywhere in this function.
 */
export async function rewrapDek(
  env: KekEnv,
  id: EnvelopeIdentity,
  stored: StoredEnvelope,
  toVersion: number,
): Promise<Pick<StoredEnvelope, 'wrappedDek' | 'wrapIv' | 'kekVersion'>> {
  const from = await importKek(env, stored.kekVersion);
  const dekBytes = await aesDecrypt(
    from,
    stored.wrapIv,
    wrapAad(id.workspaceId, id.keyId, stored.kekVersion),
    stored.wrappedDek,
    'the wrapped data key',
  );

  const to = await importKek(env, toVersion);
  const wrapIv = randomBytes(IV_BYTES);
  const wrappedDek = await aesEncrypt(to, wrapIv, wrapAad(id.workspaceId, id.keyId, toVersion), dekBytes);
  dekBytes.fill(0);

  return { wrappedDek, wrapIv, kekVersion: toVersion };
}

/** Re-wrap a namespaced integration DEK without decrypting its token payload. */
export async function rewrapSecretDek(
  env: KekEnv,
  id: SecretEnvelopeIdentity,
  stored: StoredEnvelope,
  toVersion: number,
): Promise<Pick<StoredEnvelope, 'wrappedDek' | 'wrapIv' | 'kekVersion'>> {
  const from = await importKek(env, stored.kekVersion);
  const dekBytes = await aesDecrypt(
    from,
    stored.wrapIv,
    secretWrapAad(id, stored.kekVersion),
    stored.wrappedDek,
    'the wrapped data key',
  );
  const to = await importKek(env, toVersion);
  const wrapIv = randomBytes(IV_BYTES);
  const wrappedDek = await aesEncrypt(to, wrapIv, secretWrapAad(id, toVersion), dekBytes);
  dekBytes.fill(0);
  return { wrappedDek, wrapIv, kekVersion: toVersion };
}

/**
 * SHA-256 of the key material, hex. Two Admins pasting the same key produce the
 * same fingerprint, so a re-paste is recognised without decrypting anything,
 * and a key can be matched against a provider dashboard without being shown.
 */
export async function fingerprint(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(plaintext));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The only characters of a key the product ever displays. */
export function last4(plaintext: string): string {
  return plaintext.slice(-4).padStart(4, '*');
}

/** The prefix the list route exposes: enough to compare, not enough to use. */
export const FINGERPRINT_PREFIX_LENGTH = 12;
export const fingerprintPrefix = (full: string): string => full.slice(0, FINGERPRINT_PREFIX_LENGTH);
