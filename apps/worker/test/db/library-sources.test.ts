import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { captureContext } from '../../src/context-snapshot.js';
import type { TenantWork } from '../../src/routes/tenant.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const GUIDE_HASH = '10cca5f27ed6111c62c036ee68cc5aa96fe9ccb9e0ad4e1e590eb3d30b8cc05e';

describe('governed Library sources', () => {
  let fx: Fixture;
  let financeUserId: string;
  let financeAgentId: string;
  let partnershipsTeamId: string;
  let financeTeamId: string;
  const env = makeEnv().env;

  beforeEach(async () => {
    fx = await seedWorkspace();
    financeUserId = randomUUID();
    financeAgentId = randomUUID();
    partnershipsTeamId = randomUUID();
    financeTeamId = randomUUID();
    await withClient('owner', async (tx) => {
      await tx.query('BEGIN');
      await tx.query(`INSERT INTO users(id,email,email_verified,name) VALUES($1,$2,true,'Finance Principal')`, [financeUserId, `finance-${financeUserId}@example.test`]);
      await setTenant(tx, fx.workspaceId, fx.adminId);
      await tx.query(`INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'member')`, [fx.workspaceId, financeUserId]);
      await tx.query(`INSERT INTO agents(id,workspace_id,name,status) VALUES($1,$2,'Ledger','started')`, [financeAgentId, fx.workspaceId]);
      await tx.query(
        `INSERT INTO enterprise_teams(id,workspace_id,slug,name) VALUES
          ($1,$3,'partnerships','Partnerships'),($2,$3,'finance','Finance')`,
        [partnershipsTeamId, financeTeamId, fx.workspaceId],
      );
      await tx.query(
        `INSERT INTO enterprise_team_agents(workspace_id,team_id,agent_id,principal_user_id,role_template_key) VALUES
          ($1,$2,$3,$4,'partnerships-agent'),($1,$5,$6,$7,'finance-agent')`,
        [fx.workspaceId, partnershipsTeamId, fx.agentId, fx.memberId, financeTeamId, financeAgentId, financeUserId],
      );
      await tx.query('COMMIT');
    });
    await withClient('app', async (tx) => {
      await tx.query('BEGIN');
      await setTenant(tx, fx.workspaceId, fx.adminId);
      await tx.query('SELECT ensure_partner_program_guide($1,$2)', [fx.workspaceId, fx.adminId]);
      await tx.query('SELECT ensure_partner_program_guide($1,$2)', [fx.workspaceId, fx.adminId]);
      await tx.query('COMMIT');
    });
  });

  const url = (agentId: string) => `/w/${fx.workspaceId}/library-sources?agent_id=${agentId}`;

  it('lists one matching version for both intended team principals and nothing for an unrelated admin', async () => {
    const partnerships = await asUser(env, fx.memberId, url(fx.agentId));
    expect(partnerships.status).toBe(200);
    const partnershipsBody = await partnerships.json() as { items: Array<Record<string, unknown>> };
    expect(partnershipsBody.items).toHaveLength(1);
    expect(partnershipsBody.items[0]).toMatchObject({
      title: 'Partner Program Guide', version: 1, version_label: '0.1 draft', sha256: GUIDE_HASH,
      audiences: ['Finance', 'Partnerships'], kind: 'library_source',
    });
    expect(String(partnershipsBody.items[0]?.content_markdown)).toContain('## From prospect to invoice');

    const finance = await asUser(env, financeUserId, url(financeAgentId));
    expect(finance.status).toBe(200);
    expect(((await finance.json()) as { items: unknown[] }).items).toHaveLength(1);

    expect((await asUser(env, fx.adminId, url(fx.agentId))).status).toBe(404);
    const unscoped = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/library-sources`);
    expect(unscoped.status).toBe(200);
    expect(((await unscoped.json()) as { items: unknown[] }).items).toEqual([]);

    await withClient('owner', async (tx) => {
      await tx.query('BEGIN');
      await setTenant(tx, fx.workspaceId, fx.adminId);
      const count = await tx.query(
        `SELECT count(*)::int AS count FROM library_source_versions v
          JOIN library_sources s ON s.id=v.source_id WHERE s.workspace_id=$1 AND s.slug='partner-program-guide'`,
        [fx.workspaceId],
      );
      expect(count.rows[0]?.count).toBe(1);
      await tx.query('ROLLBACK');
    });
  });

  it('captures the exact Library version, fails closed after grant revocation, and keeps the admitted snapshot', async () => {
    const sessionId = randomUUID();
    const runId = randomUUID();
    await withClient('app', async (tx) => {
      await tx.query('BEGIN');
      await setTenant(tx, fx.workspaceId, fx.memberId);
      const work = { tx, workspaceId: fx.workspaceId, userId: fx.memberId } as unknown as TenantWork;
      const source = (await tx.query<{ id: string }>(
        `SELECT id FROM library_sources WHERE workspace_id=$1 AND slug='partner-program-guide'`, [fx.workspaceId],
      )).rows[0]!;
      const snapshot = await captureContext(work, env, fx.agentId, [{ id: source.id, kind: 'library_source', sha256: GUIDE_HASH }]);
      expect(snapshot).toMatchObject({ sources: [{ id: source.id, kind: 'library_source', sha256: GUIDE_HASH }] });
      expect(JSON.stringify(snapshot)).toContain('The guide is reference material');
      await tx.query(
        `INSERT INTO sessions(id,workspace_id,owner_id,agent_id,title,model_id) VALUES($1,$2,$3,$4,'Guide run','deepseek-flash')`,
        [sessionId, fx.workspaceId, fx.memberId, fx.agentId],
      );
      await tx.query(
        `INSERT INTO runs(id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,context_snapshot)
         VALUES($1,$2,$3,$4,'completed','deepseek-flash','guide-snapshot',$5::jsonb)`,
        [runId, fx.workspaceId, sessionId, fx.agentId, JSON.stringify(snapshot)],
      );
      await tx.query('COMMIT');
    });

    await withClient('owner', async (tx) => {
      await tx.query('BEGIN');
      await setTenant(tx, fx.workspaceId, fx.adminId);
      await tx.query(
        `DELETE FROM library_source_team_grants WHERE workspace_id=$1 AND team_id=$2`,
        [fx.workspaceId, partnershipsTeamId],
      );
      await tx.query('COMMIT');
    });

    const after = await asUser(env, fx.memberId, url(fx.agentId));
    expect(after.status).toBe(200);
    expect(((await after.json()) as { items: unknown[] }).items).toEqual([]);
    await withClient('app', async (tx) => {
      await tx.query('BEGIN');
      await setTenant(tx, fx.workspaceId, fx.memberId);
      const work = { tx, workspaceId: fx.workspaceId, userId: fx.memberId } as unknown as TenantWork;
      const source = (await tx.query<{ id: string }>(
        `SELECT id FROM library_sources WHERE workspace_id=$1 AND slug='partner-program-guide'`, [fx.workspaceId],
      )).rows[0]!;
      await expect(captureContext(work, env, fx.agentId, [{ id: source.id, kind: 'library_source', sha256: GUIDE_HASH }]))
        .rejects.toMatchObject({ reason: 'context_source_missing', status: 422 });
      const stored = await tx.query<{ context_snapshot: { sources: Array<{ text: string }> } }>(
        'SELECT context_snapshot FROM runs WHERE workspace_id=$1 AND id=$2', [fx.workspaceId, runId],
      );
      expect(stored.rows[0]?.context_snapshot.sources[0]?.text).toContain('## Information shared between teams');
      await tx.query('ROLLBACK');
    });
  });
});
