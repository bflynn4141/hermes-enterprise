import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { materializeLegacyPartnerAssignment, resolvePartnerSkillAssignment, updateEnterpriseSkillAssignment } from '../../src/enterprise-skills/service.js';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import { bridgeToken } from '../../src/runtime/config.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';
import { call, makeEnv, readTenant } from './harness.js';

const policy = (agentId: string) => ({
  [agentId]: {
    source: 'agentcash_people', source_purpose: 'person_partner_research', organization_only: false, no_outreach: true,
    role_label: 'Hermes consultant', search_queries: [], intake_urls: [], keywords: ['AI agents'],
    people_search: { current_position_seniority_level: ['Founder'], person_skills: ['AI agents'], current_position_titles: [], person_locations: [] },
    ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
    minimum_priority: 50, lookback_days: 365, max_candidates: 5, max_api_requests: 1,
    minimum_rate_remaining: 5, max_spend_usd: 0.15,
  },
});

const defaultPolicy = () => Object.values(policy('22222222-2222-4222-8222-222222222222'))[0]!;

describe('enterprise skill assignment persistence', () => {
  it('keeps authenticated runtime discovery read-only while projecting legacy policy for an ungoverned agent', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv({
      ENVIRONMENT: 'development',
      AGENT_RUNTIME: 'hermes',
      HERMES_BRIDGE_SECRET: 'b'.repeat(32),
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [fx.agentId]: {
          workspace_id: fx.workspaceId,
          base_url: 'http://127.0.0.1:9999',
          api_key: 'runtime-test',
          transport: 'native',
          assignment: 'fixed',
        },
      }),
      PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(defaultPolicy()),
    });
    const token = await bridgeToken(env, fx.workspaceId, fx.agentId);
    const response = await call(env, `/internal/runtime/w/${fx.workspaceId}/agents/${fx.agentId}/skills`, {
      origin: null,
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      skills: [expect.objectContaining({ name: 'enterprise_bridge:partner-program-screening', version: '1.7.0' })],
    });
    await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const result = await client.query<{ assignments: number; enabled_schedules: number }>(
        `SELECT count(*)::int AS assignments,
                count(*) FILTER (WHERE schedule->>'enabled'='true')::int AS enabled_schedules
           FROM enterprise_skill_assignments WHERE workspace_id=$1 AND agent_id=$2`,
        [fx.workspaceId, fx.agentId],
      );
      expect(result.rows[0]).toEqual({ assignments: 0, enabled_schedules: 0 });
    });
  });

  it('imports legacy policy once, versions Admin changes, and makes pause visible to the agent role', async () => {
    const fx = await seedWorkspace();
    const env = { PARTNER_SCREENING_CONFIG_JSON: JSON.stringify(policy(fx.agentId)) } as Env;
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO agent_capabilities (workspace_id, agent_id, kind, title, scope, tool_names, position)
         VALUES ($1,$2,'can','Legacy partner tools','Partner Program',ARRAY['propose_request'],0),
                ($1,$2,'can','General web research','General',ARRAY['fetch_url'],1)`,
        [fx.workspaceId, fx.agentId],
      );
      await client.query('COMMIT');
    });
    const assignment = await withClient('app', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      const created = await materializeLegacyPartnerAssignment(env, client, fx.workspaceId, fx.agentId, fx.adminId);
      await client.query('COMMIT');
      return created!;
    });
    expect(assignment).toMatchObject({ state: 'active', revision: 1, skill_key: 'partner-program-screening' });

    const paused = await withClient('app', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      const updated = await updateEnterpriseSkillAssignment(
        client, fx.workspaceId, fx.agentId, assignment.id, fx.adminId,
        { revision: 1, state: 'paused', schedule: { enabled: false, interval_minutes: 360 } },
      );
      const history = await client.query<{ revision: number; changed_by: string | null }>(
        `SELECT revision, changed_by FROM enterprise_skill_assignment_revisions
          WHERE workspace_id=$1 AND assignment_id=$2 ORDER BY revision`,
        [fx.workspaceId, assignment.id],
      );
      await client.query('COMMIT');
      expect(history.rows).toEqual([
        { revision: 1, changed_by: fx.adminId },
        { revision: 2, changed_by: fx.adminId },
      ]);
      return updated;
    });
    expect(paused).toMatchObject({ state: 'paused', revision: 2, schedule: { enabled: false } });

    const runtime = await withClient('agent', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      const resolved = await resolvePartnerSkillAssignment(env, client, fx.workspaceId, fx.agentId);
      await client.query('COMMIT');
      return resolved;
    });
    expect(runtime.source).toBe('assignment');
    expect(runtime.config).toBeNull();
    expect(runtime.problem).toBe('Partner screening is paused.');

    const db = new PgAgentDb(makeEnv({ ENVIRONMENT: 'development' }).env, fx.workspaceId, 'paused-skill-tools');
    try {
      expect(await db.loadToolNames(fx.agentId)).toEqual(['fetch_url']);
    } finally {
      await db.close();
    }
  });
});
