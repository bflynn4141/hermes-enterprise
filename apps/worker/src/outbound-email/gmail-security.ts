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

async function hmac(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export interface GmailOAuthState {
  readonly v: 1;
  readonly workspace_id: string;
  readonly user_id: string;
  readonly nonce: string;
  readonly expires_at: number;
  readonly redirect_uri: string;
}

export async function signGmailOAuthState(payload: GmailOAuthState, secret: string): Promise<string> {
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', await hmac(secret), encoder.encode(encoded)));
  return `${encoded}.${bytesToBase64Url(signature)}`;
}

export async function verifyGmailOAuthState(
  state: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<GmailOAuthState | null> {
  const [encoded, signature, extra] = state.split('.');
  if (!encoded || !signature || extra) return null;
  let supplied: Uint8Array;
  try { supplied = base64UrlToBytes(signature); } catch { return null; }
  if (!(await crypto.subtle.verify('HMAC', await hmac(secret), supplied, encoder.encode(encoded)))) return null;
  try {
    const value = JSON.parse(decoder.decode(base64UrlToBytes(encoded))) as Partial<GmailOAuthState>;
    if (value.v !== 1 || typeof value.workspace_id !== 'string' || typeof value.user_id !== 'string'
      || typeof value.nonce !== 'string' || typeof value.expires_at !== 'number' || typeof value.redirect_uri !== 'string'
      || value.expires_at < nowSeconds || value.expires_at > nowSeconds + 900) return null;
    return value as GmailOAuthState;
  } catch { return null; }
}
