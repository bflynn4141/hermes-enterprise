// Enterprise approval reads and human commands. These routes never execute the
// approved consequence; they only record a revision-bound human authorization.
import type { Context } from 'hono';
import {
  approvalViewSchema,
  decideApprovalInputSchema,
  reviseApprovalInputSchema,
  routeApprovalInputSchema,
} from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { requireRequestedFrom } from '../domain/guards.js';
import {
  decideApproval,
  getApproval,
  reviseApproval,
  routeApproval,
} from '../domain/approvals.js';
import { inWorkspace, jsonBody, pathUuid, RouteError } from './tenant.js';

const humanContext = (work: Parameters<Parameters<typeof inWorkspace>[1]>[0]) => ({
  tx: work.tx,
  workspaceId: work.workspaceId,
  jobs: work.jobs,
  userId: work.userId,
  memberRole: work.role,
});

export async function getApprovalRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = pathUuid(c, 'id');
  const view = await inWorkspace(c, (work) => getApproval(work, requestId, work.userId));
  return c.json(approvalViewSchema.parse(view));
}

export async function createApprovalDecision(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireRequestedFrom(c);
  requireCsrf(c);
  const requestId = pathUuid(c, 'id');
  const parsed = decideApprovalInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('the approval decision is invalid', 'bad_approval_decision', 422);
  const outcome = await inWorkspace(c, async (work) => {
    requireStepUp(work.session);
    return decideApproval(humanContext(work), requestId, parsed.data);
  });
  if (outcome.view.status === 'expired') {
    return c.json({ error: 'this approval expired', reason: 'approval_expired' }, 409);
  }
  return c.json(approvalViewSchema.parse(outcome.view), outcome.duplicate ? 200 : 201, {
    'X-Hermes-Duplicate': outcome.duplicate ? 'true' : 'false',
  });
}

export async function createApprovalRevision(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireRequestedFrom(c);
  requireCsrf(c);
  const requestId = pathUuid(c, 'id');
  const parsed = reviseApprovalInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('the approval revision is invalid', 'bad_approval_revision', 422);
  const outcome = await inWorkspace(c, async (work) => {
    requireStepUp(work.session);
    return reviseApproval(humanContext(work), requestId, parsed.data);
  });
  return c.json(approvalViewSchema.parse(outcome.view), outcome.duplicate ? 200 : 201, {
    'X-Hermes-Duplicate': outcome.duplicate ? 'true' : 'false',
  });
}

export async function createApprovalRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireRequestedFrom(c);
  requireCsrf(c);
  const requestId = pathUuid(c, 'id');
  const parsed = routeApprovalInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('the approval route is invalid', 'bad_approval_route', 422);
  const outcome = await inWorkspace(c, async (work) => {
    requireStepUp(work.session);
    return routeApproval(humanContext(work), requestId, parsed.data);
  });
  return c.json(approvalViewSchema.parse(outcome.view), outcome.duplicate ? 200 : 201, {
    'X-Hermes-Duplicate': outcome.duplicate ? 'true' : 'false',
  });
}
