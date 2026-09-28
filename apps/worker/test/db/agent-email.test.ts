// Every agent's own email address (C100): created with the agent, reviewed by
// its owner and its role, and approved replies sent as the agent through a
// stubbed Cloudflare Email Service binding. Real approvals, jobs and Postgres.
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
import { emailInboxListSchema, inboundEmailListSchema } from '@hermes/shared';
import { runOutboundEmailSendJob } from '../../src/outbound-email/send-job.js';
import { INBOX_HEADERS } from './m4-fixtures.js';

const DOMAIN = 'in.hermes.test';
interface Sent { from: { name: string; email: string }; to: { name: string; email: string }; subject: string; text: string; headers: Record<string, string> }
const sent: Sent[] = [];
let nextSendError: Error | null = null;
const EMAIL = {
  send: async (message: Sent) => {
    if (nextSendError) { const error = nextSendError; nextSendError = null; throw error; }
    sent.push(message);
    return { messageId: `cf-${sent.length}` };
  },
};
const env: Env = makeEnv({
  KEK_V1: Buffer.alloc(32, 31).toString('base64'),
  EMAIL,
  EMAIL_INTAKE_DOMAIN: DOMAIN,
  EMAIL_REPLY_MODE: 'send_after_approval',
  EFFECT_EXECUTOR_MODE: 'unavailable',
  AGENT_EMAIL_DAILY_READS: '2',
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

async function listInboxes(fx: Fixture, userId: string) {
  const response = await asUser(env, userId, `/w/${fx.workspaceId}/email/inboxes`);
  expect(response.status).toBe(200);
  return emailInboxListSchema.parse(await response.json());
}

/** A workspace whose agent has an owner and so, on first look, its own address. */
async function seedAgent(): Promise<Seeded> {
  const fx = await seedWorkspace();
  const member = await scoped<{ id: string }>(fx.workspaceId, `SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2`, [fx.workspaceId, fx.adminId]);
  const adminMemberId = member[0]!.id;
  await scoped(fx.workspaceId, `INSERT INTO agent_owners (workspace_id, agent_id, member_id) VALUES ($1,$2,$3)`, [fx.workspaceId, fx.agentId, adminMemberId]);
  const list = await listInboxes(fx, fx.adminId);
  const own = list.inboxes.find((inbox) => inbox.kind === 'agent' && inbox.agent.id === fx.agentId);
  expect(own).toBeTruthy();
  return { ...fx, adminMemberId, inboxId: own!.id, address: own!.address };
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


async function sendJob(fx: Seeded, outboxId: string): Promise<void> {
  await runOutboundEmailSendJob(env, { id: randomUUID(), workspace_id: fx.workspaceId, kind: 'outbound_email_send', payload: { outbox_id: outboxId } } as unknown as Job);
}

/** Approving runs the send job after commit; `failWith` makes that first send fail. */
async function approvedReply(fx: Seeded, failWith?: string) {
  const id = await receive(fx);
  const run = await triage(fx, id);
  const suggestion = await suggestReply(fx, run);
  if (failWith) nextSendError = Object.assign(new Error(`${failWith}: refused`), { code: failWith });
  await approve(fx, fx.adminId, suggestion.request_id).catch(() => undefined);
  const [outbox] = await scoped<{ id: string; state: string; sender_address: string; sender_inbox_id: string | null }>(fx.workspaceId,
    'SELECT id, state, sender_address, sender_inbox_id FROM outbound_email_outbox WHERE request_id=$1', [suggestion.request_id]);
  return { messageId: id, requestId: suggestion.request_id, outbox: outbox! };
}

describe('every agent has its own email address (C100)', () => {
  it('gives an owned agent one readable, unguessable address the first time anyone looks', async () => {
    const fx = await seedAgent();
    expect(fx.address).toMatch(new RegExp(`^iris-[a-z2-9]{6}@${DOMAIN.replaceAll('.', '\\.')}$`, 'u'));
    const again = await listInboxes(fx, fx.adminId);
    expect(again.inboxes.filter((inbox) => inbox.kind === 'agent').map((inbox) => inbox.address)).toEqual([fx.address]);
    // The address gives the agent its suggestion tools and installs its approval policies.
    expect(await scoped(fx.workspaceId, `SELECT tool_names FROM agent_capabilities WHERE workspace_id=$1 AND scope=$2`, [fx.workspaceId, `email-inbox:${fx.inboxId}`]))
      .toEqual([{ tool_names: ['suggest_reply', 'suggest_handoff', 'get_workspace_context'] }]);
    expect(await scoped(fx.workspaceId, `SELECT count(*)::int AS n FROM approval_policies WHERE workspace_id=$1 AND key=$2 AND active`, [fx.workspaceId, `email-reply-${fx.inboxId}`]))
      .toEqual([{ n: 1 }]);
  });

  it('gives no address to an agent nobody owns, since its mail would have no reviewer', async () => {
    const fx = await seedWorkspace();
    const list = await listInboxes(fx, fx.adminId);
    expect(list.inboxes).toEqual([]);
  });

  it('follows the agent\'s role: who holds Finance reviews a Finance agent\'s mail', async () => {
    const fx = await seedAgent();
    expect((await listInboxes(fx, fx.adminId)).inboxes[0]!.role_slug).toBeNull();
    const [team] = await scoped<{ id: string }>(fx.workspaceId,
      `INSERT INTO enterprise_teams (workspace_id, slug, name) VALUES ($1,'finance','Finance') RETURNING id`, [fx.workspaceId]);
    await scoped(fx.workspaceId, `INSERT INTO enterprise_team_agents (workspace_id, team_id, agent_id, principal_user_id, role_template_key)
      VALUES ($1,$2,$3,$4,'finance-agent')`, [fx.workspaceId, team!.id, fx.agentId, fx.adminId]);
    expect((await listInboxes(fx, fx.adminId)).inboxes[0]!.role_slug).toBe('finance');
    // A Member who holds Finance now sees the agent's address and its mail.
    await scoped(fx.workspaceId, `UPDATE members SET reviewer_roles = ARRAY['finance'] WHERE workspace_id=$1 AND user_id=$2`, [fx.workspaceId, fx.memberId]);
    expect((await listInboxes(fx, fx.memberId)).inboxes.map((inbox) => inbox.address)).toEqual([fx.address]);
    await scoped(fx.workspaceId, `DELETE FROM enterprise_team_agents WHERE workspace_id=$1 AND agent_id=$2`, [fx.workspaceId, fx.agentId]);
    expect((await listInboxes(fx, fx.adminId)).inboxes[0]!.role_slug).toBeNull();
    expect((await listInboxes(fx, fx.memberId)).inboxes).toEqual([]);
  });

  it('sends the approved reply as the agent, threaded, and records Cloudflare\'s message id', async () => {
    sent.length = 0;
    const fx = await seedAgent();
    const { requestId, outbox } = await approvedReply(fx);
    expect(outbox).toMatchObject({ state: 'sent', sender_address: fx.address, sender_inbox_id: fx.inboxId });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { name: 'Iris', email: fx.address },
      to: { email: 'priya@northwind.example' },
      subject: 'Re: Invoice NW-9',
      text: 'Thanks, received.',
    });
    expect(sent[0]!.headers['In-Reply-To']).toMatch(/^<[^>]+@northwind\.example>$/u);
    expect(sent[0]!.headers.References).toContain('<root-1@northwind.example>');
    expect(Object.keys(sent[0]!.headers).sort()).toEqual(['In-Reply-To', 'References']);
    expect(await scoped(fx.workspaceId, 'SELECT state, provider_message_id FROM outbound_email_outbox WHERE id=$1', [outbox.id]))
      .toEqual([{ state: 'sent', provider_message_id: 'cf-1' }]);
    expect(await scoped(fx.workspaceId, 'SELECT effect_status FROM approval_requests WHERE request_id=$1', [requestId]))
      .toEqual([{ effect_status: 'executed' }]);
  });

  it.each([
    ['E_SENDER_NOT_VERIFIED', 'failed'],
    ['E_INTERNAL_SERVER_ERROR', 'ambiguous'],
  ])('reports %s as %s and does not send again', async (code, state) => {
    sent.length = 0;
    const fx = await seedAgent();
    const { outbox } = await approvedReply(fx, code);
    expect(await scoped(fx.workspaceId, 'SELECT state FROM outbound_email_outbox WHERE id=$1', [outbox.id])).toEqual([{ state }]);
    await sendJob(fx, outbox.id);
    expect(sent).toHaveLength(0);
  });

  it('keeps a throttled send queued for the job to retry', async () => {
    sent.length = 0;
    const fx = await seedAgent();
    const { outbox } = await approvedReply(fx, 'E_RATE_LIMIT_EXCEEDED');
    expect(await scoped(fx.workspaceId, 'SELECT state FROM outbound_email_outbox WHERE id=$1', [outbox.id])).toEqual([{ state: 'queued' }]);
    await sendJob(fx, outbox.id);
    expect(sent).toHaveLength(1);
  });

  it('cancels instead of sending when the address stopped being the agent\'s', async () => {
    sent.length = 0;
    const fx = await seedAgent();
    // Queue the reply, then pause the address before the job gets to it.
    const { outbox } = await approvedReply(fx, 'E_RATE_LIMIT_EXCEEDED');
    await scoped(fx.workspaceId, `UPDATE email_inboxes SET status='paused' WHERE id=$1`, [fx.inboxId]);
    await sendJob(fx, outbox.id);
    expect(sent).toHaveLength(0);
    expect(await scoped(fx.workspaceId, 'SELECT state, last_error FROM outbound_email_outbox WHERE id=$1', [outbox.id]))
      .toEqual([{ state: 'cancelled', last_error: 'sender_account_mismatch' }]);
  });

  it('on an allowlisted deployment, sends nothing to anyone else and says why', async () => {
    sent.length = 0;
    const fx = await seedAgent();
    Object.assign(env, { AGENT_EMAIL_RECIPIENT_MODE: 'allowlist', AGENT_EMAIL_ALLOWED_RECIPIENTS: 'tester@example.com' });
    try {
      const { requestId, outbox } = await approvedReply(fx);
      expect(sent).toHaveLength(0);
      expect(await scoped(fx.workspaceId, 'SELECT state, last_error FROM outbound_email_outbox WHERE id=$1', [outbox.id]))
        .toEqual([{ state: 'cancelled', last_error: 'recipient_not_allowed' }]);
      const [approval] = await scoped<{ effect_status: string; effect_reason: string }>(fx.workspaceId,
        'SELECT effect_status, effect_reason FROM approval_requests WHERE request_id=$1', [requestId]);
      expect(approval).toMatchObject({ effect_status: 'failed' });
      expect(approval!.effect_reason).toContain('only emails approved addresses');
    } finally {
      Object.assign(env, { AGENT_EMAIL_RECIPIENT_MODE: undefined, AGENT_EMAIL_ALLOWED_RECIPIENTS: undefined });
    }
  });

  it('on an allowlisted deployment, sends to an allowed domain', async () => {
    sent.length = 0;
    const fx = await seedAgent();
    Object.assign(env, { AGENT_EMAIL_RECIPIENT_MODE: 'allowlist', AGENT_EMAIL_ALLOWED_RECIPIENTS: '@northwind.example' });
    try {
      await approvedReply(fx);
      expect(sent.map((message) => message.to.email)).toEqual(['priya@northwind.example']);
    } finally {
      Object.assign(env, { AGENT_EMAIL_RECIPIENT_MODE: undefined, AGENT_EMAIL_ALLOWED_RECIPIENTS: undefined });
    }
  });

  it('stops reading at the daily limit, and a person can have it read one anyway', async () => {
    const fx = await seedAgent();
    // Each read finishes before the next, as it would with a real model.
    const finish = (runId: string) => scoped(fx.workspaceId, `UPDATE runs SET status='completed', ended_at=now() WHERE id=$1`, [runId]);
    await finish(await triage(fx, await receive(fx, 'One')));
    await finish(await triage(fx, await receive(fx, 'Two')));
    const third = await receive(fx, 'Three');
    const jobId = (await scoped<{ id: string }>(fx.workspaceId,
      `SELECT id FROM jobs WHERE workspace_id=$1 AND kind='email_triage' AND key=$2`, [fx.workspaceId, triageKey(third, 1)]))[0]!.id;
    await runEmailTriageJob(env, { id: jobId, workspace_id: fx.workspaceId, kind: 'email_triage', payload: { message_id: third } } as unknown as Job);
    const list = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/email/inboxes/${fx.inboxId}/messages`);
    const row = inboundEmailListSchema.parse(await list.json()).messages.find((message) => message.id === third);
    expect(row).toMatchObject({ status: 'failed', problem: 'daily_limit', can_retry: true });

    const retried = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/email/messages/${third}/retry`, { method: 'POST', body: {} });
    expect(retried.status, await retried.clone().text()).toBeLessThan(300);
    expect(await triage(fx, third, 2)).toBeTruthy();
  });
});
