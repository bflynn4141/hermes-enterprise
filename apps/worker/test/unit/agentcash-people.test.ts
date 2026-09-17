import { describe, expect, it } from 'vitest';
import type { PartnerAgentConfig } from '../../src/partner-screening/config.js';
import {
  AGENTCASH_PEOPLE_SEARCH_URL,
  agentCashPeopleSearchArguments,
  parseAgentCashPeopleSearch,
} from '../../src/partner-screening/agentcash-people.js';

const config: PartnerAgentConfig = {
  source: 'agentcash_people',
  program_name: 'Hermes Partner Program',
  source_purpose: 'person_partner_research',
  organization_only: false,
  no_outreach: true,
  role_label: 'Potential ecosystem lead',
  search_queries: [],
  intake_urls: [],
  keywords: ['artificial intelligence', 'developer relations'],
  people_search: {
    current_position_seniority_level: ['Founder', 'Head', 'Director'],
    person_skills: ['Artificial Intelligence (AI)', 'Developer Relations'],
    current_position_titles: [],
    person_locations: [],
  },
  ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
  minimum_priority: 40,
  lookback_days: 365,
  max_candidates: 5,
  max_api_requests: 1,
  minimum_rate_remaining: 0,
  max_spend_usd: 0.15,
};

describe('AgentCash People Search connector', () => {
  it('builds one bounded request from policy rather than model-selected fields', () => {
    expect(agentCashPeopleSearchArguments(config)).toEqual({
      url: AGENTCASH_PEOPLE_SEARCH_URL,
      method: 'POST',
      maxAmount: 0.15,
      body: {
        current_position_seniority_level: ['Founder', 'Head', 'Director'],
        person_skills: ['Artificial Intelligence (AI)', 'Developer Relations'],
        excludeFields: ['educations', 'languages'],
        include_employment_history: false,
        verbose: false,
        offset: 0,
      },
    });
  });

  it('sanitizes paid results into cited person candidates without contact data', () => {
    const result = parseAgentCashPeopleSearch(JSON.stringify({
      people: [{
        id: 'person-1',
        full_name: 'Rik Turner',
        headline: 'Founder, PR for AI',
        location: 'London, United Kingdom',
        email: 'must-not-persist@example.com',
        phone_numbers: ['+15551234567'],
        skills: ['Artificial Intelligence (AI)', 'Developer Relations'],
        social_profiles: {
          professional_network: {
            url: 'https://www.linkedin.com/in/rikturner',
            handle: 'rikturner',
          },
        },
        employment: {
          current: {
            title: 'Founder',
            seniority: 'Founder',
            company_id: 'company-1',
            description: 'Works with AI companies.',
          },
        },
      }],
      companies: {
        'company-1': {
          id: 'company-1',
          name: 'PR for AI',
          domain: 'prfor.ai',
          description: 'Communications for AI companies.',
          email: 'also-must-not-persist@example.com',
        },
      },
      metadata: { total: 1, credits: 1, offset: 0 },
    }), config, new Date('2026-09-16T20:00:00Z'));

    expect(result).toMatchObject({ apiRequestsUsed: 1, monetaryCostUsd: 0.15 });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      sourceKey: 'person-1',
      displayName: 'Rik Turner',
      profileUrl: 'https://www.linkedin.com/in/rikturner',
    });
    expect(result.candidates[0]?.priority.total).toBeGreaterThanOrEqual(40);
    expect(JSON.stringify(result.artifacts)).not.toContain('must-not-persist');
    expect(JSON.stringify(result.artifacts)).not.toContain('+15551234567');
  });

  it('accepts the response and payment metadata blocks persisted by Hermes', () => {
    const response = JSON.stringify({
      people: [{
        id: 'person-2',
        full_name: 'Public Profile',
        email: 'private@example.com',
        skills: ['Artificial Intelligence (AI)'],
        social_profiles: { professional_network: { url: 'https://www.linkedin.com/in/public-profile' } },
        employment: { current: { title: 'Founder', seniority: 'Founder' } },
      }],
      companies: {},
      metadata: { total: 1 },
    });
    const paymentMetadata = JSON.stringify({ paymentInfo: { price: '$0.15', transaction: '0xreceipt' } });

    const result = parseAgentCashPeopleSearch(`${response}\n${paymentMetadata}`, config, new Date('2026-09-17T22:00:00Z'));

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.displayName).toBe('Public Profile');
    expect(JSON.stringify(result.artifacts)).not.toContain('private@example.com');
    expect(JSON.stringify(result.artifacts)).not.toContain('0xreceipt');
  });

  it('rejects a response without a trustworthy professional profile URL', () => {
    expect(() => parseAgentCashPeopleSearch({
      people: [{ id: 'person-1', full_name: 'No Profile' }],
      companies: {},
      metadata: { total: 1 },
    }, config, new Date())).toThrow(/usable people/i);
  });
});
