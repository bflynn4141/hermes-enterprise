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
import { EFFECT_LABELS, EFFECT_SIMULATED_REASON, EFFECT_UNAVAILABLE_REASON } from './effects.js';
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
         ar.work_status    AS approval_work_status
    FROM events e
    LEFT JOIN users actor   ON actor.id = e.actor_user_id
    LEFT JOIN decisions d   ON d.id = e.decision_id
    LEFT JOIN effects f     ON f.id = e.effect_id
    LEFT JOIN documents doc ON doc.id = e.document_id
    LEFT JOIN requests r    ON r.id = COALESCE(e.request_id, f.request_id, doc.request_id)
    LEFT JOIN members m     ON m.id = e.member_id
    LEFT JOIN users mu      ON mu.id = m.user_id
    LEFT JOIN approval_requests ar ON ar.request_id = e.request_id`;

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
  return row.actor_type === 'agent' ? 'Iris' : row.actor_type === 'system' ? 'Hermes' : 'Someone';
};

const subjectOrNumber = (row: HistoryRow): string =>
  row.request_kind === 'application' ? subjectName(row) : (documentNumber(row) ?? subjectName(row));

/** The demo's receipt detail lines, which are also this product's promises. */
function decisionDetail(row: HistoryRow): string {
  if (row.decision === 'decline') return 'No further action taken · No message sent';
  if (row.request_kind === 'application') return 'Access pending · No message sent';
  if (row.request_kind === 'invoice') return 'Saved in Library · Not sent · No money moved';
  return 'Saved in Library · Unsigned · Not sent';
}

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
  let text = `${actor} · ${row.kind}`;
  let detail = '';
  let status = '';
  let ref: RenderedEvent['ref'] = null;

  switch (row.kind) {
    case 'request.created':
      text =
        row.request_kind === 'application'
          ? `${actor} screened ${subject}’s application`
          : row.request_kind === 'invoice'
            ? `${actor} prepared invoice ${documentNumber(row) ?? subject}`
            : row.request_kind === 'approval'
              ? `${actor} proposed ${str(asRecord(row.request_payload).summary) ?? subject}`
            : `${actor} prepared agreement ${documentNumber(row) ?? subject}`;
      detail = 'Proposed for review · No decision taken';
      status = row.request_status === 'pending' ? 'Needs review' : 'Reviewed';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    case 'request.hidden':
      text = `${actor} hid ${subjectOrNumber(row)} from their Inbox`;
      detail = 'Personal organization only · Request and other reviewers unchanged';
      status = 'Hidden';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    case 'request.restored':
      text = `${actor} restored ${subjectOrNumber(row)} to their Inbox`;
      detail = 'Personal Inbox visibility restored · Workflow unchanged';
      status = 'Restored';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    case 'approval.proposed':
      text = `${actor} proposed ${str(asRecord(row.request_payload).summary) ?? subject}`;
      detail = 'Human authorization pending · No effect executed';
      status = row.approval_status ?? 'pending';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    case 'approval.vote_recorded':
      text = `${actor} recorded an approval vote for ${subject}`;
      detail = 'Human vote recorded · Quorum and current membership rechecked';
      status = row.approval_status ?? 'pending';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    case 'approval.revised':
      text = `${actor} submitted a new version of ${subject}`;
      detail = 'Earlier votes superseded · New authorization hash required';
      status = row.approval_status ?? 'pending';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    case 'approval.routed':
      text = `${actor} routed ${subject}`;
      detail = 'Assignment changed within the immutable review policy';
      status = row.approval_status ?? 'pending';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    case 'approval.finalized':
      text = `Required human reviewers authorized ${subject}`;
      detail = `Authorization approved · Work ${row.approval_work_status ?? 'ready'} · Effect ${row.approval_effect_status ?? 'not required'}`;
      status = row.approval_status ?? 'approved';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    case 'approval.expired':
      text = `${subject} expired without authorization`;
      detail = 'No approval by timeout · Dependent work cancelled';
      status = 'expired';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
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
      status = row.request_status ?? '';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    case 'effect.assigned':
      text = `${actor} assigned ${EFFECT_LABELS[row.effect_kind as EffectKind] ?? 'an effect'}`;
      detail = `Waiting on a ${row.effect_role ?? 'reviewer'} reviewer · Nothing executed`;
      status = row.effect_status ?? 'pending';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    case 'effect.executed':
      if (row.effect_status === 'simulated') {
        text = `${actor} simulated ${EFFECT_LABELS[row.effect_kind as EffectKind] ?? 'an effect'}`;
        detail = row.effect_simulation_summary ?? EFFECT_SIMULATED_REASON;
        status = 'simulated';
      } else {
        text = `${actor} tried ${EFFECT_LABELS[row.effect_kind as EffectKind] ?? 'an effect'}`;
        detail = EFFECT_UNAVAILABLE_REASON;
        status = row.effect_status ?? 'unavailable';
      }
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    case 'effect.cancelled':
      text = `${EFFECT_LABELS[row.effect_kind as EffectKind] ?? 'An effect'} was cancelled`;
      detail = row.effect_cancelled_reason ?? 'Superseded by a new document version';
      status = 'cancelled';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    case 'document.created':
      text = `${actor} saved ${row.document_kind ?? 'a document'} ${documentNumber(row) ?? ''}`.trim();
      detail =
        row.document_kind === 'invoice'
          ? 'Saved in Library · Not sent · No money moved'
          : 'Saved in Library · Unsigned · Not sent';
      status = 'Saved';
      ref = row.document_id ? { section: 'library', view: 'documents', id: row.document_id } : null;
      break;

    case 'document.versioned':
      text = `${actor} saved version ${row.document_version ?? ''} of ${documentNumber(row) ?? subject}`.trim();
      detail = 'Pending effects cancelled · Re-rendering';
      status = 'Versioned';
      ref = row.document_id ? { section: 'library', view: 'documents', id: row.document_id } : null;
      break;

    case 'subject.redacted':
      text = 'An applicant’s data was erased';
      detail = 'The audit trail keeps ids and event kinds only';
      status = 'Erased';
      ref = { section: 'history', view: 'all' };
      break;

    case 'member.invited':
    case 'member.joined':
    case 'member.role_changed':
    case 'member.removed': {
      const who = row.member_name ?? 'a member';
      const verb =
        row.kind === 'member.invited'
          ? 'invited'
          : row.kind === 'member.joined'
            ? 'welcomed'
            : row.kind === 'member.role_changed'
              ? 'changed the role of'
              : 'removed';
      text = `${actor} ${verb} ${who}`;
      detail = 'Membership is the authorization lookup; nothing else changed';
      status = 'Members';
      ref = { section: 'members' };
      break;
    }

    case 'gmail.connected':
      text = `${actor} connected a Gmail outreach sender`;
      detail = 'Dedicated sender · Exact approved email revisions only';
      status = 'Connected';
      ref = { section: 'settings', view: 'Email' };
      break;

    case 'outbound_email.sent':
      text = `${actor} sent ${subject}`;
      detail = 'Exact approved email revision · Gmail delivery confirmed';
      status = 'Sent';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
      break;

    default:
      text = `${actor} · ${row.kind}`;
      detail = '';
      status = '';
      ref = row.request_id ? { section: 'inbox', view: 'request', id: row.request_id } : null;
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
