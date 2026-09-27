// History, rendered at read time.
//
// `events` holds ids and enum kinds and nothing else (CONVENTIONS, invariant 8
// and the erasure inventory in plan section 6). That is not a limitation to
// work around: it is the reason a data subject access request can tombstone a
// person without destroying the audit trail. The cost is that a row cannot be
// read on its own — "Maya admitted Leah" is not stored anywhere — so this file
// joins each event's ids to the rows they name and composes the sentence when
// somebody asks for the page.
//
// Which makes the tombstone case fall out for free rather than needing a second
// code path: after `redact_subject`, the request's label *is* 'Deleted
// applicant' and its payload *is* `{kind, redacted}`, so the same join produces
// "Maya admitted a deleted applicant" and History keeps rendering. A test
// redacts a subject and asks for the page again.
//
// The three tabs are the demo's: everything, decisions only, and the things
// still waiting on a human. `blocked` is derived from the current state of the
// subject rows — a request still `pending`, an effect still `pending` or
// `assigned` — never from a flag on the event, because an event is a fact about
// the past and "is this still blocked" is a question about the present.
import type { Tx } from '../db/client.js';
import type { EffectKind } from '@hermes/shared';
import { requestAudiencePredicate } from './audience.js';

export const HISTORY_TABS = ['all', 'decisions', 'blocked'] as const;
export type HistoryTab = (typeof HISTORY_TABS)[number];

export const isHistoryTab = (value: string): value is HistoryTab =>
  (HISTORY_TABS as readonly string[]).includes(value);

/** What the join returns: the event, plus the subject rows it points at. */
export interface HistoryRow {
  id: string;
  kind: string;
  created_at: Date;
  actor_type: 'user' | 'agent' | 'system';
  actor_name: string | null;
  request_id: string | null;
  request_kind: string | null;
  request_status: string | null;
  request_label: string | null;
  request_payload: Record<string, unknown> | null;
  decision: string | null;
  effect_id: string | null;
  effect_kind: string | null;
  effect_status: string | null;
  effect_simulation_summary: string | null;
  effect_role: string | null;
  effect_cancelled_reason: string | null;
  document_id: string | null;
  document_kind: string | null;
  document_version: number | null;
  member_name: string | null;
  session_id: string | null;
  approval_status: string | null;
  approval_effect_status: string | null;
  approval_work_status: string | null;
  /** When a pending approval stops counting as pending. */
  approval_expires_at?: Date | null;
  /** The agent the row is about: named on the event, the approval, the session or the request. */
  agent_name?: string | null;
  /** For an email hand-off: the name of the role it was handed to. */
  handoff_role_name?: string | null;
}

const SELECT = `
  SELECT e.id, e.kind, e.created_at, e.actor_type,
         actor.name        AS actor_name,
         r.id               AS request_id,
         r.kind            AS request_kind,
         r.status          AS request_status,
         r.label           AS request_label,
         r.payload         AS request_payload,
         d.decision        AS decision,
         e.effect_id,
         f.kind            AS effect_kind,
         f.status          AS effect_status,
         f.required_role   AS effect_role,
         f.cancelled_reason AS effect_cancelled_reason,
         f.enforcement_result -> 'simulation' ->> 'summary' AS effect_simulation_summary,
         e.document_id,
         doc.kind          AS document_kind,
         doc.version       AS document_version,
         mu.name           AS member_name,
         e.session_id,
         ar.status         AS approval_status,
         ar.effect_status  AS approval_effect_status,
         ar.work_status    AS approval_work_status,
         ar.expires_at     AS approval_expires_at,
         ag.name           AS agent_name,
         wr.name           AS handoff_role_name
    FROM events e
    LEFT JOIN users actor   ON actor.id = e.actor_user_id
    LEFT JOIN decisions d   ON d.id = e.decision_id
    LEFT JOIN effects f     ON f.id = e.effect_id
    LEFT JOIN documents doc ON doc.id = e.document_id
    LEFT JOIN requests r    ON r.id = COALESCE(e.request_id, f.request_id, doc.request_id)
    LEFT JOIN members m     ON m.id = e.member_id
    LEFT JOIN users mu      ON mu.id = m.user_id
    LEFT JOIN approval_requests ar ON ar.request_id = e.request_id
    LEFT JOIN sessions s    ON s.id = e.session_id
    LEFT JOIN agents ag     ON ag.id::text = COALESCE(e.agent_id::text, ar.requester_agent_id::text, s.agent_id::text, r.payload ->> 'agent_id')
    LEFT JOIN workspace_roles wr ON wr.workspace_id = e.workspace_id AND wr.slug = r.payload ->> 'to_role_slug'`;

/**
 * `before` is the previous page's last `created_at`, which is a timestamptz and
 * therefore sorts and pages the same way the Today/Yesterday grouping reads.
 * Ties are broken on `id` so a second event in the same microsecond is neither
 * skipped nor repeated.
 */
export async function loadHistory(
  tx: Tx,
  tab: HistoryTab,
  before: string | null,
  limit: number,
  userId: string,
): Promise<HistoryRow[]> {
  const where: string[] = [requestAudiencePredicate('r.id', '$1')];
  const values: unknown[] = [userId];

  if (tab === 'decisions') where.push(`e.kind IN ('decision.recorded', 'approval.vote_recorded', 'approval.finalized')`);
  if (tab === 'blocked') {
    where.push(`(
      (r.id IS NOT NULL AND r.status = 'pending'
        AND (r.kind <> 'approval' OR (ar.status = 'pending' AND ar.expires_at > now())))
      OR (f.id IS NOT NULL AND f.status IN ('pending', 'assigned'))
    )`);
  }
  if (before) {
    values.push(before);
    where.push(`e.created_at < $${values.length}::timestamptz`);
  }
  values.push(limit);

  const { rows } = await tx.query<HistoryRow>(
    `${SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT $${values.length}`,
    values,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** What the audit trail calls a subject it can no longer name. */
export const TOMBSTONE = 'a deleted applicant';

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

/**
 * The name to put in the sentence.
 *
 * Three ways it can be absent and all three mean the same thing to a reader:
 * the request row is gone, its payload was redacted, or its label was rewritten
 * by `redact_subject`. Any of them renders as the tombstone rather than as an
 * empty space or a "null".
 */
export function subjectName(row: Pick<HistoryRow, 'request_label' | 'request_payload'>): string {
  const payload = asRecord(row.request_payload);
  if (payload.redacted === true) return TOMBSTONE;
  const label = str(row.request_label);
  if (!label || label === 'Deleted applicant') return TOMBSTONE;
  return label;
}

const documentNumber = (row: HistoryRow): string | null => str(asRecord(row.request_payload).number);

const actorName = (row: HistoryRow): string => {
  if (row.actor_name) return row.actor_name;
  if (row.actor_type === 'agent') return row.agent_name ?? 'The agent';
  return row.actor_type === 'system' ? 'Hermes' : 'Someone';
};

/** The agent a row is about, for the middle of a sentence. */
const agentInSentence = (row: HistoryRow): string => row.agent_name ?? 'the agent';

const subjectOrNumber = (row: HistoryRow): string =>
  row.request_kind === 'application' ? subjectName(row) : (documentNumber(row) ?? subjectName(row));

/** The demo's receipt detail lines, which are also this product's promises. */
function decisionDetail(row: HistoryRow): string {
  if (row.decision === 'decline') return 'No further action taken · No message sent';
  if (row.request_kind === 'application') return 'Access pending · No message sent';
  if (row.request_kind === 'invoice') return 'Saved in Library · Not sent · No money moved';
  return 'Saved in Library · Unsigned · Not sent';
}

/**
 * The state word every row ends with.
 *
 * One vocabulary, because the client sorts rows by it: `NEEDS_PERSON` words
 * mean the row's subject is waiting on somebody right now (the same present-
 * state question the `blocked` tab asks in SQL), and every other word is a
 * finished state. A row never says "Working" once the work is done.
 */
export const HISTORY_NEEDS_PERSON = ['Needs review', 'Waiting', 'Stopped', 'Needs attention'] as const;

/** Approval status, read in the present: a pending approval past its deadline has expired. */
function approvalState(row: HistoryRow): string {
  const expired = row.approval_expires_at ? row.approval_expires_at.getTime() <= Date.now() : false;
  switch (row.approval_status) {
    case 'pending':
      return expired ? 'Expired' : 'Needs review';
    case 'approved':
      return 'Approved';
    case 'declined':
      return 'Declined';
    case 'changes_requested':
      return 'Changes requested';
    case 'expired':
      return 'Expired';
    case 'withdrawn':
      return 'Withdrawn';
    default:
      return 'Proposed';
  }
}

/** A request's status, read in the present. */
function requestState(status: string | null): string {
  switch (status) {
    case 'pending':
      return 'Needs review';
    case 'admitted':
      return 'Admitted';
    case 'declined':
      return 'Declined';
    case 'created':
    case 'drafted':
    case 'approved':
      return 'Approved';
    case 'withdrawn':
      return 'Withdrawn';
    case 'changes_requested':
      return 'Changes requested';
    case 'expired':
      return 'Expired';
    default:
      return 'Decided';
  }
}

/** What a legacy effect was, as the object of a sentence. */
const EFFECT_NOUNS: Readonly<Record<EffectKind, string>> = {
  access_grant: 'the workspace access',
  email_send: 'the email',
  payment: 'the payment',
  signature: 'the signatures',
};
const effectNoun = (row: HistoryRow): string => EFFECT_NOUNS[row.effect_kind as EffectKind] ?? 'the follow-up';
const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

const REVIEWER_ROLE_NAMES: Readonly<Record<string, string>> = { access: 'an Access', finance: 'a Finance', legal: 'a Legal' };
const reviewerRole = (role: string | null): string => `${(role && REVIEWER_ROLE_NAMES[role]) ?? 'a'} reviewer`;

/** An effect's status, read in the present. */
function effectState(status: string | null): string {
  switch (status) {
    case 'pending':
    case 'assigned':
      return 'Waiting';
    case 'executed':
      return 'Done';
    case 'simulated':
      return 'Practice run';
    case 'cancelled':
      return 'Cancelled';
    case 'failed':
      return 'Failed';
    default:
      return 'Not done here';
  }
}

/** The email's own subject, from a hand-off label written as "<Role>: <subject>". */
function handoffSubject(row: HistoryRow): string {
  const label = subjectName(row);
  const role = row.handoff_role_name;
  if (role && label.startsWith(`${role}: `)) return label.slice(role.length + 2);
  return label;
}

const isEmailHandoff = (row: HistoryRow): boolean =>
  row.request_kind === 'task' && asRecord(row.request_payload).task_type === 'email_handoff';

export interface RenderedEvent {
  id: string;
  kind: string;
  at: string;
  actor_name: string;
  actor_type: 'user' | 'agent' | 'system';
  text: string;
  detail: string;
  status: string;
  ref: { section: string; view?: string; id?: string } | null;
  request_id: string | null;
}

/** One row, rendered. Every string is capped to the contract's limits. */
export function renderHistoryRow(row: HistoryRow): RenderedEvent {
  const actor = actorName(row);
  const subject = subjectName(row);
  // Never the raw kind: a kind this switch does not know yet still reads as a sentence.
  let text = `${actor} made a change`;
  let detail = '';
  let status = 'Done';
  const requestRef: RenderedEvent['ref'] = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
  let ref: RenderedEvent['ref'] = null;

  switch (row.kind) {
    case 'request.created':
      if (isEmailHandoff(row)) {
        text = `${row.agent_name ?? 'The agent'} handed “${handoffSubject(row)}” to ${row.handoff_role_name ?? 'another team'}`;
        detail = row.request_status === 'pending' ? 'Waiting for someone on that team to handle it' : 'Handled by the receiving team';
        status = row.request_status === 'pending' ? 'Waiting' : 'Handled';
      } else if (row.request_kind === 'task') {
        text = `${actor} added a task: ${subject}`;
        detail = row.request_status === 'pending' ? 'Waiting for a person' : 'Finished';
        status = row.request_status === 'pending' ? 'Waiting' : 'Done';
      } else {
        text =
          row.request_kind === 'application'
            ? `${actor} screened ${subject}’s application`
            : row.request_kind === 'invoice'
              ? `${actor} prepared invoice ${documentNumber(row) ?? subject}`
              : row.request_kind === 'approval'
                ? `${actor} proposed ${str(asRecord(row.request_payload).summary) ?? subject}`
                : `${actor} prepared agreement ${documentNumber(row) ?? subject}`;
        const waiting = row.request_kind === 'approval' ? approvalState(row) === 'Needs review' : row.request_status === 'pending';
        detail = waiting ? 'Suggested for review · Nothing decided yet' : 'Suggested for review · A person has decided';
        status = waiting ? 'Needs review' : row.request_kind === 'approval' ? approvalState(row) : requestState(row.request_status);
      }
      ref = requestRef;
      break;

    case 'request.hidden':
      text = `${actor} hid ${subjectOrNumber(row)} from their Inbox`;
      detail = 'Only their Inbox changed · Other reviewers still see it';
      status = 'Hidden';
      ref = requestRef;
      break;

    case 'request.restored':
      text = `${actor} put ${subjectOrNumber(row)} back in their Inbox`;
      detail = 'Only their Inbox changed';
      status = 'Restored';
      ref = requestRef;
      break;

    case 'approval.proposed': {
      // Agents suggest; the member they work for is not the author.
      const proposer = row.agent_name ?? actor;
      const replyTo = asRecord(asRecord(row.request_payload).details).reply_to;
      text = replyTo && row.request_label
        ? `${proposer} suggested a ${row.request_label.charAt(0).toLowerCase()}${row.request_label.slice(1)}`
        : `${proposer} suggested ${str(asRecord(row.request_payload).summary) ?? subject}`;
      }
      status = approvalState(row);
      detail = status === 'Needs review' ? 'Waiting for approval · Nothing has happened yet' : 'Suggested for approval';
      ref = requestRef;
      break;

    case 'approval.vote_recorded':
      text = `${actor} reviewed ${subject}`;
      detail = 'Their answer counts toward the approvals it needs';
      status = approvalState(row);
      ref = requestRef;
      break;

    case 'approval.revised':
      text = `${actor} changed ${subject} after review`;
      detail = 'Earlier approvals no longer count · It needs review again';
      status = approvalState(row);
      ref = requestRef;
      break;

    case 'approval.routed':
      text = `${actor} changed who reviews ${subject}`;
      detail = 'The approval rules stayed the same';
      status = approvalState(row);
      ref = requestRef;
      break;

    case 'approval.finalized':
      text = `${capitalize(subject)} was approved`;
      detail = 'Every required reviewer approved';
      status = 'Approved';
      ref = requestRef;
      break;

    case 'approval.expired':
      text = `${capitalize(subject)} expired before anyone approved it`;
      detail = 'Nothing was done';
      status = 'Expired';
      ref = requestRef;
      break;

    case 'decision.recorded':
      text =
        row.decision === 'decline'
          ? `${actor} declined ${subjectOrNumber(row)}`
          : row.request_kind === 'application'
            ? `${actor} admitted ${subject}`
            : row.request_kind === 'invoice'
              ? `${actor} approved invoice ${documentNumber(row) ?? subject}`
              : `${actor} approved agreement ${documentNumber(row) ?? subject}`;
      detail = decisionDetail(row);
      status = row.decision === 'decline' ? 'Declined' : requestState(row.request_status);
      ref = requestRef;
      break;

    case 'effect.assigned':
      text = `${actor} passed ${effectNoun(row)} to ${reviewerRole(row.effect_role)}`;
      detail = row.effect_status === 'pending' || row.effect_status === 'assigned'
        ? `Waiting on ${reviewerRole(row.effect_role)} · Nothing has been done yet`
        : 'Handed over for a person to finish';
      status = effectState(row.effect_status);
      ref = requestRef;
      break;

    case 'effect.executed':
      if (row.effect_status === 'simulated') {
        text = `${actor} did a practice run of ${effectNoun(row)}`;
        detail = row.effect_simulation_summary
          ? `Practice run: ${row.effect_simulation_summary} · Nothing really happened`
          : 'Practice run · Nothing was really sent, paid, granted or signed';
        status = 'Practice run';
      } else {
        text = `${actor} tried to finish ${effectNoun(row)}`;
        detail = 'Hermes can’t do this itself · Nothing was sent, paid, granted or signed';
        status = effectState(row.effect_status);
      }
      ref = requestRef;
      break;

    case 'effect.cancelled':
      text = `${capitalize(effectNoun(row))} was cancelled`;
      detail = 'A newer version of the document replaced the one that was approved';
      status = 'Cancelled';
      ref = requestRef;
      break;

    case 'document.created': {
      const kind = row.document_kind === 'invoice' || row.document_kind === 'agreement' ? row.document_kind : null;
      text = kind ? `${actor} saved ${kind} ${documentNumber(row) ?? ''}`.trim() : `${actor} saved a document`;
      detail =
        row.document_kind === 'invoice'
          ? 'Saved in Library · Not sent · No money moved'
          : 'Saved in Library · Unsigned · Not sent';
      status = 'Saved';
      ref = row.document_id ? { section: 'library', view: 'documents', id: row.document_id } : null;
      break;
    }

    case 'document.versioned':
      text = `${actor} revised ${documentNumber(row) ?? subject}`;
      detail = 'Anything waiting on the earlier version was cancelled';
      status = 'Revised';
      ref = row.document_id ? { section: 'library', view: 'documents', id: row.document_id } : null;
      break;

    case 'subject.redacted':
      text = 'An applicant’s data was erased';
      detail = 'History keeps a record that something happened, without their details';
      status = 'Erased';
      ref = { section: 'history', view: 'all' };
      break;

    case 'member.invited':
      text = `${actor} invited ${row.member_name ?? 'a new member'}`;
      detail = 'They can join once they accept';
      status = 'Invited';
      ref = { section: 'members' };
      break;

    case 'member.joined':
      text = `${row.member_name ?? 'A new member'} joined the workspace`;
      detail = 'They can now sign in';
      status = 'Joined';
      ref = { section: 'members' };
      break;

    case 'member.role_changed':
      text = `${actor} changed what ${row.member_name ?? 'a member'} can do`;
      detail = 'Nothing else about them changed';
      status = 'Changed';
      ref = { section: 'members' };
      break;

    case 'member.removed':
      text = `${actor} removed ${row.member_name ?? 'a member'}`;
      detail = 'They can no longer sign in to this workspace';
      status = 'Removed';
      ref = { section: 'members' };
      break;

    case 'agent.joined':
      text = `${row.agent_name ?? 'An agent'} joined the workspace`;
      status = 'Joined';
      break;

    case 'instruction.saved':
      text = `${actor} updated ${row.agent_name ? `${row.agent_name}’s` : 'the agent’s'} instructions`;
      status = 'Updated';
      break;

    case 'instruction.proposed':
      text = `${actor} suggested new instructions for ${agentInSentence(row)}`;
      detail = 'A person decides whether to use them';
      status = 'Suggested';
      break;

    case 'context.set':
      text = `${actor} updated the background notes the agent reads`;
      status = 'Updated';
      break;

    case 'settings.changed':
      if (row.actor_type === 'system') {
        text = 'Hermes switched the workspace to a model that is available';
        detail = 'The earlier default model could no longer be used';
      } else if (row.agent_name) {
        text = `${actor} changed ${row.agent_name}’s settings`;
      } else {
        text = `${actor} changed a workspace setting`;
      }
      status = 'Changed';
      break;

    case 'session.shared':
      text = `${actor} shared a conversation`;
      status = 'Shared';
      break;

    case 'session.unshared':
      text = `${actor} stopped sharing a conversation`;
      status = 'Private';
      break;

    case 'provider_key.added':
      text = `${actor} connected a model provider`;
      status = 'Connected';
      break;

    case 'provider_key.verified':
      text = `${actor} checked a model provider connection`;
      status = 'Checked';
      break;

    case 'provider_key.revoked':
      text = `${actor} disconnected a model provider`;
      status = 'Disconnected';
      break;

    case 'provider_key.attested':
      text = `${actor} confirmed a model provider’s data terms`;
      status = 'Confirmed';
      break;

    case 'provider_key.rewrapped':
      text = 'Hermes renewed the encryption on saved model provider connections';
      detail = 'Routine security upkeep · Nothing else changed';
      status = 'Done';
      break;

    case 'slack.connected':
      text = `${actor} connected Slack`;
      status = 'Connected';
      break;

    case 'slack.disconnected':
      text = `${actor} disconnected Slack`;
      status = 'Disconnected';
      break;

    case 'slack.credential_rewrapped':
      text = 'Hermes renewed the encryption on the Slack connection';
      detail = 'Routine security upkeep · Nothing else changed';
      status = 'Done';
      break;

    case 'workspace.created':
      text = `${actor} created the workspace`;
      status = 'Created';
      break;

    case 'workspace.deletion_scheduled':
      text = `${actor} scheduled this workspace for deletion`;
      detail = 'An Admin can cancel it before it happens';
      status = 'Scheduled';
      break;

    case 'workspace.deletion_cancelled':
      text = `${actor} cancelled the workspace deletion`;
      status = 'Cancelled';
      break;

    case 'workspace.deleted':
      text = `${actor} deleted the workspace`;
      status = 'Deleted';
      break;

    case 'run.errored':
      text = `${capitalize(agentInSentence(row))} stopped because something went wrong`;
      detail = 'Nothing was sent · Someone can try again from the conversation';
      status = 'Stopped';
      break;

    case 'run.retried':
      text = row.actor_type === 'system'
        ? `Hermes had ${agentInSentence(row)} try again`
        : `${actor} asked ${agentInSentence(row)} to try again`;
      status = 'Retried';
      break;

    case 'run.retry_cancelled':
      text = `${actor} cancelled a retry for ${agentInSentence(row)}`;
      status = 'Cancelled';
      break;

    case 'usage.cap_warning':
      text = 'The workspace is close to its daily usage limit';
      detail = 'An Admin can change the limit';
      status = 'Warning';
      break;

    case 'validator.failed':
      text = 'Hermes found a decision that was not made by a person';
      detail = 'The nightly check flags this so an Admin can look into it';
      status = 'Needs attention';
      break;

    case 'gmail.connected':
      text = `${actor} connected a Gmail account for sending`;
      detail = 'Hermes sends only emails a person approved';
      status = 'Connected';
      ref = { section: 'settings', view: 'Email' };
      break;

    case 'outbound_email.sent':
      text = `${capitalize(subject)} was sent`;
      detail = 'Sent from Gmail exactly as approved';
      status = 'Sent';
      ref = requestRef;
      break;

    case 'outbound_email.simulated':
      text = `Practice send: ${subject}`;
      detail = 'This deployment doesn’t deliver email, so nothing left Hermes';
      status = 'Not sent';
      ref = requestRef;
      break;

    case 'partner.invoice_received':
      text = `${actor} submitted an invoice`;
      detail = 'Waiting for the team to review it';
      status = 'Received';
      ref = requestRef;
      break;

    case 'partner.invoice_corrected':
      text = `${actor} submitted a corrected invoice`;
      detail = 'It replaces the earlier one';
      status = 'Corrected';
      ref = requestRef;
      break;

    case 'partner.decision_acknowledged':
      text = `The partner was shown the decision on ${subject}`;
      status = 'Seen';
      ref = requestRef;
      break;

    case 'email_handoff.completed':
      text = `${actor} marked ${isEmailHandoff(row) ? `“${handoffSubject(row)}”` : subject} handled`;
      detail = 'Closed by someone on the receiving team';
      status = 'Handled';
      ref = requestRef;
      break;

    case 'email_triage.retried':
      text = row.actor_type === 'system' ? 'Hermes asked the agent to read an email again' : `${actor} asked the agent to read an email again`;
      detail = row.actor_type === 'system' ? 'The model provider was busy · Retried automatically after a wait' : 'The last attempt did not finish';
      status = 'Retried';
      break;

    case 'inbound_email.received':
      text = 'An email arrived at a role inbox';
      detail = 'Checked and saved · The agent will read it';
      status = 'Received';
      break;

    case 'email_inbox.created':
    case 'email_inbox.removed':
      text = `${actor} ${row.kind === 'email_inbox.created' ? 'added' : 'removed'} a role inbox`;
      detail = row.kind === 'email_inbox.created' ? 'New forwarding address for a role' : 'Its stored emails were deleted';
      status = row.kind === 'email_inbox.created' ? 'Added' : 'Removed';
      break;

    default:
      ref = requestRef;
      break;
  }

  return {
    id: row.id,
    kind: row.kind,
    at: row.created_at.toISOString(),
    actor_name: actor.slice(0, 120),
    actor_type: row.actor_type,
    text: text.slice(0, 300),
    detail: detail.slice(0, 300),
    status: status.slice(0, 64),
    ref,
    request_id: row.request_id,
  };
}
