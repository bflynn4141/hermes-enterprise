import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { PARTNER_PROGRAM_SKILL, runtimeSkillCards, runtimeSkillManifests } from '../../src/runtime/skills.js';

const agentId = '44444444-4444-4444-8444-444444444444';
const policy = {
  [agentId]: {
    source_purpose: 'organization_partner_research',
    organization_only: true,
    no_outreach: true,
    role_label: 'Technical partner',
    search_queries: ['developer agents in:name,description'],
    intake_urls: [],
    keywords: ['agents', 'open source'],
    ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
    minimum_priority: 60,
    lookback_days: 180,
    max_candidates: 4,
    max_api_requests: 10,
    minimum_rate_remaining: 5,
  },
};

describe('enterprise Hermes skills', () => {
  it('publishes no runtime skill without a valid agent policy', () => {
    expect(runtimeSkillManifests({} as Env, agentId)).toEqual([]);
    expect(runtimeSkillCards({} as Env, agentId)).toEqual([]);
  });

  it('turns the agent policy into non-secret auto-load configuration', () => {
    const env = {
      PARTNER_SCREENING_CONFIG_JSON: JSON.stringify(policy),
      PARTNER_GITHUB_TOKEN: 'must-not-enter-the-manifest',
    } as Env;
    const [skill] = runtimeSkillManifests(env, agentId);
    expect(skill).toMatchObject({
      name: PARTNER_PROGRAM_SKILL.name,
      version: '1.7.0',
      auto_load: true,
      config: {
        partner_program: {
          program_name: 'Hermes Partner Program',
          role_label: 'Technical partner',
          screening_dimensions: ['Track Record', 'Capacity', 'Fit'],
          minimum_priority: 60,
          no_outreach: true,
          human_review_required: true,
        },
      },
    });
    expect(JSON.stringify(skill)).not.toContain('must-not-enter-the-manifest');
    expect(runtimeSkillCards(env, agentId)).toEqual([expect.objectContaining({
      id: 'managed:partner-program-screening', adopted: true, shared_by: 'Hermes Teams Demo',
    })]);
  });
});
