// Microsoft 365 as the sending account (C99): real approval, durable job and
// OAuth callback against Postgres; Microsoft identity and Graph HTTP are stubbed.
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
import { resolveSendingAccessToken, storeSendingAccount } from '../../src/outbound-email/gmail-store.js';
import { connectorListSchema, mailboxDisconnectSchema, outboundEmailConnectionSchema } from '@hermes/shared';
import { sha256Hex } from '../../src/integrations/slack/security.js';
import { INBOX_HEADERS } from './m4-fixtures.js';
import { runOutboundEmailSendJob } from '../../src/outbound-email/send-job.js';

const DOMAIN = 'in.hermes.test';
const sent: Request[] = [];
const tokenRequests: URLSearchParams[] = [];
let senderAddress = '';
/** How the next token refresh answers: normally, a revoked grant, or a misconfigured app. */
let refreshAnswer: 'ok' | 'invalid_grant' | 'invalid_client' = 'ok';
const env: Env = makeEnv({
  KEK_V1: Buffer.alloc(32, 31).toString('base64'),
  MICROSOFT_MAIL_ENABLED: '1',
  MICROSOFT_CLIENT_ID: 'ms-client', MICROSOFT_CLIENT_SECRET: 'ms-secret',
  MICROSOFT_STATE_SECRET: 'microsoft-state-secret-at-least-thirty-two-chars',
  MICROSOFT_REDIRECT_URI: 'https://hermes.test/integrations/microsoft/oauth/callback',
  MICROSOFT_FETCHER: { fetch: async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname === 'login.microsoftonline.com') {
      const form = new URLSearchParams(await request.text());
      tokenRequests.push(form);
      if (form.get('grant_type') === 'refresh_token' && refreshAnswer !== 'ok') {
        return Response.json({ error: refreshAnswer, error_description: 'fixture' }, { status: 400 });
      }
      return Response.json(form.get('grant_type') === 'refresh_token'
        ? { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, scope: 'Mail.Send User.Read', token_type: 'Bearer' }
        : { access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read openid email', token_type: 'Bearer' });
    }
    if (url.pathname === '/v1.0/me') return Response.json({ mail: senderAddress, userPrincipalName: 'someone@contoso.onmicrosoft.com' });
    sent.push(request.clone());
    return new Response(null, { status: 202, headers: { 'request-id': 'graph-request-1' } });
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

async function oauthState(fx: Seeded, provider: 'gmail' | 'microsoft'): Promise<string> {
  const state = await signGmailOAuthState({ v: 1, workspace_id: fx.workspaceId, user_id: fx.adminId,
    nonce: randomUUID(), expires_at: Math.floor(Date.now()/1000)+600, redirect_uri: env.MICROSOFT_REDIRECT_URI! }, env.MICROSOFT_STATE_SECRET!);
  await scoped(fx.workspaceId, `INSERT INTO gmail_oauth_states (workspace_id,requested_by,state_digest,redirect_uri,expires_at,provider)
    VALUES ($1,$2,$3,$4,now()+interval '10 minutes',$5)`, [fx.workspaceId,fx.adminId,await sha256Hex(state),env.MICROSOFT_REDIRECT_URI,provider]);
  return state;
}

const callback = (state: string): Promise<Response> =>
  callWithWaitUntil(env, `/integrations/microsoft/oauth/callback?code=test&state=${encodeURIComponent(state)}`);

async function approvedPendingReply() {
  sent.length = 0;
  tokenRequests.length = 0;
  const fx = await seedInbox();
  const id = await receive(fx);
  const run = await triage(fx, id);
  const suggestion = await suggestReply(fx, run);
  await approve(fx, fx.adminId, suggestion.request_id);
  const [outbox] = await scoped<{ id: string; sender_address: string }>(fx.workspaceId,
    'SELECT id,sender_address FROM outbound_email_outbox WHERE request_id=$1', [suggestion.request_id]);
  senderAddress = outbox!.sender_address;
  return { fx, outbox: outbox!, requestId: suggestion.request_id };
}

describe('Microsoft 365 sending account', () => {
  it('sends the exact approved reply through Graph once the mailbox is connected', async () => {
    const { fx, outbox, requestId } = await approvedPendingReply();
    expect(await scoped(fx.workspaceId, 'SELECT state FROM outbound_email_outbox WHERE id=$1', [outbox.id])).toEqual([{ state: 'pending_connection' }]);

    const response = await callback(await oauthState(fx, 'microsoft'));
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('microsoft=connected');

    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(new URL(request.url).pathname).toBe('/v1.0/me/sendMail');
    expect(request.headers.get('content-type')).toBe('text/plain');
    expect(request.headers.get('authorization')).toBe('Bearer access');
    // Standard base64 of the same RFC 5322 message a Gmail send would carry.
    const mime = Buffer.from(await request.text(), 'base64').toString('utf8');
    expect(mime).toContain(`From: ${senderAddress}`);
    expect(mime).toContain('To: ');
    expect(mime).toMatch(/In-Reply-To: <[^>]+@northwind\.example>/u);
    expect(mime).toContain('Content-Type: text/plain; charset=UTF-8');

    expect(await scoped(fx.workspaceId, 'SELECT state,provider_message_id FROM outbound_email_outbox WHERE id=$1', [outbox.id]))
      .toEqual([{ state: 'sent', provider_message_id: 'graph-request-1' }]);
    expect(await scoped(fx.workspaceId, 'SELECT provider,address,status FROM outbound_email_accounts WHERE workspace_id=$1', [fx.workspaceId]))
      .toEqual([{ provider: 'microsoft', address: senderAddress, status: 'connected' }]);
    expect(await scoped(fx.workspaceId, `SELECT effect_status FROM approval_requests WHERE request_id=$1`, [requestId]))
      .toEqual([{ effect_status: 'executed' }]);
    expect(await scoped(fx.workspaceId, `SELECT count(*)::int AS n FROM events WHERE workspace_id=$1 AND kind='microsoft_mail.connected'`, [fx.workspaceId]))
      .toEqual([{ n: 1 }]);
    // The code exchange asked for Mail.Send, User.Read and a refresh token.
    expect(tokenRequests[0]!.get('scope')).toContain('https://graph.microsoft.com/Mail.Send');
    expect(tokenRequests[0]!.get('scope')).toContain('offline_access');
  });

  it('reports the account and which services this deployment can connect', async () => {
    const { fx } = await approvedPendingReply();
    await callback(await oauthState(fx, 'microsoft'));
    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/integrations/email`);
    const view = outboundEmailConnectionSchema.parse(await response.json());
    expect(view).toMatchObject({ configured: true, status: 'connected', provider: 'microsoft', providers: { gmail: false, microsoft: true }, address: senderAddress });
  });

  describe('a refresh the provider refuses', () => {
    /** A queued approved email on a connected account whose access token has expired. */
    async function queuedOnExpiredAccount() {
      const { fx, outbox } = await approvedPendingReply();
      const account = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => storeSendingAccount(tx, env, {
        workspaceId: fx.workspaceId, connectedBy: fx.adminId, address: senderAddress, provider: 'microsoft',
        token: { access_token: 'old', refresh_token: 'refresh-1', expires_at: new Date(Date.now() - 1000).toISOString(), scope: 'Mail.Send', token_type: 'Bearer' },
      }));
      await scoped(fx.workspaceId, `UPDATE outbound_email_outbox SET state='queued', account_id=$2 WHERE id=$1`, [outbox.id, account.id]);
      const run = () => runOutboundEmailSendJob(env, { id: randomUUID(), workspace_id: fx.workspaceId, kind: 'outbound_email_send', payload: { outbox_id: outbox.id } } as unknown as Job);
      return { fx, outbox, account, run };
    }

    it('marks the account for reconnecting and parks the email, sending nothing', async () => {
      const { fx, outbox, account, run } = await queuedOnExpiredAccount();
      sent.length = 0;
      refreshAnswer = 'invalid_grant';
      try { await run(); } finally { refreshAnswer = 'ok'; }
      expect(sent).toHaveLength(0);
      expect(await scoped(fx.workspaceId, 'SELECT status, last_error FROM outbound_email_accounts WHERE id=$1', [account.id]))
        .toEqual([{ status: 'error', last_error: 'refresh_grant_revoked' }]);
      expect(await scoped(fx.workspaceId, 'SELECT state, account_id, last_error FROM outbound_email_outbox WHERE id=$1', [outbox.id]))
        .toEqual([{ state: 'pending_connection', account_id: null, last_error: 'refresh_grant_revoked' }]);

      // Admins see it, on the Email page and the Connections overview.
      const status = outboundEmailConnectionSchema.parse(await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/integrations/email`)).json());
      expect(status.status).toBe('error');
      const list = connectorListSchema.parse(await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/connections`)).json());
      expect(list.connections.find((connection) => connection.key === 'microsoft_sending')).toMatchObject({ state: 'needs_attention' });

      // Reconnecting the address sends the parked email once.
      await callback(await oauthState(fx, 'microsoft'));
      expect(sent).toHaveLength(1);
      expect(await scoped(fx.workspaceId, 'SELECT state FROM outbound_email_outbox WHERE id=$1', [outbox.id])).toEqual([{ state: 'sent' }]);
    });

    it('leaves the account alone when the failure isn\'t about the grant', async () => {
      const { fx, outbox, account, run } = await queuedOnExpiredAccount();
      sent.length = 0;
      refreshAnswer = 'invalid_client';
      try { await expect(run()).rejects.toThrow(); } finally { refreshAnswer = 'ok'; }
      expect(sent).toHaveLength(0);
      expect(await scoped(fx.workspaceId, 'SELECT status FROM outbound_email_accounts WHERE id=$1', [account.id])).toEqual([{ status: 'connected' }]);
      expect(await scoped(fx.workspaceId, 'SELECT state FROM outbound_email_outbox WHERE id=$1', [outbox.id])).toEqual([{ state: 'queued' }]);
    });
  });

  it('disconnecting deletes Hermes\'s access and puts unsent approved email back to waiting', async () => {
    const { fx, outbox } = await approvedPendingReply();
    await callback(await oauthState(fx, 'microsoft'));
    // One approved email is still queued when an Admin disconnects.
    await scoped(fx.workspaceId, `UPDATE outbound_email_outbox SET state='queued', sent_at=NULL, provider_message_id=NULL WHERE id=$1`, [outbox.id]);

    const refused = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/integrations/email`, { method: 'DELETE' });
    expect(refused.status).toBe(403);

    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/integrations/email`, { method: 'DELETE' });
    expect(response.status, await response.clone().text()).toBe(200);
    expect(mailboxDisconnectSchema.parse(await response.json())).toEqual({ status: 'disconnected', waiting: 1 });

    expect(await scoped(fx.workspaceId, 'SELECT status, ciphertext, wrapped_dek FROM outbound_email_accounts WHERE workspace_id=$1', [fx.workspaceId]))
      .toEqual([{ status: 'revoked', ciphertext: null, wrapped_dek: null }]);
    expect(await scoped(fx.workspaceId, 'SELECT state, account_id FROM outbound_email_outbox WHERE id=$1', [outbox.id]))
      .toEqual([{ state: 'pending_connection', account_id: null }]);
    expect(await scoped(fx.workspaceId, `SELECT count(*)::int AS n FROM events WHERE workspace_id=$1 AND kind='outbound_email.disconnected'`, [fx.workspaceId]))
      .toEqual([{ n: 1 }]);

    const status = outboundEmailConnectionSchema.parse(await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/integrations/email`)).json());
    expect(status).toMatchObject({ status: 'disconnected', address: null, provider: null });
    const list = connectorListSchema.parse(await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/connections`)).json());
    expect(list.connections.find((connection) => connection.key === 'microsoft_sending')).toMatchObject({ state: 'not_connected' });

    // Connecting the same address again picks the waiting email back up and sends it.
    sent.length = 0;
    await callback(await oauthState(fx, 'microsoft'));
    expect(sent).toHaveLength(1);
    expect(await scoped(fx.workspaceId, 'SELECT state FROM outbound_email_outbox WHERE id=$1', [outbox.id])).toEqual([{ state: 'sent' }]);
  });

  it('refuses a state issued for Google, so one provider cannot finish the other\'s sign-in', async () => {
    const { fx, outbox } = await approvedPendingReply();
    const response = await callback(await oauthState(fx, 'gmail'));
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(await scoped(fx.workspaceId, 'SELECT state FROM outbound_email_outbox WHERE id=$1', [outbox.id])).toEqual([{ state: 'pending_connection' }]);
  });

  it('refreshes an expiring token in its own transaction and stores the new expiry', async () => {
    const fx = await seedWorkspace();
    tokenRequests.length = 0;
    const account = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => storeSendingAccount(tx, env, {
      workspaceId: fx.workspaceId, connectedBy: fx.adminId, address: 'ops@contoso.example', provider: 'microsoft',
      token: { access_token: 'old', refresh_token: 'refresh-1', expires_at: new Date(Date.now() - 1000).toISOString(), scope: 'Mail.Send', token_type: 'Bearer' },
    }));
    const first = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => resolveSendingAccessToken(
      tx, env, account.id, (fn) => withWorkspaceTransaction(env, fx.workspaceId, fn),
    ));
    expect(first.token).toBe('access-2');
    expect(tokenRequests[0]!.get('grant_type')).toBe('refresh_token');
    expect(tokenRequests[0]!.get('refresh_token')).toBe('refresh-1');
    await withWorkspaceTransaction(env, fx.workspaceId, async (tx) => {
      const current = await tx.query<{ token_expires_at: Date }>(`SELECT token_expires_at FROM outbound_email_accounts WHERE id=$1`, [account.id]);
      expect(current.rows[0]!.token_expires_at.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
