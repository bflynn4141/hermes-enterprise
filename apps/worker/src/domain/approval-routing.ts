// Approval routing (migration 0073, decision C93): who may approve each kind
// of work. The rules are data an Admin edits; this module is the one place
// that reads them and answers "may this person approve this", so the decision
// route, the Inbox counts and effect execution cannot disagree.
import {
  APPROVAL_ROUTES,
  mayApprove,
  type ApprovalRoute,
  type ApprovalRouteKey,
  type ApprovalRouteRule,
} from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { financeWorkflowRequest } from './finance-decidable.js';

export interface LoadedRoute {
  readonly rule: ApprovalRouteRule;
  readonly isDefault: boolean;
  readonly updatedAt: Date | null;
}

export type RouteRules = Readonly<Record<ApprovalRouteKey, LoadedRoute>>;

interface RouteRow {
  route_key: ApprovalRouteKey;
  admins: boolean;
  roles: string[];
  approvals_required: number;
  allow_requester: boolean;
  updated_at: Date;
}

/** Every rule, saved or default. */
export async function loadApprovalRoutes(tx: Tx, workspaceId: string): Promise<RouteRules> {
  const { rows } = await tx.query<RouteRow>(
    `SELECT route_key, admins, roles, approvals_required, allow_requester, updated_at
       FROM approval_route_rules WHERE workspace_id = $1`,
    [workspaceId],
  );
  const saved = new Map(rows.map((row) => [row.route_key, row]));
  return Object.fromEntries(APPROVAL_ROUTES.map((definition) => {
    const row = saved.get(definition.key);
    const loaded: LoadedRoute = row
      ? {
          rule: { admins: row.admins, roles: row.roles, approvals_required: row.approvals_required, allow_requester: row.allow_requester },
          isDefault: false,
          updatedAt: row.updated_at,
        }
      : { rule: definition.default, isDefault: true, updatedAt: null };
    return [definition.key, loaded];
  })) as unknown as RouteRules;
}

export function approvalRouteViews(routes: RouteRules): ApprovalRoute[] {
  return APPROVAL_ROUTES.map((definition) => {
    const loaded = routes[definition.key];
    return {
      key: definition.key,
      kind: definition.kind,
      label: definition.label,
      description: definition.description,
      workflow_note: definition.workflow_note,
      rule: { ...loaded.rule, roles: [...loaded.rule.roles] },
      is_default: loaded.isDefault,
      updated_at: loaded.updatedAt ? loaded.updatedAt.toISOString() : null,
    };
  });
}

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
  const names = await tx.query<{ slug: string; name: string }>(
    `SELECT slug, name FROM workspace_roles WHERE workspace_id = $1`,
    [workspaceId],
  );
  return {
    userId,
    role,
    reviewerRoles: member.rows[0]?.reviewer_roles ?? [],
    routes: await loadApprovalRoutes(tx, workspaceId),
    roleNames: new Map(names.rows.map((row) => [row.slug, row.name])),
  };
}

const DECISION_KEYS: readonly string[] = ['application', 'invoice', 'agreement'];

/** The request kinds this viewer could decide by rule, before the requester check. */
export function decidableKinds(viewer: ApprovalViewer): string[] {
  return DECISION_KEYS.filter((key) =>
    mayApprove(viewer.routes[key as ApprovalRouteKey].rule, { role: viewer.role, reviewer_roles: viewer.reviewerRoles }));
}

/**
 * May this viewer decide this request? The rule for its kind decides, and a
 * handoff request also goes to Finance, because the workflow routes it there
 * (the partner invoice check then also requires the handoff's own person).
 * When the rule says the requester may not approve, the person whose agent
 * prepared it may not, whatever else they hold.
 */
export function mayDecideRequest(
  viewer: ApprovalViewer,
  row: { kind: string; subject_key?: string | null; requester_id?: string | null },
): boolean {
  if (!DECISION_KEYS.includes(row.kind)) return false;
  const rule = viewer.routes[row.kind as ApprovalRouteKey].rule;
  if (!rule.allow_requester && row.requester_id && row.requester_id === viewer.userId) return false;
  const person = { role: viewer.role, reviewer_roles: viewer.reviewerRoles };
  return mayApprove(rule, person) || (financeWorkflowRequest(row) && viewer.reviewerRoles.includes('finance'));
}

/** "Admins", "Finance", "Admins or Finance", "Finance or Legal". */
export function approverLabel(rule: Pick<ApprovalRouteRule, 'admins' | 'roles'>, roleNames: ReadonlyMap<string, string>): string {
  const groups = [
    ...(rule.admins ? ['Admins'] : []),
    ...rule.roles.map((slug) => roleNames.get(slug) ?? slug),
  ];
  if (groups.length === 0) return 'Nobody';
  if (groups.length === 1) return rule.admins ? 'Workspace Admin' : groups[0]!;
  return `${groups.slice(0, -1).join(', ')} or ${groups[groups.length - 1]}`;
}

/** The label a legacy request shows for whose decision it is. */
export function requestApproverLabel(viewer: ApprovalViewer, row: { kind: string; subject_key?: string | null }): string {
  if (financeWorkflowRequest(row)) return 'Finance reviewer';
  if (!DECISION_KEYS.includes(row.kind)) return 'Workspace Admin';
  return approverLabel(viewer.routes[row.kind as ApprovalRouteKey].rule, viewer.roleNames);
}
