import type { Context } from 'hono';
import { agentWakeInputSchema, uuidSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin } from '../auth.js';
import { inWorkspace, jsonBody, pathUuid, RouteError } from './tenant.js';
import { loadRecoveryRun, recoveryView, requireRecoveryAgent, retryTask, wakeAuthorizedWork } from '../runs/recovery.js';

export async function getAgentRecovery(c: Context<{ Bindings: Env }>): Promise<Response> {
  const agentId = pathUuid(c, 'agentId');
  const requested = c.req.query('run_id');
  if (requested && !uuidSchema.safeParse(requested).success) throw new RouteError('run_id is not a uuid', 'bad_id', 400);
  return c.json(await inWorkspace(c, work => recoveryView(work, c.env, agentId, requested)));
}

export async function wakeAgent(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const agentId = pathUuid(c, 'agentId');
  const parsed = agentWakeInputSchema.safeParse(await jsonBody(c));
  if (!parsed.success) throw new RouteError('Invalid recovery action.', 'bad_body', 422);
  const input = parsed.data;
  if (input.action !== 'run_now' && (!input.run_id || input.expected_attempt === undefined)) {
    throw new RouteError('A task and expected attempt are required.', 'bad_body', 422);
  }
  const result = await inWorkspace(c, async work => {
    if (input.action === 'run_now') return wakeAuthorizedWork(work, c.env, agentId);
    if (input.action === 'retry') {
      await retryTask(work, c.env, agentId, input.run_id!, input.expected_attempt);
    } else {
      await requireRecoveryAgent(work, agentId, true);
      const run = (await loadRecoveryRun(work, agentId, input.run_id, true))!;
      if (run.attempt !== input.expected_attempt) throw new RouteError('This task has changed. Refresh its status.', 'stale_attempt', 409);
      await work.tx.query(
        `UPDATE runs SET recovery_cancelled=true,recovery_next_at=NULL WHERE workspace_id=$1 AND id=$2`,
        [work.workspaceId, run.id],
      );
      if (!run.recovery_cancelled) await work.tx.query(
        `INSERT INTO events(workspace_id,actor_type,actor_user_id,kind,run_id,session_id,agent_id)
         VALUES($1,'user',$2,'run.retry_cancelled',$3,$4,$5)`,
        [work.workspaceId,work.userId,run.id,run.session_id,agentId],
      );
    }
    return recoveryView(work, c.env, agentId, input.run_id);
  });
  return c.json(result);
}
