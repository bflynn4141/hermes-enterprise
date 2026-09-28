import { describe, expect, it } from 'vitest';
import { mockUuid } from '@hermes/shared';
import { createAuth } from '../../model/auth.js';
import { createMockBackend } from '../../model/mock.js';
import { createRest } from '../../model/rest.js';
import { walletError } from './Wallets.js';

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
});
