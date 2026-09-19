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

export { PARTNER_PROGRAM_SKILL, PARTNER_PROGRAM_TOOLS };

export interface RuntimeSkillManifest {
  readonly name: string;
  readonly version: string;
  readonly auto_load: true;
  readonly config: Readonly<Record<string, unknown>>;
}

function partnerManifest(config: Record<string, unknown>): RuntimeSkillManifest {
  return {
    name: PARTNER_PROGRAM_DEFINITION.runtimeName,
    version: PARTNER_PROGRAM_DEFINITION.version,
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

function financeManifest(config: Record<string, unknown>): RuntimeSkillManifest {
  return {
    name: PARTNER_INVOICE_REVIEW_DEFINITION.runtimeName,
    version: PARTNER_INVOICE_REVIEW_DEFINITION.version,
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
    ...(partner.config ? [partnerManifest(partner.config)] : []),
    ...(finance.config ? [financeManifest(finance.config)] : []),
  ];
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
