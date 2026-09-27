// Real approval, durable job and OAuth callback against Postgres; Gmail HTTP is stubbed.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  emailInboxSchema,
  type ApprovalView,
} from '@hermes/shared';
import type { Env } from '../../src/env.js';
import { receiveInboundEmail } from '../../src/inbound-email/intake.js';
import { suggestEmailReply } from '../../src/inbound-email/suggestions.js';
import { runEmailTriageJob } from '../../src/inbound-email/triage.js';
import { enqueueJob, runJobsAfterCommit, withWorkspaceTransaction, type Job } from '../../src/jobs.js';
import { asUser, callWithWaitUntil, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { signGmailOAuthState } from '../../src/outbound-email/gmail-security.js';
import { sha256Hex } from '../../src/integrations/slack/security.js';
import { INBOX_HEADERS } from './m4-fixtures.js';

const DOMAIN = 'in.hermes.test';
const sent: Request[] = [];
let senderAddress = '';
const env: Env = makeEnv({
  KEK_V1: Buffer.alloc(32, 31).toString('base64'),
  GMAIL_OUTREACH_ENABLED: '1',
  GMAIL_CLIENT_ID: 'client', GMAIL_CLIENT_SECRET: 'secret',
  GMAIL_STATE_SECRET: 'test-state-secret-at-least-thirty-two-characters',
  GMAIL_REDIRECT_URI: 'https://hermes.test/integrations/gmail/oauth/callback',
  GMAIL_FETCHER: { fetch: async (request: Request) => {
    const url = new URL(request.url);
    const body = url.hostname === 'oauth2.googleapis.com'
      ? { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.send', token_type: 'Bearer' }
      : url.hostname === 'openidconnect.googleapis.com'
        ? { email: senderAddress, email_verified: true }
        : (sent.push(request.clone()), { id: 'sent-message', threadId: 'thread' });
    return Response.json(body);
  } } as Fetcher,
  EMAIL_INTAKE_DOMAIN: DOMAIN,
  EMAIL_REPLY_MODE: 'send_after_approval',
  EFFECT_EXECUTOR_MODE: 'unavailable',
  ENVIRONMENT: 'development',
  MODEL_SCRIPTED: '1',
  RUN_ATTEMPT: { create: async ({ id }: { id: string }) => ({ id }) },
} as unknown as Partial<Env>).env;

/** One statement as the owner, under the workspace's tenant key (RLS is forced for the owner too). */
async function scoped<T extends Record<string, unknown>>(workspaceId: string, sql: string, params: readonly unknown[] = []): Promise<T[]> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    try {
      await setTenant(c, workspaceId, '00000000-0000-4000-8000-000000000000');
      const result = await c.query<T>(sql, [...params]);
      await c.query('COMMIT');
      return result.rows;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

function rawEmail(input: {
  to: string;
  from: string;
  subject: string;
  html: string;
  dmarc?: 'pass' | 'fail';
  replyTo?: string;
  messageId?: string;
}): Uint8Array {
  const lines = [
    `Authentication-Results: mx.cloudflare.net; dkim=${input.dmarc ?? 'pass'} header.d=example; spf=pass; dmarc=${input.dmarc ?? 'pass'} header.from=example`,
    `Message-ID: ${input.messageId ?? `<${randomUUID()}@northwind.example>`}`,
    'References: <root-1@northwind.example>',
    `From: ${input.from}`,
    ...(input.replyTo ? [`Reply-To: ${input.replyTo}`] : []),
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    input.html,
  ];
  return new TextEncoder().encode(lines.join('\r\n'));
}

interface Seeded extends Fixture {
  adminMemberId: string;
  inboxId: string;
  address: string;
}

async function seedInbox(): Promise<Seeded> {
  const fx = await seedWorkspace();
  const member = await scoped<{ id: string }>(fx.workspaceId, `SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2`, [fx.workspaceId, fx.adminId]);
  const adminMemberId = member[0]!.id;
  await scoped(fx.workspaceId, `INSERT INTO agent_owners (workspace_id, agent_id, member_id) VALUES ($1,$2,$3)`, [fx.workspaceId, fx.agentId, adminMemberId]);
  const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/email/inboxes`, {
    method: 'POST', body: { role_slug: 'partnerships', agent_id: fx.agentId, label: 'Partnerships' },
  });
  expect(response.status).toBe(201);
  const inbox = emailInboxSchema.parse(await response.json());
  expect(inbox.address).toMatch(new RegExp(`^partnerships-[a-z0-9]{8}@${DOMAIN.replaceAll('.', '\\.')}$`, 'u'));
  return { ...fx, adminMemberId, inboxId: inbox.id, address: inbox.address };
}

const triageKey = (messageId: string, attempt: number): string =>
  attempt === 1 ? `email-triage:${messageId}` : `email-triage:${messageId}:${attempt}`;

async function triage(fx: Seeded, messageId: string, attempt = 1): Promise<string> {
  const jobId = (await scoped<{ id: string }>(fx.workspaceId,
    `SELECT id FROM jobs WHERE workspace_id=$1 AND kind='email_triage' AND key=$2`, [fx.workspaceId, triageKey(messageId, attempt)],
  ))[0]?.id;
  expect(jobId).toBeTruthy();
  await runEmailTriageJob(env, { id: jobId!, workspace_id: fx.workspaceId, kind: 'email_triage', payload: { message_id: messageId } } as unknown as Job);
  const run = (await scoped<{ triage_run_id: string; status: string; mode: string }>(fx.workspaceId,
    `SELECT m.triage_run_id, m.status, r.mode FROM inbound_email_messages m JOIN runs r ON r.id=m.triage_run_id WHERE m.id=$1`, [messageId],
  ))[0];
  expect(run).toMatchObject({ status: 'triaging', mode: 'intake' });
  return run!.triage_run_id;
}

async function receive(fx: Seeded, subject = 'Invoice NW-9'): Promise<string> {
  const stored = await receiveInboundEmail(env, { to: fx.address, raw: rawEmail({ to: fx.address, from: 'priya@northwind.example', subject, html: '<p>Invoice attached.</p>' }) });
  if (stored.status !== 'stored') throw new Error('not stored');
  return stored.messageId;
}

const suggestReply = (fx: Seeded, runId: string, body = 'Thanks, received.'): Promise<{ request_id: string; sendable: boolean; reviewers: string }> =>
  withWorkspaceTransaction(env, fx.workspaceId, (tx) => suggestEmailReply({
    tx, workspaceId: fx.workspaceId, jobs: [], env, runId, toolCallId: `call_${randomUUID()}`, agentId: fx.agentId,
  }, { summary: 'Acknowledge the invoice.', body }));

async function approve(fx: Seeded, userId: string, requestId: string): Promise<ApprovalView> {
  const view = (await scoped<{ payload: ApprovalView['payload'] }>(fx.workspaceId,
    `SELECT r.payload FROM requests r WHERE r.id=$1`, [requestId],
  ))[0]!.payload;
  const response = await asUser(env, userId, `/w/${fx.workspaceId}/requests/${requestId}/approval/decisions`, {
    method: 'POST', headers: INBOX_HEADERS,
    body: {
      decision: 'approve', expected_authorization_revision: view.authorization.revision,
      expected_authorization_hash: view.authorization.hash, idempotency_key: `vote:${randomUUID()}`, note: null,
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return await response.json() as ApprovalView;
}

async function connect(fx: Seeded): Promise<void> {
  const state = await signGmailOAuthState({ v: 1, workspace_id: fx.workspaceId, user_id: fx.adminId,
    nonce: randomUUID(), expires_at: Math.floor(Date.now()/1000)+600, redirect_uri: env.GMAIL_REDIRECT_URI! }, env.GMAIL_STATE_SECRET!);
  await scoped(fx.workspaceId, `INSERT INTO gmail_oauth_states (workspace_id,requested_by,state_digest,redirect_uri,expires_at)
    VALUES ($1,$2,$3,$4,now()+interval '10 minutes')`, [fx.workspaceId,fx.adminId,await sha256Hex(state),env.GMAIL_REDIRECT_URI]);
  const response = await callWithWaitUntil(env, `/integrations/gmail/oauth/callback?code=test&state=${encodeURIComponent(state)}`);
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toContain('gmail=connected');
}

async function approvedPendingReply() {
  sent.length = 0;
  const fx = await seedInbox();
  const id = await receive(fx);
  const run = await triage(fx,id);
  const suggestion = await suggestReply(fx,run);
  await approve(fx,fx.adminId,suggestion.request_id);
  const [outbox] = await scoped<{ id: string; sender_address: string }>(fx.workspaceId,
    'SELECT id,sender_address FROM outbound_email_outbox WHERE request_id=$1', [suggestion.request_id]);
  // New approvals wait for connection without consuming the send key.
  expect(await scoped(fx.workspaceId, 'SELECT id FROM jobs WHERE key=$1', [`outbound-email:${outbox!.id}`])).toEqual([]);
  senderAddress = outbox!.sender_address;
  return { fx, outbox: outbox! };
}

async function legacyCompletedReply() {
  const { fx, outbox } = await approvedPendingReply();
  // Recreate an already-deployed approval's premature job, then let the real
  // job runner mark its no-mailbox attempt complete.
  const jobId = await withWorkspaceTransaction(env, fx.workspaceId, (tx) =>
    enqueueJob(tx, fx.workspaceId, 'outbound_email_send', `outbound-email:${outbox!.id}`, {outbox_id:outbox!.id}));
  const row = {...outbox!,job_id:jobId!};
  senderAddress = row!.sender_address;
  await runJobsAfterCommit(env,fx.workspaceId,[row!.job_id]);
  expect(await scoped(fx.workspaceId, `SELECT o.state,j.done_at IS NOT NULL AS done FROM outbound_email_outbox o
    JOIN jobs j ON j.id=$2 WHERE o.id=$1`,[row!.id,row!.job_id])).toEqual([{state:'pending_connection',done:true}]);
  return {fx,row:row!};
}

describe('Gmail connection resumes approved replies', () => {
  it('creates no send job before connection when simulation is unavailable', async () => {
    const { fx, outbox } = await approvedPendingReply();
    expect(sent).toHaveLength(0);
    expect(await scoped(fx.workspaceId, 'SELECT state FROM outbound_email_outbox WHERE id=$1', [outbox.id]))
      .toEqual([{ state: 'pending_connection' }]);
    await connect(fx);
    expect(sent).toHaveLength(1);
    expect(await scoped(fx.workspaceId, 'SELECT state FROM outbound_email_outbox WHERE id=$1', [outbox.id]))
      .toEqual([{ state: 'sent' }]);
  });

  it.each(['pending_connection', 'queued'])('revives a completed %s job and sends once after OAuth', async (state) => {
    const {fx,row} = await legacyCompletedReply();
    // queued covers messages stranded by a prior connection with the old callback.
    await scoped(fx.workspaceId, 'UPDATE outbound_email_outbox SET state=$2 WHERE id=$1', [row.id,state]);
    await connect(fx);
    expect(sent).toHaveLength(1);
    expect(await scoped(fx.workspaceId, 'SELECT state,attempt_count FROM outbound_email_outbox WHERE id=$1',[row.id]))
      .toEqual([{state:'sent',attempt_count:1}]);
    await connect(fx);
    await runJobsAfterCommit(env,fx.workspaceId,[row.job_id,row.job_id]);
    expect(sent).toHaveLength(1);
  });

  it.each(['sent','ambiguous'])("does not revive a %s message when Gmail reconnects", async (state) => {
    const {fx,row} = await legacyCompletedReply();
    await scoped(fx.workspaceId,'UPDATE outbound_email_outbox SET state=$2 WHERE id=$1',[row.id,state]);
    await connect(fx);
    expect(sent).toHaveLength(0);
    expect(await scoped(fx.workspaceId,'SELECT state FROM outbound_email_outbox WHERE id=$1',[row.id])).toEqual([{state}]);
  });
});
