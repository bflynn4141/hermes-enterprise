import type { Context } from 'hono';
import {
  partnerInvoiceReviewHandoffInputSchema,
  partnerWorkflowSetupSchema,
  partnerWorkflowViewSchema,
} from '@hermes/shared';
import { requireCsrf, requireOrigin } from '../auth.js';
import type { Env } from '../env.js';
import {
  configurePartnerWorkflow,
  loadPartnerWorkflowView,
  PartnerWorkflowError,
  publishPartnerInvoiceReviewHandoff,
} from '../partner-workflow/service.js';
import { inWorkspace, jsonBody, RouteError } from './tenant.js';

function routeError(error: unknown): never {
  if (error instanceof PartnerWorkflowError) {
    const status = error.reason.endsWith('_mismatch') || error.reason === 'principal_already_bound' ? 409 : 422;
    throw new RouteError(error.message, error.reason, status);
  }
  throw error;
}

export async function getPartnerWorkflow(c: Context<{ Bindings: Env }>): Promise<Response> {
  const view = await inWorkspace(c, (work) => loadPartnerWorkflowView(work.tx, work.workspaceId));
  return c.json(partnerWorkflowViewSchema.parse(view));
}

export async function configurePartnerWorkflowRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireCsrf(c);
  const parsed = partnerWorkflowSetupSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('The two employee/agent bindings are invalid.', 'bad_partner_workflow_setup', 422);
  const view = await inWorkspace(c, async (work) => {
    work.requireAdmin('applying employee role templates');
    try {
      return await configurePartnerWorkflow(work.tx, work.workspaceId, work.userId, parsed.data);
    } catch (error) {
      return routeError(error);
    }
  });
  return c.json(partnerWorkflowViewSchema.parse(view), 201);
}

export async function createPartnerInvoiceReviewHandoff(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireCsrf(c);
  const parsed = partnerInvoiceReviewHandoffInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) {
    throw new RouteError(
      'An actual invoice, engagement reference, authorized amount and evidence are required.',
      'bad_invoice_review_event',
      422,
    );
  }
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('publishing an invoice-review event');
    try {
      const created = await publishPartnerInvoiceReviewHandoff(
        work.tx, work.workspaceId, work.userId, parsed.data,
      );
      if (created.jobId) work.jobs.push(created.jobId);
      return created;
    } catch (error) {
      return routeError(error);
    }
  });
  return c.json(result, result.created ? 201 : 200, {
    'X-Hermes-Idempotent-Replay': result.created ? 'false' : 'true',
  });
}
