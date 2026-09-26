import runtimeContract from '../../../../runtime/hermes/contract.json';
import type { EnterpriseSkillAssignment } from '@hermes/shared';
import {
  assignmentToolNames,
  resolveEnterpriseSkillAssignment,
  type SkillQuery,
} from '../enterprise-skills/service.js';
import type { HermesEnterpriseReadiness } from './client.js';
import type { RuntimeSkillManifest } from './skills.js';
import {
  requireExactGrantMetadata,
  type DiscoveryGrantRow,
} from './discovery-grants.js';
import {
  enterpriseSkillDefinition,
  PARTNER_PROGRAM_DEFINITION,
  PARTNER_PROGRAM_TOOLS,
  toolsForSkillVersion,
} from '../enterprise-skills/registry.js';

/** The primary pin: what the local launcher installs and tests attest. */
export const HERMES_NATIVE_REVISION: string = runtimeContract.source_revision;
/**
 * Every official release the plugin is validated against. Hermes Cloud moves
 * an instance to the newest release on restart, so a runtime may attest any
 * listed revision, never an unlisted one.
 */
export const SUPPORTED_NATIVE_REVISIONS: ReadonlySet<string> = new Set(runtimeContract.supported_source_revisions);
export const ENTERPRISE_BRIDGE_VERSION = '1.7.0';
/** Exact native MCP name emitted by managed Partnerships profiles. */
export const AGENTCASH_MCP_TOOL = 'mcp__agentcash__fetch';
export const LEGACY_PARTNER_CONTENT_DIGEST =
  'sha256:cd26e70aa49de223f28216ea579d33c610305d3184a6c592c7841fa12aca6ddf';

export interface ManagedRuntimeIdentity {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly enterpriseUrl: string | undefined;
  readonly pluginRevision: string | undefined;
  readonly pluginArtifactDigest: string | undefined;
}

function cleanOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

const CURRENT_ASSIGNMENTS = new Map<string, { version: string; agentCash: boolean }>([
  ['partner-program-screening', { version: '1.8.0', agentCash: true }],
  ['partner-invoice-review', { version: '1.0.1', agentCash: false }],
]);

/** New multi-party assignments require the expanded, exact native inventory. */
export function requiresExactEnterpriseAttestation(assignment: EnterpriseSkillAssignment | null): boolean {
  if (!assignment) return false;
  const current = CURRENT_ASSIGNMENTS.get(assignment.skill_key);
  return current !== undefined && current.version === assignment.version;
}

/** Resolve the single configured role whose native inventory must be checked. */
export async function resolveEnterpriseReadinessAssignment(
  tx: SkillQuery,
  workspaceId: string,
  agentId: string,
): Promise<EnterpriseSkillAssignment | null> {
  const { rows } = await tx.query<{ skill_key: string }>(
    `SELECT skill_key FROM enterprise_skill_assignments
      WHERE workspace_id=$1 AND agent_id=$2 AND state='active' ORDER BY skill_key`,
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

function matchesManagedRuntimeIdentity(
  readiness: HermesEnterpriseReadiness,
  expected: ManagedRuntimeIdentity,
): boolean {
  return readiness.workspaceId === expected.workspaceId &&
    readiness.agentId === expected.agentId &&
    cleanOrigin(readiness.enterpriseUrl) !== null &&
    cleanOrigin(readiness.enterpriseUrl) === cleanOrigin(expected.enterpriseUrl) &&
    /^[0-9a-f]{40}$/.test(expected.pluginRevision ?? '') &&
    /^sha256:[0-9a-f]{64}$/.test(expected.pluginArtifactDigest ?? '') &&
    SUPPORTED_NATIVE_REVISIONS.has(readiness.runtimeRevision ?? '') &&
    readiness.plugin?.name === 'enterprise_bridge' &&
    readiness.plugin.version === ENTERPRISE_BRIDGE_VERSION &&
    readiness.plugin.revision === expected.pluginRevision &&
    readiness.plugin.artifactDigest === expected.pluginArtifactDigest &&
    readiness.version === ENTERPRISE_BRIDGE_VERSION &&
    readiness.nativeCronDisabled;
}

export function enterpriseReadinessToolNames(assignment: EnterpriseSkillAssignment): string[] {
  const definition = enterpriseSkillDefinition(assignment.skill_key, assignment.version);
  return [
    ...assignmentToolNames(assignment),
    'skill_view',
    ...(definition?.roleTemplateKey === 'partnerships-agent' ? [AGENTCASH_MCP_TOOL] : []),
  ];
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
      !SUPPORTED_NATIVE_REVISIONS.has(readiness.runtimeRevision ?? '') ||
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

/** Admission for a governed multi-party role must bind both halves of the
 * proof: the exact assignment inventory and the reviewed managed runtime
 * origin/plugin identity. A self-consistent skill/tool payload from an
 * unpinned or differently installed connector is not sufficient. */
export function matchesExactManagedEnterpriseAttestation(
  readiness: HermesEnterpriseReadiness,
  assignment: EnterpriseSkillAssignment | null,
  expected: ManagedRuntimeIdentity,
): boolean {
  return matchesManagedRuntimeIdentity(readiness, expected) &&
    matchesExactEnterpriseAttestation(readiness, assignment);
}

/** A promoted digest binding follows its current explicit assignment. The
 * common managed boot/source identity remains fixed while the reviewed role
 * can move from bootstrap P1.7 to P1.8 or Finance. */
export function matchesManagedRuntimeAttestation(
  readiness: HermesEnterpriseReadiness,
  expected: ManagedRuntimeIdentity,
  manifests: readonly RuntimeSkillManifest[],
): boolean {
  if (!matchesManagedRuntimeIdentity(readiness, expected) || manifests.length !== 1 ||
      !readiness.skills || readiness.skills.length !== 1 || !readiness.toolNames) return false;
  const manifest = manifests[0]!;
  const definition = enterpriseSkillDefinition(manifest.skill_key, manifest.version);
  if (!definition || manifest.binding_source !== 'enterprise_assignment' ||
      !Number.isInteger(manifest.assignment_revision) || (manifest.assignment_revision ?? 0) < 1 ||
      manifest.grant_revision !== null || manifest.binding_state !== null ||
      manifest.grant_expires_at !== null || manifest.state !== 'active' || manifest.auto_load !== true ||
      manifest.name !== definition.runtimeName || manifest.runtime_name !== definition.runtimeName ||
      manifest.artifact_digest !== definition.artifactDigest) return false;
  const expectsAgentCash = definition.roleTemplateKey === 'partnerships-agent';
  const skill = readiness.skills[0]!;
  const expectedContentDigest = manifest.skill_key === PARTNER_PROGRAM_DEFINITION.key &&
      manifest.version === PARTNER_PROGRAM_DEFINITION.version
    ? LEGACY_PARTNER_CONTENT_DIGEST
    : manifest.artifact_digest;
  const expectedTools = [
    ...toolsForSkillVersion(manifest.skill_key, manifest.version, manifest.capability_grants),
    'skill_view',
    ...(definition.roleTemplateKey === 'partnerships-agent' ? [AGENTCASH_MCP_TOOL] : []),
  ];
  return readiness.agentCashEnabled === expectsAgentCash &&
    readiness.agentCashWalletPresent === expectsAgentCash &&
    skill.name === manifest.runtime_name && skill.version === manifest.version &&
    skill.artifactDigest === manifest.artifact_digest &&
    skill.contentDigest === expectedContentDigest &&
    sameNames(readiness.toolNames, expectedTools);
}

/** Exact managed readiness for an unowned warm profile. The discovery grant is
 * the role/profile authority until acceptance atomically promotes the same
 * config and manifest to an Enterprise assignment. */
export function matchesManagedDiscoveryGrantAttestation(
  readiness: HermesEnterpriseReadiness,
  grant: DiscoveryGrantRow,
  expected: ManagedRuntimeIdentity,
): boolean {
  let descriptor;
  try {
    descriptor = requireExactGrantMetadata(grant);
  } catch {
    return false;
  }
  if (!matchesManagedRuntimeIdentity(readiness, expected) ||
      !readiness.skills || readiness.skills.length !== 1 || !readiness.toolNames ||
      grant.grant_revision !== 1 || grant.revoked_at !== null || grant.consumed_at !== null) return false;
  const definition = descriptor.definition;
  const skill = readiness.skills[0]!;
  const expectedContentDigest = definition.key === PARTNER_PROGRAM_DEFINITION.key &&
      definition.version === PARTNER_PROGRAM_DEFINITION.version
    ? LEGACY_PARTNER_CONTENT_DIGEST
    : definition.artifactDigest;
  const expectedTools = [
    ...toolsForSkillVersion(definition.key, definition.version, definition.defaultCapabilityGrants),
    'skill_view',
    ...(descriptor.expectsAgentCash ? [AGENTCASH_MCP_TOOL] : []),
  ];
  return readiness.agentCashEnabled === descriptor.expectsAgentCash &&
    readiness.agentCashWalletPresent === descriptor.expectsAgentCash &&
    readiness.nativeCronDisabled &&
    skill.name === definition.runtimeName && skill.version === definition.version &&
    skill.artifactDigest === definition.artifactDigest &&
    skill.contentDigest === expectedContentDigest &&
    sameNames(readiness.toolNames, expectedTools);
}

/** New warm capacity must prove the complete historical P1.7 inventory. This
 * deliberately does not replace the looser legacy matcher used by the already
 * deployed Iris profile. */
export function matchesLegacyCapacityAttestation(
  readiness: HermesEnterpriseReadiness,
  expected?: ManagedRuntimeIdentity,
): boolean {
  const expectedTools = [...PARTNER_PROGRAM_TOOLS, 'skill_view', AGENTCASH_MCP_TOOL];
  return (!expected || matchesManagedRuntimeIdentity(readiness, expected)) &&
    SUPPORTED_NATIVE_REVISIONS.has(readiness.runtimeRevision ?? '') &&
    readiness.plugin?.name === 'enterprise_bridge' &&
    readiness.plugin.version === ENTERPRISE_BRIDGE_VERSION &&
    readiness.version === ENTERPRISE_BRIDGE_VERSION &&
    readiness.nativeCronDisabled &&
    readiness.agentCashEnabled &&
    readiness.agentCashWalletPresent &&
    readiness.skills?.length === 1 &&
    readiness.skills[0]?.name === PARTNER_PROGRAM_DEFINITION.runtimeName &&
    readiness.skills[0]?.version === PARTNER_PROGRAM_DEFINITION.version &&
    readiness.skills[0]?.artifactDigest === PARTNER_PROGRAM_DEFINITION.artifactDigest &&
    readiness.skills[0]?.contentDigest === LEGACY_PARTNER_CONTENT_DIGEST &&
    readiness.toolNames !== null && sameNames(readiness.toolNames, expectedTools);
}
