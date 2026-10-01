import { describe, expect, it } from 'vitest';
import { formatTokenAmount, sumUsd, walletBalancesSchema } from '../src/index.js';

describe('wallet balance arithmetic', () => {
  it('adds display USD values in exact cents', () => {
    expect(sumUsd(['0.10', '0.20'])).toBe('0.30');
    expect(sumUsd(['1250.00', '1325.505', '10.5'])).toBe('2586.01');
    expect(sumUsd(['999999999999.99', '0.01'])).toBe('1000000000000.00');
    expect(sumUsd([null, '5'])).toBe('5.00');
    expect(sumUsd([null])).toBeNull();
  });
  it('formats atomic token amounts without floating point', () => {
    expect(formatTokenAmount('1250000000', 6)).toBe('1,250');
    expect(formatTokenAmount('10500000', 6)).toBe('10.5');
    expect(formatTokenAmount('500000000000000000', 18)).toBe('0.5');
    expect(formatTokenAmount('123456789012345678901234567890', 18)).toBe('123,456,789,012.345678');
    expect(formatTokenAmount('1', 18)).toBe('<0.000001');
    expect(formatTokenAmount('0', 6)).toBe('0');
  });
  it('rejects mixed-case addresses and malformed totals', () => {
    const base = { available: true, network: 'Base', usd: '1.00', partial: false, read_at: null, accounts: [] };
    expect(walletBalancesSchema.safeParse(base).success).toBe(true);
    expect(walletBalancesSchema.safeParse({ ...base, usd: '1.5' }).success).toBe(false);
    expect(walletBalancesSchema.safeParse({ ...base, accounts: [{ principal_id: crypto.randomUUID(), kind: 'member', member_id: null, agent_id: null,
      label: 'A', address: '0xABCDEF0000000000000000000000000000000000', status: 'ok', usd: '1.00', assets: [] }] }).success).toBe(false);
  });
});
