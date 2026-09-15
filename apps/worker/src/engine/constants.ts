// Every timeout, limit and budget the run engine obeys, in one place.
//
// Each constant carries the sentence from the production plan that fixed it,
// because a number without its reason is a number the next person rounds. The
// citations are to `planning/agent-workspace/PRODUCTION-PLAN.md` revision 4.

/**
 * Plan section 4, Steps: "the documented defaults are `retries: { limit: 5,
 * delay: 10000, backoff: 'exponential' }, timeout: '10 minutes'` per attempt
 * ... A Max-effort turn can stream past 10 minutes, so the provider step sets
 * `timeout: '30 minutes'` with `retries.limit: 3`".
 */
export const PROVIDER_STEP_TIMEOUT = '30 minutes' as const;
export const PROVIDER_STEP_RETRY_LIMIT = 3;
export const PROVIDER_STEP_RETRY_DELAY_MS = 10_000;

/** Plan section 4, Steps: "tool steps `timeout: '2 minutes'`". */
export const TOOL_STEP_TIMEOUT = '2 minutes' as const;
export const TOOL_STEP_RETRY_LIMIT = 3;
export const TOOL_STEP_RETRY_DELAY_MS = 5_000;

/**
 * Plan section 4, Subrequest budget: "Twelve 5-minute provider steps at one RPC
 * per 250 ms would be 14,400, so deltas are batched at 500 ms to 1 s". The
 * lower end is used: it is the one that keeps the stream feeling live.
 */
export const DELTA_BATCH_MS = 500;

/**
 * Plan section 4, Subrequest budget: the per-instance limit is "10,000/request
 * (default), configurable up to 10 million" and "the validator alarms at 50
 * percent of budget".
 */
export const SUBREQUEST_BUDGET = 10_000;
export const SUBREQUEST_ALARM_FRACTION = 0.5;

/**
 * Plan section 4, Steps: "The provider step reads guidance and the last 20
 * `run_turns`". Older turns reach the model as a summary instead.
 */
export const TURN_HISTORY_LIMIT = 20;

/** Plan section 4, Controls, Waiting: `timeout: '30 days'`, default 24 hours. */
export const CONTEXT_WAIT_TIMEOUT = '30 days' as const;
export const CONTEXT_ANSWERED_EVENT = 'context-answered' as const;

/**
 * Plan section 4: "`runs.max_turns` default 12", which is also the number the
 * subrequest budget was computed against.
 */
export const DEFAULT_MAX_TURNS = 12;

/** Plan section 4, Tools: "results over 8 KB truncated with a marker". */
export const TOOL_RESULT_MAX_BYTES = 8 * 1024;
export const TOOL_RESULT_TRUNCATION_MARKER = '\n[truncated: the result exceeded 8 KB]';

/** Plan section 4, Tools: "30 s timeout" for one tool execution. */
export const TOOL_EXECUTION_TIMEOUT_MS = 30_000;

/** Plan section 4, Tools: `get_document_text(offset, <= 6,000 tokens/call)`. */
export const DOCUMENT_TEXT_MAX_TOKENS = 6_000;
/** Four characters per token is the rule of thumb the offset window uses. */
export const CHARS_PER_TOKEN = 4;
/** The plan's nominal window: 6,000 tokens at four characters each. */
export const DOCUMENT_TEXT_NOMINAL_CHARS = DOCUMENT_TEXT_MAX_TOKENS * CHARS_PER_TOKEN;

/**
 * The window `get_document_text` actually asks for, and why it is not the
 * number above.
 *
 * The plan names two limits that contradict each other: a 6,000-token window
 * (24,000 characters) and an 8 KB cap on a tool result. The tool asked for the
 * larger one and `toolResultEnvelope` then cut it to the smaller, so the model
 * received about a third of what it requested, `next_offset` pointed past the
 * end of what it had actually read, and paging through a long document silently
 * skipped two characters in every three (security review O9). Asking for a
 * window that fits is the fix: the offset arithmetic and the bytes the model
 * sees are the same number again.
 *
 * The headroom is for the envelope itself — the tool name, the source, the
 * timestamp, the injection verdict — plus JSON escaping, which can grow a
 * character into six (`\u202e`).
 */
export const TOOL_RESULT_ENVELOPE_HEADROOM_BYTES = 1_024;
export const DOCUMENT_TEXT_MAX_CHARS = Math.min(
  DOCUMENT_TEXT_NOMINAL_CHARS,
  TOOL_RESULT_MAX_BYTES - TOOL_RESULT_ENVELOPE_HEADROOM_BYTES,
);

/**
 * Plan section 5, Resume, orphans, jobs: a run with "no event for 10 minutes,
 * a dead or purged instance ... or an old `engine_version`" is swept.
 */
export const ORPHAN_NO_EVENT_MINUTES = 10;

/**
 * Plan section 4, Controls, Stop: "The spike must honour Stop within 1 s,
 * number recorded". The engine test asserts against this budget.
 */
export const STOP_LATENCY_BUDGET_MS = 1_000;

/**
 * Plan section 4, Key and provider failures: malformed tool JSON gets "one
 * corrective tool_result then permanent".
 */
export const MALFORMED_TOOL_JSON_CORRECTIONS = 1;

/** Transient backoff, jittered so that three runs failing together do not retry together. */
export const TRANSIENT_BACKOFF_BASE_MS = 1_000;
export const TRANSIENT_BACKOFF_MAX_MS = 30_000;
export const TRANSIENT_MAX_ATTEMPTS = PROVIDER_STEP_RETRY_LIMIT;

/** Deterministic jitter so a test can assert the sequence without a clock. */
export function transientBackoffMs(attempt: number, random: number): number {
  const exponential = Math.min(TRANSIENT_BACKOFF_MAX_MS, TRANSIENT_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  // Full jitter: a uniform draw in [0, exponential]. Equal-jitter would still
  // synchronise the first half of every backoff.
  return Math.round(exponential * Math.min(1, Math.max(0, random)));
}
