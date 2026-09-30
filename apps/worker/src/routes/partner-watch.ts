import type { Context } from 'hono';
import { partnerWatchUpdateSchema } from '@hermes/shared';
import { requireCsrf,requireOrigin } from '../auth.js';
import type { Env } from '../env.js';
import { partnerWatchView,updatePartnerWatch } from '../partner-screening/watch.js';
import { inWorkspace,jsonBody,pathUuid,RouteError } from './tenant.js';

export async function getPartnerWatch(c:Context<{Bindings:Env}>):Promise<Response> {
  const agentId=pathUuid(c,'agentId');
  const result=await inWorkspace(c,work=>partnerWatchView(work.tx,c.env,work.workspaceId,work.userId,agentId));
  c.header('Cache-Control','no-store');
  return c.json(result);
}

export async function patchPartnerWatch(c:Context<{Bindings:Env}>):Promise<Response> {
  requireOrigin(c,{required:true});requireCsrf(c);
  const agentId=pathUuid(c,'agentId');
  const parsed=partnerWatchUpdateSchema.safeParse(await jsonBody<unknown>(c));
  if(!parsed.success) throw new RouteError('Watch settings or budgets are invalid.','bad_body',422);
  const result=await inWorkspace(c,work=>updatePartnerWatch(work.tx,c.env,work.workspaceId,work.userId,agentId,parsed.data,work.jobs));
  return c.json(result);
}
