// Child mutations use only the exact owner's WebAuthn stamp. The parent key is
// deliberately not accepted by submitMemberWallet; it is used only by queries.
import type { MemberWalletStamp } from '@hermes/shared';
import { classifyActivity, query, sameCredentialId, type SubmitOutcome, type TurnkeyConfig } from './turnkey-client.js';

export const MEMBER_ACCOUNT = { curve: 'CURVE_SECP256K1', pathFormat: 'PATH_FORMAT_BIP32', path: "m/44'/60'/0'/0/0", addressFormat: 'ADDRESS_FORMAT_ETHEREUM' } as const;
export const encode64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const decode64 = (value: string): Uint8Array => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0));
export async function sha256(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function memberChallenge(body: string): Promise<string> {
  // Turnkey signs UTF8 hex, not raw SHA256 bytes (official WebauthnStamper).
  return encode64(new TextEncoder().encode(await sha256(body)));
}
export function memberWalletBody(orgId: string, walletName: string, timestamp: number): string {
  return JSON.stringify({ type: 'ACTIVITY_TYPE_CREATE_WALLET', timestampMs: String(timestamp), organizationId: orgId,
    parameters: { walletName, accounts: [MEMBER_ACCOUNT], mnemonicLength: 24 } });
}
export async function memberStampMatches(stamp: MemberWalletStamp, body: string, expected: { credentialId: string; rpId: string; origins: readonly string[] }): Promise<boolean> {
  try {
    if (!sameCredentialId(stamp.credentialId, expected.credentialId)) return false;
    const data = JSON.parse(new TextDecoder().decode(decode64(stamp.clientDataJson))) as Record<string, unknown>;
    if (data.type !== 'webauthn.get' || data.challenge !== await memberChallenge(body)
      || typeof data.origin !== 'string' || !expected.origins.includes(data.origin) || data.crossOrigin === true) return false;
    const auth = decode64(stamp.authenticatorData);
    if (auth.length < 37 || (auth[32]! & 5) !== 5) return false; // user presence AND verification
    const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(expected.rpId)));
    return rpHash.every((byte, i) => auth[i] === byte);
    // Turnkey verifies the cryptographic signature against its enrolled public key.
  } catch { return false; }
}
export async function submitMemberWallet(config: Pick<TurnkeyConfig, 'baseUrl' | 'fetch' | 'timeoutMs'>, body: string, stamp: MemberWalletStamp): Promise<SubmitOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);
  try {
    const response = await (config.fetch ?? fetch)(`${config.baseUrl}/public/v1/submit/create_wallet`, {
      method: 'POST', body, headers: { 'content-type': 'application/json', 'X-Stamp-Webauthn': JSON.stringify(stamp) },
      redirect: 'manual', signal: controller.signal,
    });
    if (response.status >= 500 || response.status >= 300 && response.status < 400) return { kind: 'ambiguous', reason: 'provider_unavailable' };
    if (!response.ok) return { kind: 'rejected', code: `http_${response.status}` };
    const result = await response.json() as { activity?: Parameters<typeof classifyActivity>[0] };
    return classifyActivity(result.activity);
  } catch { return { kind: 'ambiguous', reason: 'transport' }; }
  finally { clearTimeout(timer); }
}
export type VerifiedMemberWallet = { walletId: string; address: string };
/** A unique server-generated name binds this wallet to exactly one immutable proposal. */
export async function readMemberWallet(config: TurnkeyConfig, orgId: string, name: string): Promise<VerifiedMemberWallet | null> {
  const { wallets } = await query<{ wallets?: { walletId: string; walletName: string }[] }>(config,
    '/public/v1/query/list_wallets', { organizationId: orgId });
  if (!Array.isArray(wallets)) throw new Error('malformed_wallets');
  const matching = wallets.filter(w => w.walletName === name);
  if (!matching.length) return null;
  if (matching.length !== 1 || !matching[0]?.walletId) throw new Error('ambiguous_wallet');
  const walletId = matching[0].walletId;
  const { accounts } = await query<{ accounts?: Record<string, unknown>[] }>(config,
    '/public/v1/query/list_wallet_accounts', { organizationId: orgId, walletId, paginationOptions: { limit: '100' } });
  if (!Array.isArray(accounts) || accounts.length !== 1) throw new Error('unexpected_accounts');
  const a = accounts[0]!;
  if (a.organizationId !== orgId || a.walletId !== walletId || Object.entries(MEMBER_ACCOUNT).some(([k,v]) => a[k] !== v)
    || typeof a.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a.address) || /^0x0{40}$/.test(a.address)) throw new Error('unexpected_account');
  return { walletId, address: a.address.toLowerCase() };
}
