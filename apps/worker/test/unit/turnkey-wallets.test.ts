import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { decompressP256, p1363ToDer, stampRequest } from '../../src/wallets/turnkey-stamp.js';
import {
  classifyActivity, createRootedSubOrganization, rootIsCustomerOwned, sameCredentialId, submitActivity, type TurnkeyConfig,
} from '../../src/wallets/turnkey-client.js';
import { turnkeySetupConfig } from '../../src/wallets/turnkey-config.js';
import { clientDataMatches } from '../../src/routes/wallet-root.js';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromB64url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const b64url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A real P-256 key in Turnkey's format: compressed public hex, private scalar hex. */
async function turnkeyKey() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  const x = fromB64url(jwk.x!), y = fromB64url(jwk.y!);
  const prefix = (y[31]! & 1) ? '03' : '02';
  return { publicKey: prefix + hex(x), privateKey: hex(fromB64url(jwk.d!)), jwk, verifyKey: pair.publicKey };
}

function derToP1363(der: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  let offset = 2;
  for (const half of [0, 32]) {
    const length = der[offset + 1]!;
    const int = der.subarray(offset + 2, offset + 2 + length);
    const trimmed = int[0] === 0 ? int.subarray(1) : int;
    out.set(trimmed, half + 32 - trimmed.length);
    offset += 2 + length;
  }
  return out;
}

describe('Turnkey request stamping', () => {
  it('decompresses public keys to the same point WebCrypto generated', async () => {
    for (let i = 0; i < 8; i++) {
      const key = await turnkeyKey();
      expect(decompressP256(key.publicKey)).toEqual({ x: key.jwk.x, y: key.jwk.y });
    }
    expect(() => decompressP256('04' + '00'.repeat(32))).toThrow();
    expect(() => decompressP256('02' + 'ff'.repeat(32))).toThrow();
  });

  it('produces a stamp whose DER signature verifies over the exact body', async () => {
    const key = await turnkeyKey();
    const body = JSON.stringify({ type: 'ACTIVITY_TYPE_X', organizationId: 'org', parameters: { a: 1 } });
    const stamp = await stampRequest(body, key);
    expect(stamp.name).toBe('X-Stamp');
    const decoded = JSON.parse(new TextDecoder().decode(fromB64url(stamp.value))) as { publicKey: string; scheme: string; signature: string };
    expect(decoded.publicKey).toBe(key.publicKey);
    expect(decoded.scheme).toBe('SIGNATURE_SCHEME_TK_API_P256');
    const der = Uint8Array.from(decoded.signature.match(/../g)!, (b) => parseInt(b, 16));
    expect(der[0]).toBe(0x30);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.verifyKey, derToP1363(der), new TextEncoder().encode(body));
    expect(ok).toBe(true);
    const tampered = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key.verifyKey, derToP1363(der), new TextEncoder().encode(body + ' '));
    expect(tampered).toBe(false);
  });

  it('encodes DER integers minimally and keeps them positive', () => {
    const sig = new Uint8Array(64);
    sig[0] = 0x80; sig[63] = 0x01; // r has its high bit set, s is tiny
    const der = p1363ToDer(sig);
    expect(hex(der)).toBe('3026' + '0221' + '0080' + '00'.repeat(31) + '020101');
  });
});

function fakeTurnkey(respond: (path: string, body: Record<string, unknown>) => Response | Promise<Response>) {
  const seen: { path: string; body: Record<string, unknown>; stamp: string | null }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ path: url.pathname, body, stamp: new Headers(init?.headers).get('X-Stamp') });
    return respond(url.pathname, body);
  }) as typeof fetch;
  return { fetcher, seen };
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

describe('Turnkey activity outcomes', () => {
  it('classifies statuses so only COMPLETED counts as done and unknowns are ambiguous', () => {
    expect(classifyActivity({ id: 'a', status: 'ACTIVITY_STATUS_COMPLETED' }).kind).toBe('completed');
    expect(classifyActivity({ id: 'a', status: 'ACTIVITY_STATUS_REJECTED' }).kind).toBe('rejected');
    expect(classifyActivity({ id: 'a', status: 'ACTIVITY_STATUS_FAILED' }).kind).toBe('rejected');
    expect(classifyActivity({ id: 'a', status: 'ACTIVITY_STATUS_CONSENSUS_NEEDED' }).kind).toBe('pending');
    expect(classifyActivity({ id: 'a', status: 'ACTIVITY_STATUS_PENDING' }).kind).toBe('ambiguous');
    expect(classifyActivity(undefined).kind).toBe('ambiguous');
  });

  it('treats transport errors and 5xx as ambiguous, 4xx as rejected, and never keeps provider text', async () => {
    const key = await turnkeyKey();
    const config = (fetcher: typeof fetch): TurnkeyConfig => ({ baseUrl: 'https://api.turnkey.test', parentOrgId: 'p', apiKey: key, fetch: fetcher });
    const call = (fetcher: typeof fetch) => submitActivity(config(fetcher), '/x', 'T', 'org', {});
    expect(await call((async () => { throw new TypeError('network down'); }) as typeof fetch)).toEqual({ kind: 'ambiguous', reason: 'transport' });
    expect(await call((async () => json({}, 503)) as typeof fetch)).toEqual({ kind: 'ambiguous', reason: 'http_503' });
    expect(await call((async () => json({ code: 7, message: 'secret detail' }, 400)) as typeof fetch)).toEqual({ kind: 'rejected', code: 'http_400_7' });
    expect(await call((async () => new Response('not json', { status: 200 })) as typeof fetch)).toEqual({ kind: 'ambiguous', reason: 'unparseable_response' });
  });

  it('creates a sub-organization with one passkey root and no Hermes key or email recovery', async () => {
    const key = await turnkeyKey();
    const { fetcher, seen } = fakeTurnkey(() => json({ activity: { id: 'act', status: 'ACTIVITY_STATUS_COMPLETED', result: {} } }));
    await createRootedSubOrganization({ baseUrl: 'https://api.turnkey.test', parentOrgId: 'parent', apiKey: key, fetch: fetcher }, {
      name: 'hermes-ws-x', rootUserName: 'Workspace admin', challenge: 'c'.repeat(43),
      attestation: { credentialId: 'cred', clientDataJson: 'cd', attestationObject: 'ao', transports: ['AUTHENTICATOR_TRANSPORT_INTERNAL'] },
    });
    const sent = seen[0]!;
    expect(sent.path).toBe('/public/v1/submit/create_sub_organization');
    expect(sent.stamp).toBeTruthy();
    expect(sent.body).toMatchObject({ type: 'ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8', organizationId: 'parent' });
    const parameters = sent.body.parameters as { rootQuorumThreshold: number; rootUsers: { apiKeys: unknown[]; authenticators: unknown[] }[]; disableEmailRecovery: boolean };
    expect(parameters.rootQuorumThreshold).toBe(1);
    expect(parameters.rootUsers).toHaveLength(1);
    expect(parameters.rootUsers[0]!.apiKeys).toEqual([]);
    expect(parameters.rootUsers[0]!.authenticators).toHaveLength(1);
    expect(parameters.disableEmailRecovery).toBe(true);
  });
});

describe('customer custody check', () => {
  const owned = { threshold: 1, rootUserIds: ['u1'], users: [{ userId: 'u1', apiKeyCount: 0, credentialIds: ['YWJjZGVmZ2hpamtsbW5vcA'] }] };
  it('accepts exactly one passkey-only root that matches the enrolled credential', () => {
    expect(rootIsCustomerOwned(owned, { rootUserId: 'u1', credentialId: 'YWJjZGVmZ2hpamtsbW5vcA' })).toBe(true);
    // Turnkey may report standard base64 with padding for the same bytes.
    expect(sameCredentialId('YWJjZGVmZ2hpamtsbW5vcA==', 'YWJjZGVmZ2hpamtsbW5vcA')).toBe(true);
  });
  it('rejects any extra root, API key, user, credential, or threshold change', () => {
    const expected = { rootUserId: 'u1', credentialId: 'YWJjZGVmZ2hpamtsbW5vcA' };
    expect(rootIsCustomerOwned({ ...owned, threshold: 2 }, expected)).toBe(false);
    expect(rootIsCustomerOwned({ ...owned, rootUserIds: ['u1', 'hermes'] }, expected)).toBe(false);
    expect(rootIsCustomerOwned({ ...owned, users: [{ ...owned.users[0]!, apiKeyCount: 1 }] }, expected)).toBe(false);
    expect(rootIsCustomerOwned({ ...owned, users: [...owned.users, { userId: 'u2', apiKeyCount: 0, credentialIds: [] }] }, expected)).toBe(false);
    expect(rootIsCustomerOwned({ ...owned, users: [{ ...owned.users[0]!, credentialIds: ['b3RoZXJjcmVkZW50aWFs'] }] }, expected)).toBe(false);
    expect(rootIsCustomerOwned(owned, { ...expected, rootUserId: 'u9' })).toBe(false);
    expect(sameCredentialId('', '')).toBe(false);
  });
});

describe('passkey ceremony data', () => {
  const origins = ['https://staging.hermes.example'];
  const data = (over: Record<string, unknown> = {}) => b64url(JSON.stringify({ type: 'webauthn.create', challenge: 'c'.repeat(43), origin: origins[0], ...over }));
  it('accepts only a registration for this challenge from this deployment', () => {
    expect(clientDataMatches(data(), 'c'.repeat(43), origins)).toBe(true);
    expect(clientDataMatches(data({ type: 'webauthn.get' }), 'c'.repeat(43), origins)).toBe(false);
    expect(clientDataMatches(data({ challenge: 'd'.repeat(43) }), 'c'.repeat(43), origins)).toBe(false);
    expect(clientDataMatches(data({ origin: 'https://evil.example' }), 'c'.repeat(43), origins)).toBe(false);
    expect(clientDataMatches(data({ crossOrigin: true }), 'c'.repeat(43), origins)).toBe(false);
    expect(clientDataMatches('not-json', 'c'.repeat(43), origins)).toBe(false);
  });
});

describe('Turnkey setup configuration', () => {
  const valid = {
    TURNKEY_WALLETS_ENABLED: '1', TURNKEY_PROVISIONING_ENABLED: '1',
    TURNKEY_PARENT_ORG_ID: '11111111-2222-4333-8444-555555555555',
    TURNKEY_API_PUBLIC_KEY: '02' + 'ab'.repeat(32), TURNKEY_API_PRIVATE_KEY: 'cd'.repeat(32),
    TURNKEY_PASSKEY_RP_ID: 'hermes.example', ALLOWED_ORIGINS: 'https://staging.hermes.example,https://other.example',
  };
  const config = (over: Record<string, string | undefined> = {}) => turnkeySetupConfig({ ...valid, ...over } as unknown as Env);
  it('is on only when every value is present and well formed', () => {
    expect(config()).toMatchObject({ rpId: 'hermes.example', passkeyOrigins: ['https://staging.hermes.example'], turnkey: { baseUrl: 'https://api.turnkey.com' } });
    expect(config({ TURNKEY_PROVISIONING_ENABLED: undefined })).toBeNull();
    expect(config({ TURNKEY_WALLETS_ENABLED: '0' })).toBeNull();
    expect(config({ TURNKEY_API_PRIVATE_KEY: undefined })).toBeNull();
    expect(config({ TURNKEY_API_PUBLIC_KEY: '04' + 'ab'.repeat(32) })).toBeNull();
    expect(config({ TURNKEY_PARENT_ORG_ID: 'not-a-uuid' })).toBeNull();
    expect(config({ TURNKEY_PASSKEY_RP_ID: 'elsewhere.example' })).toBeNull();
    expect(config({ TURNKEY_API_BASE_URL: 'http://api.turnkey.com' })).toBeNull();
    expect(config({ TURNKEY_API_BASE_URL: 'http://127.0.0.1:9911' })?.turnkey.baseUrl).toBe('http://127.0.0.1:9911');
  });
});
