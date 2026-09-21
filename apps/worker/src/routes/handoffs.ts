import type { Context } from 'hono';
import { handoffDetailSchema, handoffListSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { loadHandoffDetail, loadHandoffsList } from '../handoffs/service.js';
import { loadPartnerWorkflowViewV2 } from '../partner-workflow/v2.js';
import { inWorkspace, pathUuid } from './tenant.js';
import { routeError } from './partner-workflow.js';

export async function listHandoffs(c: Context<{ Bindings: Env }>): Promise<Response> {
  const payload = await inWorkspace(c, async (work) => {
    try {
      const view = await loadPartnerWorkflowViewV2(work.tx, work.workspaceId, work.userId);
      const items = await loadHandoffsList(work.tx, work.workspaceId, work.userId, view);
      return items;
    } catch (error) { return routeError(error); }
  });
  return c.json(handoffListSchema.parse(payload));
}

export async function getHandoff(c: Context<{ Bindings: Env }>): Promise<Response> {
  const handoffId = pathUuid(c, 'handoffId');
  const payload = await inWorkspace(c, async (work) => {
    try {
      const view = await loadPartnerWorkflowViewV2(work.tx, work.workspaceId, work.userId);
      return await loadHandoffDetail(work.tx, work.workspaceId, handoffId, view);
    } catch (error) { return routeError(error); }
  });
  return c.json(handoffDetailSchema.parse(payload));
}
