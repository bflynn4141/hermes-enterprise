// Pure planning only. Each role retains its own consensus/condition pair;
// independent unions would give a low-limit role another role's authority.
import { z } from 'zod';
import {
  ROLE_SPENDING_FREE_TIER, roleSpendingPolicySchema,
  type RoleSpendingActivationBlocker,
} from '@hermes/shared';

const planInputSchema = z.strictObject({
  drafts: z.array(z.strictObject({ role_id: z.uuid(), policy: roleSpendingPolicySchema })).max(100)
    .refine((items) => new Set(items.map((item) => item.role_id)).size === items.length, 'Duplicate role'),
  // The number of all existing provider policies, including unrelated guards.
  existing_policy_count: z.number().int().min(0).max(10_000).nullable(),
  provider_state_verified: z.boolean(),
  abi_verified: z.boolean(),
  signature_usage_verified: z.boolean(),
  bindings: z.array(z.strictObject({
    role_id: z.uuid(), provider_tag_id: z.uuid(),
    source_wallet_ids: z.array(z.uuid()).min(1).max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate wallet'),
    verified: z.boolean(),
  })).max(100).refine((items) => new Set(items.map((item) => item.role_id)).size === items.length, 'Duplicate role binding'),
});
export type RoleSpendingPlanInput = z.infer<typeof planInputSchema>;

export function planRoleSpendingPolicies(input: RoleSpendingPlanInput) {
  const parsed = planInputSchema.parse(input);
  const blockers = new Set<RoleSpendingActivationBlocker>([
    'activation_not_implemented', 'owner_authorization_required', 'fee_limits_not_configured',
  ]);
  if (!parsed.provider_state_verified) blockers.add('provider_state_unverified');
  if (!parsed.abi_verified) blockers.add('abi_unverified');
  if (!parsed.signature_usage_verified) blockers.add('signature_usage_unverified');
  if (parsed.existing_policy_count === null) blockers.add('policy_count_unverified');
  const total = parsed.existing_policy_count === null ? null : parsed.existing_policy_count + parsed.drafts.length;
  if (total !== null && total > ROLE_SPENDING_FREE_TIER.max_policies_per_organization) blockers.add('free_policy_limit_exceeded');
  const rules = parsed.drafts.map(({ role_id, policy }) => {
    const binding = parsed.bindings.find((item) => item.role_id === role_id && item.verified);
    if (!binding) blockers.add('role_binding_unverified');
    if (policy.future_period_limits.length) blockers.add('period_limits_not_implemented');
    return {
      role_id,
      consensus: { provider_tag_id: binding?.provider_tag_id ?? null, human_approvals: policy.human_approvals },
      condition: {
        source_wallet_ids: binding?.source_wallet_ids ?? [],
        chain_id: policy.chain_id, token_address: policy.token_address,
        function_selector: '0xa9059cbb' as const, native_value_wei: '0' as const,
        max_transfer_base_units: policy.max_transfer_base_units,
        allowed_recipients: policy.allowed_recipients,
      },
    };
  });
  // Descriptors are not Turnkey policy expressions and cannot be submitted.
  return {
    state: 'draft_only' as const, can_activate: false as const,
    required_policy_count: rules.length, existing_policy_count: parsed.existing_policy_count,
    total_policy_count: total, max_policy_count: ROLE_SPENDING_FREE_TIER.max_policies_per_organization,
    rules, activation_blockers: [...blockers],
  };
}
