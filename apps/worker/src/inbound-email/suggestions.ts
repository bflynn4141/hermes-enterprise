// Turning an agent's suggestion about a received email into something a person
// approves (decision C98).
//
// The agent's tools say only what it thinks should happen: the words of a
// reply, or which role should look at the message. Everything that decides
// where a reply goes or who must approve it is written here, from the stored
// message and the server's facts about its sender:
//
//   * recipient, sender, subject and threading come from the message the run
//     was started for, never from tool arguments, so an instruction hidden in
//     an email cannot redirect a reply (the CaMeL "send it to Bob" attack);
//   * the reply names its inbox and its exact message as approval resources.
//     The message resource carries the raw message's sha256, so the approval is
//     bound to the bytes the reviewer saw;
//   * a sender the server flagged adds the inbox's caution resource, which makes
//     the two-person policy the only one that matches. When the workspace has
//     nobody else who could be the second person, the reply is drafted but
//     cannot be sent from Hermes.
//
// A run can only suggest about the message it was started for: the lookup is
// `triage_run_id = this run`, and that column is written only by the triage
// job.
import {
  emailCautionResourceKey,
  emailInboxResourceKey,
  emailMessageResourceKey,
  hasCaution,
  senderFactsSchema,
  type ApprovalPolicy,
  type SenderFacts,
  type SuggestEmailHandoffInput,
  type SuggestEmailReplyInput,
} from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { proposeApproval, type ApprovalWork } from '../domain/approvals.js';
import type { Env } from '../env.js';
import { publishEvents } from '../jobs.js';
import { RouteError } from '../routes/errors.js';

export interface InboxOwner {
  readonly memberId: string;
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
}

export interface InboxRow {
  readonly id: string;
  readonly address: string;
  readonly label: string;
  readonly role_slug: string;
  readonly agent_id: string;
  readonly status: string;
}

/** The person an inbox's agent acts for. A reply goes out in their name. */
export async function inboxOwner(tx: Tx, workspaceId: string, agentId: string): Promise<InboxOwner | null> {
  const found = await tx.query<{ member_id: string; user_id: string; email: string; name: string | null }>(
    `SELECT m.id AS member_id, m.user_id, lower(u.email) AS email, u.name
       FROM agent_owners ao
       JOIN members m ON m.workspace_id=ao.workspace_id AND m.id=ao.member_id AND m.status='active'
       JOIN users u ON u.id=m.user_id
      WHERE ao.workspace_id=$1 AND ao.agent_id=$2`,
    [workspaceId, agentId],
  );
  const row = found.rows[0];
  return row ? { memberId: row.member_id, userId: row.user_id, email: row.email, name: row.name } : null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function registerResource(
  tx: Tx,
  workspaceId: string,
  resource: { key: string; kind: 'system' | 'rule' | 'data'; label: string; ownerMemberId: string; version: string; sha256: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO approval_resources
       (workspace_id, resource_key, kind, label, owner_member_id, version, sha256, executor_available, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,false,true)
     ON CONFLICT (workspace_id, resource_key)
     DO UPDATE SET owner_member_id=EXCLUDED.owner_member_id, label=EXCLUDED.label,
                   version=EXCLUDED.version, sha256=EXCLUDED.sha256, active=true`,
    [workspaceId, resource.key, resource.kind, resource.label.slice(0, 200), resource.ownerMemberId, resource.version, resource.sha256],
  );
}

/** Install or refresh one server-owned communication policy, versioning a change. */
async function upsertPolicy(
  tx: Tx,
  workspaceId: string,
  key: string,
  agentId: string,
  targets: readonly string[],
  steps: ApprovalPolicy['steps'],
): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${workspaceId}:${key}`]);
  const serialized = JSON.stringify(steps);
  const active = await tx.query<{ version: number; same: boolean }>(
    `SELECT version, (steps = $3::jsonb AND requester_agent_id = $4 AND target_resource_ids = $5::text[]) AS same
       FROM approval_policies WHERE workspace_id=$1 AND key=$2 AND active LIMIT 1`,
    [workspaceId, key, serialized, agentId, [...targets]],
  );
  if (active.rows[0]?.same) return;
  await tx.query(`UPDATE approval_policies SET active=false WHERE workspace_id=$1 AND key=$2 AND active`, [workspaceId, key]);
  const next = await tx.query<{ version: number }>(
    `SELECT COALESCE(max(version), 0)::int + 1 AS version FROM approval_policies WHERE workspace_id=$1 AND key=$2`,
    [workspaceId, key],
  );
  await tx.query(
    `INSERT INTO approval_policies
       (workspace_id, key, version, approval_type, requester_agent_id, target_resource_ids, priority, mode,
        prevent_self_review, require_distinct_reviewers, max_duration_seconds, steps, active)
     VALUES ($1,$2,$3,'communication',$4,$5::text[],1000000,'sequential',false,true,604800,$6::jsonb,true)`,
    [workspaceId, key, next.rows[0]?.version ?? 1, agentId, [...targets], serialized],
  );
}

export const replyPolicyKey = (inboxId: string): string => `email-reply-${inboxId}`;
export const cautionReplyPolicyKey = (inboxId: string): string => `email-reply-caution-${inboxId}`;

/**
 * The inbox's resources and policies, refreshed for the current owner and
 * membership. Returns whether a flagged sender's reply can have a second
 * approver at all; when it cannot, the caution policy is not installed and a
 * flagged reply becomes draft-only.
 */
export async function ensureInboxApprovals(
  tx: Tx,
  workspaceId: string,
  inbox: InboxRow,
  owner: InboxOwner,
): Promise<{ secondReviewerAvailable: boolean }> {
  const inboxKey = emailInboxResourceKey(inbox.id);
  const cautionKey = emailCautionResourceKey(inbox.id);
  const addressDigest = await sha256Hex(inbox.address);
  await registerResource(tx, workspaceId, {
    key: inboxKey, kind: 'system', label: `Replies from ${inbox.label}`, ownerMemberId: owner.memberId,
    version: 'inbox/v1', sha256: addressDigest,
  });
  await registerResource(tx, workspaceId, {
    key: cautionKey, kind: 'rule', label: `Flagged senders at ${inbox.label}`, ownerMemberId: owner.memberId,
    version: 'caution/v1', sha256: addressDigest,
  });
  const ownerStep: ApprovalPolicy['steps'][number] = {
    id: 'owner-review', label: 'Approve the reply', order: 0,
    reviewers: [{ kind: 'member', member_id: owner.memberId }], quorum: 1,
  };
  await upsertPolicy(tx, workspaceId, replyPolicyKey(inbox.id), inbox.agent_id, [inboxKey], [ownerStep]);

  // The second person is anyone else who is an Admin or holds the inbox's
  // role. The approval engine requires every role selector in a step to be
  // satisfiable on its own, so only roles someone else actually holds are named.
  const others = await tx.query<{ admins: number; holders: number }>(
    `SELECT count(*) FILTER (WHERE role='admin')::int AS admins,
            count(*) FILTER (WHERE $3 = ANY(reviewer_roles))::int AS holders
       FROM members WHERE workspace_id=$1 AND status='active' AND id<>$2`,
    [workspaceId, owner.memberId, inbox.role_slug],
  );
  const counts = others.rows[0] ?? { admins: 0, holders: 0 };
  const reviewers: ApprovalPolicy['steps'][number]['reviewers'] = [
    ...(counts.admins > 0 ? [{ kind: 'role' as const, role: 'admin', minimum_distinct_members: 1 }] : []),
    ...(counts.holders > 0 ? [{ kind: 'role' as const, role: inbox.role_slug, minimum_distinct_members: 1 }] : []),
  ];
  if (reviewers.length === 0) {
    await tx.query(
      `UPDATE approval_policies SET active=false WHERE workspace_id=$1 AND key=$2 AND active`,
      [workspaceId, cautionReplyPolicyKey(inbox.id)],
    );
    return { secondReviewerAvailable: false };
  }
  await upsertPolicy(tx, workspaceId, cautionReplyPolicyKey(inbox.id), inbox.agent_id, [inboxKey, cautionKey], [
    ownerStep,
    { id: 'second-review', label: 'A second person checks the sender', order: 1, reviewers, quorum: 1 },
  ]);
  return { secondReviewerAvailable: true };
}

interface TriagedMessage {
  readonly id: string;
  readonly inbox: InboxRow;
  readonly subject: string;
  readonly fromAddress: string;
  readonly fromName: string | null;
  readonly rawSha256: string;
  readonly receivedAt: Date;
  readonly facts: SenderFacts;
  readonly sessionId: string;
}

/** The one message this run was started for, or a refusal the model can read. */
async function messageForRun(tx: Tx, workspaceId: string, runId: string, agentId: string): Promise<TriagedMessage> {
  const found = await tx.query<{
    id: string; subject: string; from_address: string; from_name: string | null; raw_sha256: string;
    received_at: Date; sender_facts: unknown; session_id: string;
    inbox_id: string; address: string; label: string; role_slug: string; agent_id: string; inbox_status: string;
  }>(
    `SELECT m.id, m.subject, m.from_address, m.from_name, m.raw_sha256, m.received_at, m.sender_facts,
            r.session_id, i.id AS inbox_id, i.address, i.label, i.role_slug, i.agent_id, i.status AS inbox_status
       FROM inbound_email_messages m
       JOIN email_inboxes i ON i.workspace_id=m.workspace_id AND i.id=m.inbox_id
       JOIN runs r ON r.workspace_id=m.workspace_id AND r.id=m.triage_run_id
      WHERE m.workspace_id=$1 AND m.triage_run_id=$2 AND i.agent_id=$3
      FOR UPDATE OF m`,
    [workspaceId, runId, agentId],
  );
  const row = found.rows[0];
  if (!row) {
    throw new RouteError('This tool only works in a run started for a received email.', 'not_an_email_run', 422);
  }
  const facts = senderFactsSchema.parse(row.sender_facts);
  return {
    id: row.id,
    inbox: { id: row.inbox_id, address: row.address, label: row.label, role_slug: row.role_slug, agent_id: row.agent_id, status: row.inbox_status },
    subject: row.subject,
    fromAddress: row.from_address,
    fromName: row.from_name,
    rawSha256: row.raw_sha256,
    receivedAt: row.received_at,
    facts,
    sessionId: row.session_id,
  };
}

async function recordSuggestion(tx: Tx, workspaceId: string, messageId: string, requestId: string): Promise<void> {
  await tx.query(
    `UPDATE inbound_email_messages
        SET status='suggested',
            request_ids = CASE WHEN $3 = ANY(request_ids) THEN request_ids ELSE array_append(request_ids, $3::uuid) END
      WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, messageId, requestId],
  );
}

/**
 * Who can see a reply suggestion (invariant 10). Without an audience an
 * approval is visible to the whole workspace, and so would the email it
 * cites be, through the evidence route. The audience is the people who may
 * read the inbox anyway (its agent's owner and its role's holders) plus, for
 * a flagged sender, the Admins who may be the second approver.
 */
async function addReplyAudience(
  tx: Tx,
  workspaceId: string,
  requestId: string,
  inbox: InboxRow,
  owner: InboxOwner,
  caution: boolean,
): Promise<void> {
  await tx.query(
    `INSERT INTO request_audiences (workspace_id, request_id, user_id, purpose)
     SELECT $1, $2, m.user_id, CASE WHEN m.user_id = $3 THEN 'owner' ELSE 'reviewer' END
       FROM members m
      WHERE m.workspace_id = $1 AND m.status = 'active'
        AND (m.user_id = $3 OR $4 = ANY(m.reviewer_roles) OR ($5 AND m.role = 'admin'))
     ON CONFLICT (request_id, user_id) DO NOTHING`,
    [workspaceId, requestId, owner.userId, inbox.role_slug, caution],
  );
}

/** The address a reply is sent from: a connected sender mailbox, else the owner. */
async function replySender(tx: Tx, workspaceId: string, owner: InboxOwner): Promise<string> {
  const account = await tx.query<{ address: string }>(
    `SELECT address FROM outbound_email_accounts
      WHERE workspace_id=$1 AND status='connected'
      ORDER BY (address=$2) DESC, created_at LIMIT 1`,
    [workspaceId, owner.email],
  );
  return account.rows[0]?.address ?? owner.email;
}

const replySubject = (subject: string): string => {
  const trimmed = subject.trim();
  if (!trimmed) return 'Re: your email';
  return /^re:/iu.test(trimmed) ? trimmed.slice(0, 500) : `Re: ${trimmed}`.slice(0, 500);
};

export interface SuggestionContext extends ApprovalWork {
  readonly env: Pick<Env, 'EMAIL_REPLY_MODE'>;
  readonly runId: string;
  readonly toolCallId: string;
  readonly agentId: string;
}

export async function suggestEmailReply(
  context: SuggestionContext,
  input: SuggestEmailReplyInput,
): Promise<{ request_id: string; status: string; sendable: boolean; reviewers: 'owner' | 'owner_and_second_person' }> {
  const { tx, workspaceId } = context;
  const message = await messageForRun(tx, workspaceId, context.runId, context.agentId);
  const owner = await inboxOwner(tx, workspaceId, message.inbox.agent_id);
  if (!owner) throw new RouteError('The inbox agent has no active owner to send a reply as.', 'inbox_owner_missing', 409);
  const { secondReviewerAvailable } = await ensureInboxApprovals(tx, workspaceId, message.inbox, owner);
  await registerResource(tx, workspaceId, {
    key: emailMessageResourceKey(message.id), kind: 'data',
    label: `Email from ${message.fromAddress}`, ownerMemberId: owner.memberId,
    version: message.receivedAt.toISOString(), sha256: message.rawSha256,
  });

  const flagged = hasCaution(message.facts);
  // Draft-only unless an operator enabled sending (C81), and always for a
  // flagged sender nobody else can second-check.
  const sendingEnabled = context.env.EMAIL_REPLY_MODE === 'send_after_approval';
  const caution = flagged && secondReviewerAvailable;
  const draftOnly = !sendingEnabled || (flagged && !secondReviewerAvailable);
  const sender = await replySender(tx, workspaceId, owner);
  const recipientName = (message.fromName ?? message.fromAddress).slice(0, 200);
  const subject = replySubject(message.subject);
  const consequence = draftOnly
    ? flagged && sendingEnabled
      ? `Hermes won't send this reply. The sender needs checking, and nobody else on your team can be the second approver. Approving saves the reply so you can send it from your own email once you've checked the sender.`
      : "Approving saves this reply. Hermes won't send it from here."
    : `Approving sends this reply from ${sender} to ${message.fromAddress}, in the same email thread. Nothing else is sent.`;
  const cautions = message.facts.warnings.filter((warning) => warning.severity === 'caution');
  const approval = await proposeApproval({
    tx,
    workspaceId,
    jobs: context.jobs,
    agentId: context.agentId,
    sessionId: message.sessionId,
    runId: context.runId,
  }, {
    label: `Reply to ${recipientName}`.slice(0, 200),
    policy_key: caution ? cautionReplyPolicyKey(message.inbox.id) : replyPolicyKey(message.inbox.id),
    proposal: {
      kind: 'approval',
      approval_type: 'communication',
      summary: input.summary,
      consequence,
      evidence: [{
        id: message.id,
        kind: 'artifact',
        label: `Email from ${message.fromAddress}`.slice(0, 200),
        ...(cautions.length > 0 ? { note: cautions.map((warning) => warning.detail).join(' ').slice(0, 2000) } : {}),
      }],
      illustrative: false,
      details: {
        channel: 'email',
        draft_only: draftOnly,
        sender: { member_id: owner.memberId, address: sender },
        recipients: [{ name: recipientName, address: message.fromAddress }],
        subject,
        body: input.body,
        attachments: [],
        reply_to: { inbox_id: message.inbox.id, message_id: message.id, caution },
      },
    },
    target_agent_ids: [],
    target_member_ids: [],
    target_resource_ids: [],
    dependent_request_ids: [],
    idempotency_key: `email-reply:${message.id}:${(await sha256Hex(`${context.runId}:${context.toolCallId}`)).slice(0, 40)}`,
  });
  await addReplyAudience(tx, workspaceId, approval.request_id, message.inbox, owner, caution);
  await recordSuggestion(tx, workspaceId, message.id, approval.request_id);
  return {
    request_id: approval.request_id,
    status: approval.status,
    sendable: !draftOnly,
    reviewers: caution ? 'owner_and_second_person' : 'owner',
  };
}

async function roleNameOf(tx: Tx, workspaceId: string, slug: string): Promise<string> {
  const found = await tx.query<{ name: string }>(
    `SELECT name FROM workspace_roles WHERE workspace_id=$1 AND slug=$2`,
    [workspaceId, slug],
  );
  return found.rows[0]?.name ?? slug.replace(/_/gu, ' ');
}

/**
 * Put the message in front of another role. Internal routing, so no approval:
 * the result is a task the receiving people read and close, carrying the
 * server's facts about the sender. It can never pay, sign or reply.
 */
export async function suggestEmailHandoff(
  context: SuggestionContext,
  input: SuggestEmailHandoffInput,
): Promise<{ request_id: string; recipients: number }> {
  const { tx, workspaceId } = context;
  const message = await messageForRun(tx, workspaceId, context.runId, context.agentId);
  if (input.role_slug === message.inbox.role_slug) {
    throw new RouteError('This message already belongs to that role. Hand off to a different role.', 'handoff_same_role', 422);
  }
  const role = await tx.query<{ name: string }>(
    `SELECT name FROM workspace_roles WHERE workspace_id=$1 AND slug=$2`,
    [workspaceId, input.role_slug],
  );
  const roleName = role.rows[0]?.name;
  if (!roleName) throw new RouteError(`There is no ${input.role_slug} role in this workspace.`, 'unknown_role', 422);
  const holders = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM members WHERE workspace_id=$1 AND status='active' AND $2 = ANY(reviewer_roles)`,
    [workspaceId, input.role_slug],
  );
  if (holders.rows.length === 0) {
    throw new RouteError(`Nobody holds the ${roleName} role yet, so there is nobody to hand this to.`, 'role_has_no_holders', 422);
  }
  // One hand-off per message and role. The message row is locked by
  // messageForRun, so a replayed tool call finds the first one here.
  const subjectKey = `email-handoff:${message.id}:${input.role_slug}`;
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM requests WHERE workspace_id=$1 AND subject_key=$2`,
    [workspaceId, subjectKey],
  );
  if (existing.rows[0]) return { request_id: existing.rows[0].id, recipients: holders.rows.length };
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO requests (workspace_id, kind, subject_key, label, payload, status, run_id, session_id, tool_call_id)
     VALUES ($1,'task',$2,$3,$4::jsonb,'pending',$5,$6,$7)
     RETURNING id`,
    [
      workspaceId, subjectKey,
      `${roleName}: ${message.subject || `Email from ${message.fromAddress}`}`.slice(0, 200),
      JSON.stringify({
        kind: 'task',
        task_type: 'email_handoff',
        description: `${input.summary}\n\n${input.note}`.slice(0, 4000),
        action_label: 'Mark handled',
        agent_id: context.agentId,
        session_id: message.sessionId,
        inbound_email_id: message.id,
        from_role_slug: message.inbox.role_slug,
        to_role_slug: input.role_slug,
        from_role_name: (await roleNameOf(tx, workspaceId, message.inbox.role_slug)).slice(0, 120),
        to_role_name: roleName.slice(0, 120),
      }),
      context.runId, message.sessionId, `email-handoff:${context.toolCallId}`,
    ],
  );
  const requestId = inserted.rows[0]?.id;
  if (!requestId) throw new Error('email_handoff_request_missing');
  {
    // The receiving role decides; the inbox owner can follow what they handed over.
    const owner = await inboxOwner(tx, workspaceId, message.inbox.agent_id);
    const audience = new Map<string, 'owner' | 'reviewer'>(holders.rows.map((holder) => [holder.user_id, 'reviewer']));
    if (owner && !audience.has(owner.userId)) audience.set(owner.userId, 'owner');
    for (const [userId, purpose] of audience) {
      await tx.query(
        `INSERT INTO request_audiences (workspace_id, request_id, user_id, purpose)
         VALUES ($1,$2,$3,$4) ON CONFLICT (request_id,user_id) DO NOTHING`,
        [workspaceId, requestId, userId, purpose],
      );
    }
    await tx.query(
      `INSERT INTO events (workspace_id, actor_type, kind, request_id, session_id) VALUES ($1,'system','request.created',$2,$3)`,
      [workspaceId, requestId, message.sessionId],
    );
    context.jobs.push(...await publishEvents(tx, workspaceId, [
      { kind: 'request.created', payload: { request_id: requestId, kind: 'task', status: 'pending', label: `${roleName}: ${message.subject}`.slice(0, 200), run_id: context.runId, session_id: message.sessionId } },
      { kind: 'entity.updated', payload: { entity_type: 'request', entity_id: requestId, ref: { section: 'inbox', view: 'request', id: requestId }, version: null } },
    ]));
  }
  await recordSuggestion(tx, workspaceId, message.id, requestId);
  return { request_id: requestId, recipients: holders.rows.length };
}
