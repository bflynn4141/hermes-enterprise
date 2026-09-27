// Enterprise skill assignments are governance: an Admin may read and change
// their state, config and schedule on any agent in the workspace. None of it
// is run content (src/domain/agent-governance-access.ts).
//
// Decision C96 adds assigning and removing a catalog skill. An Admin picks a
// skill by key only: the server chooses the version, the reviewed artifact,
// the lane and the default settings, because the runtime attests exact skill
// bytes. Three things stay out of reach on purpose:
//
//   * a second active skill, because managed readiness admits exactly one;
//   * an agent whose Hermes runtime attests its skill at startup, because a
//     changed assignment would only fail admission until the runtime is
//     rebuilt (docs/HERMES-AGENT-RUNTIME.md);
//   * a skill from another role's lane, which that lane's connector scopes do
//     not cover.
import type { Context } from 'hono';
import {
  enterpriseSkillAssignmentCreateSchema,
  enterpriseSkillAssignmentPageSchema,
  enterpriseSkillAssignmentSchema,
  enterpriseSkillAssignmentUpdateSchema,
  enterpriseSkillCatalogSchema,
} from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import {
  listEnterpriseSkillAssignments,
  removeEnterpriseSkillAssignment,
  updateEnterpriseSkillAssignment,
} from '../enterprise-skills/service.js';
import { catalogSkillDefinition, ENTERPRISE_SKILL_CATALOG, toolsForSkillVersion } from '../enterprise-skills/registry.js';
import { assignCatalogSkill } from '../partner-workflow/service.js';
import { agentHasManagedRuntime } from '../domain/agent-directory.js';
import { publishEvents } from '../jobs.js';
import { inWorkspace, jsonBody, pathUuid, type TenantWork } from './tenant.js';
import { RouteError } from './errors.js';
import { requireAgentGovernanceAccess } from '../domain/agent-governance-access.js';
import { requireAgentConfigurationWrite } from './admin-agents.js';

export const RUNTIME_REBUILD_MESSAGE =
  'This agent runs on a Hermes runtime that checks its exact skill when it starts, so its skills can’t change here. '
  + 'The runtime needs a rebuild first; see the runtime runbook in docs/HERMES-AGENT-RUNTIME.md.';

/** GET /w/:ws/skill-catalog — what an Admin may assign, at the version a new assignment gets. */
export async function listSkillCatalog(c: Context<{ Bindings: Env }>): Promise<Response> {
  const items = await inWorkspace(c, async (work) => {
    work.requireAdmin('viewing the skill catalog');
    return ENTERPRISE_SKILL_CATALOG.map((definition) => ({
      key: definition.key,
      name: definition.name,
      description: definition.description,
      version: definition.version,
      digest: definition.artifactDigest,
      tools: toolsForSkillVersion(definition.key, definition.version, definition.defaultCapabilityGrants),
      template: definition.roleTemplateKey,
    }));
  });
  c.header('Cache-Control', 'no-store');
  return c.json(enterpriseSkillCatalogSchema.parse({ items }));
}

/** The shared tail of an assignment write: the per-agent lock the role setup also takes, and the managed-runtime refusal. */
async function lockUnmanagedAgent(c: Context<{ Bindings: Env }>, work: TenantWork, agentId: string): Promise<void> {
  await work.tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`agent-setup:${agentId}`]);
  if (await agentHasManagedRuntime(work, c.env.HERMES_RUNTIME_AGENTS, agentId)) {
    throw new RouteError(RUNTIME_REBUILD_MESSAGE, 'runtime_rebuild_required', 409);
  }
}

async function auditSkillChange(work: TenantWork, agentId: string): Promise<void> {
  await work.tx.query(
    `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, agent_id)
     VALUES ($1,'user',$2,'settings.changed',$3)`,
    [work.workspaceId, work.userId, agentId],
  );
  work.jobs.push(...(await publishEvents(work.tx, work.workspaceId, [
    { kind: 'entity.updated', payload: { entity: 'agent', id: agentId, reason: 'agent_skills_changed' } },
  ])));
}

/** POST /w/:ws/agents/:agentId/skill-assignments — assign a catalog skill (C96). */
export async function createSkillAssignment(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireCsrf(c);
  const agentId = pathUuid(c, 'agentId');
  const parsed = enterpriseSkillAssignmentCreateSchema.safeParse(await jsonBody<unknown>(c).catch(() => null));
  const definition = parsed.success ? catalogSkillDefinition(parsed.data.skill_key) : null;
  if (!definition) throw new RouteError('choose a skill from the catalog', 'unknown_skill', 422);
  const entity = await inWorkspace(c, async (work) => {
    await requireAgentConfigurationWrite(work, agentId, 'assigning a skill');
    await lockUnmanagedAgent(c, work, agentId);
    const lane = (await work.tx.query<{ team_id: string; role_template_key: string }>(
      `SELECT team_id, role_template_key FROM enterprise_team_agents WHERE workspace_id=$1 AND agent_id=$2`,
      [work.workspaceId, agentId],
    )).rows[0];
    if (!lane) throw new RouteError('this agent has no role to attach a skill to; give it a role first', 'no_lane', 422);
    const current = await work.tx.query<{ skill_key: string; state: string }>(
      `SELECT skill_key, state FROM enterprise_skill_assignments
        WHERE workspace_id=$1 AND agent_id=$2 AND removed_at IS NULL`,
      [work.workspaceId, agentId],
    );
    if (current.rows.some((row) => row.skill_key === definition.key)) {
      throw new RouteError('this agent already has that skill', 'already_assigned', 409);
    }
    if (current.rows.some((row) => row.state === 'active')) {
      throw new RouteError('an agent runs one active skill; pause or remove the current one first', 'one_active_skill', 409);
    }
    // A lane's connector scopes cover its own role's skill only.
    if (lane.role_template_key !== definition.roleTemplateKey) {
      throw new RouteError('that skill belongs to another role', 'skill_role_mismatch', 422);
    }
    await assignCatalogSkill(work.tx, work.workspaceId, lane.team_id, agentId, work.userId, definition);
    await auditSkillChange(work, agentId);
    const assigned = (await listEnterpriseSkillAssignments(c.env, work.tx, work.workspaceId, agentId, work.userId))
      .find((item) => item.skill_key === definition.key);
    if (!assigned) throw new RouteError('the skill was not assigned', 'assign_failed', 409);
    return assigned;
  });
  return c.json(enterpriseSkillAssignmentSchema.parse(entity), 201);
}

/** DELETE /w/:ws/agents/:agentId/skill-assignments/:id — remove a catalog skill (C96). */
export async function deleteSkillAssignment(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireCsrf(c);
  const agentId = pathUuid(c, 'agentId');
  const assignmentId = pathUuid(c, 'id');
  await inWorkspace(c, async (work) => {
    await requireAgentConfigurationWrite(work, agentId, 'removing a skill');
    await lockUnmanagedAgent(c, work, agentId);
    if (!(await removeEnterpriseSkillAssignment(work.tx, work.workspaceId, agentId, assignmentId))) {
      throw new RouteError('no such skill assignment', 'not_found', 404);
    }
    await auditSkillChange(work, agentId);
  });
  return new Response(null, { status: 204 });
}

export async function listSkillAssignments(c: Context<{ Bindings: Env }>): Promise<Response> {
  const agentId = pathUuid(c, 'agentId');
  const items = await inWorkspace(c, async (work) => {
    await requireAgentGovernanceAccess(work, agentId);
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
    await requireAgentGovernanceAccess(work, agentId);
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
    const access = await requireAgentGovernanceAccess(work, agentId);
    if (!access.conversations) requireStepUp(work.session);
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
