import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import type { NormalizedGmailThread } from '../../src/inbound-email/gmail-read-api.js';
import { recordInboundEvents } from '../../src/inbound-email/service.js';
import type { TenantWork } from '../../src/routes/tenant.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const env = makeEnv().env;

async function seedSnapshot(fx: Fixture): Promise<{ snapshotId: string; teamId: string }> {
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
  return { snapshotId, teamId };
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

describe('inbound email and external evidence database boundaries', () => {
  it('keeps snapshots append-only and hidden from the agent database role', async () => {
    const fx = await seedWorkspace();
    const { snapshotId } = await seedSnapshot(fx);
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
  });

  it('records access evidence without executing the effect or creating outbound work', async () => {
    const fx = await seedWorkspace();
    const { snapshotId } = await seedSnapshot(fx);
    const effectId = await seedEffect(fx, 'access_grant');
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/effects/${effectId}/external-evidence`, {
      method: 'POST',
      body: { snapshot_id: snapshotId, occurred_at: '2026-09-19T12:00:00.000Z', note: 'Completed by the workspace owner in the provider.' },
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
      expect(jobs.rows[0]?.count).toBe('0');
      await c.query('COMMIT');
    });
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
