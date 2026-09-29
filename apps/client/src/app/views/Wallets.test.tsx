import { describe, expect, it } from 'vitest';
import { mockUuid } from '@hermes/shared';
import { createAuth } from '../../model/auth.js';
import { createMockBackend } from '../../model/mock.js';
import { createRest } from '../../model/rest.js';
import { ownerError, walletError } from './Wallets.js';
import { PasskeyError } from '../../model/passkey.js';

describe('wallet enrollment client contract', () => {
  it('round-trips a pending enrollment without inventing an address, and reuses a repeated request', async () => {
    const mock = createMockBackend({ wallets: 'enabled' });
    const rest = createRest({ auth: createAuth('fake'), fetchImpl: mock.fetchImpl });
    const ws = mockUuid(1);
    const first = await rest.requestWalletEnrollment(ws, { kind: 'workspace' });
    const replay = await rest.requestWalletEnrollment(ws, { kind: 'workspace' });
    expect(replay.id).toBe(first.id);
    expect(first.address).toBeNull();
    expect(first.status).toBe('awaiting_owner_enrollment');
    expect((await rest.wallets(ws)).items).toHaveLength(1);
  });
  it('leaves the default deployment disabled', async () => {
    const mock = createMockBackend();
    const rest = createRest({ auth: createAuth('fake'), fetchImpl: mock.fetchImpl });
    expect(await rest.wallets(mockUuid(1))).toMatchObject({ enabled: false, items: [] });
  });
  it('does not describe failed requests as successful or safe to blindly retry', () => {
    expect(walletError(new Error('network'))).toContain('Refresh the status');
    expect(walletError({ reason: 'wallets_unavailable' })).toContain('not enabled');
    expect(walletError({ reason: 'admin_required' })).toContain('admin');
  });
  it('sets up the owner only with a passkey made for the issued challenge', async () => {
    const mock = createMockBackend({ wallets: 'enabled' });
    const rest = createRest({ auth: createAuth('fake'), fetchImpl: mock.fetchImpl });
    const ws = mockUuid(1);
    expect((await rest.wallets(ws)).root).toMatchObject({ status: 'not_started', available: true });
    const challenge = await rest.startWalletRoot(ws);
    const clientData = (value: string) => btoa(JSON.stringify({ type: 'webauthn.create', challenge: value, origin: 'http://localhost' })).replace(/=+$/, '');
    const attestation = { credential_id: 'Y3JlZGVudGlhbC0xMjM0NTY3OA', attestation_object: 'o2NmbXRkbm9uZQ', transports: ['internal' as const] };
    await expect(rest.submitWalletRoot(ws, { setup_id: challenge.setup_id, attestation: { ...attestation, client_data_json: clientData('x'.repeat(43)) } }))
      .rejects.toMatchObject({ reason: 'wallet_passkey_invalid' });
    const root = await rest.submitWalletRoot(ws, { setup_id: challenge.setup_id, attestation: { ...attestation, client_data_json: clientData(challenge.challenge) } });
    expect(root).toMatchObject({ status: 'verified' });
    await expect(rest.startWalletRoot(ws)).rejects.toMatchObject({ reason: 'wallet_root_exists' });
  });
  it('explains owner setup failures without claiming anything was set up', () => {
    expect(ownerError(new PasskeyError('cancelled'))).toContain('Nothing was set up');
    expect(ownerError(new PasskeyError('unsupported'))).toContain("can't create passkeys");
    expect(ownerError({ reason: 'wallet_root_exists' })).toContain('already has a wallet owner');
    expect(ownerError(new Error('network'))).toContain('Check setup');
  });
});
