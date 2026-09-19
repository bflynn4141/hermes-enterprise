// Enterprise-owned Hermes skills. The procedure remains a standard bundled
// Hermes skill. Enterprise stores only the per-agent assignment: validated
// non-secret config, semantic capability grants, schedule and review policy.
import type { EnterpriseSkillAssignment } from '@hermes/shared';
import type { Env } from '../env.js';
import { partnerAgentConfig } from '../partner-screening/config.js';
import {
  PARTNER_INVOICE_REVIEW_DEFINITION,
  PARTNER_PROGRAM_DEFINITION,
  PARTNER_PROGRAM_SKILL,
  PARTNER_PROGRAM_TOOLS,
} from '../enterprise-skills/registry.js';
import { resolveEnterpriseSkillAssignment, resolvePartnerSkillAssignment } from '../enterprise-skills/service.js';
import type { SkillQuery } from '../enterprise-skills/service.js';
import type { RuntimeDb } from './store.js';

export { PARTNER_PROGRAM_SKILL, PARTNER_PROGRAM_TOOLS };

export interface RuntimeSkillManifest {
  readonly name: string;
  readonly skill_key: string;
  readonly runtime_name: string;
  readonly version: string;
  readonly artifact_digest: string;
  readonly state: 'active';
  readonly assignment_revision: number | null;
  readonly grant_revision: number | null;
  readonly binding_source: 'enterprise_assignment' | 'legacy_config' | 'preflight_grant';
  readonly binding_state: 'prepared' | 'linked_available' | 'linked_reserved' | null;
  readonly grant_expires_at: string | null;
  readonly capability_grants: readonly string[];
  readonly auto_load: true;
  readonly config: Readonly<Record<string, unknown>>;
}

function partnerManifest(
  config: Record<string, unknown>,
  assignment?: EnterpriseSkillAssignment | null,
  preflight?: {
    grantRevision: number;
    assignmentRevision: number | null;
    linkedCapacityId: string | null;
    capacityState: string | null;
    expiresAt: Date | null;
  },
): RuntimeSkillManifest {
  const runtimeName = assignment?.runtime_name ?? PARTNER_PROGRAM_DEFINITION.runtimeName;
  return {
    name: runtimeName,
    skill_key: PARTNER_PROGRAM_DEFINITION.key,
    runtime_name: runtimeName,
    version: assignment?.version ?? PARTNER_PROGRAM_DEFINITION.version,
    artifact_digest: assignment?.artifact_digest ?? PARTNER_PROGRAM_DEFINITION.artifactDigest,
    state: 'active',
    assignment_revision: preflight?.assignmentRevision ?? assignment?.revision ?? null,
    grant_revision: preflight?.grantRevision ?? null,
    binding_source: preflight ? 'preflight_grant' : assignment ? 'enterprise_assignment' : 'legacy_config',
    binding_state: preflight
      ? preflight.linkedCapacityId
        ? preflight.capacityState === 'reserved' ? 'linked_reserved' : 'linked_available'
        : 'prepared'
      : null,
    grant_expires_at: preflight?.expiresAt?.toISOString() ?? null,
    capability_grants: assignment?.capability_grants ?? PARTNER_PROGRAM_DEFINITION.defaultCapabilityGrants,
    auto_load: true,
    config: {
      partner_program: {
        ...config,
        screening_dimensions: ['Track Record', 'Capacity', 'Fit'],
        human_review_required: true,
      },
    },
  };
}

function financeManifest(config: Record<string, unknown>, assignment?: EnterpriseSkillAssignment | null): RuntimeSkillManifest {
  const runtimeName = assignment?.runtime_name ?? PARTNER_INVOICE_REVIEW_DEFINITION.runtimeName;
  return {
    name: runtimeName,
    skill_key: PARTNER_INVOICE_REVIEW_DEFINITION.key,
    runtime_name: runtimeName,
    version: assignment?.version ?? PARTNER_INVOICE_REVIEW_DEFINITION.version,
    artifact_digest: assignment?.artifact_digest ?? PARTNER_INVOICE_REVIEW_DEFINITION.artifactDigest,
    state: 'active',
    assignment_revision: assignment?.revision ?? null,
    grant_revision: null,
    binding_source: assignment ? 'enterprise_assignment' : 'legacy_config',
    binding_state: null,
    grant_expires_at: null,
    capability_grants: assignment?.capability_grants ?? PARTNER_INVOICE_REVIEW_DEFINITION.defaultCapabilityGrants,
    auto_load: true,
    config: {
      invoice_review: {
        ...config,
        connector: 'enterprise-partner-records',
        human_review_required: true,
        payment_execution_available: false,
      },
    },
  };
}

export function preflightPartnerManifest(
  config: Readonly<Record<string, unknown>>,
  grant: {
    grant_revision: number;
    assignment_revision: number | null;
    linked_capacity_id: string | null;
    capacity_state: string | null;
    expires_at: Date | null;
  },
): RuntimeSkillManifest {
  return partnerManifest({ ...config }, null, {
    grantRevision: grant.grant_revision,
    assignmentRevision: grant.assignment_revision,
    linkedCapacityId: grant.linked_capacity_id,
    capacityState: grant.capacity_state,
    expiresAt: grant.expires_at,
  });
}

/**
 * Read-only Agent/app-role runtime path. Legacy policy may be projected for an
 * ungoverned rollout agent, but discovery never creates authority or a schedule.
 * An explicit paused assignment returns no skill.
 */
export async function runtimeSkillManifestsForAgent(
  env: Env,
  tx: SkillQuery,
  workspaceId: string,
  agentId: string,
): Promise<readonly RuntimeSkillManifest[]> {
  const partner = await resolvePartnerSkillAssignment(env, tx, workspaceId, agentId);
  const finance = await resolveEnterpriseSkillAssignment(tx, workspaceId, agentId, PARTNER_INVOICE_REVIEW_DEFINITION.key);
  return [
    ...(partner.config ? [partnerManifest(partner.config, partner.assignment)] : []),
    ...(finance.config ? [financeManifest(finance.config, finance.assignment)] : []),
  ];
}

/** Workflow discovery uses one tenant-scoped transaction, not one per read. */
export async function loadRuntimeSkillSnapshot(
  env: Env,
  db: Pick<RuntimeDb, 'withRuntimeTransaction' | 'runtimeQuery'>,
  workspaceId: string,
  agentId: string,
): Promise<readonly RuntimeSkillManifest[]> {
  return db.withRuntimeTransaction(() => runtimeSkillManifestsForAgent(
    env,
    { query: (text, values) => db.runtimeQuery(text, values) },
    workspaceId,
    agentId,
  ));
}

/**
 * Legacy-only synchronous fallback retained for warm invitation profiles and
 * old unit callers. Deployed agent runs use runtimeSkillManifestsForAgent.
 */
export function runtimeSkillManifests(env: Env, agentId: string): readonly RuntimeSkillManifest[] {
  const { config } = partnerAgentConfig(env, agentId);
  return config ? [partnerManifest(config)] : [];
}

export function runtimeSkillCard(assignment: EnterpriseSkillAssignment): {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly shared_by: string;
  readonly description: string;
  readonly detail: string;
  readonly adopted: true;
} {
  const source = assignment.config.source;
  const state = assignment.state === 'paused' ? 'Paused. ' : '';
  return {
    id: `managed:${assignment.skill_key}`,
    name: assignment.name,
    version: `v${assignment.version}`,
    shared_by: 'Hermes Enterprise',
    description: assignment.description,
    detail: state + (assignment.skill_key === PARTNER_INVOICE_REVIEW_DEFINITION.key
      ? 'Checks a Finance-private invoice against an explicitly shared engagement reference, flags duplicates or missing context, and prepares a human decision. It cannot approve or pay.'
      : source === 'agentcash_people'
        ? 'AgentCash People Search is attached through one exact, leased $0.15 call. Iris may enrich one shortlisted professional contact and prepares draft-only outreach for human review; no message, call, or text is sent.'
        : 'Reviews stored public evidence, names gaps, and prepares draft-only outreach. A human reviews and no message is sent.'),
    adopted: true,
  };
}

/** Legacy card helper kept for older callers during the assignment rollout. */
export function runtimeSkillCards(env: Env, agentId: string): readonly ReturnType<typeof runtimeSkillCard>[] {
  const { config } = partnerAgentConfig(env, agentId);
  if (!config) return [];
  return [runtimeSkillCard({
    id: crypto.randomUUID(),
    agent_id: agentId,
    agent_name: null,
    team: null,
    skill_key: PARTNER_PROGRAM_DEFINITION.key,
    runtime_name: PARTNER_PROGRAM_DEFINITION.runtimeName,
    name: PARTNER_PROGRAM_DEFINITION.name,
    version: PARTNER_PROGRAM_DEFINITION.version,
    artifact_digest: null,
    description: PARTNER_PROGRAM_DEFINITION.description,
    state: 'active',
    revision: 1,
    config,
    capability_grants: [...PARTNER_PROGRAM_DEFINITION.defaultCapabilityGrants],
    schedule: { enabled: true, interval_minutes: 360 },
    human_review_required: true,
    config_fields: [...PARTNER_PROGRAM_DEFINITION.configFields],
    updated_at: new Date(0).toISOString(),
  })];
}
