// The band an approval falls in (decision C94) and the short labels both the
// server and the Admin screen show (C95). A decision route or an effect never
// compares amounts itself; this is the function they all call.
import { describe, expect, it } from 'vitest';
import {
  approvalRouteUpdateSchema,
  approverLabel,
  approverParts,
  bandSuffix,
  effectiveRule,
  formatThresholdAmount,
  groupsOf,
  ruleProblem,
  type ApprovalRouteRule,
} from '../src/index.js';

const base: ApprovalRouteRule = { admins: true, roles: [], approvals_required: 1, allow_requester: true, one_from_each: false };
const over: ApprovalRouteRule = { admins: true, roles: ['finance'], approvals_required: 2, allow_requester: false, one_from_each: true };
const route = { rule: base, threshold: { over_minor: 500_000, currency: 'USD', rule: over } };
const names = new Map([['finance', 'Finance'], ['legal', 'Legal']]);

describe('effectiveRule', () => {
  it('uses the base rule when there is no threshold or no amount', () => {
    expect(effectiveRule({ rule: base, threshold: null }, { minor: 9_000_000, currency: 'USD' })).toEqual({ rule: base, band: 'base', reason: null });
    expect(effectiveRule(route, null)).toEqual({ rule: base, band: 'base', reason: null });
  });

  it('treats "over" as strictly greater than the threshold', () => {
    expect(effectiveRule(route, { minor: 500_000, currency: 'USD' }).band).toBe('base');
    expect(effectiveRule(route, { minor: 500_001, currency: 'USD' })).toEqual({ rule: over, band: 'over', reason: 'over_threshold' });
    expect(effectiveRule(route, { minor: 12_000_000, currency: 'USD' }).rule).toBe(over);
  });

  it('fails closed on another currency, whatever the amount', () => {
    expect(effectiveRule(route, { minor: 1, currency: 'EUR' })).toEqual({ rule: over, band: 'over', reason: 'other_currency' });
  });
});

describe('rule checks and labels', () => {
  it('refuses a rule nobody can meet, and one from each without two groups and two people', () => {
    expect(ruleProblem({ ...base, admins: false })).toBe('no_approver');
    expect(ruleProblem({ ...base, one_from_each: true, approvals_required: 2 })).toBe('one_from_each_needs_groups');
    expect(ruleProblem({ ...over, approvals_required: 1 })).toBe('one_from_each_needs_groups');
    expect(ruleProblem(over)).toBeNull();
    expect(groupsOf({ admins: true, roles: ['finance', 'finance'] })).toEqual(['admins', 'role:finance']);
  });

  it('reads as short, sentence-case labels', () => {
    expect(approverLabel(base, names)).toBe('Workspace Admin');
    expect(approverLabel({ ...base, admins: false, roles: ['finance'] }, names)).toBe('Finance');
    expect(approverLabel({ ...base, admins: false, roles: ['finance'], approvals_required: 2 }, names)).toBe('Finance, 2 different people');
    expect(approverLabel({ ...base, roles: ['legal'] }, names)).toBe('Admins or Legal');
    expect(approverLabel(over, names)).toBe('Admins and Finance, one of each');
    expect(approverParts({ ...over, approvals_required: 3 }, names)).toEqual(['Admins and Finance', '3 different people with one of each']);
    expect(formatThresholdAmount(500_000, 'USD')).toBe('5,000.00 USD');
    expect(bandSuffix(route.threshold, 'over_threshold')).toBe(' (over 5,000.00 USD)');
    expect(bandSuffix(route.threshold, 'other_currency')).toBe(' (amounts not in USD)');
    expect(bandSuffix(route.threshold, null)).toBe('');
  });

  it('accepts a PUT body written before one_from_each existed', () => {
    const parsed = approvalRouteUpdateSchema.parse({ admins: true, roles: [], approvals_required: 1, allow_requester: true });
    expect(parsed.one_from_each).toBe(false);
    expect(parsed.threshold).toBeUndefined();
    expect(approvalRouteUpdateSchema.safeParse({ ...parsed, threshold: { over_minor: 0, currency: 'USD', rule: base } }).success).toBe(false);
    expect(approvalRouteUpdateSchema.safeParse({ ...parsed, threshold: { over_minor: 100, currency: 'usd', rule: base } }).success).toBe(false);
  });
});
