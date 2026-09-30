import { describe, expect, it } from 'vitest';
import { ROLE_SPENDING_USDC_ADDRESS, type RoleSpendingPolicy } from '@hermes/shared';
import { planRoleSpendingPolicies, type RoleSpendingPlanInput } from '../../src/wallets/role-spending.js';

const firstRole = '11111111-1111-4111-8111-111111111111';
const secondRole = '22222222-2222-4222-8222-222222222222';
const firstTag = '33333333-3333-4333-8333-333333333333';
const secondTag = '44444444-4444-4444-8444-444444444444';
const wallet = '55555555-5555-4555-8555-555555555555';
function policy(amount = '1000000', destination = `0x${'12'.repeat(20)}`): RoleSpendingPolicy {
  return { version: 1, chain_id: 8453, asset: 'USDC', token_address: ROLE_SPENDING_USDC_ADDRESS, decimals: 6,
    max_transfer_base_units: amount, allowed_recipients: [destination], human_approvals: 2, future_period_limits: [] };
}
function input(): RoleSpendingPlanInput {
  return { drafts: [{ role_id: firstRole, policy: policy() }], existing_policy_count: 4,
    provider_state_verified: true, abi_verified: true, signature_usage_verified: true,
    bindings: [{ role_id: firstRole, provider_tag_id: firstTag, source_wallet_ids: [wallet], verified: true }] };
}
describe('inert role spending plan', () => {
  it('counts unrelated existing policies and never activates even within the free cap', () => {
    const plan = planRoleSpendingPolicies(input());
    expect(plan).toMatchObject({ can_activate: false, state: 'draft_only', required_policy_count: 1, total_policy_count: 5 });
    expect(plan.activation_blockers).toContain('activation_not_implemented');
    expect(plan.activation_blockers).not.toContain('free_policy_limit_exceeded');
    expect(planRoleSpendingPolicies({ ...input(), existing_policy_count: 5 }).activation_blockers).toContain('free_policy_limit_exceeded');
  });
  it('does not union one role’s high ceiling or destinations into another role', () => {
    const original = input();
    const plan = planRoleSpendingPolicies({ ...original, existing_policy_count: 0,
      drafts: [...original.drafts, { role_id: secondRole, policy: policy('100000000', `0x${'ab'.repeat(20)}`) }],
      bindings: [...original.bindings, { role_id: secondRole, provider_tag_id: secondTag, source_wallet_ids: [wallet], verified: true }],
    });
    expect(plan.rules).toHaveLength(2);
    expect(plan.rules[0]).toMatchObject({ role_id: firstRole, consensus: { provider_tag_id: firstTag },
      condition: { max_transfer_base_units: '1000000', allowed_recipients: [`0x${'12'.repeat(20)}`] } });
    expect(plan.rules[1]).toMatchObject({ role_id: secondRole, consensus: { provider_tag_id: secondTag },
      condition: { max_transfer_base_units: '100000000', allowed_recipients: [`0x${'ab'.repeat(20)}`] } });
  });
  it('fails closed on unknown quota, ABI, provider identity or signature usage', () => {
    const plan = planRoleSpendingPolicies({ ...input(), existing_policy_count: null,
      abi_verified: false, provider_state_verified: false, signature_usage_verified: false, bindings: [] });
    expect(plan.total_policy_count).toBeNull();
    expect(plan.activation_blockers).toEqual(expect.arrayContaining([
      'policy_count_unverified', 'abi_unverified', 'provider_state_unverified', 'signature_usage_unverified', 'role_binding_unverified',
    ]));
    expect(plan.rules[0]?.consensus.provider_tag_id).toBeNull();
    expect(plan.rules[0]?.condition.source_wallet_ids).toEqual([]);
  });
  it('never treats a period budget as an enforceable per-transaction condition', () => {
    const value = input();
    value.drafts[0]!.policy.future_period_limits = [{ period: 'month', max_base_units: '100000000', enforcement: 'not_implemented' }];
    const plan = planRoleSpendingPolicies(value);
    expect(plan.activation_blockers).toContain('period_limits_not_implemented');
    expect(plan.rules[0]?.condition).not.toHaveProperty('future_period_limits');
  });
  it('refuses invalid counts or duplicate roles instead of undercounting required policies', () => {
    expect(() => planRoleSpendingPolicies({ ...input(), existing_policy_count: -1 })).toThrow();
    expect(() => planRoleSpendingPolicies({ ...input(), drafts: [...input().drafts, ...input().drafts] })).toThrow();
    expect(() => planRoleSpendingPolicies({ ...input(), bindings: [...input().bindings, ...input().bindings] })).toThrow();
  });
});
