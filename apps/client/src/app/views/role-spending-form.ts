// Exact USDC conversion: a displayed decimal never passes through Number.
import { ROLE_SPENDING_USDC_ADDRESS, roleSpendingPolicySchema, type RoleSpendingPolicy } from '@hermes/shared';
const maximum = (1n << 256n) - 1n;

export function usdcToBaseUnits(input: string): string {
  const value = input.trim();
  const parts = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(value);
  if (!parts || value.length > 80) throw new Error('Enter a positive USDC amount with up to 6 decimal places.');
  const units = BigInt(parts[1]!) * 1_000_000n + BigInt((parts[2] ?? '').padEnd(6, '0'));
  if (units <= 0n || units > maximum) throw new Error('Enter a positive USDC amount within the supported range.');
  return units.toString();
}
export function formatUsdcBaseUnits(units: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(units) || units.length > 78 || BigInt(units) > maximum) throw new Error('Invalid USDC base units');
  const whole = BigInt(units) / 1_000_000n;
  const fraction = (BigInt(units) % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''}`;
}
export interface RoleSpendingFields {
  perTransfer: string;
  recipients: string;
  approvals: string;
  daily: string;
  monthly: string;
}
export function roleSpendingFields(policy: RoleSpendingPolicy | null): RoleSpendingFields {
  const limit = (period: 'day' | 'month') => {
    const found = policy?.future_period_limits.find((item) => item.period === period);
    return found ? formatUsdcBaseUnits(found.max_base_units) : '';
  };
  return { perTransfer: policy ? formatUsdcBaseUnits(policy.max_transfer_base_units) : '',
    recipients: policy?.allowed_recipients.join('\n') ?? '', approvals: String(policy?.human_approvals ?? 1),
    daily: limit('day'), monthly: limit('month') };
}
export function roleSpendingPolicyFromFields(fields: RoleSpendingFields): RoleSpendingPolicy {
  if (!/^(?:[1-9]|10)$/.test(fields.approvals)) throw new Error('Choose between 1 and 10 human approvals.');
  const amount = (value: string, name: string) => {
    try { return usdcToBaseUnits(value); } catch (error) { throw new Error(`${name}: ${(error as Error).message}`); }
  };
  const allowed = fields.recipients.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
  const parsed = roleSpendingPolicySchema.safeParse({
    version: 1, chain_id: 8453, asset: 'USDC', token_address: ROLE_SPENDING_USDC_ADDRESS, decimals: 6,
    max_transfer_base_units: amount(fields.perTransfer, 'Per transfer'),
    allowed_recipients: allowed, human_approvals: Number(fields.approvals),
    future_period_limits: [
      ...(fields.daily.trim() ? [{ period: 'day', max_base_units: amount(fields.daily, 'Daily limit'), enforcement: 'not_implemented' }] : []),
      ...(fields.monthly.trim() ? [{ period: 'month', max_base_units: amount(fields.monthly, 'Monthly limit'), enforcement: 'not_implemented' }] : []),
    ],
  });
  if (!parsed.success) throw new Error('Enter 1–100 distinct lowercase wallet addresses; omit the zero address and USDC contract.');
  return parsed.data;
}
