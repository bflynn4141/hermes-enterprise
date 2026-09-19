import type { Context } from 'hono';
import {
  enterpriseSkillAssignmentPageSchema,
  enterpriseSkillAssignmentSchema,
  enterpriseSkillAssignmentUpdateSchema,
} from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin } from '../auth.js';
import { listEnterpriseSkillAssignments, updateEnterpriseSkillAssignment } from '../enterprise-skills/service.js';
import { inWorkspace, jsonBody, pathUuid, RouteError } from './tenant.js';

async function requireAgent(workspaceId: string, agentId: string, tx: Parameters<typeof listEnterpriseSkillAssignments>[1]): Promise<void> {
  const { rows } = await tx.query(`SELECT 1 FROM agents WHERE workspace_id=$1 AND id=$2`, [workspaceId, agentId]);
  if (!rows[0]) throw new RouteError('no such agent', 'not_found', 404);
}

export async function listSkillAssignments(c: Context<{ Bindings: Env }>): Promise<Response> {
  const agentId = pathUuid(c, 'agentId');
  const items = await inWorkspace(c, async (work) => {
    await requireAgent(work.workspaceId, agentId, work.tx);
    return listEnterpriseSkillAssignments(
      c.env, work.tx, work.workspaceId, agentId, work.role === 'admin' ? work.userId : null,
    );
  });
  return c.json(enterpriseSkillAssignmentPageSchema.parse({ items, cursor: null, total: items.length }));
}

export async function getSkillAssignment(c: Context<{ Bindings: Env }>): Promise<Response> {
  const agentId = pathUuid(c, 'agentId');
  const assignmentId = pathUuid(c, 'id');
  const entity = await inWorkspace(c, async (work) => {
    await requireAgent(work.workspaceId, agentId, work.tx);
    const items = await listEnterpriseSkillAssignments(
      c.env, work.tx, work.workspaceId, agentId, work.role === 'admin' ? work.userId : null,
    );
    const assignment = items.find((item) => item.id === assignmentId);
    if (!assignment) throw new RouteError('no such skill assignment', 'not_found', 404);
    return assignment;
  });
  return c.json(enterpriseSkillAssignmentSchema.parse(entity));
}

export async function patchSkillAssignment(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireCsrf(c);
  const agentId = pathUuid(c, 'agentId');
  const assignmentId = pathUuid(c, 'id');
  const parsed = enterpriseSkillAssignmentUpdateSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('skill assignment configuration is invalid', 'bad_body', 400);
  const entity = await inWorkspace(c, async (work) => {
    work.requireAdmin('configuring an enterprise skill');
    await requireAgent(work.workspaceId, agentId, work.tx);
    // Ensure legacy deployments have a concrete row before applying the patch.
    await listEnterpriseSkillAssignments(c.env, work.tx, work.workspaceId, agentId, work.userId);
    try {
      const assignment = await updateEnterpriseSkillAssignment(
        work.tx, work.workspaceId, agentId, assignmentId, work.userId, parsed.data,
      );
      await work.tx.query(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, agent_id)
         VALUES ($1,'user',$2,'settings.changed',$3)`,
        [work.workspaceId, work.userId, agentId],
      );
      return assignment;
    } catch (error) {
      if (error instanceof Error && error.message === 'enterprise_skill_assignment_not_found') {
        throw new RouteError('no such skill assignment', 'not_found', 404);
      }
      if (error instanceof Error && error.message === 'enterprise_skill_not_supported') {
        throw new RouteError('this enterprise skill cannot be configured here', 'not_supported', 422);
      }
      if (error instanceof Error && error.message === 'enterprise_skill_assignment_stale') {
        throw new RouteError('this skill assignment changed; reload it before saving', 'stale_revision', 409);
      }
      throw error;
    }
  });
  return c.json(enterpriseSkillAssignmentSchema.parse(entity));
}
