// App approval routing does not itself grant Turnkey authority. Once custody is
// configured, ordinary role/settings routes may not change payment review
// eligibility while the corresponding owner-backed policy path is unavailable.
import { groupsOf, inGroup, mayApprove, type ApprovalRouteRule, type ApprovalThreshold } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { loadApprovalRoutes, thresholdOf } from '../domain/approval-routing.js';
import { RouteError } from '../routes/errors.js';

type Person = { role: string; reviewer_roles: readonly string[] };
export const walletPaymentPermissionRequired = () => new RouteError(
  'this change affects payment review and needs a verified owner-approved payment policy', 'wallet_payment_permission_required', 409);

/** Serializes every protected role/rule edit with custody setup and one another. */
export async function custodyConfigured(tx: Tx, workspaceId: string): Promise<boolean> {
  await tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [workspaceId]);
  const { rows } = await tx.query(`SELECT 1 FROM workspace_wallet_config c WHERE c.workspace_id=$1
    AND (c.provider_org_id IS NOT NULL OR c.status <> 'awaiting_owner_enrollment')`, [workspaceId]);
  return rows.length > 0;
}
export function paymentBandAuthority(rule: ApprovalRouteRule, person: Person): string {
  const eligible = mayApprove(rule, person);
  // Switching between named groups can change which quorum this person may
  // satisfy even when a plain boolean "can approve" remains true.
  return JSON.stringify({ eligible, groups: rule.one_from_each ? groupsOf(rule).filter(g => inGroup(g, person)).sort() : [] });
}
export async function guardPaymentMemberChanges(tx: Tx, workspaceId: string, changes: readonly { before: Person; after: Person }[]): Promise<void> {
  if (!await custodyConfigured(tx,workspaceId)) return;
  const route = (await loadApprovalRoutes(tx,workspaceId)).payment;
  const bands = [route.rule, ...(route.threshold ? [route.threshold.rule] : [])];
  if (changes.some(({before,after}) => bands.some(rule => paymentBandAuthority(rule,before) !== paymentBandAuthority(rule,after)))) throw walletPaymentPermissionRequired();
}
const normalizedRule = (rule: ApprovalRouteRule) => ({ ...rule, roles: [...new Set(rule.roles)].sort() });
const normalizedRoute = (rule: ApprovalRouteRule, threshold: ApprovalThreshold|null) => JSON.stringify({
  rule: normalizedRule(rule), threshold: threshold ? { ...threshold, rule: normalizedRule(threshold.rule) } : null,
});
export async function guardPaymentRuleChange(tx: Tx, workspaceId: string, rule: ApprovalRouteRule, threshold: ApprovalThreshold|null): Promise<void> {
  if (!await custodyConfigured(tx,workspaceId)) return;
  const current = (await loadApprovalRoutes(tx,workspaceId)).payment;
  if (normalizedRoute(current.rule,thresholdOf(current)) !== normalizedRoute(rule,threshold)) throw walletPaymentPermissionRequired();
}
