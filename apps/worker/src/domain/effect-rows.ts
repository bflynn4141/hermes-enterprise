// Reading the effects ledger.
//
// One query shape serves the ledger screen, a request's review pane and the
// execute route, because they differ only in their filter. The shaping is here
// rather than in the route for the same reason `requests.ts` shapes there: the
// client parses with a `.strict()` schema, so exactly these fields exist and
// exactly one place decides what goes in them.
//
// `reason` is the honest column. An effect that has never been executed carries
// the sentence explaining what it is waiting for; one somebody pressed Execute
// on carries the sentence explaining that nothing happened. Neither is an error
// string: both are the product telling the truth about a boundary it does not
// cross.
import { effectSimulationSchema, mayApprove, type ApprovalRouteKey, type EffectKind, type EffectSimulation } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import {
  countConfirmations,
  primaryRole,
  requestAmount,
  routedLabel,
  routedRule,
  type Confirmer,
  type RouteRules,
  type RoutedRule,
} from './approval-routing.js';
import { EFFECT_LABELS, EFFECT_SIMULATED_REASON, EFFECT_UNAVAILABLE_REASON } from './effects.js';
import { requestAudiencePredicate } from './audience.js';

export interface EffectRow {
  id: string;
  request_id: string;
  decision_id: string;
  kind: string;
  status: string;
  required_role: string;
  approvals_required: number;
  assignee_id: string | null;
  assignee_name: string | null;
  cancelled_reason: string | null;
  enforcement_result: unknown;
  created_at: Date;
  /**
   * Who has confirmed a multi-person effect (0071), oldest first. Every
   * confirmer as stored; `withLiveRequirement` narrows it to those who still
   * count under the rule as it is now.
   */
  confirmed_by: string[];
  /** The same people with who they are now, for the live re-check (C95). */
  confirmers: Confirmer[];
  /** Everyone who approved the request: the decider, plus any earlier approvals (C95). */
  decision_approvers: string[];
  /** The request's kind and amount: a payment reads its invoice's total (C94). */
  request_kind: string | null;
  amount_minor: unknown;
  amount_currency: string | null;
  /** The stamped assignee as they are now, so a stale assignee is not shown. */
  assignee_role: string | null;
  assignee_reviewer_roles: string[] | null;
  assignee_active: boolean | null;
  /** Set by `withLiveRequirement`: who carries it out, in words. */
  approver_label?: string;
  /** Set by `withLiveRequirement`: one from each named group has confirmed, when the rule asks. */
  covered?: boolean;
}

const SELECT = `
  SELECT e.id, e.request_id, e.decision_id, e.kind, e.status, e.required_role,
         e.approvals_required, e.assignee_id, u.name AS assignee_name,
         e.cancelled_reason, e.enforcement_result, e.created_at,
         ARRAY(SELECT c.user_id::text FROM effect_confirmations c
                WHERE c.effect_id = e.id ORDER BY c.created_at, c.user_id) AS confirmed_by,
         (SELECT COALESCE(json_agg(json_build_object(
                   'user_id', c.user_id,
                   'role', cm.role,
                   'reviewer_roles', COALESCE(cm.reviewer_roles, '{}'::text[]),
                   'active', COALESCE(cm.status = 'active', false)
                 ) ORDER BY c.created_at, c.user_id), '[]'::json)
            FROM effect_confirmations c
            LEFT JOIN members cm ON cm.workspace_id = c.workspace_id AND cm.user_id = c.user_id
           WHERE c.effect_id = e.id) AS confirmers,
         ARRAY(SELECT d.decided_by::text FROM decisions d WHERE d.id = e.decision_id AND d.decided_by IS NOT NULL
               UNION
               SELECT dc.user_id::text FROM decision_confirmations dc WHERE dc.request_id = e.request_id) AS decision_approvers,
         er.kind AS request_kind,
         er.payload -> 'total_minor' AS amount_minor,
         er.payload ->> 'currency' AS amount_currency,
         am.role AS assignee_role,
         am.reviewer_roles AS assignee_reviewer_roles,
         (am.status = 'active') AS assignee_active
    FROM effects e
    LEFT JOIN users u ON u.id = e.assignee_id
    LEFT JOIN requests er ON er.id = e.request_id
    LEFT JOIN members am ON am.workspace_id = e.workspace_id AND am.user_id = e.assignee_id`;

export interface EffectFilter {
  readonly requestId?: string;
  readonly status?: readonly string[];
  readonly audienceUserId?: string;
  readonly limit?: number;
}

export async function effectRows(tx: Tx, filter: EffectFilter = {}): Promise<EffectRow[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (filter.requestId) {
    values.push(filter.requestId);
    where.push(`e.request_id = $${values.length}`);
  }
  if (filter.status && filter.status.length > 0) {
    values.push([...filter.status]);
    where.push(`e.status = ANY ($${values.length}::text[])`);
  }
  if (filter.audienceUserId) {
    values.push(filter.audienceUserId);
    where.push(requestAudiencePredicate('e.request_id', `$${values.length}`));
  }
  values.push(Math.min(200, filter.limit ?? 100));

  const { rows } = await tx.query<EffectRow>(
    `${SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $${values.length}`,
    values,
  );
  return rows;
}

export async function loadEffect(tx: Tx, effectId: string, audienceUserId?: string): Promise<EffectRow | null> {
  const { rows } = await tx.query<EffectRow>(
    `${SELECT} WHERE e.id = $1${audienceUserId ? ` AND ${requestAudiencePredicate('e.request_id', '$2')}` : ''}`,
    audienceUserId ? [effectId, audienceUserId] : [effectId],
  );
  return rows[0] ?? null;
}

/** The sentence under an effect's label: what it is waiting for, or what happened. */
export function effectReason(
  row: Pick<EffectRow, 'status' | 'required_role' | 'assignee_name' | 'cancelled_reason'>
    & Partial<Pick<EffectRow, 'approvals_required' | 'confirmed_by' | 'approver_label'>>,
): string {
  // The rule's own words ("Admins or Finance") when the rule is known, so a
  // reader never sees a role slug or a rule that silently dropped Admins.
  const who = row.approver_label ?? row.required_role;
  switch (row.status) {
    case 'cancelled':
      return row.cancelled_reason ?? 'Cancelled by a later version';
    case 'simulated':
      return EFFECT_SIMULATED_REASON;
    case 'unavailable':
    case 'failed':
    case 'executed':
      return EFFECT_UNAVAILABLE_REASON;
    case 'assigned':
    case 'pending':
    default:
      if ((row.approvals_required ?? 1) > 1 && (row.confirmed_by?.length ?? 0) > 0) {
        return `${row.confirmed_by!.length} of ${row.approvals_required} confirmations · ${who} · Nothing executed`;
      }
      return row.assignee_name
        ? `Waiting on ${row.assignee_name} · ${who} · Nothing executed`
        : `Waiting on ${who} · Nothing executed`;
  }
}

/** The simulation record, only on a `simulated` row and only if it parses. */
export function effectSimulation(row: Pick<EffectRow, 'status' | 'enforcement_result'>): EffectSimulation | null {
  if (row.status !== 'simulated') return null;
  const result = row.enforcement_result as { simulation?: unknown } | null;
  const parsed = effectSimulationSchema.safeParse(result?.simulation);
  return parsed.success ? parsed.data : null;
}

/** The rule for an effect's kind, at its invoice's amount (C94). */
export function effectRule(row: Pick<EffectRow, 'kind' | 'request_kind' | 'amount_minor' | 'amount_currency'>, routes: RouteRules): RoutedRule | null {
  const route = routes[row.kind as ApprovalRouteKey];
  if (!route) return null;
  const amount = requestAmount({
    kind: row.request_kind ?? '',
    payload: { total_minor: row.amount_minor, currency: row.amount_currency },
  });
  return routedRule(route, amount);
}

/**
 * Who an effect needs, and how many, is the workspace's current rule for its
 * kind at its amount (decisions C93, C94), not what was stamped when it was
 * created, so a changed rule applies to everything already waiting. The same
 * goes for the people: a confirmation counts only while its confirmer is an
 * active member who still passes the rule, and a stamped assignee who no
 * longer could carry it out is not shown as the one it waits on.
 */
export function withLiveRequirement(row: EffectRow, routing: { routes: RouteRules; roleNames: ReadonlyMap<string, string> }): EffectRow {
  const routed = effectRule(row, routing.routes);
  if (!routed) return row;
  const { rule } = routed;
  const progress = countConfirmations(rule, row.confirmers, (person) =>
    mayApprove(rule, { role: person.role, reviewer_roles: person.reviewerRoles })
      && (rule.allow_requester || !row.decision_approvers.includes(person.userId)));
  const assigneeStands = row.assignee_id !== null
    && row.assignee_active === true
    && mayApprove(rule, { role: row.assignee_role ?? '', reviewer_roles: row.assignee_reviewer_roles ?? [] });
  return {
    ...row,
    approvals_required: rule.approvals_required,
    required_role: primaryRole(rule),
    approver_label: routedLabel(routed, routing.roleNames),
    confirmed_by: [...progress.counted],
    covered: progress.covered,
    assignee_id: assigneeStands ? row.assignee_id : null,
    assignee_name: assigneeStands ? row.assignee_name : null,
  };
}

/**
 * `viewerId` answers "have I already confirmed this?", so the Inbox can say it
 * is waiting on someone else instead of offering the same person a second vote.
 */
export function toEffectEntity(row: EffectRow, viewerId?: string): Record<string, unknown> {
  return {
    ...(row.approvals_required > 1
      ? {
          confirmations: {
            required: row.approvals_required,
            recorded: row.confirmed_by.length,
            by_viewer: viewerId !== undefined && row.confirmed_by.includes(viewerId),
          },
        }
      : {}),
    simulation: effectSimulation(row),
    id: row.id,
    request_id: row.request_id,
    kind: row.kind,
    status: row.status,
    required_role: row.required_role.slice(0, 32),
    ...(row.approver_label ? { approver_label: row.approver_label.slice(0, 200) } : {}),
    label: (EFFECT_LABELS[row.kind as EffectKind] ?? 'Effect').slice(0, 200),
    reason: effectReason(row).slice(0, 200),
  };
}
