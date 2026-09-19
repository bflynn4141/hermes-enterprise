// The `receipt` job: the two messages a decision leaves in the conversation.
//
// A decision is made in the Inbox, which is a different surface from the chat
// the request came out of. The demo closed that loop by writing two lines into
// the session: a `human` line saying what the person did, and Iris's
// acknowledgement of the new state. This job is that, with the three properties
// a chat message written by a background job has to have:
//
//   * **It goes to the originating session**, `requests.session_id`, not to
//     whatever session happens to be open. The request was proposed in one
//     conversation and the receipt belongs in that conversation, even if the
//     person who decided it was looking at another.
//   * **It is idempotent.** The job is keyed on `decision_id`
//     (UNIQUE(kind, key) in `jobs`), and the two messages carry
//     `client_id = receipt:{decision_id}:{role}` under
//     UNIQUE(session_id, client_id). So a replayed job — the committing request
//     died after the commit and the minute Cron picked it up, or the claim
//     expired mid-flight — writes nothing the second time. A duplicated receipt
//     is not a cosmetic bug: it reads as a second decision.
//   * **Iris's line is derived from current state, not from the payload.**
//     "Three requests remain" comes from `v_inbox_count` at the moment the
//     receipt is written, which is the same view the Inbox badge reads. A count
//     carried in the job payload would be the count at decision time, and four
//     decisions in quick succession would leave four confident, wrong numbers
//     in the transcript.
//
// The `entity.updated` for the request rides along, because a client that was
// looking at the request when somebody else decided it should refetch rather
// than keep rendering an Approve button.
import type { Env } from '../env.js';
import type { Job } from '../jobs.js';
import { publishEvents, runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';

export interface ReceiptJobPayload {
  readonly decision_id: string;
  readonly request_id: string;
  /** Where the receipt is posted. Null when the request had no session. */
  readonly session_id: string | null;
  readonly kind: 'application' | 'invoice' | 'agreement';
  readonly decision: 'approve' | 'decline';
  readonly resulting_status: string;
  /** Effect rows the decision recorded as pending. None of them executed. */
  readonly effect_ids: readonly string[];
}

export function parseReceiptPayload(payload: unknown): ReceiptJobPayload | null {
  const value = (payload ?? {}) as Partial<ReceiptJobPayload>;
  if (typeof value.decision_id !== 'string' || typeof value.request_id !== 'string') return null;
  if (value.decision !== 'approve' && value.decision !== 'decline') return null;
  return {
    decision_id: value.decision_id,
    request_id: value.request_id,
    session_id: typeof value.session_id === 'string' ? value.session_id : null,
    kind: value.kind ?? 'application',
    decision: value.decision,
    resulting_status: typeof value.resulting_status === 'string' ? value.resulting_status : 'pending',
    effect_ids: Array.isArray(value.effect_ids) ? value.effect_ids.filter((id): id is string => typeof id === 'string') : [],
  };
}

// ---------------------------------------------------------------------------
// The template
// ---------------------------------------------------------------------------

const COUNT_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'] as const;

/** "Three requests remain." Derived, never stored; invariant 4. */
export function remainingSentence(pending: number): string {
  if (pending === 0) return 'No requests remain.';
  const word = COUNT_WORDS[pending] ?? String(pending);
  return pending === 1 ? 'One request remains.' : `${word} requests remain.`;
}

/** The first name, when the label is a person's name; the whole label otherwise. */
const firstName = (label: string): string => label.trim().split(/\s+/)[0] ?? label;

export interface ReceiptText {
  readonly human: string;
  readonly iris: string;
}

/**
 * The two lines, from the demo's `adapter.mjs` listener.
 *
 * Every sentence names what did *not* happen, because that is the part a reader
 * would otherwise assume: admitted but access pending, created but not sent,
 * saved but unsigned, declined and no message sent.
 */
export function receiptText(input: {
  actor: string;
  kind: ReceiptJobPayload['kind'];
  decision: ReceiptJobPayload['decision'];
  label: string;
  number: string | null;
  pending: number;
}): ReceiptText {
  const rest = remainingSentence(input.pending);
  const subject = input.kind === 'application' ? firstName(input.label) : (input.number ?? input.label);

  if (input.decision === 'decline') {
    return {
      human: `${input.actor} declined ${subject} in Inbox`,
      iris: `${subject}’s ${input.kind} is declined. No message was sent. ${rest}`,
    };
  }
  switch (input.kind) {
    case 'application':
      return {
        human: `${input.actor} admitted ${subject} in Inbox`,
        iris: `${subject} is admitted. Access is pending. ${rest}`,
      };
    case 'invoice':
      return {
        human: `${input.actor} approved Create invoice in Inbox`,
        iris: `Invoice ${subject} is created in Library. Not sent. No money moved. ${rest}`,
      };
    default:
      return {
        human: `${input.actor} approved Create draft in Inbox`,
        iris: `Agreement ${subject} is saved as an unsigned draft in Library. Not sent. ${rest}`,
      };
  }
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

interface Context {
  label: string;
  payload: Record<string, unknown> | null;
  actor: string;
  pending: number;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** `client_id` for one of the two rows; the idempotency key inside the session. */
export const receiptClientId = (decisionId: string, role: 'human' | 'iris'): string =>
  `receipt:${decisionId}:${role}`;

export async function runReceiptJob(env: Env, job: Pick<Job, 'workspace_id' | 'key' | 'payload'>): Promise<void> {
  const parsed = parseReceiptPayload(job.payload);
  if (!parsed) {
    // Malformed payloads are logged and finished rather than retried: the same
    // bytes will be just as malformed in a minute.
    console.log(JSON.stringify({ at: 'job.receipt', key: job.key, ok: false, note: 'malformed receipt payload' }));
    return;
  }
  const sessionId = parsed.session_id;
  if (!sessionId) {
    console.log(
      JSON.stringify({ at: 'job.receipt', key: job.key, decision_id: parsed.decision_id, note: 'no originating session' }),
    );
    return;
  }

  const jobs = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    // The idempotency check, before anything is allocated. Doing it after
    // `next_seq` was incremented would leave a gap in the transcript's sequence
    // numbers on every replay.
    const existing = await tx.query(`SELECT 1 FROM messages WHERE session_id = $1 AND client_id = $2`, [
      sessionId,
      receiptClientId(parsed.decision_id, 'human'),
    ]);
    if (existing.rowCount && existing.rowCount > 0) return [];

    const context = await tx.query<Context>(
      `SELECT r.label,
              r.payload,
              COALESCE(u.name, 'An Admin') AS actor,
              (
                SELECT count(*)::integer
                  FROM requests pending_request
                 WHERE pending_request.workspace_id=$2 AND pending_request.status='pending'
                   AND (
                     NOT EXISTS (
                       SELECT 1 FROM request_audiences audience
                        WHERE audience.workspace_id=pending_request.workspace_id
                          AND audience.request_id=pending_request.id
                     )
                     OR EXISTS (
                       SELECT 1 FROM request_audiences audience
                        WHERE audience.workspace_id=pending_request.workspace_id
                          AND audience.request_id=pending_request.id
                          AND audience.user_id=origin.owner_id
                     )
                   )
              ) AS pending
         FROM requests r
         JOIN sessions origin ON origin.workspace_id=r.workspace_id AND origin.id=$3
         LEFT JOIN decisions d ON d.request_id = r.id
         LEFT JOIN users u ON u.id = d.decided_by
        WHERE r.workspace_id=$2 AND r.id=$1`,
      [parsed.request_id, job.workspace_id, sessionId],
    );
    const row = context.rows[0];
    if (!row) return [];

    const payload = asRecord(row.payload);
    const text = receiptText({
      actor: row.actor,
      kind: parsed.kind,
      decision: parsed.decision,
      // A redacted request has no name left to print, and the receipt says so
      // rather than printing an empty string.
      label: payload.redacted === true ? 'A deleted applicant' : row.label,
      number: typeof payload.number === 'string' ? payload.number : null,
      pending: Number(row.pending) || 0,
    });

    const block = {
      type: 'receipt',
      title: text.human,
      subtitle: text.iris,
      requestId: parsed.request_id,
    };

    const appended: { id: string; seq: number; role: 'human' | 'iris'; text: string; blocks: unknown[] }[] = [];
    for (const [role, body, blocks] of [
      ['human', text.human, []],
      ['iris', text.iris, [block]],
    ] as const) {
      const seqRow = await tx.query<{ seq: number }>(
        `UPDATE sessions SET next_seq = next_seq + 1, last_activity_at = now()
          WHERE id = $1 RETURNING next_seq - 1 AS seq`,
        [sessionId],
      );
      const seq = seqRow.rows[0]?.seq ?? 0;
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO messages (workspace_id, session_id, seq, role, kind, text, blocks, status, client_id)
         VALUES ($1, $2, $3, $4, 'receipt', $5, $6::jsonb, 'complete', $7)
         ON CONFLICT (session_id, client_id) WHERE client_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          job.workspace_id,
          sessionId,
          seq,
          role,
          body,
          JSON.stringify(blocks),
          receiptClientId(parsed.decision_id, role),
        ],
      );
      const id = inserted.rows[0]?.id;
      if (id) appended.push({ id, seq, role, text: body, blocks: [...blocks] });
    }

    return publishEvents(
      tx,
      job.workspace_id,
      [
        ...appended.map((message) => ({
          kind: 'message.appended',
          sessionId,
          payload: {
            message_id: message.id,
            session_id: sessionId,
            seq: message.seq,
            role: message.role,
            kind: 'receipt',
            text: message.text,
            blocks: message.blocks,
            status: 'complete',
            run_id: null,
          },
        })),
        {
          kind: 'entity.updated',
          payload: {
            entity_type: 'request',
            entity_id: parsed.request_id,
            ref: { section: 'inbox', view: 'request', id: parsed.request_id },
            version: null,
          },
        },
      ],
    );
  });

  await runJobsAfterCommit(env, job.workspace_id, jobs);
}
