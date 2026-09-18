// Requests as the review pane reads them.
//
// One row in `requests` has to serve three different screens — an application's
// evidence report, an invoice's line items, an agreement's numbered sections —
// and the client parses every response with `requestEntitySchema`, which is
// `.strict()`. That strictness is the design constraint here and a good one: a
// field the contract does not name cannot be smuggled into the client, so the
// shaping happens on this side, in one function, rather than as three views'
// worth of optional keys.
//
// Two consequences worth naming:
//
//   * `subject` and `title` are *derived* from the payload rather than stored.
//     The demo showed the person's name above an application and the document
//     number above an invoice, and both come from the payload the agent already
//     had to validate against `documents.ts`. A second stored copy would be a
//     second thing to redact.
//   * `version` is the row's `updated_at` in whole seconds. The client uses it
//     as an optimistic-concurrency hint — refetch when the number you hold is
//     older than the one an event carried — and a timestamp already has exactly
//     that property without a column that something has to remember to bump.
import type { Tx } from '../db/client.js';
import type { ApprovalListProjection, RequestKind, RequestTriage } from '@hermes/shared';
import { decisionSummary } from './request-summary.js';

export interface RequestRow {
  id: string;
  kind: RequestKind;
  status: string;
  label: string;
  payload: Record<string, unknown> | null;
  session_id: string | null;
  run_id: string | null;
  created_at: Date;
  version: number;
  note: string | null;
  decision_id: string | null;
  decided_at: Date | null;
  decided_by_name: string | null;
  triage_status?: 'pending' | 'complete' | 'abstained' | 'failed' | null;
  triage_score?: string | number | null;
  triage_band?: 'urgent' | 'high' | 'normal' | 'low' | null;
  triage_confidence?: string | number | null;
  triage_reason_codes?: unknown;
  triage_completed_at?: Date | null;
  triage_rubric_version?: string | null;
  triage_model_id?: string | null;
}

/** Every column the shaping needs, plus the latest note and the decision. */
export const REQUEST_SELECT = `
  SELECT r.id, r.kind, r.status, r.label, r.payload, r.session_id, r.run_id, r.created_at,
         EXTRACT(EPOCH FROM r.updated_at)::int AS version,
         (SELECT n.body FROM request_notes n
           WHERE n.request_id = r.id ORDER BY n.created_at DESC, n.id DESC LIMIT 1) AS note,
         d.id AS decision_id,
         d.decided_at,
         u.name AS decided_by_name,
         ta.status AS triage_status,
         ta.priority_score AS triage_score,
         ta.priority_band AS triage_band,
         ta.confidence AS triage_confidence,
         ta.reason_codes AS triage_reason_codes,
         ta.completed_at AS triage_completed_at,
         ta.rubric_version AS triage_rubric_version,
         ta.model_id AS triage_model_id
    FROM requests r
    LEFT JOIN decisions d ON d.request_id = r.id
    LEFT JOIN users u ON u.id = d.decided_by
    LEFT JOIN LATERAL (
      SELECT status, priority_score, priority_band, confidence, reason_codes,
             completed_at, rubric_version, model_id
        FROM request_triage_assessments
       WHERE request_id = r.id
         AND request_version = EXTRACT(EPOCH FROM r.updated_at)::int
       ORDER BY created_at DESC
       LIMIT 1
    ) ta ON true`;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

/** Who or what the request is about. Null after a tombstone, by construction. */
export function subjectOf(row: Pick<RequestRow, 'kind' | 'payload' | 'label'>): string | null {
  const payload = asRecord(row.payload);
  if (payload.redacted === true) return null;
  switch (row.kind) {
    case 'application':
      return text(asRecord(payload.applicant).name) ?? text(row.label);
    case 'invoice':
      return text(asRecord(payload.payee).name) ?? text(row.label);
    case 'agreement': {
      const parties = Array.isArray(payload.parties) ? payload.parties : [];
      return text(asRecord(parties[0]).name) ?? text(row.label);
    }
    case 'approval':
      return text(row.label);
    default:
      return text(row.label);
  }
}

/** The line under the subject: the role applied for, or the document number. */
export function titleOf(row: Pick<RequestRow, 'kind' | 'payload'>): string | null {
  const payload = asRecord(row.payload);
  if (payload.redacted === true) return null;
  switch (row.kind) {
    case 'application':
      return text(payload.proposed_role) ?? text(asRecord(payload.applicant).title);
    case 'invoice': {
      const number = text(payload.number);
      return number ? `Invoice ${number}` : null;
    }
    case 'agreement': {
      const number = text(payload.number);
      return number ? `Agreement ${number}` : null;
    }
    case 'approval':
      return text(payload.summary) ?? text(payload.approval_type);
    default:
      return null;
  }
}

interface Source {
  id: string;
  name: string;
  note: string;
}

/** The evidence list, trimmed to the contract's field set and limits. */
function sourcesOf(payload: Record<string, unknown>): Source[] {
  const raw = Array.isArray(payload.sources) ? payload.sources : Array.isArray(payload.evidence) ? payload.evidence : [];
  return raw.slice(0, 20).flatMap((entry): Source[] => {
    const source = asRecord(entry);
    const id = text(source.id);
    const name = text(source.name) ?? text(source.label);
    if (!id || !name) return [];
    return [{ id: id.slice(0, 64), name: name.slice(0, 200), note: (text(source.note) ?? '').slice(0, 400) }];
  });
}

function missingOf(payload: Record<string, unknown>): string[] {
  const raw = Array.isArray(payload.missing) ? payload.missing : [];
  return raw.filter((value): value is string => typeof value === 'string').slice(0, 20).map((v) => v.slice(0, 200));
}

/** The row as `requestEntitySchema` wants it. Parse the result before sending. */
function triageOf(row: RequestRow, active: boolean, approval: ApprovalListProjection | null): RequestTriage {
  if (!active) return { status: 'unavailable', band: 'assessing', score: null, confidence: null, reason_codes: [], assessed_at: null, rubric_version: row.triage_rubric_version ?? '1', model_id: row.triage_model_id ?? 'typesafe/jev' };
  const status = row.triage_status ?? 'pending';
  const complete = status === 'complete' && row.triage_band !== null;
  const reasons = Array.isArray(row.triage_reason_codes) ? row.triage_reason_codes.filter((value): value is string => typeof value === 'string').slice(0, 8) : [];
  const result: RequestTriage = {
    status,
    band: complete ? row.triage_band! : 'assessing',
    score: complete && row.triage_score !== null ? Number(row.triage_score) : null,
    confidence: complete && row.triage_confidence !== null ? Number(row.triage_confidence) : null,
    reason_codes: reasons,
    assessed_at: row.triage_completed_at?.toISOString() ?? null,
    rubric_version: row.triage_rubric_version ?? '1',
    model_id: row.triage_model_id ?? 'typesafe/jev',
  };
  if (complete && approval && row.status === 'pending') {
    const expiresInHours = (Date.parse(approval.expires_at) - Date.now()) / 3_600_000;
    if (expiresInHours <= 4) {
      result.band = 'urgent';
      result.score = Math.max(result.score ?? 0, 90);
      result.reason_codes = [...new Set(['expires_within_4h', ...result.reason_codes])].slice(0, 8);
    } else if (expiresInHours <= 24 && result.band !== 'urgent') {
      result.band = 'high';
      result.score = Math.max(result.score ?? 0, 70);
      result.reason_codes = [...new Set(['expires_within_24h', ...result.reason_codes])].slice(0, 8);
    }
  }
  return result;
}

export function toRequestEntity(row: RequestRow, approval: ApprovalListProjection | null = null, triageActive = false, canDecideLegacy = false): Record<string, unknown> {
  const payload = asRecord(row.payload);
  const subject = subjectOf(row);
  const title = titleOf(row);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    label: row.label.slice(0, 200),
    subject: subject?.slice(0, 200) ?? null,
    title: title?.slice(0, 200) ?? null,
    session_id: row.session_id,
    run_id: row.run_id,
    created_at: row.created_at.toISOString(),
    version: Math.max(0, row.version),
    payload,
    sources: sourcesOf(payload),
    missing: missingOf(payload),
    note: row.note,
    decision_id: row.decision_id,
    decided_at: row.decided_at ? row.decided_at.toISOString() : null,
    decided_by_name: row.decided_by_name,
    approval,
    decision_summary: decisionSummary(row, approval, canDecideLegacy),
    triage: triageOf(row, triageActive, approval),
  };
}

/** One request, or null. Runs under the caller's tenant transaction. */
export async function loadRequest(tx: Tx, requestId: string): Promise<RequestRow | null> {
  const { rows } = await tx.query<RequestRow>(`${REQUEST_SELECT} WHERE r.id = $1`, [requestId]);
  return rows[0] ?? null;
}
