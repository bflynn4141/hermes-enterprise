import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import {
  assignmentToolNames,
  listEnterpriseSkillAssignments,
  resolveEnterpriseSkillAssignment,
  resolvePartnerSkillAssignment,
  type SkillQuery,
} from '../../src/enterprise-skills/service.js';
import {
  PARTNER_INVOICE_REVIEW_DEFINITION,
  PARTNER_INVOICE_REVIEW_LEGACY_DEFINITION,
  PARTNER_PROGRAM_DEFINITION,
  PARTNER_PROGRAM_MULTI_PARTY_DEFINITION,
} from '../../src/enterprise-skills/registry.js';
import { runtimeSkillManifestsForAgent } from '../../src/runtime/skills.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const config = {
  source: 'agentcash_people', program_name: 'Hermes Partner Program', source_purpose: 'person_partner_research',
  organization_only: false, no_outreach: true, role_label: 'Hermes consultant', search_queries: [], intake_urls: [],
  keywords: ['AI agents'], ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
  minimum_priority: 50, lookback_days: 365, max_candidates: 5, max_api_requests: 1, minimum_rate_remaining: 5,
  max_spend_usd: 0.15,
  people_search: { current_position_seniority_level: ['Founder'], person_skills: ['AI agents'], current_position_titles: [], person_locations: [], offset: 0, search_after: null },
};

function queryFor(state: 'active' | 'paused'): SkillQuery {
  return {
    async query<T>(_statement: string, values: readonly unknown[] = []) {
      if (values[2] === PARTNER_INVOICE_REVIEW_DEFINITION.key) return { rows: [] as T[] };
      return { rows: [{
        id: '33333333-3333-4333-8333-333333333333', agent_id: agentId,
        skill_key: 'partner-program-screening', skill_version: '1.7.0', state, config,
        capability_grants: ['partner.discovery.read', 'partner.outreach.draft', 'partner.handoff.publish'],
        schedule: { enabled: true, interval_minutes: 360 }, approval_policy: { human_review_required: true },
        revision: 3, updated_at: new Date('2026-09-18T12:00:00Z'),
      }] as T[] };
    },
  };
}

function financeGovernedQuery(): SkillQuery {
  return {
    async query<T>(statement: string, values: readonly unknown[] = []) {
      if (statement.includes('AS governed')) return { rows: [{ governed: true }] as T[] };
      if (values[2] === PARTNER_PROGRAM_DEFINITION.key) return { rows: [] as T[] };
      if (values[2] === PARTNER_INVOICE_REVIEW_DEFINITION.key) {
        return { rows: [{
          id: '33333333-3333-4333-8333-333333333333', agent_id: agentId,
          agent_name: 'Ledger', team_id: '44444444-4444-4444-8444-444444444444',
          team_slug: 'finance', team_name: 'Finance',
          artifact_id: '55555555-5555-4555-8555-555555555555',
          artifact_digest: PARTNER_INVOICE_REVIEW_DEFINITION.artifactDigest,
          skill_key: PARTNER_INVOICE_REVIEW_DEFINITION.key,
          skill_version: PARTNER_INVOICE_REVIEW_DEFINITION.version,
          state: 'active', config: { duplicate_window_days: 365, require_engagement_evidence: true },
          capability_grants: [...PARTNER_INVOICE_REVIEW_DEFINITION.defaultCapabilityGrants],
          schedule: { enabled: false, interval_minutes: 360 }, approval_policy: { human_review_required: true },
          revision: 1, updated_at: new Date('2026-09-18T12:00:00Z'),
        }] as T[] };
      }
      return { rows: [] as T[] };
    },
  };
}

describe('enterprise skill assignments', () => {
  it('uses the reviewed assignment as the runtime skill and exact tool grant source', async () => {
    const resolved = await resolvePartnerSkillAssignment({} as Env, queryFor('active'), workspaceId, agentId);
    expect(resolved.source).toBe('assignment');
    expect(resolved.config?.program_name).toBe('Hermes Partner Program');
    expect(assignmentToolNames(resolved.assignment)).toEqual([
      'list_partner_candidates', 'get_partner_candidate',
      'propose_request', 'propose_approval', 'propose_instruction',
    ]);
    await expect(runtimeSkillManifestsForAgent({} as Env, queryFor('active'), workspaceId, agentId))
      .resolves.toEqual([expect.objectContaining({ name: 'enterprise_bridge:partner-program-screening', version: '1.7.0' })]);
  });

  it('serves the runtime a config without null leaves because Hermes config.yaml cannot keep them', async () => {
    // Hermes save_config drops every leaf equal to its (absent) default, so a
    // Cloud dashboard can never persist `search_after: null`. The managed
    // plugin compares its pinned settings byte-for-byte with this manifest.
    const [manifest] = await runtimeSkillManifestsForAgent({} as Env, queryFor('active'), workspaceId, agentId);
    const program = manifest!.config.partner_program as { people_search: Record<string, unknown> };
    expect(program.people_search).toEqual({
      current_position_seniority_level: ['Founder'], person_skills: ['AI agents'],
      current_position_titles: [], person_locations: [], offset: 0,
    });
    expect('search_after' in program.people_search).toBe(false);
    expect(program).toEqual(expect.objectContaining({ program_name: 'Hermes Partner Program', max_spend_usd: 0.15 }));
  });

  it('makes pause a runtime boundary rather than a visual-only state', async () => {
    const resolved = await resolvePartnerSkillAssignment({} as Env, queryFor('paused'), workspaceId, agentId);
    expect(resolved.config).toBeNull();
    expect(assignmentToolNames(resolved.assignment)).toEqual([]);
    await expect(runtimeSkillManifestsForAgent({} as Env, queryFor('paused'), workspaceId, agentId)).resolves.toEqual([]);
  });

  it('keeps deployed legacy artifact identities and tool inventories while new versions opt in', async () => {
    expect(PARTNER_PROGRAM_DEFINITION.artifactDigest).toBe(
      'sha256:9f124ce44aa318b13e9f8ccfd92072d8b3ba6a22030eaad31cfafbfda3a1e2a9',
    );
    const legacyFinance: SkillQuery = {
      async query<T>() {
        return { rows: [{
          id: '33333333-3333-4333-8333-333333333333', agent_id: agentId,
          artifact_id: '55555555-5555-4555-8555-555555555555',
          artifact_digest: PARTNER_INVOICE_REVIEW_LEGACY_DEFINITION.artifactDigest,
          skill_key: PARTNER_INVOICE_REVIEW_LEGACY_DEFINITION.key,
          skill_version: PARTNER_INVOICE_REVIEW_LEGACY_DEFINITION.version,
          state: 'active', config: { duplicate_window_days: 365, require_engagement_evidence: true },
          capability_grants: [...PARTNER_INVOICE_REVIEW_LEGACY_DEFINITION.defaultCapabilityGrants],
          schedule: { enabled: false, interval_minutes: 360 }, approval_policy: { human_review_required: true },
          revision: 1, updated_at: new Date('2026-09-18T12:00:00Z'),
        }] as T[] };
      },
    };
    const legacy = await resolveEnterpriseSkillAssignment(
      legacyFinance, workspaceId, agentId, PARTNER_INVOICE_REVIEW_LEGACY_DEFINITION.key,
    );
    expect(legacy.problem).toBeNull();
    expect(assignmentToolNames(legacy.assignment)).not.toContain('get_partner_handoff_result');
    expect(PARTNER_PROGRAM_MULTI_PARTY_DEFINITION.runtimeName).toBe('enterprise_bridge:partner-program-screening-v1-8');
    expect(PARTNER_PROGRAM_MULTI_PARTY_DEFINITION.version).toBe('1.8.0');
    expect(PARTNER_INVOICE_REVIEW_DEFINITION.version).toBe('1.0.1');
  });

  it('does not attach the deployment-wide legacy Partnerships policy to a Finance-governed agent', async () => {
    const env = { PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(config) } as Env;
    await expect(runtimeSkillManifestsForAgent(env, financeGovernedQuery(), workspaceId, agentId)).resolves.toEqual([
      expect.objectContaining({
        name: PARTNER_INVOICE_REVIEW_DEFINITION.runtimeName,
        version: PARTNER_INVOICE_REVIEW_DEFINITION.version,
      }),
    ]);
  });

  it('keeps assignment reads side-effect free even when legacy environment config exists', async () => {
    const statements: string[] = [];
    const tx: SkillQuery = {
      async query<T>(statement: string) {
        statements.push(statement);
        return { rows: [] as T[] };
      },
    };
    const env = { PARTNER_SCREENING_CONFIG_JSON: JSON.stringify({ [agentId]: config }) } as Env;
    await expect(listEnterpriseSkillAssignments(env, tx, workspaceId, agentId, null)).resolves.toEqual([]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^\s*SELECT/);
    expect(statements[0]).not.toMatch(/(?:^|\s)(?:INSERT|UPDATE|DELETE)\s/i);
  });

  it('fails closed when the Finance assignment artifact or version is not the reviewed one', async () => {
    const financeQuery = (version: string, digest: string): SkillQuery => ({
      async query<T>() {
        return { rows: [{
          id: '33333333-3333-4333-8333-333333333333', agent_id: agentId,
          agent_name: 'Ledger', team_id: '44444444-4444-4444-8444-444444444444',
          team_slug: 'finance', team_name: 'Finance',
          artifact_id: '55555555-5555-4555-8555-555555555555', artifact_digest: digest,
          skill_key: 'partner-invoice-review', skill_version: version, state: 'active',
          config: { duplicate_window_days: 365, require_engagement_evidence: true },
          capability_grants: ['partner.shared.read', 'partner.invoice.read', 'partner.invoice.review.prepare'],
          schedule: { enabled: false, interval_minutes: 360 }, approval_policy: { human_review_required: true },
          revision: 1, updated_at: new Date('2026-09-18T12:00:00Z'),
        }] as T[] };
      },
    });
    await expect(resolveEnterpriseSkillAssignment(
      financeQuery('1.0.0', `sha256:${'0'.repeat(64)}`), workspaceId, agentId, 'partner-invoice-review',
    )).resolves.toMatchObject({ config: null, problem: expect.stringContaining('artifact does not match') });
    await expect(resolveEnterpriseSkillAssignment(
      financeQuery('9.9.9', `sha256:${'0'.repeat(64)}`), workspaceId, agentId, 'partner-invoice-review',
    )).resolves.toMatchObject({ config: null, problem: expect.stringContaining('Unsupported') });
  });
});
