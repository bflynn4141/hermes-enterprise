import { enterpriseSkillAssignmentSchema, enterpriseSkillScheduleSchema, type EnterpriseSkillAssignment } from '@hermes/shared';
import type { QueryResultRow } from 'pg';
import type { Env } from '../env.js';
import { partnerAgentConfig, type PartnerAgentConfig } from '../partner-screening/config.js';
import {
  ENTERPRISE_SKILL_REGISTRY,
  enterpriseSkillDefinition,
  PARTNER_INVOICE_REVIEW_DEFINITION,
  PARTNER_PROGRAM_DEFINITION,
  toolsForSkillVersion,
  type EnterpriseSkillDefinition,
} from './registry.js';

interface AssignmentRow extends QueryResultRow {
  id: string;
  agent_id: string;
  agent_name?: string | null;
  team_id?: string | null;
  team_slug?: string | null;
  team_name?: string | null;
  artifact_id?: string | null;
  artifact_digest?: string | null;
  skill_key: string;
  skill_version: string;
  state: 'active' | 'paused';
  config: Record<string, unknown>;
  capability_grants: string[];
  schedule: unknown;
  approval_policy: Record<string, unknown>;
  revision: number;
  updated_at: Date | string;
}

export interface SkillQuery {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface ResolvedSkillAssignment {
  readonly assignment: EnterpriseSkillAssignment | null;
  readonly config: PartnerAgentConfig | null;
  readonly problem: string | null;
  readonly source: 'assignment' | 'legacy' | 'none';
}

export interface ResolvedEnterpriseSkillAssignment {
  readonly assignment: EnterpriseSkillAssignment | null;
  readonly config: Record<string, unknown> | null;
  readonly problem: string | null;
}

const ASSIGNMENT_COLUMNS = `
  esa.id, esa.agent_id, a.name AS agent_name,
  esa.team_id, et.slug AS team_slug, et.name AS team_name,
  esa.artifact_id, art.digest AS artifact_digest,
  esa.skill_key, esa.skill_version, esa.state, esa.config, esa.capability_grants,
  esa.schedule, esa.approval_policy, esa.revision, esa.updated_at`;

const ASSIGNMENT_FROM = `
  FROM enterprise_skill_assignments esa
  JOIN agents a ON a.workspace_id=esa.workspace_id AND a.id=esa.agent_id
  LEFT JOIN enterprise_teams et ON et.workspace_id=esa.workspace_id AND et.id=esa.team_id
  LEFT JOIN enterprise_skill_artifacts art ON art.id=esa.artifact_id`;

const SELECT_ASSIGNMENT = `
  SELECT ${ASSIGNMENT_COLUMNS}
  ${ASSIGNMENT_FROM}
  WHERE esa.workspace_id=$1 AND esa.agent_id=$2 AND esa.skill_key=$3`;

function publicAssignment(row: AssignmentRow, definition: EnterpriseSkillDefinition<Record<string, unknown>>): EnterpriseSkillAssignment {
  const schedule = enterpriseSkillScheduleSchema.parse(row.schedule);
  return enterpriseSkillAssignmentSchema.parse({
    id: row.id,
    agent_id: row.agent_id,
    agent_name: row.agent_name ?? null,
    team: row.team_id && row.team_slug && row.team_name
      ? { id: row.team_id, slug: row.team_slug, name: row.team_name }
      : null,
    skill_key: row.skill_key,
    runtime_name: definition.runtimeName,
    name: definition.name,
    version: row.skill_version,
    artifact_digest: row.artifact_digest ?? null,
    description: definition.description,
    state: row.state,
    revision: row.revision,
    config: row.config,
    capability_grants: row.capability_grants,
    schedule,
    human_review_required: row.approval_policy.human_review_required === true,
    config_fields: definition.configFields,
    updated_at: new Date(row.updated_at).toISOString(),
  });
}

async function selectAssignment(tx: SkillQuery, workspaceId: string, agentId: string, skillKey: string): Promise<AssignmentRow | null> {
  const { rows } = await tx.query<AssignmentRow>(SELECT_ASSIGNMENT, [workspaceId, agentId, skillKey]);
  return rows[0] ?? null;
}

async function hasEnterpriseGovernance(tx: SkillQuery, workspaceId: string, agentId: string): Promise<boolean> {
  const { rows } = await tx.query<{ governed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM enterprise_skill_assignments
        WHERE workspace_id=$1 AND agent_id=$2
       UNION ALL
       SELECT 1 FROM enterprise_team_agents
        WHERE workspace_id=$1 AND agent_id=$2
     ) AS governed`,
    [workspaceId, agentId],
  );
  return rows[0]?.governed === true;
}

async function insertRevision(tx: SkillQuery, workspaceId: string, row: AssignmentRow, changedBy: string | null): Promise<void> {
  await tx.query(
    `INSERT INTO enterprise_skill_assignment_revisions
       (assignment_id, workspace_id, revision, skill_version, state, config,
        capability_grants, schedule, approval_policy, team_id, artifact_id, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
     ON CONFLICT (assignment_id, revision) DO NOTHING`,
    [row.id, workspaceId, row.revision, row.skill_version, row.state, JSON.stringify(row.config),
      row.capability_grants, JSON.stringify(row.schedule), JSON.stringify(row.approval_policy),
      row.team_id ?? null, row.artifact_id ?? null, changedBy],
  );
}

function assignmentProblem(
  row: AssignmentRow,
  definition: EnterpriseSkillDefinition<Record<string, unknown>>,
): string | null {
  if (row.skill_version !== definition.version) return `Unsupported ${definition.name} version ${row.skill_version}.`;
  if (row.artifact_id && row.artifact_digest !== definition.artifactDigest) {
    return `The ${definition.name} artifact does not match its immutable registry digest.`;
  }
  if (definition.key === PARTNER_INVOICE_REVIEW_DEFINITION.key && !row.artifact_id) {
    return 'The Partner invoice review assignment has no immutable artifact identity.';
  }
  return null;
}

/**
 * Explicit compatibility migration for an execution/setup path. Read routes do
 * not call this function: viewing Skills or source status cannot create
 * authority or turn on a schedule.
 */
export async function materializeLegacyPartnerAssignment(
  env: Env,
  tx: SkillQuery,
  workspaceId: string,
  agentId: string,
  assignedBy: string | null,
  options: { scheduleEnabled?: boolean } = {},
): Promise<EnterpriseSkillAssignment | null> {
  const existing = await selectAssignment(tx, workspaceId, agentId, PARTNER_PROGRAM_DEFINITION.key);
  if (existing) return publicAssignment(existing, PARTNER_PROGRAM_DEFINITION);
  // The deployment-wide legacy policy exists only for ungoverned rollout
  // agents. It must never add Partnerships authority to an agent that already
  // has an explicit Enterprise role or another reviewed skill assignment.
  if (await hasEnterpriseGovernance(tx, workspaceId, agentId)) return null;
  const legacy = partnerAgentConfig(env, agentId);
  if (!legacy.config) return null;
  const schedule = { enabled: options.scheduleEnabled ?? true, interval_minutes: 360 };
  const approvalPolicy = { human_review_required: true };
  const artifact = await tx.query<{ id: string }>(
    `SELECT id FROM enterprise_skill_artifacts
      WHERE skill_key=$1 AND skill_version=$2 AND digest=$3`,
    [PARTNER_PROGRAM_DEFINITION.key, PARTNER_PROGRAM_DEFINITION.version,
      PARTNER_PROGRAM_DEFINITION.artifactDigest],
  );
  const artifactId = artifact.rows[0]?.id;
  if (!artifactId) throw new Error('legacy_partner_artifact_not_found');
  await tx.query(
    `INSERT INTO enterprise_skill_assignments
       (workspace_id, agent_id, skill_key, skill_version, state, config,
        capability_grants, schedule, approval_policy, artifact_id, assigned_by)
     VALUES ($1,$2,$3,$4,'active',$5::jsonb,$6,$7::jsonb,$8::jsonb,$9,$10)
     ON CONFLICT (workspace_id, agent_id, skill_key) DO NOTHING`,
    [workspaceId, agentId, PARTNER_PROGRAM_DEFINITION.key, PARTNER_PROGRAM_DEFINITION.version,
      JSON.stringify(legacy.config), [...PARTNER_PROGRAM_DEFINITION.defaultCapabilityGrants],
      JSON.stringify(schedule), JSON.stringify(approvalPolicy), artifactId, assignedBy],
  );
  const row = await selectAssignment(tx, workspaceId, agentId, PARTNER_PROGRAM_DEFINITION.key);
  if (!row) return null;
  await insertRevision(tx, workspaceId, row, assignedBy);
  return publicAssignment(row, PARTNER_PROGRAM_DEFINITION);
}

export async function listEnterpriseSkillAssignments(
  _env: Env,
  tx: SkillQuery,
  workspaceId: string,
  agentId: string,
  _assignedBy: string | null,
): Promise<EnterpriseSkillAssignment[]> {
  const { rows } = await tx.query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_COLUMNS}
       ${ASSIGNMENT_FROM}
      WHERE esa.workspace_id=$1 AND esa.agent_id=$2 ORDER BY esa.skill_key`,
    [workspaceId, agentId],
  );
  return rows.flatMap((row) => {
    const definition = enterpriseSkillDefinition(row.skill_key, row.skill_version);
    return definition ? [publicAssignment(row, definition)] : [];
  });
}

export async function resolveEnterpriseSkillAssignment(
  tx: SkillQuery,
  workspaceId: string,
  agentId: string,
  skillKey: string,
): Promise<ResolvedEnterpriseSkillAssignment> {
  const fallbackDefinition = ENTERPRISE_SKILL_REGISTRY.get(skillKey);
  if (!fallbackDefinition) return { assignment: null, config: null, problem: 'This enterprise skill is not supported.' };
  const row = await selectAssignment(tx, workspaceId, agentId, skillKey);
  if (!row) return { assignment: null, config: null, problem: `${fallbackDefinition.name} is not assigned.` };
  const definition = enterpriseSkillDefinition(row.skill_key, row.skill_version);
  if (!definition) return { assignment: null, config: null, problem: `Unsupported ${fallbackDefinition.name} version ${row.skill_version}.` };
  const assignment = publicAssignment(row, definition);
  if (row.state === 'paused') return { assignment, config: null, problem: `${definition.name} is paused.` };
  const identityProblem = assignmentProblem(row, definition);
  if (identityProblem) return { assignment, config: null, problem: identityProblem };
  const parsed = definition.configSchema.safeParse(row.config);
  if (!parsed.success) return { assignment, config: null, problem: `The assigned ${definition.name} configuration is invalid.` };
  return { assignment, config: parsed.data, problem: null };
}

export async function resolvePartnerSkillAssignment(
  env: Env,
  tx: SkillQuery,
  workspaceId: string,
  agentId: string,
  options: { materialize?: boolean; assignedBy?: string | null } = {},
): Promise<ResolvedSkillAssignment> {
  let row = await selectAssignment(tx, workspaceId, agentId, PARTNER_PROGRAM_DEFINITION.key);
  if (!row && options.materialize) {
    await materializeLegacyPartnerAssignment(env, tx, workspaceId, agentId, options.assignedBy ?? null);
    row = await selectAssignment(tx, workspaceId, agentId, PARTNER_PROGRAM_DEFINITION.key);
  }
  if (!row) {
    if (await hasEnterpriseGovernance(tx, workspaceId, agentId)) {
      return { assignment: null, config: null, problem: 'Partner screening is not assigned to this Enterprise agent.', source: 'none' };
    }
    const legacy = partnerAgentConfig(env, agentId);
    return { assignment: null, config: legacy.config, problem: legacy.problem, source: legacy.config ? 'legacy' : 'none' };
  }
  const definition = enterpriseSkillDefinition(row.skill_key, row.skill_version);
  if (!definition) return { assignment: null, config: null, problem: `Unsupported Partner Program version ${row.skill_version}.`, source: 'assignment' };
  const assignment = publicAssignment(row, definition);
  if (row.state === 'paused') return { assignment, config: null, problem: 'Partner screening is paused.', source: 'assignment' };
  const identityProblem = assignmentProblem(row, definition);
  if (identityProblem) return { assignment, config: null, problem: identityProblem, source: 'assignment' };
  const parsed = definition.configSchema.safeParse(row.config);
  if (!parsed.success) return { assignment, config: null, problem: 'The assigned Partner Program skill configuration is invalid.', source: 'assignment' };
  return { assignment, config: parsed.data as PartnerAgentConfig, problem: null, source: 'assignment' };
}

export async function updateEnterpriseSkillAssignment(
  tx: SkillQuery,
  workspaceId: string,
  agentId: string,
  assignmentId: string,
  changedBy: string,
  patch: { revision: number; state?: 'active' | 'paused'; config?: Record<string, unknown>; schedule?: { enabled: boolean; interval_minutes: number } },
): Promise<EnterpriseSkillAssignment> {
  const locked = await tx.query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_COLUMNS}
       ${ASSIGNMENT_FROM}
      WHERE esa.workspace_id=$1 AND esa.agent_id=$2 AND esa.id=$3 FOR UPDATE OF esa`,
    [workspaceId, agentId, assignmentId],
  );
  const current = locked.rows[0];
  if (!current) throw new Error('enterprise_skill_assignment_not_found');
  if (current.revision !== patch.revision) throw new Error('enterprise_skill_assignment_stale');
  const definition = enterpriseSkillDefinition(current.skill_key, current.skill_version);
  if (!definition) throw new Error('enterprise_skill_not_supported');
  const config = patch.config === undefined ? current.config : definition.configSchema.parse(patch.config);
  const schedule = patch.schedule === undefined ? enterpriseSkillScheduleSchema.parse(current.schedule) : enterpriseSkillScheduleSchema.parse(patch.schedule);
  const state = patch.state ?? current.state;
  await tx.query(
    `UPDATE enterprise_skill_assignments
        SET state=$4, config=$5::jsonb, schedule=$6::jsonb, revision=revision+1
      WHERE workspace_id=$1 AND agent_id=$2 AND id=$3`,
    [workspaceId, agentId, assignmentId, state, JSON.stringify(config), JSON.stringify(schedule)],
  );
  const updated = await selectAssignment(tx, workspaceId, agentId, current.skill_key);
  if (!updated) throw new Error('enterprise_skill_assignment_not_found');
  await insertRevision(tx, workspaceId, updated, changedBy);
  return publicAssignment(updated, definition);
}

export function assignmentToolNames(assignment: EnterpriseSkillAssignment | null): string[] {
  return assignment?.state === 'active'
    ? toolsForSkillVersion(assignment.skill_key, assignment.version, assignment.capability_grants)
    : [];
}
