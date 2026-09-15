// The `receipt` job, typed and inert until M4.
//
// What it will do: post a template receipt into the session the request came
// from, keyed on `decision_id`, so that two tabs deciding the same request
// still produce one receipt (the `jobs` UNIQUE(kind, key) is the idempotency
// and `decision_id` is the id inside the key).
//
// Why it is a stub rather than absent: the decision route (M4) writes the row
// in the same transaction as the decision, and a job kind with no runner would
// be claimed, fail, and retry once a minute forever. This runner is honest
// instead — it says the payload is well-formed and that the work lands in M4 —
// and the shape below is the contract M4 fills in, so that the route and the
// runner cannot disagree about what a receipt job carries.
import type { Env } from '../env.js';

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

/**
 * M4 replaces the body. Until then the job completes rather than retrying, so
 * a decision recorded against a pre-M4 deploy does not leave a job churning.
 */
export async function runReceiptJob(env: Env, jobKey: string, payload: unknown): Promise<void> {
  void env;
  const parsed = parseReceiptPayload(payload);
  console.log(
    JSON.stringify({
      at: 'job.receipt',
      key: jobKey,
      decision_id: parsed?.decision_id ?? null,
      ok: parsed !== null,
      note: parsed === null ? 'malformed receipt payload' : 'the receipt template lands in M4',
    }),
  );
  return Promise.resolve();
}
