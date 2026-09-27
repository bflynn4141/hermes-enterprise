// Approval routing (migrations 0073 and 0074, decisions C93–C95): who may
// approve each kind of work. The rules are data an Admin edits; this module is
// the one place that reads them and answers "may this person approve this",
// "which band does this amount fall in" and "how many eligible people have
// approved so far", so the decision route, the Inbox counts and effect
// execution cannot disagree.
import {
  APPROVAL_ROUTES,
  approverLabel,
  bandSuffix,
  effectiveRule,
  groupsOf,
  inGroup,
  mayApprove,
  type ApprovalRoute,
  type ApprovalRouteKey,
  type ApprovalRouteRule,
  type ApprovalThreshold,
  type RuleBand,
} from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { financeWorkflowRequest } from './finance-decidable.js';
import { requestAudiencePredicate } from './audience.js';

export { approverLabel };

export interface LoadedThreshold {
  readonly overMinor: number;
  readonly currency: string;
  readonly rule: ApprovalRouteRule;
}

export interface LoadedRoute {
  readonly rule: ApprovalRouteRule;
  /** The band above an amount (C94); only invoices and payments have one. */
  readonly threshold: LoadedThreshold | null;
  readonly isDefault: boolean;
  readonly updatedAt: Date | null;
}

export type RouteRules = Readonly<Record<ApprovalRouteKey, LoadedRoute>>;

interface RouteRow {
  route_key: ApprovalRouteKey;
  band: RuleBand;
  admins: boolean;
  roles: string[];
  approvals_required: number;
  allow_requester: boolean;
  one_from_each: boolean;
  over_minor: string | number | null;
  over_currency: string | null;
  updated_at: Date;
}

const ruleOf = (row: RouteRow): ApprovalRouteRule => ({
  admins: row.admins,
  roles: row.roles,
  approvals_required: row.approvals_required,
  allow_requester: row.allow_requester,
  one_from_each: row.one_from_each,
});

/** Every rule, saved or default, with its band above an amount when there is one. */
export async function loadApprovalRoutes(tx: Tx, workspaceId: string): Promise<RouteRules> {
  const { rows } = await tx.query<RouteRow>(
    `SELECT route_key, band, admins, roles, approvals_required, allow_requester, one_from_each,
            over_minor, over_currency, updated_at
       FROM approval_route_rules WHERE workspace_id = $1`,
    [workspaceId],
  );
  return Object.fromEntries(APPROVAL_ROUTES.map((definition) => {
    const base = rows.find((row) => row.route_key === definition.key && row.band === 'base');
    const over = rows.find((row) => row.route_key === definition.key && row.band === 'over');
    const updated = [base?.updated_at, over?.updated_at].filter((value): value is Date => value instanceof Date);
    const loaded: LoadedRoute = {
      rule: base ? ruleOf(base) : definition.default,
      threshold: over && definition.amount
        ? { overMinor: Number(over.over_minor), currency: over.over_currency ?? '', rule: ruleOf(over) }
        : null,
      isDefault: !base && !over,
      updatedAt: updated.length ? new Date(Math.max(...updated.map((value) => value.valueOf()))) : null,
    };
    return [definition.key, loaded];
  })) as unknown as RouteRules;
}

const copyRule = (rule: ApprovalRouteRule) => ({ ...rule, roles: [...rule.roles] });

/** The shared shape of a band, for `effectiveRule` and the wire. */
export const thresholdOf = (loaded: Pick<LoadedRoute, 'threshold'>) =>
  loaded.threshold
    ? { over_minor: loaded.threshold.overMinor, currency: loaded.threshold.currency, rule: copyRule(loaded.threshold.rule) }
    : null;

export function approvalRouteViews(routes: RouteRules): ApprovalRoute[] {
  return APPROVAL_ROUTES.map((definition) => {
    const loaded = routes[definition.key];
    return {
      key: definition.key,
      kind: definition.kind,
      label: definition.label,
      description: definition.description,
      workflow_note: definition.workflow_note,
      amount: definition.amount,
      rule: copyRule(loaded.rule),
      threshold: thresholdOf(loaded),
      is_default: loaded.isDefault,
      updated_at: loaded.updatedAt ? loaded.updatedAt.toISOString() : null,
    };
  });
}

/**
 * The amount a threshold compares: an invoice's `total_minor` and `currency`.
 * A payment effect reads its invoice request's payload, so both share this.
 * Nothing else has an amount this round. A total with no readable currency
 * still counts as an amount, in no currency, so it takes the stricter band.
 */
export function requestAmount(row: { kind: string; payload: unknown }): { minor: number; currency: string } | null {
  if (row.kind !== 'invoice') return null;
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : {};
  const minor = payload.total_minor;
  if (typeof minor !== 'number' || !Number.isSafeInteger(minor) || minor < 0) return null;
  const currency = typeof payload.currency === 'string' && /^[A-Z]{3}$/.test(payload.currency) ? payload.currency : '';
  return { minor, currency };
}

export interface RoutedRule {
  readonly rule: ApprovalRouteRule;
  readonly band: RuleBand;
  readonly reason: 'over_threshold' | 'other_currency' | null;
  readonly threshold: ApprovalThreshold | null;
}

/** The rule that applies to one piece of work of this kind, at this amount. */
export function routedRule(loaded: LoadedRoute, amount: { minor: number; currency: string } | null): RoutedRule {
  const threshold = thresholdOf(loaded);
  return { ...effectiveRule({ rule: loaded.rule, threshold }, amount), threshold };
}

/** "Finance, 2 different people (over 5,000.00 USD)": the label with its band. */
export function routedLabel(routed: RoutedRule, roleNames: ReadonlyMap<string, string>): string {
  return `${approverLabel(routed.rule, roleNames)}${bandSuffix(routed.threshold, routed.reason)}`;
}

/**
 * The role an effect is stamped with and assigned by: the first role the rule
 * names, or `admin` for an Admins-only rule. Who may actually carry it out is
 * always `mayApprove` against the whole rule; this is only a default assignee
 * and the short slug the effects schema carries.
 */
export const primaryRole = (rule: Pick<ApprovalRouteRule, 'roles'>): string => rule.roles[0] ?? 'admin';

/** What a person may approve is their workspace role, the roles they hold, and the rules. */
export interface ApprovalViewer {
  readonly userId: string;
  readonly role: string;
  readonly reviewerRoles: readonly string[];
  readonly routes: RouteRules;
  readonly roleNames: ReadonlyMap<string, string>;
}

export async function loadApprovalViewer(tx: Tx, workspaceId: string, userId: string, role: string): Promise<ApprovalViewer> {
  const member = await tx.query<{ reviewer_roles: string[] }>(
    `SELECT reviewer_roles FROM members WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
    [workspaceId, userId],
  );
  return {
    userId,
    role,
    reviewerRoles: member.rows[0]?.reviewer_roles ?? [],
    routes: await loadApprovalRoutes(tx, workspaceId),
    roleNames: await loadRoleNames(tx, workspaceId),
  };
}

export async function loadRoleNames(tx: Tx, workspaceId: string): Promise<Map<string, string>> {
  const names = await tx.query<{ slug: string; name: string }>(
    `SELECT slug, name FROM workspace_roles WHERE workspace_id = $1`,
    [workspaceId],
  );
  return new Map(names.rows.map((row) => [row.slug, row.name]));
}

const DECISION_KEYS: readonly string[] = ['application', 'invoice', 'agreement'];
export const isDecisionKind = (kind: string): kind is 'application' | 'invoice' | 'agreement' => DECISION_KEYS.includes(kind);

/** The request kinds this viewer could decide by rule at some amount, before the requester check. */
export function decidableKinds(viewer: ApprovalViewer): string[] {
  const person = { role: viewer.role, reviewer_roles: viewer.reviewerRoles };
  return DECISION_KEYS.filter((key) => {
    const loaded = viewer.routes[key as ApprovalRouteKey];
    return mayApprove(loaded.rule, person) || (loaded.threshold ? mayApprove(loaded.threshold.rule, person) : false);
  });
}

/** A legacy request, as much of it as routing needs. */
export interface RoutableRequest {
  readonly kind: string;
  readonly payload?: unknown;
  readonly subject_key?: string | null;
  readonly requester_id?: string | null;
  /**
   * For a handoff request, whether this person is on its audience. The
   * decision route knows; list reads only see requests the viewer may read,
   * so they leave it out.
   */
  readonly handed_to_viewer?: boolean;
}

/** The rule for a legacy request's kind, at its amount. */
export function decisionRule(routes: RouteRules, row: RoutableRequest): RoutedRule {
  return routedRule(routes[row.kind as ApprovalRouteKey], requestAmount({ kind: row.kind, payload: row.payload }));
}

/** Someone whose approval might count: the viewer, or a person who approved earlier. */
export interface ApproverPerson {
  readonly userId: string;
  readonly role: string;
  readonly reviewerRoles: readonly string[];
}

/**
 * The rule decides, and a handoff request also goes to Finance, because the
 * workflow routes it there (the partner invoice check then also requires the
 * handoff's own person). When the rule says the requester may not approve, the
 * person whose agent prepared it may not, whatever else they hold.
 */
function eligibleForDecision(rule: ApprovalRouteRule, row: RoutableRequest, person: ApproverPerson): boolean {
  if (!rule.allow_requester && row.requester_id && row.requester_id === person.userId) return false;
  const byRule = mayApprove(rule, { role: person.role, reviewer_roles: person.reviewerRoles });
  const byHandoff = financeWorkflowRequest(row) && person.reviewerRoles.includes('finance') && (row.handed_to_viewer ?? true);
  return byRule || byHandoff;
}

/** May this viewer decide this request? */
export function mayDecideRequest(viewer: ApprovalViewer, row: RoutableRequest): boolean {
  if (!isDecisionKind(row.kind)) return false;
  return eligibleForDecision(decisionRule(viewer.routes, row).rule, row, viewer);
}

/** The label a legacy request shows for whose decision it is. */
export function requestApproverLabel(viewer: ApprovalViewer, row: RoutableRequest): string {
  if (financeWorkflowRequest(row)) return 'Finance reviewer';
  if (!isDecisionKind(row.kind)) return 'Workspace Admin';
  const routed = decisionRule(viewer.routes, row);
  const label = routedLabel(routed, viewer.roleNames);
  // Otherwise an Admin looking at their own agent's request would read
  // "Workspace Admin" and not see why they cannot decide it.
  if (!routed.rule.allow_requester && row.requester_id && row.requester_id === viewer.userId) {
    return `${label}, not you: your agent prepared this`;
  }
  return label;
}

/** A person who pressed approve, with who they are now (C95 re-checks at count time). */
export interface Confirmer {
  readonly user_id: string;
  readonly role: string | null;
  readonly reviewer_roles: readonly string[] | null;
  /** An active member of this workspace right now. */
  readonly active: boolean;
  /** Still able to read the request: on its audience, or it has none. */
  readonly in_audience?: boolean;
}

export interface ApprovalProgress {
  readonly required: number;
  /** Distinct confirmers who are still eligible under the rule. */
  readonly recorded: number;
  readonly by_viewer: boolean;
  /** One from each named group, when the rule asks for it; otherwise true. */
  readonly covered: boolean;
  /** The user ids that count, oldest first. */
  readonly counted: readonly string[];
}

/**
 * Count the approvals that still stand. A confirmer counts only while they are
 * an active member who passes `eligible` under the rule as it is now, so a
 * person who lost the role, or left, no longer counts toward the number.
 */
export function countConfirmations(
  rule: ApprovalRouteRule,
  confirmers: readonly Confirmer[],
  eligible: (person: ApproverPerson) => boolean,
  viewerId?: string,
): ApprovalProgress {
  const people = confirmers
    .filter((confirmer) => confirmer.active && confirmer.role !== null && confirmer.in_audience !== false)
    .map((confirmer) => ({ userId: confirmer.user_id, role: confirmer.role ?? '', reviewerRoles: confirmer.reviewer_roles ?? [] }))
    .filter((person, index, all) => all.findIndex((other) => other.userId === person.userId) === index)
    .filter(eligible);
  const covered = !rule.one_from_each || groupsOf(rule).every((group) =>
    people.some((person) => inGroup(group, { role: person.role, reviewer_roles: person.reviewerRoles })));
  return {
    required: rule.approvals_required,
    recorded: people.length,
    by_viewer: viewerId !== undefined && people.some((person) => person.userId === viewerId),
    covered,
    counted: people.map((person) => person.userId),
  };
}

/** Whether the approvals so far are enough to record the decision or run the action. */
export const progressComplete = (progress: ApprovalProgress): boolean =>
  progress.recorded >= progress.required && progress.covered;

/** The approvals on a legacy request that still count, from confirmers already loaded. */
export function decisionProgressOf(viewer: ApprovalViewer, row: RoutableRequest, confirmers: readonly Confirmer[]): ApprovalProgress {
  const { rule } = decisionRule(viewer.routes, row);
  // Handoff audience membership is re-checked through `in_audience`.
  const { handed_to_viewer: _handedToViewer, ...counted } = row;
  return countConfirmations(rule, confirmers, (person) => eligibleForDecision(rule, counted, person), viewer.userId);
}

/**
 * The confirmers of one request as a JSON array column, for REQUEST_SELECT and
 * the Inbox counts, so a list reads them in the same query instead of one
 * query per row. `requestIdSql` names the request id column in the outer query.
 */
export const decisionConfirmersSql = (requestIdSql: string): string => `(
  SELECT COALESCE(json_agg(json_build_object(
           'user_id', dc.user_id,
           'role', dm.role,
           'reviewer_roles', COALESCE(dm.reviewer_roles, '{}'::text[]),
           'active', COALESCE(dm.status = 'active', false),
           'in_audience', ${requestAudiencePredicate('dc.request_id', 'dc.user_id')}
         ) ORDER BY dc.created_at, dc.user_id), '[]'::json)
    FROM decision_confirmations dc
    LEFT JOIN members dm ON dm.workspace_id = dc.workspace_id AND dm.user_id = dc.user_id
   WHERE dc.request_id = ${requestIdSql})`;

/** Progress on one request, read inside the decision transaction (C95). */
export async function decisionProgress(tx: Tx, request: RoutableRequest & { id: string }, viewer: ApprovalViewer): Promise<ApprovalProgress> {
  const { rows } = await tx.query<{ confirmers: Confirmer[] }>(
    `SELECT ${decisionConfirmersSql('$1::uuid')} AS confirmers`,
    [request.id],
  );
  return decisionProgressOf(viewer, request, rows[0]?.confirmers ?? []);
}

/**
 * Everything the Inbox shows about a legacy request's decision for one
 * viewer: whether they may decide it, whether it still needs them (not when
 * they already approved it), the label, and the approvals so far.
 */
export function legacyDecisionState(
  viewer: ApprovalViewer,
  row: RoutableRequest & { decision_confirmers?: readonly Confirmer[] | null },
): { canDecide: boolean; actionable: boolean; label: string; progress: ApprovalProgress | null } {
  const canDecide = mayDecideRequest(viewer, row);
  const progress = isDecisionKind(row.kind) ? decisionProgressOf(viewer, row, row.decision_confirmers ?? []) : null;
  return { canDecide, actionable: canDecide && !progress?.by_viewer, label: requestApproverLabel(viewer, row), progress };
}
