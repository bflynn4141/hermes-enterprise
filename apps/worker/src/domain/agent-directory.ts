// The Admin agent directory: every agent in the workspace, with its owner, role,
// skills, where it runs and which operations wait for a person.
//
// This is governance data only (see agent-governance-access.ts). The queries
// below read agents, owners, role bindings, skill assignments, runtime
// placement and approval policy. They never join sessions, messages, runs,
// traces or parked tool calls, so nothing a member's agent has done can reach
// an Admin through this list. `test/db/agent-directory.test.ts` holds that line.
import { AGENT_OPERATION_CATALOG, agentDirectorySchema, type AgentDirectory, type AgentDirectoryRuntime } from '@hermes/shared';
import type { TenantWork } from '../routes/tenant.js';
import { enterpriseSkillDefinition, ENTERPRISE_SKILL_REGISTRY } from '../enterprise-skills/registry.js';
import { hasAgentContextAccess } from './agent-context-access.js';

interface AgentRow {
  id: string;
  name: string;
  responsibility: string | null;
  status: 'draft' | 'provisioning' | 'started';
  context_scope: 'private' | 'workspace';
  owner_member_id: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  team_slug: string | null;
  team_name: string | null;
  role_template_key: string | null;
  principal_user_id: string | null;
  principal_member_id: string | null;
  principal_name: string | null;
  capacity_label: string | null;
  capacity_state: string | null;
  provisioning_label: string | null;
  provisioning_status: string | null;
  binding_ready: boolean | null;
  policy_revision: number | null;
  policy_operations: Record<string, unknown> | null;
}

interface SkillRow {
  id: string;
  agent_id: string;
  skill_key: string;
  skill_version: string;
  state: 'active' | 'paused';
}

/**
 * Agent ids the operator bound to this workspace in `HERMES_RUNTIME_AGENTS`.
 * Only the keys and the workspace are read: the base URL and key in each entry
 * are none of the directory's business.
 */
export function deploymentRuntimeAgentIds(raw: string | undefined, workspaceId: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? '');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();
    return new Set(Object.entries(parsed as Record<string, unknown>)
      .filter(([, entry]) => !!entry && typeof entry === 'object'
        && (entry as Record<string, unknown>).workspace_id === workspaceId)
      .map(([agentId]) => agentId));
  } catch {
    return new Set();
  }
}

export function runtimePlacement(row: Pick<AgentRow, 'capacity_label' | 'capacity_state' | 'provisioning_label' | 'provisioning_status' | 'binding_ready'>, deployment: boolean): AgentDirectoryRuntime {
  const source = row.capacity_label !== null ? 'cloud_capacity'
    : row.provisioning_label !== null ? 'cloud_provisioned'
      : deployment ? 'deployment' : 'none';
  let state: AgentDirectoryRuntime['state'] = 'setting_up';
  if (row.binding_ready === true || source === 'deployment') state = 'connected';
  else if (row.capacity_state === 'quarantined' || row.provisioning_status === 'failed') state = 'failed';
  else if (source === 'none') state = 'not_connected';
  return { source, label: row.capacity_label ?? row.provisioning_label ?? null, state };
}

export async function loadAgentDirectory(work: TenantWork, runtimeAgents: string | undefined): Promise<AgentDirectory> {
  const agents = await work.tx.query<AgentRow>(
    `SELECT a.id, a.name, a.responsibility, a.status, a.context_scope,
            om.id AS owner_member_id, om.user_id AS owner_user_id, COALESCE(ou.name, ou.email) AS owner_name,
            et.slug AS team_slug, et.name AS team_name, ta.role_template_key, ta.principal_user_id,
            pm.id AS principal_member_id, COALESCE(pu.name, pu.email) AS principal_name,
            cap.instance_name AS capacity_label, cap.state AS capacity_state,
            prov.instance_name AS provisioning_label, prov.status AS provisioning_status,
            (rb.ready_at IS NOT NULL) AS binding_ready,
            pol.revision AS policy_revision, pol.operations AS policy_operations
       FROM agents a
       LEFT JOIN agent_owners ao ON ao.workspace_id=a.workspace_id AND ao.agent_id=a.id
       LEFT JOIN members om ON om.workspace_id=ao.workspace_id AND om.id=ao.member_id
       LEFT JOIN users ou ON ou.id=om.user_id
       LEFT JOIN enterprise_team_agents ta ON ta.workspace_id=a.workspace_id AND ta.agent_id=a.id
       LEFT JOIN enterprise_teams et ON et.workspace_id=ta.workspace_id AND et.id=ta.team_id
       LEFT JOIN members pm ON pm.workspace_id=ta.workspace_id AND pm.user_id=ta.principal_user_id
       LEFT JOIN users pu ON pu.id=ta.principal_user_id
       LEFT JOIN LATERAL (
         SELECT c.instance_name, c.state FROM hermes_cloud_capacity c
          WHERE c.workspace_id=a.workspace_id AND c.assigned_agent_id=a.id
          ORDER BY c.assigned_at DESC NULLS LAST LIMIT 1
       ) cap ON true
       LEFT JOIN agent_provisioning prov ON prov.workspace_id=a.workspace_id AND prov.agent_id=a.id
       LEFT JOIN agent_runtime_bindings rb ON rb.workspace_id=a.workspace_id AND rb.agent_id=a.id
       LEFT JOIN agent_operation_policies pol ON pol.workspace_id=a.workspace_id AND pol.agent_id=a.id
      WHERE a.workspace_id=$1
      ORDER BY lower(a.name), a.id
      LIMIT 500`,
    [work.workspaceId],
  );
  const skills = await work.tx.query<SkillRow>(
    `SELECT id, agent_id, skill_key, skill_version, state
       FROM enterprise_skill_assignments WHERE workspace_id=$1 ORDER BY skill_key`,
    [work.workspaceId],
  );
  const deployment = deploymentRuntimeAgentIds(runtimeAgents, work.workspaceId);
  const items = [];
  for (const row of agents.rows) {
    // Sequential on purpose: one pg client serialises a transaction.
    const conversations = await hasAgentContextAccess(work, row.id);
    const operations = row.policy_operations ?? {};
    items.push({
      id: row.id,
      name: row.name,
      responsibility: row.responsibility,
      status: row.status,
      context_scope: row.context_scope,
      owner: row.owner_user_id
        ? { member_id: row.owner_member_id, user_id: row.owner_user_id, name: row.owner_name ?? 'Member' }
        : null,
      role: row.team_slug && row.team_name && row.role_template_key && row.principal_user_id
        ? {
          team: { slug: row.team_slug, name: row.team_name },
          role_template_key: row.role_template_key,
          principal: { member_id: row.principal_member_id, user_id: row.principal_user_id, name: row.principal_name ?? 'Member' },
        }
        : null,
      skills: skills.rows.filter((skill) => skill.agent_id === row.id).map((skill) => ({
        assignment_id: skill.id,
        skill_key: skill.skill_key,
        name: (enterpriseSkillDefinition(skill.skill_key, skill.skill_version) ?? ENTERPRISE_SKILL_REGISTRY.get(skill.skill_key))?.name ?? skill.skill_key,
        version: skill.skill_version,
        state: skill.state,
      })),
      runtime: runtimePlacement(row, deployment.has(row.id)),
      approvals: {
        revision: row.policy_revision ?? 0,
        required: AGENT_OPERATION_CATALOG.filter((operation) => operations[operation.id] === true)
          .map((operation) => ({ id: operation.id, label: operation.label })),
      },
      viewer: { can_configure: work.role === 'admin', can_view_conversations: conversations },
    });
  }
  return agentDirectorySchema.parse({ items, total: items.length });
}
