// /w/:ws/email — role inboxes and the mail they receive (decision C98).
//
// Admins create, pause and remove inbox addresses; that is configuration and
// needs a recent sign-in like every other Admin write. Reading what arrived is
// different: the content belongs to the role, so the inbox agent's principal,
// the role's holders and the people a hand-off was put in front of may read it
// (inbound-email/view.ts, mayReadInboundEmail). An Admin who is none of those
// sees counts, not messages.
//
// Anyone who may read a message may also ask its agent to read it again after
// a failed attempt. That is not a decision and grants nothing new: the retry
// runs the same intake-mode turn, with the same suggestion-only tools, that
// the message's arrival already started. It still needs an allowlisted Origin
// and CSRF, like every other write, and is rate-limited per person.
//
// Closing a hand-off moves a task out of `pending`, which CONVENTIONS
// invariant 1 reserves for guarded routes. So it carries the decision route's
// guards: an allowlisted Origin, `X-Requested-From: inbox`, CSRF and step-up,
// and only a person the hand-off was addressed to may close it.
import type { Context } from 'hono';
import {
  createEmailInboxInputSchema,
  emailInboxListSchema,
  emailInboxSchema,
  inboundEmailListItemSchema,
  inboundEmailListSchema,
  inboundEmailViewSchema,
  taskPayloadSchema,
  type EmailInbox,
  type InboundEmailListItem,
} from '@hermes/shared';
import { z } from 'zod';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { consumeRate } from '../auth/rate-limit.js';
import { requireRequestedFrom } from '../domain/guards.js';
import { publishEvents } from '../jobs.js';
import { retryEmailTriage } from '../inbound-email/triage.js';
import { DERIVED_EMAIL_STATUS_SQL, EMAIL_PROBLEM_SQL, EMAIL_RETRYABLE_SQL, loadInboundEmail, mayReadInboundEmail } from '../inbound-email/view.js';
import { inboxOwner, cautionReplyPolicyKey, replyPolicyKey } from '../inbound-email/suggestions.js';
import { addressToken, ensureAgentInboxes, grantInboxAuthority, inboxCapabilityScope as capabilityScope, intakeDomain } from '../inbound-email/agent-address.js';
import { emailCautionResourceKey, emailInboxResourceKey } from '@hermes/shared';
import { RouteError } from './errors.js';
import { inWorkspace, jsonBody, pathUuid, type TenantWork } from './tenant.js';


interface InboxRow {
  id: string;
  address: string;
  label: string;
  role_slug: string | null;
  kind: 'agent' | 'role';
  agent_id: string;
  agent_name: string;
  status: 'active' | 'paused';
  created_at: Date;
  message_count: number;
  latest_received_at: Date | null;
}

const INBOX_SELECT = `
  SELECT i.id, i.address, i.label, i.role_slug, i.kind, i.agent_id, a.name AS agent_name, i.status, i.created_at,
         (SELECT count(*)::int FROM inbound_email_messages m WHERE m.workspace_id=i.workspace_id AND m.inbox_id=i.id) AS message_count,
         (SELECT max(m.received_at) FROM inbound_email_messages m WHERE m.workspace_id=i.workspace_id AND m.inbox_id=i.id) AS latest_received_at
    FROM email_inboxes i
    JOIN agents a ON a.workspace_id=i.workspace_id AND a.id=i.agent_id`;

const inboxView = (row: InboxRow): EmailInbox => emailInboxSchema.parse({
  id: row.id,
  address: row.address,
  label: row.label,
  kind: row.kind,
  role_slug: row.role_slug,
  agent: { id: row.agent_id, name: row.agent_name },
  status: row.status,
  created_at: row.created_at.toISOString(),
  message_count: row.message_count,
  latest_received_at: row.latest_received_at?.toISOString() ?? null,
});

/** Whether the viewer reads this inbox's mail: its agent's principal or a holder of its role. */
async function mayReadInbox(work: TenantWork, inboxId: string): Promise<boolean> {
  const found = await work.tx.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM email_inboxes i
         JOIN members viewer ON viewer.workspace_id=i.workspace_id AND viewer.user_id=$3 AND viewer.status='active'
        WHERE i.workspace_id=$1 AND i.id=$2
          AND (i.role_slug = ANY(viewer.reviewer_roles)
               OR EXISTS (SELECT 1 FROM agent_owners ao WHERE ao.workspace_id=i.workspace_id AND ao.agent_id=i.agent_id AND ao.member_id=viewer.id))
     ) AS allowed`,
    [work.workspaceId, inboxId, work.userId],
  );
  return found.rows[0]?.allowed === true;
}

async function auditInbox(work: TenantWork, kind: 'email_inbox.created' | 'email_inbox.removed' | 'settings.changed'): Promise<void> {
  await work.tx.query(
    `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind) VALUES ($1, 'user', $2, $3)`,
    [work.workspaceId, work.userId, kind],
  );
  work.jobs.push(...(await publishEvents(work.tx, work.workspaceId, [
    { kind: 'entity.updated', payload: { entity_type: 'workspace_settings', entity_id: work.workspaceId, ref: null, version: null } },
  ])));
}


export async function listEmailInboxes(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await inWorkspace(c, async (work) => {
    // Every agent has its own address (C100); agents made before that, or
    // before they had an owner, get theirs the first time anyone looks.
    await ensureAgentInboxes(work.tx, intakeDomain(c.env.EMAIL_INTAKE_DOMAIN), work.workspaceId,
      { admin: work.role === 'admin', userId: work.userId });
    const rows = await work.tx.query<InboxRow>(
      `${INBOX_SELECT}
        WHERE i.workspace_id=$1
          AND ($3 OR EXISTS (
            SELECT 1 FROM members viewer
             WHERE viewer.workspace_id=i.workspace_id AND viewer.user_id=$2 AND viewer.status='active'
               AND (i.role_slug = ANY(viewer.reviewer_roles)
                    OR EXISTS (SELECT 1 FROM agent_owners ao WHERE ao.workspace_id=i.workspace_id AND ao.agent_id=i.agent_id AND ao.member_id=viewer.id))
          ))
        ORDER BY (i.kind = 'agent') DESC, a.name, i.created_at`,
      [work.workspaceId, work.userId, work.role === 'admin'],
    );
    return {
      domain: c.env.EMAIL_INTAKE_DOMAIN?.trim().toLowerCase() || null,
      inboxes: rows.rows.map(inboxView),
      can_manage: work.role === 'admin',
    };
  });
  c.header('Cache-Control', 'no-store');
  return c.json(emailInboxListSchema.parse(body));
}

export async function createEmailInbox(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const parsed = createEmailInboxInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('that is not a valid inbox', 'bad_inbox', 422);
  const input = parsed.data;
  const domain = c.env.EMAIL_INTAKE_DOMAIN?.trim().toLowerCase();
  if (!domain || !/^[a-z0-9.-]{3,253}$/u.test(domain)) {
    throw new RouteError('This deployment has no receiving email domain yet.', 'email_intake_not_configured', 503);
  }
  const inbox = await inWorkspace(c, async (work) => {
    work.requireAdmin('adding an email inbox');
    requireStepUp(work.session);
    const role = await work.tx.query<{ name: string }>(
      `SELECT name FROM workspace_roles WHERE workspace_id=$1 AND slug=$2`,
      [work.workspaceId, input.role_slug],
    );
    if (!role.rows[0]) throw new RouteError('no such role', 'unknown_role', 422);
    const agent = await work.tx.query<{ status: string }>(
      `SELECT status FROM agents WHERE workspace_id=$1 AND id=$2`,
      [work.workspaceId, input.agent_id],
    );
    if (!agent.rows[0] || !['draft', 'started'].includes(agent.rows[0].status)) {
      throw new RouteError('no such agent', 'unknown_agent', 422);
    }
    const owner = await inboxOwner(work.tx, work.workspaceId, input.agent_id);
    if (!owner) throw new RouteError('That agent has no owner to reply as. Give it an owner first.', 'agent_owner_missing', 422);

    const localRole = input.role_slug.replace(/_/gu, '-').slice(0, 40);
    const address = `${localRole}-${addressToken(8)}@${domain}`;
    const inserted = await work.tx.query<{ id: string }>(
      `INSERT INTO email_inboxes (workspace_id, kind, role_slug, agent_id, address, label, created_by)
       VALUES ($1,'role',$2,$3,$4,$5,$6) RETURNING id`,
      [work.workspaceId, input.role_slug, input.agent_id, address, input.label, work.userId],
    );
    const id = inserted.rows[0]!.id;
    await grantInboxAuthority(work.tx, work.workspaceId,
      { id, address, label: input.label, role_slug: input.role_slug, agent_id: input.agent_id, status: 'active', kind: 'role' }, owner);
    await auditInbox(work, 'email_inbox.created');
    const row = await work.tx.query<InboxRow>(`${INBOX_SELECT} WHERE i.workspace_id=$1 AND i.id=$2`, [work.workspaceId, id]);
    return inboxView(row.rows[0]!);
  });
  c.header('Cache-Control', 'no-store');
  return c.json(inbox, 201);
}

export async function patchEmailInbox(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const inboxId = pathUuid(c, 'id');
  const parsed = z.object({ status: z.enum(['active', 'paused']) }).strict().safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('status must be active or paused', 'bad_inbox', 422);
  const inbox = await inWorkspace(c, async (work) => {
    work.requireAdmin('pausing an email inbox');
    requireStepUp(work.session);
    const changed = await work.tx.query(
      `UPDATE email_inboxes SET status=$3 WHERE workspace_id=$1 AND id=$2`,
      [work.workspaceId, inboxId, parsed.data.status],
    );
    if (changed.rowCount !== 1) throw new RouteError('no such inbox', 'unknown_inbox', 404);
    await auditInbox(work, 'settings.changed');
    const row = await work.tx.query<InboxRow>(`${INBOX_SELECT} WHERE i.workspace_id=$1 AND i.id=$2`, [work.workspaceId, inboxId]);
    return inboxView(row.rows[0]!);
  });
  c.header('Cache-Control', 'no-store');
  return c.json(inbox);
}

/**
 * Removing an inbox deletes every message it received (the stored copies, not
 * only the address), withdraws its agent's suggestion tools and retires its
 * approval policies. Approvals already decided keep their audit rows; their
 * email evidence becomes unavailable, which is the point.
 */
export async function deleteEmailInbox(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const inboxId = pathUuid(c, 'id');
  await inWorkspace(c, async (work) => {
    work.requireAdmin('removing an email inbox');
    requireStepUp(work.session);
    const found = await work.tx.query<{ agent_id: string }>(
      `SELECT agent_id FROM email_inboxes WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,
      [work.workspaceId, inboxId],
    );
    const inbox = found.rows[0];
    if (!inbox) throw new RouteError('no such inbox', 'unknown_inbox', 404);
    await work.tx.query(
      `DELETE FROM agent_capabilities WHERE workspace_id=$1 AND agent_id=$2 AND scope=$3`,
      [work.workspaceId, inbox.agent_id, capabilityScope(inboxId)],
    );
    await work.tx.query(
      `UPDATE approval_policies SET active=false WHERE workspace_id=$1 AND key = ANY($2::text[]) AND active`,
      [work.workspaceId, [replyPolicyKey(inboxId), cautionReplyPolicyKey(inboxId)]],
    );
    await work.tx.query(
      `UPDATE approval_resources SET active=false
        WHERE workspace_id=$1 AND (resource_key = ANY($2::text[])
          OR resource_key IN (SELECT 'email-message:' || id FROM inbound_email_messages WHERE workspace_id=$1 AND inbox_id=$3))`,
      [work.workspaceId, [emailInboxResourceKey(inboxId), emailCautionResourceKey(inboxId)], inboxId],
    );
    await work.tx.query(`DELETE FROM email_inboxes WHERE workspace_id=$1 AND id=$2`, [work.workspaceId, inboxId]);
    await auditInbox(work, 'email_inbox.removed');
  });
  return c.body(null, 204);
}

/** Recent messages as list rows; `where` filters `m` with $1 = workspace and $2 = the id it names. */
async function listItems(work: TenantWork, where: 'inbox' | 'message', id: string): Promise<InboundEmailListItem[]> {
  const rows = await work.tx.query<{
    id: string; received_at: Date; subject: string; sender_facts: unknown; status: string; request_ids: string[];
    can_retry: boolean; retrying: boolean; problem: string | null;
  }>(
    `SELECT m.id, m.received_at, m.subject, m.sender_facts, m.request_ids, ${DERIVED_EMAIL_STATUS_SQL} AS status,
            ${EMAIL_RETRYABLE_SQL} AS can_retry,
            (m.status = 'received' AND m.triage_attempt > 1 AND NOT ${EMAIL_RETRYABLE_SQL}) AS retrying,
            ${EMAIL_PROBLEM_SQL} AS problem
       FROM inbound_email_messages m
       JOIN email_inboxes i ON i.workspace_id=m.workspace_id AND i.id=m.inbox_id
       LEFT JOIN runs r ON r.workspace_id=m.workspace_id AND r.id=m.triage_run_id
      WHERE m.workspace_id=$1 AND ${where === 'inbox' ? 'm.inbox_id' : 'm.id'}=$2
      ORDER BY m.received_at DESC LIMIT 100`,
    [work.workspaceId, id],
  );
  return rows.rows.map((row) => inboundEmailListItemSchema.parse({
    id: row.id,
    received_at: row.received_at.toISOString(),
    subject: row.subject,
    sender: row.sender_facts,
    status: row.status,
    request_ids: row.request_ids.slice(0, 10),
    can_retry: row.can_retry,
    retrying: row.retrying,
    problem: row.problem,
  }));
}

export async function listInboxMessages(c: Context<{ Bindings: Env }>): Promise<Response> {
  const inboxId = pathUuid(c, 'id');
  const body = await inWorkspace(c, async (work) => {
    if (!(await mayReadInbox(work, inboxId))) throw new RouteError('no such inbox', 'unknown_inbox', 404);
    return { messages: await listItems(work, 'inbox', inboxId) };
  });
  c.header('Cache-Control', 'no-store');
  return c.json(inboundEmailListSchema.parse(body));
}

/**
 * Try again after a failed triage: the message goes back to `received` and
 * its agent gets a fresh intake run. Answers 202 with the message's list row;
 * the new run starts after the commit.
 */
export async function retryInboundEmail(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireCsrf(c);
  const messageId = pathUuid(c, 'id');
  const item = await inWorkspace(c, async (work) => {
    if (!(await mayReadInboundEmail(work.tx, work.workspaceId, messageId, work.userId))) {
      throw new RouteError('no such message', 'unknown_message', 404);
    }
    await consumeRate(work.tx, work.userId, work.workspaceId, { action: 'email.retry', limit: 10, windowSeconds: 60 });
    const jobId = await retryEmailTriage(work.tx, work.workspaceId, messageId, work.userId);
    if (jobId) work.jobs.push(jobId);
    const [row] = await listItems(work, 'message', messageId);
    return row!;
  });
  c.header('Cache-Control', 'no-store');
  return c.json(inboundEmailListItemSchema.parse(item), 202);
}

export async function getInboundEmail(c: Context<{ Bindings: Env }>): Promise<Response> {
  const messageId = pathUuid(c, 'id');
  const view = await inWorkspace(c, async (work) => {
    if (!(await mayReadInboundEmail(work.tx, work.workspaceId, messageId, work.userId))) {
      throw new RouteError('no such message', 'unknown_message', 404);
    }
    const stored = await loadInboundEmail(work.tx, work.workspaceId, messageId);
    if (!stored) throw new RouteError('no such message', 'unknown_message', 404);
    return stored.view;
  });
  c.header('Cache-Control', 'no-store');
  return c.json(inboundEmailViewSchema.parse(view));
}

export async function completeEmailHandoff(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireRequestedFrom(c);
  requireCsrf(c);
  const requestId = pathUuid(c, 'id');
  await inWorkspace(c, async (work) => {
    requireStepUp(work.session);
    const found = await work.tx.query<{ status: string; payload: unknown; session_id: string | null; in_audience: boolean; addressed: boolean }>(
      `SELECT r.status, r.payload, r.session_id,
              EXISTS (SELECT 1 FROM request_audiences ra WHERE ra.request_id=r.id AND ra.user_id=$3) AS in_audience,
              EXISTS (SELECT 1 FROM request_audiences ra
                       WHERE ra.request_id=r.id AND ra.user_id=$3 AND ra.purpose='reviewer') AS addressed
         FROM requests r
        WHERE r.workspace_id=$1 AND r.id=$2 AND r.kind='task'
        FOR UPDATE OF r`,
      [work.workspaceId, requestId, work.userId],
    );
    const request = found.rows[0];
    const payload = request ? taskPayloadSchema.safeParse(request.payload) : null;
    // A hand-off is audience-scoped (invariant 10): to anyone outside its
    // audience it does not exist.
    if (!request || !request.in_audience || !payload?.success || payload.data.task_type !== 'email_handoff') {
      throw new RouteError('no such hand-off', 'unknown_handoff', 404);
    }
    if (!request.addressed) throw new RouteError('only the people this was handed to can close it', 'not_addressed', 403);
    if (request.status !== 'pending') throw new RouteError(`this hand-off is already ${request.status}`, 'not_pending', 409);
    await work.tx.query(`UPDATE requests SET status='approved' WHERE workspace_id=$1 AND id=$2 AND status='pending'`, [work.workspaceId, requestId]);
    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, request_id, session_id)
       VALUES ($1,'user',$2,'email_handoff.completed',$3,$4)`,
      [work.workspaceId, work.userId, requestId, request.session_id],
    );
    work.jobs.push(...(await publishEvents(work.tx, work.workspaceId, [
      { kind: 'entity.updated', payload: { entity_type: 'request', entity_id: requestId, ref: { section: 'inbox', view: 'request', id: requestId }, version: null } },
    ])));
  });
  return c.body(null, 204);
}
