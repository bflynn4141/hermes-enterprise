import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { PARTNER_PROGRAM_DEFINITION } from '../enterprise-skills/registry.js';
import { resolvePartnerSkillAssignment } from '../enterprise-skills/service.js';
import { RouteError } from '../routes/tenant.js';
import { requireDynamicBridgeAuth, requireResolvedBridgeAuth, type RuntimeBinding } from './config.js';
import { requireDigestBearer } from './credentials.js';

export const DISCOVERY_GRANT_TTL_MS = 24 * 60 * 60 * 1000;
export interface DiscoveryGrantRow {
  id: string;
  workspace_id: string;
  agent_id: string;
  credential_digest: Uint8Array;
  role_template_key: 'partnerships-agent';
  skill_key: 'partner-program-screening';
  skill_version: '1.7.0';
  runtime_name: 'enterprise_bridge:partner-program-screening';
  artifact_digest: string;
  assignment_id: string | null;
  assignment_revision: number | null;
  config_digest: string;
  grant_revision: number;
  linked_capacity_id: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  consumed_at: Date | null;
  capacity_state: 'available' | 'reserved' | 'assigning' | 'assigned' | 'quarantined' | null;
}

export interface DiscoveryContext {
  readonly kind: 'preflight_grant';
  readonly grant: DiscoveryGrantRow;
  readonly config: Readonly<Record<string, unknown>>;
}

export type RuntimeDiscoveryAuthorization =
  | DiscoveryContext
  | { readonly kind: 'runtime_binding'; readonly binding: RuntimeBinding };

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function discoveryConfigDigest(config: Readonly<Record<string, unknown>>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(config)));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function exactLegacyDiscoveryConfig(
  env: Env,
  tx: Pick<Tx, 'query'>,
  workspaceId: string,
  agentId: string,
): Promise<{
  config: Readonly<Record<string, unknown>>;
  assignmentId: string | null;
  assignmentRevision: number | null;
  configDigest: string;
}> {
  const resolved = await resolvePartnerSkillAssignment(env, tx, workspaceId, agentId);
  if (!resolved.config || resolved.problem ||
      (resolved.assignment !== null && (
        resolved.assignment.skill_key !== PARTNER_PROGRAM_DEFINITION.key ||
        resolved.assignment.version !== PARTNER_PROGRAM_DEFINITION.version ||
        resolved.assignment.runtime_name !== PARTNER_PROGRAM_DEFINITION.runtimeName ||
        resolved.assignment.artifact_digest !== PARTNER_PROGRAM_DEFINITION.artifactDigest ||
        resolved.assignment.state !== 'active' ||
        resolved.assignment.capability_grants.length !== PARTNER_PROGRAM_DEFINITION.defaultCapabilityGrants.length ||
        new Set(resolved.assignment.capability_grants).size !== resolved.assignment.capability_grants.length ||
        !PARTNER_PROGRAM_DEFINITION.defaultCapabilityGrants.every((grant) =>
          resolved.assignment!.capability_grants.includes(grant))
      ))) {
    throw new RouteError(
      'This identity does not have the reviewed legacy Partnerships profile required for discovery.',
      'discovery_profile_mismatch',
      409,
    );
  }
  return {
    config: resolved.config,
    assignmentId: resolved.assignment?.id ?? null,
    assignmentRevision: resolved.assignment?.revision ?? null,
    configDigest: await discoveryConfigDigest({
      role_template_key: PARTNER_PROGRAM_DEFINITION.roleTemplateKey,
      config: resolved.config,
    }),
  };
}

function requireExactGrantMetadata(grant: DiscoveryGrantRow): void {
  if (grant.role_template_key !== PARTNER_PROGRAM_DEFINITION.roleTemplateKey ||
      grant.skill_key !== PARTNER_PROGRAM_DEFINITION.key ||
      grant.skill_version !== PARTNER_PROGRAM_DEFINITION.version ||
      grant.runtime_name !== PARTNER_PROGRAM_DEFINITION.runtimeName ||
      grant.artifact_digest !== PARTNER_PROGRAM_DEFINITION.artifactDigest) {
    throw new RouteError(
      'The reviewed discovery profile changed. Revoke and prepare a new credential.',
      'discovery_profile_changed',
      409,
    );
  }
}

async function latestGrant(
  tx: Pick<Tx, 'query'>,
  workspaceId: string,
  agentId: string,
): Promise<DiscoveryGrantRow | null> {
  const { rows } = await tx.query<DiscoveryGrantRow>(
    `SELECT g.id, g.workspace_id, g.agent_id, g.credential_digest,
            g.role_template_key, g.skill_key, g.skill_version, g.runtime_name,
            g.artifact_digest, g.assignment_id, g.assignment_revision,
            g.config_digest, g.grant_revision, g.linked_capacity_id,
            g.expires_at, g.revoked_at, g.consumed_at, c.state AS capacity_state
       FROM runtime_discovery_grants g
       LEFT JOIN hermes_cloud_capacity c
         ON c.workspace_id=g.workspace_id AND c.id=g.linked_capacity_id
      WHERE g.workspace_id=$1 AND g.agent_id=$2
      ORDER BY g.created_at DESC LIMIT 1`,
    [workspaceId, agentId],
  );
  return rows[0] ?? null;
}

function grantIsUsable(grant: DiscoveryGrantRow, now = new Date()): boolean {
  if (grant.revoked_at || grant.consumed_at) return false;
  if (!grant.linked_capacity_id) return Boolean(grant.expires_at && grant.expires_at > now);
  return grant.expires_at === null && ['available', 'reserved'].includes(grant.capacity_state ?? '');
}

export async function requireCurrentGrantConfig(
  env: Env,
  tx: Pick<Tx, 'query'>,
  grant: DiscoveryGrantRow,
  options: { allowLegacyAssignmentPromotion?: boolean } = {},
): Promise<Readonly<Record<string, unknown>>> {
  requireExactGrantMetadata(grant);
  const current = await exactLegacyDiscoveryConfig(env, tx, grant.workspace_id, grant.agent_id);
  const exactSnapshot = current.assignmentId === grant.assignment_id &&
    current.assignmentRevision === grant.assignment_revision &&
    current.configDigest === grant.config_digest;
  const exactFirstMaterialization = options.allowLegacyAssignmentPromotion === true &&
    grant.assignment_id === null && grant.assignment_revision === null &&
    current.assignmentId !== null && current.assignmentRevision === 1 &&
    current.configDigest === grant.config_digest;
  if (!exactSnapshot && !exactFirstMaterialization) {
    throw new RouteError(
      'The reviewed discovery profile changed. Revoke and prepare a new credential.',
      'discovery_profile_changed',
      409,
    );
  }
  if (exactFirstMaterialization) {
    const promoted = await tx.query(
      `UPDATE runtime_discovery_grants
          SET assignment_id=$3, assignment_revision=$4
        WHERE workspace_id=$1 AND id=$2
          AND assignment_id IS NULL AND assignment_revision IS NULL
          AND revoked_at IS NULL AND consumed_at IS NULL`,
      [grant.workspace_id, grant.id, current.assignmentId, current.assignmentRevision],
    );
    if (promoted.rowCount !== 1) throw new RouteError(
      'The reviewed discovery profile changed. Revoke and prepare a new credential.',
      'discovery_profile_changed',
      409,
    );
    grant.assignment_id = current.assignmentId;
    grant.assignment_revision = current.assignmentRevision;
  }
  return current.config;
}

/** GET /skills and GET /tools are the only routes that call this fallback.
 * Every other native route continues to require a ready runtime binding. */
export async function requireRuntimeDiscoveryAuth(
  env: Env,
  tx: Pick<Tx, 'query'>,
  workspaceId: string,
  agentId: string,
  authorization: string | null,
): Promise<RuntimeDiscoveryAuthorization> {
  const grant = await latestGrant(tx, workspaceId, agentId);
  const identity = await tx.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM agents WHERE workspace_id=$1 AND id=$2
     ) AS exists`,
    [workspaceId, agentId],
  );
  if (identity.rows[0]?.exists) {
    return { kind: 'runtime_binding', binding: await requireResolvedBridgeAuth(
      env, tx, workspaceId, agentId, authorization,
    ) };
  }
  if (!grant) {
    return { kind: 'runtime_binding', binding: await requireResolvedBridgeAuth(
      env, tx, workspaceId, agentId, authorization,
    ) };
  }
  if (grant.consumed_at) {
    return { kind: 'runtime_binding', binding: await requireDynamicBridgeAuth(
      env, tx, workspaceId, agentId, authorization,
    ) };
  }
  if (!grantIsUsable(grant)) {
    throw new RouteError('Invalid runtime credential.', 'runtime_unauthorized', 403);
  }
  await requireDigestBearer(grant.credential_digest, workspaceId, agentId, authorization);
  return { kind: 'preflight_grant', grant, config: await requireCurrentGrantConfig(env, tx, grant) };
}

export async function lockCurrentPreparedGrant(
  env: Env,
  tx: Tx,
  workspaceId: string,
  agentId: string,
  grantId: string,
): Promise<{ grant: DiscoveryGrantRow; config: Readonly<Record<string, unknown>> }> {
  const { rows } = await tx.query<DiscoveryGrantRow>(
    `SELECT g.id, g.workspace_id, g.agent_id, g.credential_digest,
            g.role_template_key, g.skill_key, g.skill_version, g.runtime_name,
            g.artifact_digest, g.assignment_id, g.assignment_revision,
            g.config_digest, g.grant_revision, g.linked_capacity_id,
            g.expires_at, g.revoked_at, g.consumed_at, NULL::text AS capacity_state
       FROM runtime_discovery_grants g
      WHERE g.workspace_id=$1 AND g.agent_id=$2 AND g.id=$3
      FOR UPDATE`,
    [workspaceId, agentId, grantId],
  );
  const grant = rows[0];
  if (!grant || grant.linked_capacity_id || grant.revoked_at || grant.consumed_at ||
      !grant.expires_at || grant.expires_at <= new Date()) {
    throw new RouteError('The discovery credential is no longer available.', 'discovery_grant_unavailable', 409);
  }
  return { grant, config: await requireCurrentGrantConfig(env, tx, grant) };
}
