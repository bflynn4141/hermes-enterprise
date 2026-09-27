// GET   /w/:ws/admin/agents          the Admin agent directory
// PATCH /w/:ws/admin/agents/:agentId  rename an agent, choose its model (C96)
//
// Admin only. The directory lists every agent in the workspace with the
// configuration an Admin governs and no run content; the rule and its reasons
// live in src/domain/agent-governance-access.ts and src/domain/agent-directory.ts.
//
// The PATCH changes two columns on `agents` and nothing else: it never reads
// or returns a session, message, run or parked call. It always asks for a
// recent sign-in. Renaming another person's agent, or changing the model its
// conversations start with, is the same bar as changing a member's role; for
// the Admin's own agent the same rule is simpler than a second path.
import type { Context } from 'hono';
import { adminAgentPatchSchema, agentDirectoryEntrySchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { agentHasManagedRuntime, loadAgentDirectory } from '../domain/agent-directory.js';
import { requireAgentGovernanceAccess } from '../domain/agent-governance-access.js';
import { publishEvents } from '../jobs.js';
import { requireRunnableModel } from '../model/runnable.js';
import { RouteError } from './errors.js';
import { inWorkspace, jsonBody, pathUuid, type TenantWork } from './tenant.js';

export async function listAdminAgents(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await inWorkspace(c, async (work) => {
    work.requireAdmin('Viewing every agent');
    return loadAgentDirectory(work, c.env.HERMES_RUNTIME_AGENTS);
  });
  c.header('Cache-Control', 'no-store');
  return c.json(body);
}

/**
 * Admin, governance access and a recent sign-in, in that order: the same
 * guards every Admin write to an agent uses (C91, C96). An unknown agent is
 * `unknown_agent`, whether it never existed or belongs to another workspace.
 */
export async function requireAgentConfigurationWrite(work: TenantWork, agentId: string, action: string): Promise<void> {
  work.requireAdmin(action);
  try {
    await requireAgentGovernanceAccess(work, agentId);
  } catch (error) {
    if (error instanceof RouteError && error.status === 404) throw new RouteError('no such agent in this workspace', 'unknown_agent', 404);
    throw error;
  }
  requireStepUp(work.session);
}

export async function patchAdminAgent(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const agentId = pathUuid(c, 'agentId');
  const parsed = adminAgentPatchSchema.safeParse(await jsonBody<unknown>(c).catch(() => null));
  if (!parsed.success) throw new RouteError('an agent needs a name of 1 to 80 characters, or a model', 'bad_agent_update', 422);
  const input = parsed.data;
  const entry = await inWorkspace(c, async (work) => {
    await requireAgentConfigurationWrite(work, agentId, 'configuring an agent');
    if (typeof input.model_id === 'string') {
      // A model this workspace cannot run would be a default no session can
      // use. An agent on a Hermes runtime is also held to the models the
      // runtime's model proxy routes.
      const runtime = await agentHasManagedRuntime(work, c.env.HERMES_RUNTIME_AGENTS, agentId);
      await requireRunnableModel(c.env, work.tx, work.workspaceId, input.model_id, { runtime });
    }
    await work.tx.query(
      `UPDATE agents
          SET name = COALESCE($3, name),
              model_id = CASE WHEN $4::boolean THEN $5 ELSE model_id END,
              updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, agentId, input.name ?? null, input.model_id !== undefined, input.model_id ?? null],
    );
    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, agent_id)
       VALUES ($1, 'user', $2, 'settings.changed', $3)`,
      [work.workspaceId, work.userId, agentId],
    );
    work.jobs.push(...(await publishEvents(work.tx, work.workspaceId, [
      { kind: 'entity.updated', payload: { entity: 'agent', id: agentId, reason: 'agent_configured' } },
    ])));
    const directory = await loadAgentDirectory(work, c.env.HERMES_RUNTIME_AGENTS, agentId);
    const updated = directory.items[0];
    if (!updated) throw new RouteError('no such agent in this workspace', 'unknown_agent', 404);
    return updated;
  });
  return c.json(agentDirectoryEntrySchema.parse(entry));
}
