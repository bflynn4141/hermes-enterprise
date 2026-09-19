import type { EnterpriseSkillAssignment } from '@hermes/shared';
import {
  assignmentToolNames,
  resolveEnterpriseSkillAssignment,
  type SkillQuery,
} from '../enterprise-skills/service.js';
import type { HermesEnterpriseReadiness } from './client.js';

export const HERMES_NATIVE_REVISION = '5d59366010640c1d6b8f170d8a4ee109db2bbdef';
export const ENTERPRISE_BRIDGE_VERSION = '1.7.0';

const CURRENT_ASSIGNMENTS = new Map<string, { version: string; agentCash: boolean }>([
  ['partner-program-screening', { version: '1.8.0', agentCash: true }],
  ['partner-invoice-review', { version: '1.0.1', agentCash: false }],
]);

/** New multi-party assignments require the expanded, exact native inventory. */
export function requiresExactEnterpriseAttestation(assignment: EnterpriseSkillAssignment | null): boolean {
  const current = assignment && CURRENT_ASSIGNMENTS.get(assignment.skill_key);
  return current?.version === assignment?.version;
}

/** Resolve the single configured role whose native inventory must be checked. */
export async function resolveEnterpriseReadinessAssignment(
  tx: SkillQuery,
  workspaceId: string,
  agentId: string,
): Promise<EnterpriseSkillAssignment | null> {
  const { rows } = await tx.query<{ skill_key: string }>(
    `SELECT skill_key FROM enterprise_skill_assignments
      WHERE workspace_id=$1 AND agent_id=$2 ORDER BY skill_key`,
    [workspaceId, agentId],
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new Error('enterprise_profile_has_ambiguous_skill_assignments');
  const resolved = await resolveEnterpriseSkillAssignment(tx, workspaceId, agentId, rows[0]!.skill_key);
  if (!resolved.assignment || resolved.problem || !resolved.config) {
    throw new Error('enterprise_profile_skill_assignment_inactive');
  }
  return resolved.assignment;
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((name) => actual.includes(name));
}

export function enterpriseReadinessToolNames(assignment: EnterpriseSkillAssignment): string[] {
  return [...assignmentToolNames(assignment), 'skill_view'];
}

/**
 * Validate native readiness for one resolved assignment. Legacy/unassigned
 * provisioning retains its existing AgentCash contract; it never satisfies
 * this function's exact multi-party branch.
 */
export function matchesEnterpriseReadiness(
  readiness: HermesEnterpriseReadiness,
  assignment: EnterpriseSkillAssignment | null,
): boolean {
  const current = assignment && CURRENT_ASSIGNMENTS.get(assignment.skill_key);
  if (!assignment || current?.version !== assignment.version) {
    return readiness.nativeCronDisabled && readiness.agentCashEnabled && readiness.agentCashWalletPresent;
  }
  if (!assignment.artifact_digest || assignment.state !== 'active' ||
      readiness.runtimeRevision !== HERMES_NATIVE_REVISION ||
      readiness.plugin?.name !== 'enterprise_bridge' ||
      readiness.plugin.version !== ENTERPRISE_BRIDGE_VERSION ||
      readiness.version !== ENTERPRISE_BRIDGE_VERSION ||
      !readiness.nativeCronDisabled || readiness.agentCashEnabled !== current.agentCash ||
      readiness.agentCashWalletPresent !== current.agentCash ||
      !readiness.skills || !readiness.toolNames) {
    return false;
  }
  const expectedTools = enterpriseReadinessToolNames(assignment);
  return readiness.skills.length === 1 &&
    readiness.skills[0]?.name === assignment.runtime_name &&
    readiness.skills[0]?.version === assignment.version &&
    readiness.skills[0]?.artifactDigest === assignment.artifact_digest &&
    readiness.skills[0]?.contentDigest === assignment.artifact_digest &&
    sameNames(readiness.toolNames, expectedTools);
}

/** Admission gate for the new workflow; legacy compatibility can never pass. */
export function matchesExactEnterpriseAttestation(
  readiness: HermesEnterpriseReadiness,
  assignment: EnterpriseSkillAssignment | null,
): boolean {
  return requiresExactEnterpriseAttestation(assignment) &&
    matchesEnterpriseReadiness(readiness, assignment);
}
