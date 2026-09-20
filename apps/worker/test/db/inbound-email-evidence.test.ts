import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApprovalProposal, ApprovalView } from '@hermes/shared';
import { withTenantTransaction } from '../../src/db/client.js';
import { proposeApproval } from '../../src/domain/approvals.js';
import type { Env } from '../../src/env.js';
import type { NormalizedGmailThread } from '../../src/inbound-email/gmail-read-api.js';
import { recordInboundEvents } from '../../src/inbound-email/service.js';
import type { TenantWork } from '../../src/routes/tenant.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const env = makeEnv().env;

interface SeededSnapshot {
  snapshotId: string;
  teamId: string;
  accountId: string;
  sourceId: string;
  versionId: string;
}

async function seedSnapshot(fx: Fixture): Promise<SeededSnapshot> {
  const teamId = randomUUID();
  const accountId = randomUUID();
  const sourceId = randomUUID();
  const versionId = randomUUID();
  const snapshotId = randomUUID();
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    await c.query(
      `INSERT INTO enterprise_teams (id,workspace_id,slug,name) VALUES ($1,$2,'partnerships','Partnerships')`,
      [teamId, fx.workspaceId],
    );
    await c.query(
      `INSERT INTO enterprise_team_agents
         (workspace_id,team_id,agent_id,principal_user_id,role_template_key)
       VALUES ($1,$2,$3,$4,'partnerships-agent')`,
      [fx.workspaceId, teamId, fx.agentId, fx.adminId],
    );
    await c.query(
      `INSERT INTO gmail_evidence_accounts
         (id,workspace_id,address,ciphertext,iv,wrapped_dek,wrap_iv,kek_version,scope,token_expires_at,connected_by)
       VALUES ($1,$2,'iris@example.test','\\x01','\\x02','\\x03','\\x04',1,
         'https://www.googleapis.com/auth/gmail.readonly',now() + interval '1 hour',$3)`,
      [accountId, fx.workspaceId, fx.adminId],
    );
    await c.query(
      `INSERT INTO library_sources (id,workspace_id,slug,title,summary,created_by)
       VALUES ($1,$2,$3,'Selected partner thread','Immutable selected Gmail evidence.',$4)`,
      [sourceId, fx.workspaceId, `gmail-thread-${sourceId.replaceAll('-', '').slice(0, 16)}`, fx.adminId],
    );
    await c.query(
      `INSERT INTO library_source_versions
         (id,workspace_id,source_id,version,version_label,sha256,content_markdown,created_by)
       VALUES ($1,$2,$3,1,'Gmail snapshot 1',$4,'# Imported Gmail thread evidence',$5)`,
      [versionId, fx.workspaceId, sourceId, 'a'.repeat(64), fx.adminId],
    );
    await c.query(
      `INSERT INTO library_source_team_grants (workspace_id,source_id,team_id,granted_by)
       VALUES ($1,$2,$3,$4)`,
      [fx.workspaceId, sourceId, teamId, fx.adminId],
    );
    await c.query(
      `INSERT INTO mailbox_thread_snapshots
         (id,workspace_id,account_id,team_id,library_source_id,library_version_id,provider,
          provider_thread_id,title,message_count,normalized_sha256,normalized_thread,imported_by)
       VALUES ($1,$2,$3,$4,$5,$6,'gmail','thread_1234','Selected partner thread',1,$7,$8::jsonb,$9)`,
      [snapshotId, fx.workspaceId, accountId, teamId, sourceId, versionId, 'a'.repeat(64),
        JSON.stringify({ messages: [{ direction: 'inbound', sent_at: '2026-09-19T12:00:00.000Z',
          from: { address: 'partner@example.test' }, text_body: 'The access was granted outside Hermes.' }] }),
        fx.adminId],
    );
    await c.query('COMMIT');
  });
  return { snapshotId, teamId, accountId, sourceId, versionId };
}

async function seedAdditionalSnapshot(
  fx: Fixture,
  parent: Pick<SeededSnapshot, 'teamId' | 'accountId'>,
): Promise<SeededSnapshot> {
  const sourceId = randomUUID();
  const versionId = randomUUID();
  const snapshotId = randomUUID();
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    await c.query(
      `INSERT INTO library_sources (id,workspace_id,slug,title,summary,created_by)
       VALUES ($1,$2,$3,'Other selected thread','Other immutable selected Gmail evidence.',$4)`,
      [sourceId, fx.workspaceId, `gmail-thread-${sourceId.replaceAll('-', '')}`, fx.adminId],
    );
    await c.query(
      `INSERT INTO library_source_versions
         (id,workspace_id,source_id,version,version_label,sha256,content_markdown,created_by)
       VALUES ($1,$2,$3,1,'Gmail snapshot 1',$4,'# Other selected thread',$5)`,
      [versionId, fx.workspaceId, sourceId, 'e'.repeat(64), fx.adminId],
    );
    await c.query(
      `INSERT INTO library_source_team_grants (workspace_id,source_id,team_id,granted_by)
       VALUES ($1,$2,$3,$4)`,
      [fx.workspaceId, sourceId, parent.teamId, fx.adminId],
    );
    await c.query(
      `INSERT INTO mailbox_thread_snapshots
         (id,workspace_id,account_id,team_id,library_source_id,library_version_id,provider,
          provider_thread_id,title,message_count,normalized_sha256,normalized_thread,imported_by)
       VALUES ($1,$2,$3,$4,$5,$6,'gmail','thread_other','Other selected thread',1,$7,'{}'::jsonb,$8)`,
      [snapshotId, fx.workspaceId, parent.accountId, parent.teamId, sourceId, versionId,
        'e'.repeat(64), fx.adminId],
    );
    await c.query('COMMIT');
  });
  return { snapshotId, teamId: parent.teamId, accountId: parent.accountId, sourceId, versionId };
}

async function seedEffect(fx: Fixture, kind: 'access_grant' | 'signature' | 'payment'): Promise<string> {
  const requestId = randomUUID();
  const decisionId = randomUUID();
  const effectId = randomUUID();
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    await c.query(
      `INSERT INTO requests (id,workspace_id,kind,label,payload,status,session_id)
       VALUES ($1,$2,'application','External completion','{}'::jsonb,'pending',$3)`,
      [requestId, fx.workspaceId, fx.sessionId],
    );
    await c.query(
      `INSERT INTO decisions (id,workspace_id,request_id,decision,resulting_status,decided_by)
       VALUES ($1,$2,$3,'approve','admitted',$4)`,
      [decisionId, fx.workspaceId, requestId, fx.adminId],
    );
    await c.query(
      `INSERT INTO effects (id,workspace_id,decision_id,request_id,kind,status,required_role)
       VALUES ($1,$2,$3,$4,$5,'pending','access')`,
      [effectId, fx.workspaceId, decisionId, requestId, kind],
    );
    await c.query('COMMIT');
  });
  return effectId;
}

async function seedBoundEffect(
  fx: Fixture,
  snapshotId: string,
  kind: 'access_grant' | 'signature' = 'access_grant',
): Promise<{ effectId: string; view: ApprovalView }> {
  let adminMemberId = '';
  const resourceKey = `mailbox-evidence-${snapshotId}`;
  const policyKey = `external-evidence-${randomUUID()}`;
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    const member = await c.query<{ id: string }>(
      `SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2 AND status='active'`,
      [fx.workspaceId, fx.adminId],
    );
    adminMemberId = member.rows[0]!.id;
    await c.query(
      `INSERT INTO agent_owners (workspace_id,agent_id,member_id)
       VALUES ($1,$2,$3) ON CONFLICT (agent_id) DO UPDATE SET member_id=EXCLUDED.member_id`,
      [fx.workspaceId, fx.agentId, adminMemberId],
    );
    await c.query(
      `INSERT INTO approval_resources
         (workspace_id,resource_key,kind,label,owner_member_id,version,sha256,executor_available)
       VALUES ($1,$2,'artifact','Selected Gmail evidence',$3,'1',$4,false)`,
      [fx.workspaceId, resourceKey, adminMemberId, 'a'.repeat(64)],
    );
    await c.query(
      `INSERT INTO approval_policies
         (workspace_id,key,version,approval_type,requester_agent_id,priority,mode,prevent_self_review,steps)
       VALUES ($1,$2,1,'access',$3,100,'sequential',false,$4::jsonb)`,
      [fx.workspaceId, policyKey, fx.agentId, JSON.stringify([{
        id: 'owner-review', label: 'Owner review', order: 0,
        reviewers: [{ kind: 'member', member_id: adminMemberId }], quorum: 1,
      }])],
    );
    await c.query('COMMIT');
  });
  const proposal: ApprovalProposal = {
    kind: 'approval', approval_type: 'access', illustrative: false,
    summary: 'Review evidence for an external access completion.',
    consequence: 'Records a non-provider-verified receipt and executes nothing.',
    evidence: [{ id: snapshotId, kind: 'source', label: 'Selected Gmail thread snapshot' }],
    details: {
      resource_id: resourceKey,
      resource_label: 'Selected Gmail evidence',
      requested_agent_id: fx.agentId,
      operations: ['read'],
      purpose: 'Verify the exact externally completed access action.',
      access_expires_at: '2026-10-01T17:00:00-07:00',
    },
  };
  const view = await withTenantTransaction(
    env,
    'app',
    { workspaceId: fx.workspaceId, userId: fx.adminId },
    (tx) => proposeApproval(
      { tx, workspaceId: fx.workspaceId, jobs: [], agentId: fx.agentId,
        userId: fx.adminId, sessionId: fx.sessionId },
      { label: proposal.summary, policy_key: policyKey, proposal,
        target_agent_ids: [], target_member_ids: [], target_resource_ids: [], dependent_request_ids: [],
        idempotency_key: `external-evidence:${randomUUID()}` },
    ),
  );
  const effectId = randomUUID();
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    await c.query(`UPDATE approval_requests SET status='approved' WHERE request_id=$1`, [view.request_id]);
    await c.query(
      `UPDATE approval_revisions SET status='approved' WHERE request_id=$1 AND revision=$2`,
      [view.request_id, view.payload.authorization.revision],
    );
    await c.query(
      `INSERT INTO request_audiences (workspace_id,request_id,user_id,purpose)
       VALUES ($1,$2,$3,'reviewer')`,
      [fx.workspaceId, view.request_id, fx.adminId],
    );
    const decision = await c.query<{ id: string }>(
      `INSERT INTO decisions (workspace_id,request_id,decision,resulting_status,decided_by)
       VALUES ($1,$2,'approve','admitted',$3) RETURNING id`,
      [fx.workspaceId, view.request_id, fx.adminId],
    );
    await c.query(
      `INSERT INTO effects
         (id,workspace_id,decision_id,request_id,kind,status,required_role)
       VALUES ($1,$2,$3,$4,$5,'pending','access')`,
      [effectId, fx.workspaceId, decision.rows[0]!.id, view.request_id, kind],
    );
    await c.query('COMMIT');
  });
  return { effectId, view };
}

async function seedOutreach(
  fx: Fixture,
  threadId: string,
  recipient = 'partner@example.test',
): Promise<{ candidateId: string; requestId: string }> {
  const screeningRunId = randomUUID();
  const candidateId = randomUUID();
  const requestId = randomUUID();
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    await c.query(
      `INSERT INTO partner_screening_runs
         (id,workspace_id,agent_id,created_by,idempotency_key,status,source,authentication,config_snapshot,api_requests_max)
       VALUES ($1,$2,$3,$4,$5,'completed','github','unauthenticated','{}',1)`,
      [screeningRunId, fx.workspaceId, fx.agentId, fx.adminId, randomUUID()],
    );
    await c.query(
      `INSERT INTO partner_candidates
         (id,workspace_id,agent_id,source,source_key,display_name,profile_url,
          deterministic_priority,priority_breakdown,confidence,latest_run_id,first_seen_at,last_seen_at)
       VALUES ($1,$2,$3,'github',$4,'Partner','https://github.com/example',80,'{}','high',$5,now(),now())`,
      [candidateId, fx.workspaceId, fx.agentId, randomUUID(), screeningRunId],
    );
    await c.query(
      `INSERT INTO requests (id,workspace_id,kind,label,payload,status,session_id)
       VALUES ($1,$2,'application','Partner outreach','{}','pending',$3)`,
      [requestId, fx.workspaceId, fx.sessionId],
    );
    await c.query(
      `INSERT INTO partner_engagements (workspace_id,agent_id,candidate_id,request_id,stage)
       VALUES ($1,$2,$3,$4,'sent')`,
      [fx.workspaceId, fx.agentId, candidateId, requestId],
    );
    const hash = `sha256:${'b'.repeat(64)}`;
    await c.query(
      `INSERT INTO outbound_email_outbox
         (workspace_id,request_id,authorization_revision,authorization_hash,candidate_id,
          recipient_index,sender_address,recipient_name,recipient_address,subject,body,state,
          provider_message_id,provider_thread_id,sent_at)
       VALUES
         ($1,$2,1,$3,$4,0,'iris@example.test','Partner',$5,'Hello','Reviewed','sent','sent-1',$6,now()-interval '1 hour'),
         ($1,$2,1,$3,$4,1,'iris@example.test','Partner',$5,'Follow up','Reviewed','queued',NULL,NULL,NULL)`,
      [fx.workspaceId, requestId, hash, candidateId, recipient, threadId],
    );
    await c.query('COMMIT');
  });
  return { candidateId, requestId };
}

describe('inbound email and external evidence database boundaries', () => {
  it('keeps snapshots append-only and hidden from the agent database role', async () => {
    const fx = await seedWorkspace();
    const { snapshotId, sourceId, teamId } = await seedSnapshot(fx);
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await expect(c.query(
        `UPDATE mailbox_thread_snapshots SET title='mutated' WHERE id=$1`, [snapshotId],
      )).rejects.toThrow();
      await c.query('ROLLBACK');
    });
    await withClient('agent', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await expect(c.query(`SELECT * FROM mailbox_thread_snapshots WHERE id=$1`, [snapshotId]))
        .rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await expect(c.query(
        `DELETE FROM library_source_team_grants
          WHERE workspace_id=$1 AND source_id=$2 AND team_id=$3`,
        [fx.workspaceId, sourceId, teamId],
      )).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
  });

  it('rejects app-role snapshot bindings to the wrong source or a foreign workspace version', async () => {
    const fx = await seedWorkspace();
    const local = await seedSnapshot(fx);
    const foreignFx = await seedWorkspace();
    const foreign = await seedSnapshot(foreignFx);
    const foreignUnboundVersionId = randomUUID();
    const otherSourceId = randomUUID();
    const otherVersionId = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, foreignFx.workspaceId, foreignFx.adminId);
      await c.query(
        `INSERT INTO library_source_versions
           (id,workspace_id,source_id,version,version_label,sha256,content_markdown,created_by)
         VALUES ($1,$2,$3,2,'Foreign v2',$4,'# Foreign unbound version',$5)`,
        [foreignUnboundVersionId, foreignFx.workspaceId, foreign.sourceId, 'f'.repeat(64), foreignFx.adminId],
      );
      await c.query('COMMIT');
    });
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO library_sources (id,workspace_id,slug,title,summary,created_by)
         VALUES ($1,$2,$3,'Other source','Other immutable evidence.',$4)`,
        [otherSourceId, fx.workspaceId, `other-${otherSourceId.replaceAll('-', '')}`, fx.adminId],
      );
      await c.query(
        `INSERT INTO library_source_versions
           (id,workspace_id,source_id,version,version_label,sha256,content_markdown,created_by)
         VALUES ($1,$2,$3,1,'Other v1',$4,'# Other source',$5)`,
        [otherVersionId, fx.workspaceId, otherSourceId, 'b'.repeat(64), fx.adminId],
      );
      await c.query(
        `INSERT INTO library_source_team_grants (workspace_id,source_id,team_id,granted_by)
         VALUES ($1,$2,$3,$4)`,
        [fx.workspaceId, otherSourceId, local.teamId, fx.adminId],
      );
      await c.query('COMMIT');
    });
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await expect(c.query(
        `INSERT INTO mailbox_thread_snapshots
           (workspace_id,account_id,team_id,library_source_id,library_version_id,provider,
            provider_thread_id,title,message_count,normalized_sha256,normalized_thread,imported_by)
         VALUES ($1,$2,$3,$4,$5,'gmail','wrong-source','Wrong source',1,$6,'{}'::jsonb,$7)`,
        [fx.workspaceId, local.accountId, local.teamId, local.sourceId, otherVersionId, 'c'.repeat(64), fx.adminId],
      )).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await expect(c.query(
        `INSERT INTO mailbox_thread_snapshots
           (workspace_id,account_id,team_id,library_source_id,library_version_id,provider,
            provider_thread_id,title,message_count,normalized_sha256,normalized_thread,imported_by)
         VALUES ($1,$2,$3,$4,$5,'gmail','foreign-version','Foreign version',1,$6,'{}'::jsonb,$7)`,
        [fx.workspaceId, local.accountId, local.teamId, foreign.sourceId, foreignUnboundVersionId,
          'd'.repeat(64), fx.adminId],
      )).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
  });

  it('keeps a newer same-thread Team B version out of Team A latest-source lookup', async () => {
    const fx = await seedWorkspace();
    const teamA = await seedSnapshot(fx);
    const agentB = randomUUID();
    const teamB = randomUUID();
    const sourceB = randomUUID();
    const versionB1 = randomUUID();
    const versionB2 = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(`INSERT INTO agents (id,workspace_id,name,status) VALUES ($1,$2,'Finance Iris','started')`, [agentB, fx.workspaceId]);
      await c.query(`INSERT INTO enterprise_teams (id,workspace_id,slug,name) VALUES ($1,$2,'finance','Finance')`, [teamB, fx.workspaceId]);
      await c.query(
        `INSERT INTO enterprise_team_agents
           (workspace_id,team_id,agent_id,principal_user_id,role_template_key)
         VALUES ($1,$2,$3,$4,'finance-agent')`,
        [fx.workspaceId, teamB, agentB, fx.memberId],
      );
      await c.query(
        `INSERT INTO library_sources (id,workspace_id,slug,title,summary,created_by)
         VALUES ($1,$2,$3,'Selected partner thread','Team B selected Gmail evidence.',$4)`,
        [sourceB, fx.workspaceId, `gmail-thread-${sourceB.replaceAll('-', '')}`, fx.memberId],
      );
      await c.query(
        `INSERT INTO library_source_versions
           (id,workspace_id,source_id,version,version_label,sha256,content_markdown,created_by)
         VALUES
           ($1,$3,$4,1,'Gmail snapshot 1',$5,'# Team B v1',$7),
           ($2,$3,$4,2,'Gmail snapshot 2',$6,'# Team B v2 private',$7)`,
        [versionB1, versionB2, fx.workspaceId, sourceB, 'b'.repeat(64), 'c'.repeat(64), fx.memberId],
      );
      await c.query(
        `INSERT INTO library_source_team_grants (workspace_id,source_id,team_id,granted_by)
         VALUES ($1,$2,$3,$4)`,
        [fx.workspaceId, sourceB, teamB, fx.memberId],
      );
      for (const [versionId, digest, title] of [
        [versionB1, 'b'.repeat(64), 'Team B v1'],
        [versionB2, 'c'.repeat(64), 'Team B v2'],
      ] as const) {
        await c.query(
          `INSERT INTO mailbox_thread_snapshots
             (workspace_id,account_id,team_id,library_source_id,library_version_id,provider,
              provider_thread_id,title,message_count,normalized_sha256,normalized_thread,imported_by)
           VALUES ($1,$2,$3,$4,$5,'gmail','thread_1234',$6,1,$7,'{}'::jsonb,$8)`,
          [fx.workspaceId, teamA.accountId, teamB, sourceB, versionId, title, digest, fx.memberId],
        );
      }
      await c.query('COMMIT');
    });
    const teamAResponse = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/library-sources?agent_id=${fx.agentId}`);
    const teamBResponse = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/library-sources?agent_id=${agentB}`);
    expect(teamAResponse.status).toBe(200);
    expect(teamBResponse.status).toBe(200);
    const teamABody = await teamAResponse.json() as { items: Array<{ id: string; version: number; content_markdown: string }> };
    const teamBBody = await teamBResponse.json() as { items: Array<{ id: string; version: number; content_markdown: string }> };
    expect(teamABody.items).toContainEqual(expect.objectContaining({ id: teamA.sourceId, version: 1 }));
    expect(teamABody.items.some((item) => item.id === sourceB || item.content_markdown.includes('Team B'))).toBe(false);
    expect(teamBBody.items).toContainEqual(expect.objectContaining({ id: sourceB, version: 2, content_markdown: '# Team B v2 private' }));
  });

  it('records access evidence without executing the effect or creating outbound work', async () => {
    const fx = await seedWorkspace();
    const { snapshotId } = await seedSnapshot(fx);
    const { effectId, view } = await seedBoundEffect(fx, snapshotId);
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/effects/${effectId}/external-evidence`, {
      method: 'POST',
      body: { snapshot_id: snapshotId, occurred_at: new Date(Date.now() - 60_000).toISOString(), note: 'Completed by the workspace owner in the provider.' },
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      effect_id: effectId,
      effect_kind: 'access_grant',
      claimed_outcome: 'completed_outside_hermes',
      verification: 'evidence_recorded_not_provider_verified',
      provider_execution_by_hermes: false,
    });
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const effect = await c.query<{ status: string; executed_at: Date | null }>(
        `SELECT status,executed_at FROM effects WHERE id=$1`, [effectId],
      );
      expect(effect.rows[0]).toEqual({ status: 'pending', executed_at: null });
      const jobs = await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM jobs WHERE workspace_id=$1 AND kind='outbound_email_send'`,
        [fx.workspaceId],
      );
      const receipt = await c.query<{
        request_id: string;
        authorization_revision: number;
        authorization_hash: string;
        library_source_id: string;
        library_version_id: string;
      }>(
        `SELECT request_id,authorization_revision,authorization_hash,
                library_source_id,library_version_id
           FROM external_effect_evidence_receipts
          WHERE workspace_id=$1 AND effect_id=$2`,
        [fx.workspaceId, effectId],
      );
      expect(jobs.rows[0]?.count).toBe('0');
      expect(receipt.rows[0]).toMatchObject({
        request_id: view.request_id,
        authorization_revision: view.payload.authorization.revision,
        authorization_hash: view.payload.authorization.hash,
      });
      expect(receipt.rows[0]?.library_source_id).toBeTruthy();
      expect(receipt.rows[0]?.library_version_id).toBeTruthy();
      await c.query('COMMIT');
    });
  });

  it('rejects future external-evidence timestamps before writing a receipt', async () => {
    const fx = await seedWorkspace();
    const { snapshotId } = await seedSnapshot(fx);
    const { effectId } = await seedBoundEffect(fx, snapshotId);
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/effects/${effectId}/external-evidence`, {
      method: 'POST',
      body: { snapshot_id: snapshotId, occurred_at: new Date(Date.now() + 60_000).toISOString(), note: 'Impossible future completion.' },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ reason: 'future_evidence_time' });
  });

  it('rejects an accessible snapshot that is not cited by the approved effect revision', async () => {
    const fx = await seedWorkspace();
    const cited = await seedSnapshot(fx);
    const uncited = await seedAdditionalSnapshot(fx, cited);
    const { effectId } = await seedBoundEffect(fx, cited.snapshotId);
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/effects/${effectId}/external-evidence`, {
      method: 'POST',
      body: { snapshot_id: uncited.snapshotId, occurred_at: new Date(Date.now() - 60_000).toISOString(), note: 'Wrong evidence.' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'evidence_binding_required' });
  });

  it('serves cited mailbox evidence to the approval audience, not the requester team principal', async () => {
    const fx = await seedWorkspace();
    const { snapshotId } = await seedSnapshot(fx);
    const { view } = await seedBoundEffect(fx, snapshotId);
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(`DELETE FROM request_audiences WHERE workspace_id=$1 AND request_id=$2`, [fx.workspaceId, view.request_id]);
      await c.query(
        `INSERT INTO request_audiences (workspace_id,request_id,user_id,purpose)
         VALUES ($1,$2,$3,'reviewer')`,
        [fx.workspaceId, view.request_id, fx.memberId],
      );
      await c.query('COMMIT');
    });
    const path = `/w/${fx.workspaceId}/requests/${view.request_id}/approval/evidence/${snapshotId}`;
    const reviewer = await asUser(env, fx.memberId, path);
    expect(reviewer.status).toBe(200);
    expect(await reviewer.json()).toMatchObject({ id: snapshotId, kind: 'mailbox_thread' });
    const principalOutsideAudience = await asUser(env, fx.adminId, path);
    expect(principalOutsideAudience.status).toBe(404);
    expect(await principalOutsideAudience.json()).toMatchObject({ reason: 'approval_evidence_unavailable' });
  });

  it('turns an explicit unsubscribe reply into a durable stop and never a send', async () => {
    const fx = await seedWorkspace();
    const { snapshotId } = await seedSnapshot(fx);
    const screeningRunId = randomUUID();
    const candidateId = randomUUID();
    const requestId = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO partner_screening_runs
           (id,workspace_id,agent_id,created_by,idempotency_key,status,source,authentication,config_snapshot,api_requests_max)
         VALUES ($1,$2,$3,$4,$5,'completed','github','unauthenticated','{}',1)`,
        [screeningRunId, fx.workspaceId, fx.agentId, fx.adminId, randomUUID()],
      );
      await c.query(
        `INSERT INTO partner_candidates
           (id,workspace_id,agent_id,source,source_key,display_name,profile_url,
            deterministic_priority,priority_breakdown,confidence,latest_run_id,first_seen_at,last_seen_at)
         VALUES ($1,$2,$3,'github',$4,'Partner','https://github.com/example',80,'{}','high',$5,now(),now())`,
        [candidateId, fx.workspaceId, fx.agentId, randomUUID(), screeningRunId],
      );
      await c.query(
        `INSERT INTO requests (id,workspace_id,kind,label,payload,status,session_id)
         VALUES ($1,$2,'application','Partner outreach','{}','pending',$3)`,
        [requestId, fx.workspaceId, fx.sessionId],
      );
      await c.query(
        `INSERT INTO partner_engagements (workspace_id,agent_id,candidate_id,request_id,stage)
         VALUES ($1,$2,$3,$4,'sent')`,
        [fx.workspaceId, fx.agentId, candidateId, requestId],
      );
      const hash = `sha256:${'b'.repeat(64)}`;
      await c.query(
        `INSERT INTO outbound_email_outbox
           (workspace_id,request_id,authorization_revision,authorization_hash,candidate_id,
            recipient_index,sender_address,recipient_name,recipient_address,subject,body,state,
            provider_message_id,provider_thread_id,sent_at)
         VALUES
           ($1,$2,1,$3,$4,0,'iris@example.test','Partner','partner@example.test','Hello','Reviewed','sent','sent-1','thread_1234',now()-interval '1 hour'),
           ($1,$2,1,$3,$4,1,'iris@example.test','Partner','partner@example.test','Follow up','Reviewed','queued',NULL,NULL,NULL)`,
        [fx.workspaceId, requestId, hash, candidateId],
      );
      await c.query('COMMIT');
    });

    const thread: NormalizedGmailThread = {
      provider: 'gmail', provider_thread_id: 'thread_1234', mailbox_address: 'iris@example.test',
      subject: 'Re: Hello',
      messages: [{
        provider_message_id: 'reply-1', internet_message_id: null, in_reply_to: null, references: [],
        sent_at: new Date().toISOString(), from: { name: 'Partner', address: 'partner@example.test' },
        to: [{ name: 'Iris', address: 'iris@example.test' }], cc: [], direction: 'inbound',
        subject: 'Re: Hello', snippet: 'Please unsubscribe me.', text_body: 'Please unsubscribe me.',
        content_type: 'text/plain', auto_submitted: null, list_unsubscribe: null, attachments: [],
      }],
    };
    const events = await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const work = {
        tx: c, workspaceId: fx.workspaceId, userId: fx.adminId, jobs: [],
      } as unknown as TenantWork;
      const recorded = await recordInboundEvents(work, snapshotId, thread);
      await c.query('COMMIT');
      return recorded;
    });
    expect(events).toEqual({ replies: 1, bounces: 0, unsubscribes: 1, sends_enqueued: 0 });
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const engagement = await c.query<{ stage: string }>(
        `SELECT stage FROM partner_engagements WHERE candidate_id=$1`, [candidateId],
      );
      const queued = await c.query<{ state: string; last_error: string | null }>(
        `SELECT state,last_error FROM outbound_email_outbox WHERE request_id=$1 AND recipient_index=1`, [requestId],
      );
      const suppression = await c.query<{ reason: string }>(
        `SELECT reason FROM contact_suppressions WHERE workspace_id=$1 AND address='partner@example.test'`,
        [fx.workspaceId],
      );
      const jobs = await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM jobs WHERE workspace_id=$1 AND kind='outbound_email_send'`,
        [fx.workspaceId],
      );
      expect(engagement.rows[0]?.stage).toBe('suppressed');
      expect(queued.rows[0]).toEqual({ state: 'cancelled', last_error: 'recipient_unsubscribed' });
      expect(suppression.rows[0]?.reason).toBe('unsubscribe');
      expect(jobs.rows[0]?.count).toBe('0');
      await c.query('COMMIT');
    });
  });

  it('records DSN-looking text as unverified evidence without suppressing or cancelling outreach', async () => {
    const fx = await seedWorkspace();
    const { snapshotId } = await seedSnapshot(fx);
    const { candidateId, requestId } = await seedOutreach(fx, 'thread_1234', 'partner@example.test');
    const thread: NormalizedGmailThread = {
      provider: 'gmail', provider_thread_id: 'thread_1234', mailbox_address: 'iris@example.test',
      subject: 'Delivery status notification',
      messages: [{
        provider_message_id: 'spoofed-dsn-1', internet_message_id: null, in_reply_to: null, references: [],
        sent_at: new Date().toISOString(),
        from: { name: 'Mail Delivery Subsystem', address: 'mailer-daemon@example.test' },
        to: [{ name: 'Iris', address: 'iris@example.test' }], cc: [], direction: 'inbound',
        subject: 'Delivery status notification', snippet: 'Delivery failed',
        text_body: 'Final-Recipient: rfc822; partner@example.test\nAction: failed\nStatus: 5.1.1',
        content_type: 'message/delivery-status', auto_submitted: null, list_unsubscribe: null, attachments: [],
      }],
    };
    const events = await withClient('app', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const work = { tx: c, workspaceId: fx.workspaceId, userId: fx.adminId, jobs: [] } as unknown as TenantWork;
      const recorded = await recordInboundEvents(work, snapshotId, thread);
      await c.query('COMMIT');
      return recorded;
    });
    expect(events).toEqual({ replies: 0, bounces: 1, unsubscribes: 0, sends_enqueued: 0 });
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const event = await c.query<{ evidence: Record<string, unknown> }>(
        `SELECT evidence FROM inbound_email_events
          WHERE workspace_id=$1 AND snapshot_id=$2 AND provider_message_id='spoofed-dsn-1'`,
        [fx.workspaceId, snapshotId],
      );
      const suppression = await c.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM contact_suppressions
          WHERE workspace_id=$1 AND address='partner@example.test'`,
        [fx.workspaceId],
      );
      const engagement = await c.query<{ stage: string }>(
        `SELECT stage FROM partner_engagements WHERE workspace_id=$1 AND candidate_id=$2`,
        [fx.workspaceId, candidateId],
      );
      const queued = await c.query<{ state: string; last_error: string | null }>(
        `SELECT state,last_error FROM outbound_email_outbox WHERE request_id=$1 AND recipient_index=1`,
        [requestId],
      );
      expect(event.rows[0]?.evidence).toMatchObject({
        detection: 'unverified_delivery_status_text', authenticated_delivery: false, action_taken: 'none',
      });
      expect(suppression.rows[0]?.count).toBe('0');
      expect(engagement.rows[0]?.stage).toBe('sent');
      expect(queued.rows[0]).toEqual({ state: 'queued', last_error: null });
      await c.query('COMMIT');
    });
  });

  it('refuses to use the receipt path for payments', async () => {
    const fx = await seedWorkspace();
    const { snapshotId } = await seedSnapshot(fx);
    const effectId = await seedEffect(fx, 'payment');
    const response = await asUser(env as Env, fx.adminId, `/w/${fx.workspaceId}/effects/${effectId}/external-evidence`, {
      method: 'POST',
      body: { snapshot_id: snapshotId, occurred_at: '2026-09-19T12:00:00.000Z', note: 'Claimed payment evidence.' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'unsupported_effect_evidence' });
  });
});
