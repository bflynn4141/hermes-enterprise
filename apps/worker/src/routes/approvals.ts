// Enterprise approval reads and human commands. These routes never execute the
// approved consequence; they only record a revision-bound human authorization.
import type { Context } from 'hono';
import {
  approvalViewSchema,
  approvalEvidenceViewSchema,
  decideApprovalInputSchema,
  reviseApprovalInputSchema,
  routeApprovalInputSchema,
  emailSendListSchema,
  settleEmailSendInputSchema,
} from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { effectExecutorMode } from '../domain/effects.js';
import { requireRequestedFrom } from '../domain/guards.js';
import {
  decideApproval,
  getApproval,
  reviseApproval,
  routeApproval,
} from '../domain/approvals.js';
import { inWorkspace, jsonBody, pathUuid } from './tenant.js';
import { RouteError } from './errors.js';
import { getApprovalEvidence } from '../domain/approval-evidence.js';
import { listEmailSends, settleEmailSend } from '../outbound-email/settlement.js';

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

export async function getApprovalEvidenceRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = pathUuid(c, 'id');
  const evidenceId = pathUuid(c, 'evidenceId');
  const evidence = await inWorkspace(c, (work) =>
    getApprovalEvidence(work.tx, work.workspaceId, requestId, evidenceId, work.userId));
  return c.json(approvalEvidenceViewSchema.parse(evidence));
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
    return decideApproval({ ...humanContext(work), simulateEmailReplies: effectExecutorMode(c.env) === 'simulated' }, requestId, parsed.data);
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

/** Each recipient's delivery of an approved email, including any a person must settle. */
export async function getEmailSendsRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = pathUuid(c, 'id');
  const list = await inWorkspace(c, async (work) => {
    await getApproval(work, requestId, work.userId);
    return listEmailSends(work.tx, work.workspaceId, requestId, work.userId);
  });
  return c.json(emailSendListSchema.parse(list));
}

/** A person's answer after checking the mailbox for a send whose outcome is unknown. */
export async function settleEmailSendRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireRequestedFrom(c);
  requireCsrf(c);
  const requestId = pathUuid(c, 'id');
  const outboxId = pathUuid(c, 'sendId');
  const parsed = settleEmailSendInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('the answer is invalid', 'bad_email_send_settlement', 422);
  const outcome = await inWorkspace(c, async (work) => {
    requireStepUp(work.session);
    return settleEmailSend(humanContext(work), requestId, outboxId, parsed.data);
  });
  return c.json(emailSendListSchema.parse(outcome.list), outcome.duplicate ? 200 : 201, {
    'X-Hermes-Duplicate': outcome.duplicate ? 'true' : 'false',
  });
}
