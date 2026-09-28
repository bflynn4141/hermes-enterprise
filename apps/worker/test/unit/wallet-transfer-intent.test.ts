import { describe, expect, it } from 'vitest';
import { BASE_USDC_ADDRESS, prepareTransferIntent, verifyTransferIntent } from '../../src/wallets/transfer-intent.js';
const now = new Date('2026-09-28T12:00:00.000Z');
const options = { now };
function input() {
  return {
    workspaceId: '11111111-1111-4111-8111-111111111111',
    principalId: '22222222-2222-4222-8222-222222222222',
    accountId: '33333333-3333-4333-8333-333333333333',
    sourceAddress: `0x${'11'.repeat(20)}`, recipientAddress: `0x${'22'.repeat(20)}`,
    chainId: 8453, tokenAddress: BASE_USDC_ADDRESS, decimals: 6,
    amountBaseUnits: '9007199254740993', nonce: '0', gasLimit: '100000',
    maxFeePerGasWei: '1000000000', maxPriorityFeePerGasWei: '1000000', maxTotalFeeWei: '200000000000000',
    expiresAt: '2026-09-28T12:10:00.000Z', policyVersion: 'policy-1', policyDigest: 'a'.repeat(64),
    approvalRevision: 1, purpose: 'Approved partner invoice',
    simulation: { status: 'succeeded', blockNumber: '12345', blockHash: `0x${'ab'.repeat(32)}`, simulatedAt: now.toISOString() },
  };
}
describe('immutable Base USDC transfer intent', () => {
  it('encodes exact integer ERC20 transfer and native value zero without precision loss', async () => {
    const result = await prepareTransferIntent(input(), options);
    expect(result.intent.calldata).toBe(`0xa9059cbb${'22'.repeat(20).padStart(64, '0')}${'20000000000001'.padStart(64, '0')}`);
    expect(result.intent.nativeValueWei).toBe('0');
    expect(result.intentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.intent)).toBe(true);
    expect(Object.isFrozen(result.intent.simulation)).toBe(true);
    expect(await verifyTransferIntent(result.intent, result.intentHash, options)).toEqual(result);
  });
  it('hash is independent of property insertion order', async () => {
    const original = input();
    const reversed = Object.fromEntries(Object.entries(original).reverse());
    expect((await prepareTransferIntent(reversed, options)).intentHash).toBe((await prepareTransferIntent(original, options)).intentHash);
  });
  it.each(['1.1', '1e6', '-1', '01', ' 1', '0', (1n << 256n).toString(), 1000000])('rejects invalid amount %s', async (amountBaseUnits) => {
    await expect(prepareTransferIntent({ ...input(), amountBaseUnits }, options)).rejects.toThrow();
  });
  it.each([
    { chainId: 84532 }, { tokenAddress: `0x${'33'.repeat(20)}` }, { decimals: 18 },
    { recipientAddress: `0x${'00'.repeat(20)}` }, { sourceAddress: `0x${'00'.repeat(20)}` },
    { recipientAddress: `0x${'aB'.repeat(20)}` }, { recipientAddress: BASE_USDC_ADDRESS },
    { recipientAddress: `0x${'11'.repeat(20)}` }, { calldata: '0x095ea7b3' }, { nativeValueWei: '1' },
    { expiresAt: now.toISOString() }, { expiresAt: '2026-10-01T00:00:00.000Z' },
    { nonce: '18446744073709551615' }, { maxPriorityFeePerGasWei: '1000000001' },
    { maxTotalFeeWei: '999' }, { gasLimit: '1000001' },
  ])('rejects unsupported or unsafe input %j', async (patch) => {
    await expect(prepareTransferIntent({ ...input(), ...patch }, options)).rejects.toThrow();
  });
  it('rejects failed, stale and future simulation evidence', async () => {
    for (const patch of [{ status: 'failed' }, { simulatedAt: '2026-09-28T11:54:59.999Z' }, { simulatedAt: '2026-09-28T12:00:00.001Z' }]) {
      const candidate = input();
      await expect(prepareTransferIntent({ ...candidate, simulation: { ...candidate.simulation, ...patch } }, options)).rejects.toThrow();
    }
  });
  it('invalidates approval when any bound identity, policy, revision, or transaction changes', async () => {
    const original = await prepareTransferIntent(input(), options);
    for (const patch of [
      { workspaceId: input().principalId }, { principalId: input().accountId }, { accountId: input().workspaceId },
      { sourceAddress: `0x${'44'.repeat(20)}` }, { recipientAddress: `0x${'55'.repeat(20)}` },
      { amountBaseUnits: '2' }, { nonce: '1' }, { gasLimit: '100001' }, { maxFeePerGasWei: '1000000001' },
      { maxPriorityFeePerGasWei: '2' }, { maxTotalFeeWei: '200000000000001' },
      { policyVersion: 'policy-2' }, { policyDigest: 'b'.repeat(64) }, { approvalRevision: 2 },
      { expiresAt: '2026-09-28T12:11:00.000Z' }, { purpose: 'Different purpose' },
    ]) {
      const changed = await prepareTransferIntent({ ...input(), ...patch }, options);
      await expect(verifyTransferIntent(changed.intent, original.intentHash, options)).rejects.toThrow('hash mismatch');
    }
  });
  it('rejects calldata mutations, extra fields, expiration and invalid clock on verification', async () => {
    const original = await prepareTransferIntent(input(), options);
    for (const patch of [{ calldata: `0xa9059cbb${'0'.repeat(128)}` }, { calldata: `0x095ea7b3${'0'.repeat(128)}` }, { nativeValueWei: '1' }, { arbitrary: true }]) {
      await expect(verifyTransferIntent({ ...original.intent, ...patch }, original.intentHash, options)).rejects.toThrow();
    }
    await expect(verifyTransferIntent(original.intent, original.intentHash, { now: new Date(original.intent.expiresAt) })).rejects.toThrow('expired');
    await expect(verifyTransferIntent(original.intent, original.intentHash, { now: new Date('invalid') })).rejects.toThrow('clock');
  });
});
