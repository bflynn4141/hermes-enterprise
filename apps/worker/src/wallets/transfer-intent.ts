import { z } from 'zod';

// Circle's native USDC deployment, not bridged USDbC. Verified 2026-09-28:
// https://developers.circle.com/stablecoins/usdc-contract-addresses
// https://docs-w3s-node-sdk.circle.com/variables/chains.BASE.html
export const BASE_USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
export const BASE_CHAIN_ID = 8453 as const;
export const USDC_DECIMALS = 6 as const;
const UINT256_MAX = (1n << 256n) - 1n;
const uint = z.string().max(78).regex(/^(0|[1-9][0-9]*)$/).refine((value) => {
  try { return BigInt(value) <= UINT256_MAX; } catch { return false; }
}, 'Integer exceeds uint256');
function integerCheck(value: string, check: (value: bigint) => boolean): boolean {
  try { return check(BigInt(value)); } catch { return false; }
}
const positive = uint.refine((value) => integerCheck(value, (number) => number > 0n), 'Must be positive');
// Canonical lower-case only: do not silently accept a mistyped mixed-case checksum.
const address = z.string().regex(/^0x[0-9a-f]{40}$/).refine((value) => !/^0x0{40}$/.test(value), 'Zero address');
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.iso.datetime({ precision: 3 });
const fields = {
  workspaceId: z.uuid(), principalId: z.uuid(), accountId: z.uuid(),
  sourceAddress: address, recipientAddress: address,
  chainId: z.literal(BASE_CHAIN_ID), tokenAddress: z.literal(BASE_USDC_ADDRESS), decimals: z.literal(USDC_DECIMALS),
  amountBaseUnits: positive, nonce: uint.refine((value) => integerCheck(value, (number) => number < (1n << 64n) - 1n), 'Nonce exceeds EIP-2681 limit'),
  gasLimit: positive.refine((value) => integerCheck(value, (number) => number >= 21_000n && number <= 1_000_000n), 'Unsupported gas limit'),
  maxFeePerGasWei: positive, maxPriorityFeePerGasWei: uint,
  // Includes a separately estimated Base L1 data/operator fee allowance. This is
  // an application ceiling, not an on-chain guarantee; execution must recheck it.
  maxTotalFeeWei: positive,
  expiresAt: timestamp, policyVersion: z.string().min(1).max(128), policyDigest: digest,
  approvalRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  purpose: z.string().trim().min(1).max(2000),
  simulation: z.strictObject({ status: z.literal('succeeded'), blockNumber: uint,
    blockHash: z.string().regex(/^0x[0-9a-f]{64}$/), simulatedAt: timestamp }),
};
export const TransferIntentInputSchema = z.strictObject(fields);
export const TransferIntentSchema = z.strictObject({ ...fields,
  version: z.literal(1), transactionType: z.literal(2), nativeValueWei: z.literal('0'),
  calldata: z.string().regex(/^0xa9059cbb[0-9a-f]{128}$/),
});
export type TransferIntentInput = z.infer<typeof TransferIntentInputSchema>;
export type TransferIntent = z.infer<typeof TransferIntentSchema>;
export type PreparedTransferIntent = Readonly<{ intent: Readonly<TransferIntent>; canonicalJson: string; intentHash: string }>;

function calldata(recipient: string, amount: string): string {
  return `0xa9059cbb${recipient.slice(2).padStart(64, '0')}${BigInt(amount).toString(16).padStart(64, '0')}`;
}
function assertValid(intent: TransferIntentInput, now: Date): void {
  const time = now.getTime();
  const expires = Date.parse(intent.expiresAt);
  const simulated = Date.parse(intent.simulation.simulatedAt);
  if (!Number.isFinite(time) || expires <= time) throw new Error('Transfer intent expired or invalid clock');
  if (expires > time + 24 * 60 * 60 * 1000) throw new Error('Transfer expiry exceeds 24 hours');
  if (simulated > time || simulated < time - 5 * 60 * 1000) throw new Error('Fresh successful simulation required');
  if (intent.sourceAddress === intent.recipientAddress || intent.recipientAddress === BASE_USDC_ADDRESS) throw new Error('Unsupported recipient');
  if (BigInt(intent.maxPriorityFeePerGasWei) > BigInt(intent.maxFeePerGasWei)) throw new Error('Priority fee exceeds fee ceiling');
  const executionFee = BigInt(intent.gasLimit) * BigInt(intent.maxFeePerGasWei);
  if (executionFee > BigInt(intent.maxTotalFeeWei)) throw new Error('Gas envelope exceeds total fee ceiling');
}
function canonicalize(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
async function prepared(intent: TransferIntent): Promise<PreparedTransferIntent> {
  const canonicalJson = canonicalize(intent);
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`hermes:base-usdc-transfer:v1\n${canonicalJson}`));
  const intentHash = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
  Object.freeze(intent.simulation);
  return Object.freeze({ intent: Object.freeze(intent), canonicalJson, intentHash });
}
/** Pure preparation only. Caller must load identities, permissions, nonce and
 * simulation from trusted server/provider state; accepting JSON is not verification
 * of ownership, funds, simulation provenance or Turnkey policy enforcement. */
export async function prepareTransferIntent(input: unknown, options: { now?: Date } = {}): Promise<PreparedTransferIntent> {
  const parsed = TransferIntentInputSchema.parse(input);
  assertValid(parsed, options.now ?? new Date());
  return prepared({ ...parsed, version: 1, transactionType: 2, nativeValueWei: '0', calldata: calldata(parsed.recipientAddress, parsed.amountBaseUnits) });
}
/** Recheck freshness and all committed fields immediately before approval/use.
 * A mismatch requires a new approval; this function never refreshes approved bytes. */
export async function verifyTransferIntent(input: unknown, expectedHash: string, options: { now?: Date } = {}): Promise<PreparedTransferIntent> {
  digest.parse(expectedHash);
  const parsed = TransferIntentSchema.parse(input);
  assertValid(parsed, options.now ?? new Date());
  if (parsed.calldata !== calldata(parsed.recipientAddress, parsed.amountBaseUnits)) throw new Error('Calldata does not match transfer');
  const result = await prepared(parsed);
  if (result.intentHash !== expectedHash) throw new Error('Approved transfer intent hash mismatch');
  return result;
}
