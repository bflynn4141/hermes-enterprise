const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function importHmac(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type SlackRequestVerification =
  | { ok: true; timestamp: number }
  | { ok: false; reason: 'missing_headers' | 'bad_timestamp' | 'stale_request' | 'bad_signature' };

export async function verifySlackRequest(
  headers: Headers,
  rawBody: string,
  signingSecret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<SlackRequestVerification> {
  const timestampRaw = headers.get('x-slack-request-timestamp');
  const signature = headers.get('x-slack-signature');
  if (!timestampRaw || !signature) return { ok: false, reason: 'missing_headers' };
  const timestamp = Number(timestampRaw);
  if (!Number.isInteger(timestamp)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(nowSeconds - timestamp) > 300) return { ok: false, reason: 'stale_request' };
  if (!/^v0=[0-9a-f]{64}$/i.test(signature)) return { ok: false, reason: 'bad_signature' };
  const key = await importHmac(signingSecret);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`v0:${timestampRaw}:${rawBody}`)));
  const supplied = Uint8Array.from(signature.slice(3).match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
  if (supplied.length !== expected.length) return { ok: false, reason: 'bad_signature' };
  const ok = await crypto.subtle.verify('HMAC', key, supplied, encoder.encode(`v0:${timestampRaw}:${rawBody}`));
  return ok ? { ok: true, timestamp } : { ok: false, reason: 'bad_signature' };
}

export interface SlackOAuthStatePayload {
  readonly v: 1;
  readonly workspace_id: string;
  readonly user_id: string;
  readonly nonce: string;
  readonly expires_at: number;
  readonly redirect_uri: string;
}

export async function signSlackOAuthState(payload: SlackOAuthStatePayload, secret: string): Promise<string> {
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await importHmac(secret);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(encoded)));
  return `${encoded}.${bytesToBase64Url(signature)}`;
}

export async function verifySlackOAuthState(
  state: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<SlackOAuthStatePayload | null> {
  const [encoded, signature, extra] = state.split('.');
  if (!encoded || !signature || extra) return null;
  let supplied: Uint8Array;
  try {
    supplied = base64UrlToBytes(signature);
  } catch {
    return null;
  }
  const key = await importHmac(secret);
  if (!(await crypto.subtle.verify('HMAC', key, supplied, encoder.encode(encoded)))) return null;
  try {
    const value = JSON.parse(decoder.decode(base64UrlToBytes(encoded))) as Partial<SlackOAuthStatePayload>;
    if (
      value.v !== 1 || typeof value.workspace_id !== 'string' || typeof value.user_id !== 'string'
      || typeof value.nonce !== 'string' || typeof value.expires_at !== 'number' || typeof value.redirect_uri !== 'string'
      || value.expires_at < nowSeconds || value.expires_at > nowSeconds + 900
    ) return null;
    return value as SlackOAuthStatePayload;
  } catch {
    return null;
  }
}
