import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { agentDirectorySchema, enterpriseSkillCatalogSchema } from '@hermes/shared';
import type { Env } from '../../src/env.js';
import { configurePartnerWorkflow } from '../../src/partner-workflow/service.js';
import { materializeLegacyPartnerAssignment, resolvePartnerSkillAssignment, updateEnterpriseSkillAssignment } from '../../src/enterprise-skills/service.js';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import { bridgeToken } from '../../src/runtime/config.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';
import { asUser, call, makeEnv, readTenant } from './harness.js';

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

/**
 * Iris (Maya's, Partnerships, no runtime) and Ledger (Dana's, Finance, on a
 * Hermes Cloud instance that attests its skill at startup), both set up by the
 * role setup so each already has its lane's catalog skill.
 */
async function catalogFixture() {
  const fx = await seedWorkspace();
  const ledgerId = randomUUID();
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    const dana = await client.query<{ id: string }>('SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2', [fx.workspaceId, fx.memberId]);
    await client.query(`INSERT INTO agents (id,workspace_id,name,status,context_scope) VALUES ($1,$2,'Ledger','started','private')`, [ledgerId, fx.workspaceId]);
    await client.query('INSERT INTO agent_owners (workspace_id,agent_id,member_id) VALUES ($1,$2,$3)', [fx.workspaceId, ledgerId, dana.rows[0]!.id]);
    await client.query(
      `INSERT INTO agent_provisioning (workspace_id,agent_id,status,instance_name) VALUES ($1,$2,'ready','hermes-pool-04')`,
      [fx.workspaceId, ledgerId],
    );
    await client.query('COMMIT');
  });
  await withClient('app', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    await configurePartnerWorkflow(client, fx.workspaceId, fx.adminId, {
      partnerships: { agent_id: fx.agentId, principal_user_id: fx.adminId },
      finance: { agent_id: ledgerId, principal_user_id: fx.memberId },
    });
    await client.query('COMMIT');
  });
  return { ...fx, ledgerId };
}

const assignments = (fx: { workspaceId: string }, agentId: string) => `/w/${fx.workspaceId}/agents/${agentId}/skill-assignments`;

async function assignmentIds(fx: { workspaceId: string; adminId: string }, agentId: string): Promise<Array<{ id: string; skill_key: string; state: string }>> {
  const { env } = makeEnv();
  const response = await asUser(env, fx.adminId, assignments(fx, agentId));
  return ((await response.json()) as { items: Array<{ id: string; skill_key: string; state: string }> }).items;
}

describe('assigning catalog skills (C96)', () => {
  it('lists the catalog at the version a new assignment gets, for Admins only', async () => {
    const fx = await catalogFixture();
    const { env } = makeEnv();
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/skill-catalog`);
    expect(response.status).toBe(200);
    const catalog = enterpriseSkillCatalogSchema.parse(await response.json());
    expect(catalog.items.map(({ key, version, template }) => ({ key, version, template }))).toEqual([
      { key: 'partner-program-screening', version: '1.8.0', template: 'partnerships-agent' },
      { key: 'partner-invoice-review', version: '1.0.1', template: 'finance-agent' },
    ]);
    expect(catalog.items[1]!.tools).toContain('get_partner_handoff_result');
    expect((await asUser(env, fx.memberId, `/w/${fx.workspaceId}/skill-catalog`)).status).toBe(403);
  });

  it('removes and re-assigns a skill at the pinned version, and the directory follows', async () => {
    const fx = await catalogFixture();
    const { env } = makeEnv();
    const [current] = await assignmentIds(fx, fx.agentId);
    expect(current).toMatchObject({ skill_key: 'partner-program-screening', state: 'active' });

    const removed = await asUser(env, fx.adminId, `${assignments(fx, fx.agentId)}/${current!.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect(await assignmentIds(fx, fx.agentId)).toEqual([]);
    const kept = await readTenant(fx.workspaceId, fx.adminId, (client) => client.query(
      `SELECT state, removed_at IS NOT NULL AS removed, schedule->>'enabled' AS schedule FROM enterprise_skill_assignments WHERE id=$1`, [current!.id],
    ));
    // Kept for the grants that refer to it and for its history, paused.
    expect(kept.rows[0]).toEqual({ state: 'paused', removed: true, schedule: 'false' });
    let directory = agentDirectorySchema.parse(await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/admin/agents`)).json());
    expect(directory.items.find((agent) => agent.id === fx.agentId)?.skills).toEqual([]);
    expect((await asUser(env, fx.adminId, `${assignments(fx, fx.agentId)}/${current!.id}`, { method: 'DELETE' })).status).toBe(404);

    const assigned = await asUser(env, fx.adminId, assignments(fx, fx.agentId), { method: 'POST', body: { skill_key: 'partner-program-screening' } });
    expect(assigned.status).toBe(201);
    expect(await assigned.json()).toMatchObject({
      id: current!.id,
      skill_key: 'partner-program-screening',
      version: '1.8.0',
      state: 'active',
      team: { slug: 'partnerships' },
      artifact_digest: 'sha256:281bbfff95d40e202c3ced5d1cb30ebf432868bee100d0c2a647faa40757a9e5',
      schedule: { enabled: false },
    });
    directory = agentDirectorySchema.parse(await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/admin/agents`)).json());
    expect(directory.items.find((agent) => agent.id === fx.agentId)?.skills).toEqual([
      expect.objectContaining({ assignment_id: current!.id, skill_key: 'partner-program-screening', version: '1.8.0', state: 'active' }),
    ]);
    const history = await readTenant(fx.workspaceId, fx.adminId, (client) => client.query<{ state: string; changed_by: string }>(
      `SELECT state, changed_by FROM enterprise_skill_assignment_revisions WHERE assignment_id=$1 ORDER BY revision`, [current!.id],
    ));
    expect(history.rows.slice(-2)).toEqual([
      { state: 'paused', changed_by: fx.adminId },
      { state: 'active', changed_by: fx.adminId },
    ]);
  });

  it('refuses an unknown skill, a duplicate, a second active skill, another role’s skill and an agent with no role', async () => {
    const fx = await catalogFixture();
    const { env } = makeEnv();
    const post = (agentId: string, body: unknown) => asUser(env, fx.adminId, assignments(fx, agentId), { method: 'POST', body });
    for (const body of [{ skill_key: 'free-form-skill' }, { skill_key: 'partner-program-screening', skill_version: '1.7.0' }, {}]) {
      const refused = await post(fx.agentId, body);
      expect(refused.status, JSON.stringify(body)).toBe(422);
      expect(await refused.json()).toMatchObject({ reason: 'unknown_skill' });
    }
    const duplicate = await post(fx.agentId, { skill_key: 'partner-program-screening' });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ reason: 'already_assigned' });
    // Managed readiness admits exactly one active skill.
    const second = await post(fx.agentId, { skill_key: 'partner-invoice-review' });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ reason: 'one_active_skill' });
    const [current] = await assignmentIds(fx, fx.agentId);
    expect((await asUser(env, fx.adminId, `${assignments(fx, fx.agentId)}/${current!.id}`, { method: 'DELETE' })).status).toBe(204);
    const otherRole = await post(fx.agentId, { skill_key: 'partner-invoice-review' });
    expect(otherRole.status).toBe(422);
    expect(await otherRole.json()).toMatchObject({ reason: 'skill_role_mismatch' });

    const loose = randomUUID();
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(`INSERT INTO agents (id,workspace_id,name,status,context_scope) VALUES ($1,$2,'Scout','started','workspace')`, [loose, fx.workspaceId]);
      await client.query('COMMIT');
    });
    const noLane = await post(loose, { skill_key: 'partner-program-screening' });
    expect(noLane.status).toBe(422);
    expect(await noLane.json()).toMatchObject({ reason: 'no_lane' });
    expect(await assignmentIds(fx, fx.agentId)).toEqual([]);
  });

  it('refuses to change the skills of an agent whose runtime attests them, and says it needs a rebuild', async () => {
    const fx = await catalogFixture();
    const { env } = makeEnv();
    const [current] = await assignmentIds(fx, fx.ledgerId);
    const removed = await asUser(env, fx.adminId, `${assignments(fx, fx.ledgerId)}/${current!.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(409);
    const body = await removed.json() as { reason: string; error: string };
    expect(body.reason).toBe('runtime_rebuild_required');
    expect(body.error).toContain('needs a rebuild');
    const assigned = await asUser(env, fx.adminId, assignments(fx, fx.ledgerId), { method: 'POST', body: { skill_key: 'partner-invoice-review' } });
    expect(assigned.status).toBe(409);
    expect(await assigned.json()).toMatchObject({ reason: 'runtime_rebuild_required' });
    expect(await assignmentIds(fx, fx.ledgerId)).toEqual([expect.objectContaining({ id: current!.id, state: 'active' })]);
  });

  it('is an Admin write that needs a recent sign-in', async () => {
    const fx = await catalogFixture();
    const { env } = makeEnv();
    const [current] = await assignmentIds(fx, fx.agentId);
    expect((await asUser(env, fx.memberId, `${assignments(fx, fx.agentId)}/${current!.id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await asUser(env, fx.memberId, assignments(fx, fx.agentId), { method: 'POST', body: { skill_key: 'partner-program-screening' } })).status).toBe(403);

    await withClient('owner', (client) => client.query(
      `UPDATE auth_sessions SET authenticated_at = now() - interval '10 minutes' WHERE sid = $1`, [`dev-${fx.adminId}`],
    ));
    const stale = await asUser(env, fx.adminId, `${assignments(fx, fx.agentId)}/${current!.id}`, { method: 'DELETE' });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ reason: 'reauth_required' });
    expect(await assignmentIds(fx, fx.agentId)).toEqual([expect.objectContaining({ id: current!.id, state: 'active' })]);
  });
});
