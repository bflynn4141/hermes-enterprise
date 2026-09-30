// Financial profiles are saved proposals, never an authorization to sign or pay.
import { z } from 'zod';

export const ROLE_SPENDING_USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
const uint256Max = (1n << 256n) - 1n;
const amount = z.string().max(78).regex(/^[1-9][0-9]*$/).refine((value) => {
  try { return BigInt(value) <= uint256Max; } catch { return false; }
}, 'Amount exceeds uint256');
const recipient = z.string().regex(/^0x[0-9a-f]{40}$/).refine((value) =>
  value !== `0x${'0'.repeat(40)}` && value !== ROLE_SPENDING_USDC_ADDRESS, 'Unsupported recipient');

export const roleSpendingPolicySchema = z.strictObject({
  version: z.literal(1),
  chain_id: z.literal(8453),
  asset: z.literal('USDC'),
  token_address: z.literal(ROLE_SPENDING_USDC_ADDRESS),
  decimals: z.literal(6),
  max_transfer_base_units: amount,
  allowed_recipients: z.array(recipient).min(1).max(100).refine((items) => new Set(items).size === items.length, 'Duplicate recipient'),
  human_approvals: z.number().int().min(1).max(10),
  // These fields preserve future intent, not a rolling/calendar budget promise.
  future_period_limits: z.array(z.strictObject({
    period: z.enum(['day', 'month']),
    max_base_units: amount,
    enforcement: z.literal('not_implemented'),
  })).max(2).refine((items) => new Set(items.map((item) => item.period)).size === items.length, 'Duplicate period'),
});
export const roleSpendingDraftInputSchema = z.strictObject({
  expected_revision: z.number().int().min(0).max(2_147_483_646),
  policy: roleSpendingPolicySchema,
});
export const roleSpendingActivationBlockerSchema = z.enum([
  'activation_not_implemented', 'provider_state_unverified', 'policy_count_unverified',
  'free_policy_limit_exceeded', 'signature_usage_unverified', 'abi_unverified',
  'role_binding_unverified', 'period_limits_not_implemented', 'owner_authorization_required',
  'fee_limits_not_configured',
]);

export const roleSpendingFreeTierSchema = z.strictObject({
  checked_on: z.literal('2026-09-29'),
  max_policies_per_organization: z.literal(5),
  free_signatures_per_month: z.literal(25),
  max_users_per_suborganization: z.literal(100),
  max_wallets_per_suborganization: z.literal(100),
  max_tags_per_suborganization: z.literal(10),
  signature_usage: z.literal('unverified'),
  free_execution_guaranteed: z.literal(false),
  sources: z.tuple([z.literal('https://www.turnkey.com/pricing'), z.literal('https://docs.turnkey.com/reference/resource-limits')]),
});
export const ROLE_SPENDING_FREE_TIER = roleSpendingFreeTierSchema.parse({
  checked_on: '2026-09-29', max_policies_per_organization: 5, free_signatures_per_month: 25,
  max_users_per_suborganization: 100, max_wallets_per_suborganization: 100, max_tags_per_suborganization: 10,
  signature_usage: 'unverified', free_execution_guaranteed: false,
  sources: ['https://www.turnkey.com/pricing', 'https://docs.turnkey.com/reference/resource-limits'],
});

export const roleSpendingDraftSchema = z.strictObject({
  role_id: z.uuid(),
  revision: z.number().int().min(0).max(2_147_483_647),
  state: z.literal('draft_only'),
  enforcement: z.literal('none'),
  policy: roleSpendingPolicySchema.nullable(),
  updated_at: z.iso.datetime().nullable(),
  updated_by: z.uuid().nullable(),
  provider_activation_available: z.literal(false),
  free_tier: roleSpendingFreeTierSchema,
  activation_blockers: z.array(roleSpendingActivationBlockerSchema).min(1),
}).superRefine((record, ctx) => {
  const empty = record.revision === 0;
  if (empty !== (record.policy === null) || empty !== (record.updated_at === null) || empty !== (record.updated_by === null)) {
    ctx.addIssue({ code: 'custom', message: 'Draft revision and saved policy do not agree' });
  }
});

export type RoleSpendingPolicy = z.infer<typeof roleSpendingPolicySchema>;
export type RoleSpendingDraftInput = z.infer<typeof roleSpendingDraftInputSchema>;
export type RoleSpendingDraft = z.infer<typeof roleSpendingDraftSchema>;
export type RoleSpendingActivationBlocker = z.infer<typeof roleSpendingActivationBlockerSchema>;
