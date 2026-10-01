import { z } from 'zod';
export const walletEnrollmentInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace') }).strict(),
  z.object({ kind: z.literal('member'), member_id: z.uuid() }).strict(),
  z.object({ kind: z.literal('agent'), agent_id: z.uuid() }).strict(),
]);
export const walletRecordSchema = z.object({
  id: z.uuid(), kind: z.enum(['workspace', 'member', 'agent']),
  member_id: z.uuid().nullable(), agent_id: z.uuid().nullable(), label: z.string(),
  status: z.literal('awaiting_owner_enrollment'), address: z.null(), created_at: z.iso.datetime(),
});
/**
 * Custody of the workspace's Turnkey sub-organization. `verified` means Hermes
 * read the provider back and found the Admin's passkey as the only root.
 */
export const walletRootStatusSchema = z.enum(['not_started', 'in_progress', 'needs_reconciliation', 'verified', 'needs_attention']);
export const walletRootSchema = z.object({
  status: walletRootStatusSchema,
  /** Provider setup is configured for this deployment. */
  available: z.boolean(),
  owner_name: z.string().nullable(),
  verified_at: z.iso.datetime().nullable(),
});
export const walletOverviewSchema = z.object({
  enabled: z.boolean(), chain_id: z.literal(8453), asset: z.literal('USDC'),
  setup_status: z.enum(['not_configured', 'awaiting_owner_enrollment']),
  can_manage: z.boolean(), items: z.array(walletRecordSchema),
  root: walletRootSchema,
});
const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
/** What the browser needs to create the Admin's passkey. */
export const walletRootChallengeSchema = z.object({
  setup_id: z.uuid(),
  challenge: base64url.length(43),
  rp_id: z.string().min(1).max(253),
  user_handle: base64url.length(43),
  user_name: z.string().min(1).max(64),
  expires_at: z.iso.datetime(),
});
export const walletRootSubmitSchema = z.object({
  setup_id: z.uuid(),
  attestation: z.object({
    credential_id: base64url.min(16).max(1366),
    client_data_json: base64url.max(4096),
    attestation_object: base64url.max(65536),
    transports: z.array(z.enum(['internal', 'usb', 'nfc', 'ble', 'hybrid'])).max(5),
  }).strict(),
}).strict();
export const walletRootReconcileSchema = z.object({}).strict();
export type WalletRecord = z.infer<typeof walletRecordSchema>;
export type WalletOverview = z.infer<typeof walletOverviewSchema>;
export type WalletRoot = z.infer<typeof walletRootSchema>;
export type WalletRootChallenge = z.infer<typeof walletRootChallengeSchema>;
export type WalletRootSubmit = z.infer<typeof walletRootSubmitSchema>;
export type WalletEnrollmentInput = z.infer<typeof walletEnrollmentInputSchema>;

/** One token held by a wallet on Base. `amount` is atomic units; `usd` is Turnkey's display value. */
export const walletAssetSchema = z.object({
  symbol: z.string().min(1).max(16), name: z.string().max(64),
  decimals: z.number().int().min(0).max(36),
  amount: z.string().regex(/^\d+$/),
  usd: z.string().regex(/^\d+(\.\d+)?$/).nullable(),
});
export const walletBalanceAccountSchema = z.object({
  principal_id: z.uuid(), kind: z.enum(['workspace', 'member', 'agent']),
  member_id: z.uuid().nullable(), agent_id: z.uuid().nullable(), label: z.string(),
  address: z.string().regex(/^0x[0-9a-f]{40}$/),
  /** `unavailable`: Turnkey could not be read just now; never shown as zero. */
  status: z.enum(['ok', 'unavailable']),
  usd: z.string().regex(/^\d+\.\d{2}$/).nullable(),
  assets: z.array(walletAssetSchema),
});
export const walletBalancesSchema = z.object({
  available: z.boolean(), network: z.literal('Base'),
  /** Sum of readable accounts; null when none could be read. */
  usd: z.string().regex(/^\d+\.\d{2}$/).nullable(),
  partial: z.boolean(),
  read_at: z.iso.datetime().nullable(),
  accounts: z.array(walletBalanceAccountSchema),
});
export type WalletAsset = z.infer<typeof walletAssetSchema>;
export type WalletBalanceAccount = z.infer<typeof walletBalanceAccountSchema>;
export type WalletBalances = z.infer<typeof walletBalancesSchema>;

/** Adds decimal USD strings exactly, in cents; display values only. */
export function sumUsd(values: readonly (string | null)[]): string | null {
  const present = values.filter((value): value is string => value !== null);
  if (!present.length) return null;
  const cents = present.reduce((total, value) => {
    const [whole, fraction = ''] = value.split('.');
    return total + BigInt(whole!) * 100n + BigInt((fraction + '00').slice(0, 2)) + (Number(fraction[2] ?? '0') >= 5 ? 1n : 0n);
  }, 0n);
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Formats an atomic amount with its decimals, trimming trailing zeros (no floating point). */
export function formatTokenAmount(amount: string, decimals: number, maxFraction = 6): string {
  const value = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (!fraction && whole === 0n && value > 0n) return `<0.${'0'.repeat(maxFraction - 1)}1`;
  return fraction ? `${grouped}.${fraction}` : grouped;
}
