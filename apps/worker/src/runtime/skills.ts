// Enterprise-owned Hermes skills. The procedure is packaged with the governed
// runtime plugin; this module supplies only the non-secret configuration that
// differs by enterprise/agent. Credentials and authority never enter SKILL.md.
import type { Env } from '../env.js';
import { partnerAgentConfig } from '../partner-screening/config.js';

export const PARTNER_PROGRAM_SKILL = {
  name: 'enterprise_bridge:partner-program-screening',
  key: 'partner-program-screening',
  version: '1.4.0',
  title: 'Partner program screening',
  description: 'Screen public partner prospects and prepare cited outreach drafts for human review.',
} as const;

export interface RuntimeSkillManifest {
  readonly name: string;
  readonly version: string;
  readonly auto_load: true;
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * The official Hermes runtime injects `skills.config` when it auto-loads a
 * skill. Keep this payload deliberately non-secret: it is written to the
 * dedicated profile's config.yaml and may appear in model context.
 */
export function runtimeSkillManifests(env: Env, agentId: string): readonly RuntimeSkillManifest[] {
  const { config } = partnerAgentConfig(env, agentId);
  if (!config) return [];
  return [{
    name: PARTNER_PROGRAM_SKILL.name,
    version: PARTNER_PROGRAM_SKILL.version,
    auto_load: true,
    config: {
      partner_program: {
        program_name: config.program_name,
        source: config.source,
        role_label: config.role_label,
        source_purpose: config.source_purpose,
        screening_dimensions: ['Track Record', 'Capacity', 'Fit'],
        search_queries: config.search_queries,
        intake_urls: config.intake_urls,
        keywords: config.keywords,
        ranking_weights: config.ranking_weights,
        minimum_priority: config.minimum_priority,
        lookback_days: config.lookback_days,
        max_candidates: config.max_candidates,
        organization_only: config.organization_only,
        people_search: config.people_search,
        max_spend_usd: config.max_spend_usd,
        no_outreach: config.no_outreach,
        human_review_required: true,
      },
    },
  }];
}

export function runtimeSkillCards(env: Env, agentId: string): readonly [{
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly shared_by: string;
  readonly description: string;
  readonly detail: string;
  readonly adopted: true;
}] | readonly [] {
  if (runtimeSkillManifests(env, agentId).length === 0) return [];
  return [{
    id: `managed:${PARTNER_PROGRAM_SKILL.key}`,
    name: PARTNER_PROGRAM_SKILL.title,
    version: `v${PARTNER_PROGRAM_SKILL.version}`,
    shared_by: 'Hermes Enterprise',
    description: PARTNER_PROGRAM_SKILL.description,
    detail: partnerAgentConfig(env, agentId).config?.source === 'agentcash_people'
      ? 'AgentCash People Search is attached through one exact, leased $0.15 call. Iris reviews sanitized evidence and prepares draft-only outreach; a human reviews and no message is sent.'
      : 'Reviews stored public evidence, names gaps, and prepares draft-only outreach. A human reviews and no message is sent.',
    adopted: true,
  }];
}
