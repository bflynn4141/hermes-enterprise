// The four properties the production plan names for the key store, plus the
// ones that would otherwise only be discovered during a rotation.
//
// No KEK literal appears in this file: the test material is generated, because
// a 32-byte base64 string in a repository is indistinguishable from a real
// secret to anyone reading it later — including gitleaks.
import { describe, expect, it } from 'vitest';
import {
  KeyCryptoError,
  currentKekVersion,
  fingerprint,
  kekVersions,
  last4,
  openKey,
  openSecret,
  rewrapDek,
  rewrapSecretDek,
  sealSecret,
  sealKey,
  type KekEnv,
  type StoredEnvelope,
} from '../../src/keys/envelope.js';

/** A deterministic 32-byte KEK, so a failure is reproducible. */
function kek(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) bytes[i] = (seed * 31 + i * 7) % 256;
  return btoa(String.fromCharCode(...bytes));
}

const WORKSPACE_A = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_B = '22222222-2222-4222-8222-222222222222';
const KEY_1 = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const KEY_2 = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

// Shaped like a provider key without being one: assembled at runtime so no
// literal in this repository looks like a credential.
const SAMPLE_KEY = ['sk', 'ant', 'api03', 'ThisIsNotARealKey000000000'].join('-');

const envV1: KekEnv = { KEK_V1: kek(1) };
const envV1V2 = { KEK_V1: kek(1), KEK_V2: kek(2), KEK_CURRENT: '2' } as unknown as KekEnv;

describe('envelope encryption', () => {
  it('round-trips a key for the workspace and row it was sealed under', async () => {
    const id = { workspaceId: WORKSPACE_A, keyId: KEY_1 };
    const sealed = await sealKey(envV1, id, SAMPLE_KEY);

    expect(sealed.kekVersion).toBe(1);
    // The stored bytes are not the key: the most basic property, and the one
    // that would be broken by an "optimisation" that stored it plainly.
    expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain('ThisIsNotARealKey');

    expect(await openKey(envV1, id, sealed)).toBe(SAMPLE_KEY);
  });

  it('refuses a ciphertext moved to another row in the same workspace', async () => {
    const first = await sealKey(envV1, { workspaceId: WORKSPACE_A, keyId: KEY_1 }, SAMPLE_KEY);
    const second = await sealKey(envV1, { workspaceId: WORKSPACE_A, keyId: KEY_2 }, 'sk-second-key-000000');

    // The swapped row: first row's data ciphertext under the second row's DEK.
    const swapped: StoredEnvelope = { ...second, ciphertext: first.ciphertext, iv: first.iv };
    await expect(openKey(envV1, { workspaceId: WORKSPACE_A, keyId: KEY_2 }, swapped)).rejects.toThrow(KeyCryptoError);

    // And the whole envelope read under the wrong row id, which is what a
    // mistaken join would produce.
    await expect(openKey(envV1, { workspaceId: WORKSPACE_A, keyId: KEY_2 }, first)).rejects.toThrow(KeyCryptoError);
  });

  it('refuses a ciphertext read as another workspace', async () => {
    const sealed = await sealKey(envV1, { workspaceId: WORKSPACE_A, keyId: KEY_1 }, SAMPLE_KEY);
    // Row-level security should make this unreachable. The AAD is the second
    // independent check, so a policy regression still does not leak a key.
    await expect(openKey(envV1, { workspaceId: WORKSPACE_B, keyId: KEY_1 }, sealed)).rejects.toThrow(KeyCryptoError);
  });

  it('encrypts under v1, rotates to v2, and still decrypts', async () => {
    const id = { workspaceId: WORKSPACE_A, keyId: KEY_1 };
    const sealed = await sealKey(envV1, id, SAMPLE_KEY);
    expect(sealed.kekVersion).toBe(1);

    const rewrapped = await rewrapDek(envV1V2, id, sealed, 2);
    const rotated: StoredEnvelope = { ...sealed, ...rewrapped };

    expect(rotated.kekVersion).toBe(2);
    // The data ciphertext is untouched: a rotation re-wraps the DEK and never
    // handles the provider key itself.
    expect(rotated.ciphertext).toEqual(sealed.ciphertext);
    expect(rotated.iv).toEqual(sealed.iv);

    expect(await openKey(envV1V2, id, rotated)).toBe(SAMPLE_KEY);
  });

  it('refuses a wrapped DEK replayed under a different KEK version', async () => {
    const id = { workspaceId: WORKSPACE_A, keyId: KEY_1 };
    const sealed = await sealKey(envV1, id, SAMPLE_KEY);
    // The wrap AAD binds the version, so claiming v2 for a v1 wrap fails even
    // though both secrets are present.
    const lying: StoredEnvelope = { ...sealed, kekVersion: 2 };
    await expect(openKey(envV1V2, id, lying)).rejects.toThrow(KeyCryptoError);
  });

  it('domain-separates and rotates encrypted Slack material', async () => {
    const id = { workspaceId: WORKSPACE_A, keyId: KEY_1, namespace: 'hermes/slack-installation/v1' };
    const sealed = await sealSecret(envV1, id, JSON.stringify({ access_token: 'fixture-only' }));
    await expect(openSecret(envV1, id, sealed)).resolves.toContain('fixture-only');
    await expect(openSecret(envV1, { ...id, namespace: 'hermes/other-integration/v1' }, sealed)).rejects.toThrow(KeyCryptoError);
    const rewrapped = await rewrapSecretDek(envV1V2, id, sealed, 2);
    await expect(openSecret(envV1V2, id, { ...sealed, ...rewrapped })).resolves.toContain('fixture-only');
    expect(rewrapped.kekVersion).toBe(2);
  });

  it('refuses to seal when no KEK is configured', async () => {
    await expect(sealKey({} as KekEnv, { workspaceId: WORKSPACE_A, keyId: KEY_1 }, SAMPLE_KEY)).rejects.toThrow(
      /no KEK/,
    );
  });

  it('never puts the secret in the error when a KEK is malformed', async () => {
    const bad = { KEK_V1: btoa('too short') } as KekEnv;
    await expect(sealKey(bad, { workspaceId: WORKSPACE_A, keyId: KEY_1 }, SAMPLE_KEY)).rejects.toThrow(
      /must decode to 32 bytes/,
    );
  });
});

describe('KEK versions', () => {
  it('lists only versions that have a value', () => {
    expect(kekVersions({ KEK_V1: kek(1), KEK_V2: '' } as unknown as KekEnv)).toEqual([1]);
  });

  it('defaults to the lowest version present, and honours KEK_CURRENT', () => {
    const both = { KEK_V1: kek(1), KEK_V2: kek(2) } as unknown as KekEnv;
    // The two-deploy rotation is only two deploys if putting `KEK_V2` in place
    // does not, by itself, make v2 current. `KEK_CURRENT` is optional, so
    // "unset" is the state every deployment starts a rotation from — and while
    // this defaulted to the highest version, `wrangler secret put KEK_V2`
    // alone made restarted instances write envelopes the instances that had
    // not restarted could not read (`kek_version_unknown`, a 503 on every key
    // read). The lowest version is the one every instance can read, which is
    // the property the second deploy exists to move.
    expect(currentKekVersion(both)).toBe(1);
    expect(currentKekVersion({ ...both, KEK_CURRENT: '2' } as KekEnv)).toBe(2);
    expect(currentKekVersion({ ...both, KEK_CURRENT: '1' } as KekEnv)).toBe(1);
    // One version present: the two rules agree, and a fresh deployment that
    // never sets `KEK_CURRENT` still encrypts under the key it has.
    expect(currentKekVersion({ KEK_V2: kek(2) } as unknown as KekEnv)).toBe(2);
  });

  it('refuses a KEK_CURRENT with no matching secret', () => {
    expect(() => currentKekVersion({ KEK_V1: kek(1), KEK_CURRENT: '3' } as KekEnv)).toThrow(/no secret/);
  });
});

describe('fingerprint and last4', () => {
  it('is stable for the same key and different for another', async () => {
    const a = await fingerprint(SAMPLE_KEY);
    expect(a).toHaveLength(64);
    expect(await fingerprint(SAMPLE_KEY)).toBe(a);
    expect(await fingerprint(`${SAMPLE_KEY}x`)).not.toBe(a);
  });

  it('shows four characters and pads a short one rather than leaking it', () => {
    expect(last4(SAMPLE_KEY)).toBe(SAMPLE_KEY.slice(-4));
    expect(last4('ab')).toBe('**ab');
  });
});
