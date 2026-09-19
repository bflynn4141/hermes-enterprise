import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Bootstrap } from '@hermes/shared';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import { buildSystemPrompt } from '../../src/engine/prompt.js';
import {
  FINANCE_ROLE_INSTRUCTIONS,
  PARTNER_PROGRAM_BOOTSTRAP_INSTRUCTIONS,
} from '../../src/enterprise-skills/role-instructions.js';
import { configurePartnerWorkflow } from '../../src/partner-workflow/service.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';

const legacyDefaultPolicy = {
  source: 'agentcash_people',
  source_purpose: 'person_partner_research',
  organization_only: false,
  no_outreach: true,
  role_label: 'Hermes consultant',
  search_queries: [],
  intake_urls: [],
  keywords: ['AI agents'],
  people_search: {
    current_position_seniority_level: ['Founder'],
    person_skills: ['AI agents'],
    current_position_titles: [],
    person_locations: [],
  },
  ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
  minimum_priority: 50,
  lookback_days: 365,
  max_candidates: 5,
  max_api_requests: 1,
  minimum_rate_remaining: 5,
  max_spend_usd: 0.15,
};

async function inviteAndAccept() {
  const fx = await seedWorkspace();
  const joinerId = randomUUID();
  const invitationId = randomUUID();
  const email = `finance-${joinerId.slice(0, 8)}@example.test`;
  const { env } = makeEnv({
    PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(legacyDefaultPolicy),
  });
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO users (id,email,email_verified,name) VALUES ($1,$2,true,'Finance Reviewer')`,
      [joinerId, email],
    );
    await setTenant(client, fx.workspaceId, fx.adminId);
    await client.query(
      `INSERT INTO invitations (id,workspace_id,email,role,expires_at,invited_by)
       VALUES ($1,$2,$3,'member',now() + interval '7 days',$4)`,
      [invitationId, fx.workspaceId, email, fx.adminId],
    );
    await client.query('COMMIT');
  });
  const accepted = await asUser(env, joinerId, `/invitations/${invitationId}/accept`, {
    method: 'POST', body: {},
  });
  expect(accepted.status).toBe(200);
  const bootstrap = await accepted.json() as Bootstrap;
  const starter = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
    const row = await client.query<{ request_id: string; policy_id: string }>(
      `SELECT ar.request_id,ar.policy_id
         FROM approval_requests ar
         JOIN approval_policies ap ON ap.id=ar.policy_id
        WHERE ar.workspace_id=$1 AND ar.requester_agent_id=$2
          AND ap.key=$3 AND ar.status='pending'`,
      [fx.workspaceId, bootstrap.agent.id, `partner-first-search-${bootstrap.agent.id}`],
    );
    return row.rows[0]!;
  });
  expect(starter).toBeTruthy();
  return { ...fx, env, joinerId, invitationId, financeAgentId: bootstrap.agent.id, starter };
}

async function configure(fx: Awaited<ReturnType<typeof inviteAndAccept>>): Promise<void> {
  await withClient('app', async (client) => {
    await client.query('BEGIN');
    try {
      await setTenant(client, fx.workspaceId, fx.adminId);
      await configurePartnerWorkflow(client, fx.workspaceId, fx.adminId, {
        partnerships: { agent_id: fx.agentId, principal_user_id: fx.adminId },
        finance: { agent_id: fx.financeAgentId, principal_user_id: fx.joinerId },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

describe('invitation profile to Finance role conversion', () => {
  it('atomically installs the Finance prompt, closes onboarding, and retires only pending starter authority', async () => {
    const fx = await inviteAndAccept();
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO approval_policies
           (workspace_id,key,version,approval_type,requester_agent_id,priority,mode,
            prevent_self_review,require_distinct_reviewers,max_duration_seconds,steps,active)
         VALUES ($1,$2,1,'run_plan',$3,1,'sequential',false,true,60,'[]'::jsonb,true)`,
        [fx.workspaceId, `unrelated-policy-${fx.financeAgentId}`, fx.financeAgentId],
      );
      await client.query('COMMIT');
    });

    await configure(fx);
    // The route calls configure twice for compatibility. A repeated service
    // application must preserve the saved revision and keep schedules off.
    await configure(fx);

    const stored = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const agent = await client.query<{
        responsibility: string; instructions_active: string; status: string;
        setup_step: string | null; started: boolean;
      }>(
        `SELECT responsibility,instructions_active,status,setup_step,started_at IS NOT NULL AS started
           FROM agents WHERE workspace_id=$1 AND id=$2`,
        [fx.workspaceId, fx.financeAgentId],
      );
      const versions = await client.query<{ body: string; proposed_by: string; sources: unknown }>(
        `SELECT body,proposed_by,sources FROM instruction_versions
          WHERE workspace_id=$1 AND agent_id=$2 ORDER BY created_at,id`,
        [fx.workspaceId, fx.financeAgentId],
      );
      const starter = await client.query<{
        approval_status: string; work_status: string; work_reason: string;
        request_status: string; revision_status: string; policy_active: boolean;
      }>(
        `SELECT ar.status AS approval_status,ar.work_status,ar.work_reason,
                r.status AS request_status,rv.status AS revision_status,ap.active AS policy_active
           FROM approval_requests ar
           JOIN requests r ON r.id=ar.request_id
           JOIN approval_revisions rv ON rv.request_id=ar.request_id AND rv.revision=ar.authorization_revision
           JOIN approval_policies ap ON ap.id=ar.policy_id
          WHERE ar.workspace_id=$1 AND ar.request_id=$2`,
        [fx.workspaceId, fx.starter.request_id],
      );
      const assignments = await client.query<{
        skill_key: string; state: string; schedule_enabled: boolean;
      }>(
        `SELECT skill_key,state,COALESCE((schedule->>'enabled')::boolean,false) AS schedule_enabled
           FROM enterprise_skill_assignments
          WHERE workspace_id=$1 AND agent_id=$2 ORDER BY skill_key`,
        [fx.workspaceId, fx.financeAgentId],
      );
      const policies = await client.query<{ key: string; active: boolean }>(
        `SELECT key,active FROM approval_policies WHERE workspace_id=$1 AND requester_agent_id=$2 ORDER BY key`,
        [fx.workspaceId, fx.financeAgentId],
      );
      const jobs = await client.query(
        `SELECT id FROM jobs WHERE workspace_id=$1 AND kind='partner_screening'
          AND payload->>'agent_id'=$2`,
        [fx.workspaceId, fx.financeAgentId],
      );
      return {
        agent: agent.rows[0]!, versions: versions.rows, starter: starter.rows[0]!,
        assignments: assignments.rows, policies: policies.rows, screeningJobs: jobs.rowCount,
      };
    });

    expect(stored.agent).toEqual({
      responsibility: 'Finance invoice review', instructions_active: FINANCE_ROLE_INSTRUCTIONS,
      status: 'started', setup_step: null, started: true,
    });
    expect(stored.versions).toHaveLength(2);
    expect(stored.versions[0]).toMatchObject({
      body: PARTNER_PROGRAM_BOOTSTRAP_INSTRUCTIONS,
      proposed_by: fx.joinerId,
      sources: [expect.objectContaining({ kind: 'invitation_bootstrap', invitation_id: fx.invitationId })],
    });
    expect(stored.versions[1]).toMatchObject({
      body: FINANCE_ROLE_INSTRUCTIONS,
      proposed_by: fx.adminId,
      sources: [expect.objectContaining({
        kind: 'enterprise_role_template', role_template_key: 'finance-agent',
        role_template_version: '1.0.0',
      })],
    });
    expect(stored.starter).toMatchObject({
      approval_status: 'withdrawn', work_status: 'cancelled', request_status: 'withdrawn',
      revision_status: 'withdrawn', policy_active: false,
    });
    expect(stored.starter.work_reason).toContain('Finance role');
    expect(stored.assignments).toEqual([
      { skill_key: 'partner-invoice-review', state: 'active', schedule_enabled: false },
      { skill_key: 'partner-program-screening', state: 'paused', schedule_enabled: false },
    ]);
    expect(stored.policies).toEqual(expect.arrayContaining([
      { key: `partner-first-search-${fx.financeAgentId}`, active: false },
      { key: `unrelated-policy-${fx.financeAgentId}`, active: true },
    ]));
    expect(stored.screeningJobs).toBe(0);

    const db = new PgAgentDb(fx.env, fx.workspaceId, 'finance-role-conversion');
    try {
      await expect(db.loadToolNames(fx.financeAgentId)).resolves.toEqual([
        'get_partner_handoff_result', 'list_requests', 'get_request',
      ]);
      const runId = randomUUID();
      await withClient('owner', async (client) => {
        await client.query('BEGIN');
        await setTenant(client, fx.workspaceId, fx.adminId);
        const session = await client.query<{ id: string }>(
          `SELECT id FROM sessions WHERE workspace_id=$1 AND owner_id=$2 AND agent_id=$3 LIMIT 1`,
          [fx.workspaceId, fx.joinerId, fx.financeAgentId],
        );
        await client.query(
          `INSERT INTO runs (id,workspace_id,session_id,agent_id,status,mode,model_id,client_turn_id)
           VALUES ($1,$2,$3,$4,'working','work','deepseek-flash',$5)`,
          [runId, fx.workspaceId, session.rows[0]!.id, fx.financeAgentId, randomUUID()],
        );
        await client.query('COMMIT');
      });
      const run = await db.loadRun(runId);
      expect(run).toBeTruthy();
      const prompt = await buildSystemPrompt(db, run!, []);
      expect(prompt).toContain(FINANCE_ROLE_INSTRUCTIONS);
      expect(prompt).not.toContain(PARTNER_PROGRAM_BOOTSTRAP_INSTRUCTIONS);
    } finally {
      await db.close();
    }

    const lateSetup = await asUser(fx.env, fx.joinerId, `/w/${fx.workspaceId}/agents/${fx.financeAgentId}`, {
      method: 'PATCH',
      body: {
        first_run: {
          role_id: 'partner-program', role_label: 'Partner Program', loop_id: 'screen-partners',
          partner_criteria: 'Replace the Finance role with generic onboarding.',
          reviewers: {
            admission: 'You', 'role-benefits': 'You', 'external-message': 'You',
            'agreement-money': 'Admin + Finance',
          },
        },
      },
    });
    expect(lateSetup.status).toBe(409);
    await expect(lateSetup.json()).resolves.toMatchObject({ reason: 'agent_role_managed' });
    const lateStep = await asUser(fx.env, fx.joinerId, `/w/${fx.workspaceId}/agents/${fx.financeAgentId}`, {
      method: 'PATCH', body: { setup_step: 'context' },
    });
    expect(lateStep.status).toBe(409);
    await expect(lateStep.json()).resolves.toMatchObject({ reason: 'agent_role_managed' });
  });

  it('fails closed when first-run customization wins the setup lock', async () => {
    const fx = await inviteAndAccept();
    const custom = 'Keep these user-authored instructions exactly as reviewed.';
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.joinerId);
      await client.query(
        `UPDATE agents SET responsibility='Custom analyst',instructions_active=$3,
            status='started',setup_step=NULL,started_at=now()
          WHERE workspace_id=$1 AND id=$2`,
        [fx.workspaceId, fx.financeAgentId, custom],
      );
      await client.query(
        `INSERT INTO instruction_versions
           (workspace_id,agent_id,body,status,proposed_by,sources,saved_at,created_at)
         VALUES ($1,$2,$3,'saved',$4,'[{"kind":"first_run_setup"}]'::jsonb,now(),now() + interval '1 second')`,
        [fx.workspaceId, fx.financeAgentId, custom, fx.joinerId],
      );
      await client.query('COMMIT');
    });

    await expect(configure(fx)).rejects.toMatchObject({ reason: 'finance_instruction_conflict' });
    const stored = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const agent = await client.query<{ responsibility: string; instructions_active: string }>(
        `SELECT responsibility,instructions_active FROM agents WHERE workspace_id=$1 AND id=$2`,
        [fx.workspaceId, fx.financeAgentId],
      );
      const governed = await client.query(
        `SELECT 1 FROM enterprise_team_agents WHERE workspace_id=$1 AND agent_id=$2`,
        [fx.workspaceId, fx.financeAgentId],
      );
      const starter = await client.query<{ status: string; active: boolean }>(
        `SELECT ar.status,ap.active FROM approval_requests ar
          JOIN approval_policies ap ON ap.id=ar.policy_id
          WHERE ar.workspace_id=$1 AND ar.request_id=$2`,
        [fx.workspaceId, fx.starter.request_id],
      );
      return { agent: agent.rows[0]!, governed: governed.rowCount, starter: starter.rows[0]! };
    });
    expect(stored).toEqual({
      agent: { responsibility: 'Custom analyst', instructions_active: custom },
      governed: 0,
      starter: { status: 'pending', active: true },
    });
  });

  it('keeps an established Finance profile operationally unchanged and rejects newer instruction edits', async () => {
    const fx = await inviteAndAccept();
    await configure(fx);
    const proposed = 'A pending user edit must not be silently replaced.';
    const saved = 'A saved user edit must not be silently replaced.';
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `UPDATE agents SET status='provisioning',setup_step='context',started_at=NULL
          WHERE workspace_id=$1 AND id=$2`,
        [fx.workspaceId, fx.financeAgentId],
      );
      await client.query(
        `INSERT INTO instruction_versions
           (workspace_id,agent_id,body,status,proposed_by,sources,created_at)
         VALUES ($1,$2,'Discarded draft','discarded',$3,'[{"kind":"first_run_setup"}]'::jsonb,
                 now() + interval '1 second')`,
        [fx.workspaceId, fx.financeAgentId, fx.joinerId],
      );
      await client.query('COMMIT');
    });

    // A discarded draft is retained but does not replace the exact current
    // Finance revision. Idempotent configuration must not start a profile that
    // is still provisioning or rewrite its setup bookkeeping.
    await configure(fx);
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO instruction_versions
           (workspace_id,agent_id,body,status,proposed_by,sources,created_at)
         VALUES ($1,$2,$3,'proposed',$4,'[{"kind":"first_run_setup"}]'::jsonb,
                 now() + interval '2 seconds')`,
        [fx.workspaceId, fx.financeAgentId, proposed, fx.joinerId],
      );
      await client.query('COMMIT');
    });
    await expect(configure(fx)).rejects.toMatchObject({ reason: 'finance_instruction_conflict' });

    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `UPDATE instruction_versions SET status='discarded'
          WHERE workspace_id=$1 AND agent_id=$2 AND body=$3`,
        [fx.workspaceId, fx.financeAgentId, proposed],
      );
      await client.query(
        `INSERT INTO instruction_versions
           (workspace_id,agent_id,body,status,proposed_by,sources,saved_at,created_at)
         VALUES ($1,$2,$3,'saved',$4,'[{"kind":"first_run_setup"}]'::jsonb,now(),
                 now() + interval '3 seconds')`,
        [fx.workspaceId, fx.financeAgentId, saved, fx.joinerId],
      );
      await client.query('COMMIT');
    });
    await expect(configure(fx)).rejects.toMatchObject({ reason: 'finance_instruction_conflict' });

    const stored = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const agent = await client.query<{
        status: string; setup_step: string | null; started_at: Date | null; instructions_active: string;
      }>(
        `SELECT status,setup_step,started_at,instructions_active
           FROM agents WHERE workspace_id=$1 AND id=$2`,
        [fx.workspaceId, fx.financeAgentId],
      );
      const versions = await client.query<{ body: string; status: string }>(
        `SELECT body,status FROM instruction_versions
          WHERE workspace_id=$1 AND agent_id=$2 ORDER BY created_at,id`,
        [fx.workspaceId, fx.financeAgentId],
      );
      return { agent: agent.rows[0]!, versions: versions.rows };
    });
    expect(stored.agent).toEqual({
      status: 'provisioning', setup_step: 'context', started_at: null,
      instructions_active: FINANCE_ROLE_INSTRUCTIONS,
    });
    expect(stored.versions).toEqual(expect.arrayContaining([
      { body: 'Discarded draft', status: 'discarded' },
      { body: proposed, status: 'discarded' },
      { body: saved, status: 'saved' },
    ]));
  });

  it('preserves a decided starter receipt while removing future Partner scheduling authority', async () => {
    const fx = await inviteAndAccept();
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `UPDATE approval_requests SET status='approved',work_status='ready',finalized_at=now()
          WHERE workspace_id=$1 AND request_id=$2`,
        [fx.workspaceId, fx.starter.request_id],
      );
      await client.query(
        `UPDATE approval_revisions SET status='approved'
          WHERE workspace_id=$1 AND request_id=$2`,
        [fx.workspaceId, fx.starter.request_id],
      );
      await client.query(
        `UPDATE requests SET status='admitted'
          WHERE workspace_id=$1 AND id=$2`,
        [fx.workspaceId, fx.starter.request_id],
      );
      await client.query('COMMIT');
    });

    await configure(fx);
    const stored = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const row = await client.query<{
        approval_status: string; work_status: string; request_status: string;
        revision_status: string; policy_active: boolean; partner_state: string;
        partner_schedule_enabled: boolean;
      }>(
        `SELECT ar.status AS approval_status,ar.work_status,r.status AS request_status,
                rv.status AS revision_status,ap.active AS policy_active,
                esa.state AS partner_state,
                COALESCE((esa.schedule->>'enabled')::boolean,false) AS partner_schedule_enabled
           FROM approval_requests ar
           JOIN requests r ON r.id=ar.request_id
           JOIN approval_revisions rv ON rv.request_id=ar.request_id AND rv.revision=ar.authorization_revision
           JOIN approval_policies ap ON ap.id=ar.policy_id
           JOIN enterprise_skill_assignments esa
             ON esa.workspace_id=ar.workspace_id AND esa.agent_id=ar.requester_agent_id
            AND esa.skill_key='partner-program-screening'
          WHERE ar.workspace_id=$1 AND ar.request_id=$2`,
        [fx.workspaceId, fx.starter.request_id],
      );
      return row.rows[0]!;
    });
    expect(stored).toEqual({
      approval_status: 'approved', work_status: 'ready', request_status: 'admitted',
      revision_status: 'approved', policy_active: false,
      partner_state: 'paused', partner_schedule_enabled: false,
    });
  });
});
