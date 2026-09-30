import { describe, expect, it } from 'vitest';
import { formatUsdcBaseUnits, roleSpendingFields, roleSpendingPolicyFromFields, usdcToBaseUnits, type RoleSpendingFields } from './role-spending-form.js';
const fields = (): RoleSpendingFields => ({ perTransfer: '100.000001', recipients: `0x${'12'.repeat(20)}`, approvals: '2', daily: '', monthly: '' });
describe('USDC spending draft input', () => {
  it('round-trips the smallest unit and amounts above floating-point precision', () => {
    for (const value of ['0.000001', '100.000001', '9007199254740993.123456']) {
      expect(formatUsdcBaseUnits(usdcToBaseUnits(value))).toBe(value);
    }
    expect(usdcToBaseUnits('1.234567')).toBe('1234567');
    expect(usdcToBaseUnits(' 1.00 ')).toBe('1000000');
    expect(formatUsdcBaseUnits('1000000')).toBe('1');
  });
  it('rejects precision loss, overflow and numeric shorthand instead of rounding', () => {
    for (const value of ['0', '0.0000001', '-1', '1e3', '1,000', '01', 'NaN', '+1', '1.', '.1', '9'.repeat(80)]) {
      expect(() => usdcToBaseUnits(value), value).toThrow();
    }
    expect(() => formatUsdcBaseUnits('1.5')).toThrow();
    const max = ((1n << 256n) - 1n).toString();
    expect(usdcToBaseUnits(formatUsdcBaseUnits(max))).toBe(max);
    expect(() => formatUsdcBaseUnits((1n << 256n).toString())).toThrow();
  });
  it('creates a strict proposal and preserves explicitly unenforced future limits', () => {
    const parsed = roleSpendingPolicyFromFields({ ...fields(), daily: '1000', monthly: '30000.12' });
    expect(parsed).toMatchObject({ max_transfer_base_units: '100000001', human_approvals: 2, chain_id: 8453,
      future_period_limits: [{ period: 'day', max_base_units: '1000000000', enforcement: 'not_implemented' },
        { period: 'month', max_base_units: '30000120000', enforcement: 'not_implemented' }] });
    expect(roleSpendingFields(parsed)).toEqual({ ...fields(), daily: '1000', monthly: '30000.12' });
  });
  it('validates addresses and human quorum before a save can be sent', () => {
    for (const recipients of ['', `0x${'00'.repeat(20)}`, `0x${'AB'.repeat(20)}`, `${fields().recipients}\n${fields().recipients}`]) {
      expect(() => roleSpendingPolicyFromFields({ ...fields(), recipients })).toThrow();
    }
    for (const approvals of ['0', '11', '1.5', '2e0']) {
      expect(() => roleSpendingPolicyFromFields({ ...fields(), approvals })).toThrow();
    }
  });
});
