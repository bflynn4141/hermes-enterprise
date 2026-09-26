// /w/:ws/approval-routes — who may approve each kind of work (decision C93).
//
// Admin only. A rule decides who may approve invoices and release payments, so
// writes need a recent sign-in, like changing a member's role. There is no
// self-change rule here: a rule names roles and Admins, never one person, and
// changing who holds a role still goes through `/roles` and `/members`.
import type { Context } from 'hono';
import {
  APPROVAL_ROUTE_KEYS,
  approvalRouteDefinition,
  approvalRouteListSchema,
  approvalRouteSchema,
  approvalRouteUpdateSchema,
  type ApprovalRouteKey,
} from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { approvalRouteViews, loadApprovalRoutes } from '../domain/approval-routing.js';
import { roleSlugs } from '../domain/roles.js';
import { publishEvents } from '../jobs.js';
import { RouteError } from './errors.js';
import { inWorkspace, jsonBody, type TenantWork } from './tenant.js';

function routeKey(c: Context): ApprovalRouteKey {
  const key = c.req.param('key') ?? '';
  if (!(APPROVAL_ROUTE_KEYS as readonly string[]).includes(key)) {
    throw new RouteError('there is no approval called that', 'unknown_route', 404);
  }
  return key as ApprovalRouteKey;
}

async function routeView(work: TenantWork, key: ApprovalRouteKey) {
  return approvalRouteViews(await loadApprovalRoutes(work.tx, work.workspaceId)).find((route) => route.key === key)!;
}

async function audit(work: TenantWork): Promise<void> {
  await work.tx.query(
    `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind) VALUES ($1, 'user', $2, 'settings.changed')`,
    [work.workspaceId, work.userId],
  );
  work.jobs.push(...(await publishEvents(work.tx, work.workspaceId, [
    { kind: 'entity.updated', payload: { entity: 'approval_route_rules', id: work.workspaceId, reason: 'approval_routes_changed' } },
  ])));
}

export async function listApprovalRoutes(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await inWorkspace(c, async (work) => {
    work.requireAdmin('viewing approval rules');
    return { items: approvalRouteViews(await loadApprovalRoutes(work.tx, work.workspaceId)) };
  });
  c.header('Cache-Control', 'no-store');
  return c.json(approvalRouteListSchema.parse(body));
}

export async function putApprovalRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const key = routeKey(c);
  const parsed = approvalRouteUpdateSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('that is not a valid approval rule', 'bad_rule', 422);
  const rule = { ...parsed.data, roles: [...new Set(parsed.data.roles)] };
  const route = await inWorkspace(c, async (work) => {
    work.requireAdmin('changing who approves');
    requireStepUp(work.session);
    if (!rule.admins && rule.roles.length === 0) {
      throw new RouteError('choose at least one group who can approve', 'no_approver', 422);
    }
    if (approvalRouteDefinition(key).kind === 'decision' && rule.approvals_required !== 1) {
      throw new RouteError('one person makes this decision', 'decision_single_approver', 422);
    }
    const known = await roleSlugs(work.tx, work.workspaceId);
    const unknown = rule.roles.filter((slug) => !known.has(slug));
    if (unknown.length > 0) {
      throw new RouteError(`this workspace has no role called ${unknown.join(', ')}`, 'unknown_role', 422);
    }
    await work.tx.query(
      `INSERT INTO approval_route_rules (workspace_id, route_key, admins, roles, approvals_required, allow_requester, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, route_key) DO UPDATE SET
         admins = EXCLUDED.admins, roles = EXCLUDED.roles,
         approvals_required = EXCLUDED.approvals_required,
         allow_requester = EXCLUDED.allow_requester,
         updated_by = EXCLUDED.updated_by`,
      [work.workspaceId, key, rule.admins, rule.roles, rule.approvals_required, rule.allow_requester, work.userId],
    );
    await audit(work);
    return routeView(work, key);
  });
  return c.json(approvalRouteSchema.parse(route));
}

/** Back to the default: the rule the product had before it was editable. */
export async function resetApprovalRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const key = routeKey(c);
  const route = await inWorkspace(c, async (work) => {
    work.requireAdmin('changing who approves');
    requireStepUp(work.session);
    const removed = await work.tx.query(
      `DELETE FROM approval_route_rules WHERE workspace_id = $1 AND route_key = $2`,
      [work.workspaceId, key],
    );
    if ((removed.rowCount ?? 0) > 0) await audit(work);
    return routeView(work, key);
  });
  return c.json(approvalRouteSchema.parse(route));
}
