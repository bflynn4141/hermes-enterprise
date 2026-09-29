import type { Env } from '../env.js';
import type { TurnkeyConfig } from './turnkey-client.js';

export interface TurnkeySetupConfig {
  readonly turnkey: TurnkeyConfig;
  /** WebAuthn relying party. The admin's passkey is bound to it for life. */
  readonly rpId: string;
  /** Origins a passkey ceremony may come from: allowed app origins on the RP ID. */
  readonly passkeyOrigins: readonly string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Provider access for creating workspace sub-organizations. Null unless both
 * wallet flags are on and every value is present and well formed, so a
 * half-configured deployment can record enrollment requests but never calls
 * Turnkey.
 */
export function turnkeySetupConfig(env: Env): TurnkeySetupConfig | null {
  if (env.TURNKEY_WALLETS_ENABLED !== '1' || env.TURNKEY_PROVISIONING_ENABLED !== '1') return null;
  const parentOrgId = env.TURNKEY_PARENT_ORG_ID?.trim() ?? '';
  const publicKey = env.TURNKEY_API_PUBLIC_KEY?.trim().toLowerCase() ?? '';
  const privateKey = env.TURNKEY_API_PRIVATE_KEY?.trim().toLowerCase() ?? '';
  const rpId = env.TURNKEY_PASSKEY_RP_ID?.trim().toLowerCase() ?? '';
  if (!UUID.test(parentOrgId) || !/^0[23][0-9a-f]{64}$/.test(publicKey) || !/^[0-9a-f]{64}$/.test(privateKey)) return null;
  if (!/^[a-z0-9.-]{1,253}$/.test(rpId)) return null;
  let baseUrl: URL;
  try { baseUrl = new URL(env.TURNKEY_API_BASE_URL?.trim() || 'https://api.turnkey.com'); } catch { return null; }
  const localBase = ['localhost', '127.0.0.1'].includes(baseUrl.hostname);
  if ((baseUrl.protocol !== 'https:' && !(localBase && baseUrl.protocol === 'http:')) || baseUrl.pathname !== '/' || baseUrl.search || baseUrl.username) return null;
  const passkeyOrigins = (env.ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter((item) => {
    try {
      const url = new URL(item);
      const secure = url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost');
      return secure && (url.hostname === rpId || url.hostname.endsWith(`.${rpId}`)) && url.origin === item;
    } catch { return false; }
  });
  if (!passkeyOrigins.length) return null;
  return {
    turnkey: {
      baseUrl: baseUrl.origin,
      parentOrgId,
      apiKey: { publicKey, privateKey },
      fetch: turnkeyFetcher(env),
    },
    rpId,
    passkeyOrigins,
  };
}

export function turnkeyFetcher(env: Env): typeof fetch {
  if (!env.TURNKEY_FETCHER) return (input, init) => globalThis.fetch(input, { ...init, redirect: 'manual' });
  return (input, init) => env.TURNKEY_FETCHER!.fetch(new Request(input, init));
}
