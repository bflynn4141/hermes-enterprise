import { describe, expect, it } from 'vitest';
import {
  ROLE_SPENDING_FREE_TIER, ROLE_SPENDING_USDC_ADDRESS,
  roleSpendingDraftInputSchema, roleSpendingDraftSchema, roleSpendingPolicySchema,
} from '../src/role-spending.js';

const policy = () => ({
  version: 1, chain_id: 8453, asset: 'USDC', token_address: ROLE_SPENDING_USDC_ADDRESS, decimals: 6,
  max_transfer_base_units: '9007199254740993', allowed_recipients: [`0x${'12'.repeat(20)}`],
  human_approvals: 2, future_period_limits: [],
});
describe('role spending draft contract', () => {
  it('preserves amounts beyond JavaScript precision as exact integer strings', () => {
    expect(roleSpendingPolicySchema.parse(policy()).max_transfer_base_units).toBe('9007199254740993');
    expect(roleSpendingPolicySchema.parse({ ...policy(), max_transfer_base_units: ((1n << 256n) - 1n).toString() })).toBeTruthy();
  });
  it('refuses fractional, signed, noncanonical, zero, numeric and overflowing amounts', () => {
    for (const value of ['1.5', '-1', '+1', '01', '0', '1e6', 100, (1n << 256n).toString()]) {
      expect(roleSpendingPolicySchema.safeParse({ ...policy(), max_transfer_base_units: value }).success).toBe(false);
    }
  });
  it('pins native Base USDC and refuses hidden activation flags', () => {
    for (const patch of [{ chain_id: 1 }, { decimals: 18 }, { asset: 'ETH' },
      { token_address: `0x${'11'.repeat(20)}` }, { active: true }, { provider_policy_id: 'pretend' }, { version: 2 }]) {
      expect(roleSpendingPolicySchema.safeParse({ ...policy(), ...patch }).success).toBe(false);
    }
    expect(roleSpendingDraftInputSchema.safeParse({ expected_revision: 0, policy: policy(), workspace_id: crypto.randomUUID() }).success).toBe(false);
  });
  it('requires a bounded recipient allowlist and at least one human approver', () => {
    for (const allowed_recipients of [[], [`0x${'0'.repeat(40)}`], [ROLE_SPENDING_USDC_ADDRESS],
      ['0xABCDEF1234567890ABCDEF1234567890ABCDEF12'], [policy().allowed_recipients[0], policy().allowed_recipients[0]]]) {
      expect(roleSpendingPolicySchema.safeParse({ ...policy(), allowed_recipients }).success).toBe(false);
    }
    for (const human_approvals of [0, -1, 1.5, 11]) {
      expect(roleSpendingPolicySchema.safeParse({ ...policy(), human_approvals }).success).toBe(false);
    }
  });
  it('only accepts future period budgets when explicitly marked unenforced', () => {
    const period = { period: 'day', max_base_units: '100000000', enforcement: 'not_implemented' };
    expect(roleSpendingPolicySchema.safeParse({ ...policy(), future_period_limits: [period] }).success).toBe(true);
    expect(roleSpendingPolicySchema.safeParse({ ...policy(), future_period_limits: [{ ...period, enforcement: 'turnkey' }] }).success).toBe(false);
    expect(roleSpendingPolicySchema.safeParse({ ...policy(), future_period_limits: [period, period] }).success).toBe(false);
  });
  it('cannot represent a saved or enforced policy with revision zero', () => {
    const empty = {
      role_id: crypto.randomUUID(), revision: 0, state: 'draft_only', enforcement: 'none', policy: null,
      updated_at: null, updated_by: null, provider_activation_available: false,
      free_tier: ROLE_SPENDING_FREE_TIER, activation_blockers: ['activation_not_implemented'],
    };
    expect(roleSpendingDraftSchema.safeParse(empty).success).toBe(true);
    for (const patch of [{ policy: policy() }, { revision: 1 }, { state: 'active' }, { enforcement: 'turnkey' },
      { provider_activation_available: true }, { free_tier: { ...ROLE_SPENDING_FREE_TIER, free_execution_guaranteed: true } }]) {
      expect(roleSpendingDraftSchema.safeParse({ ...empty, ...patch }).success).toBe(false);
    }
  });
});
