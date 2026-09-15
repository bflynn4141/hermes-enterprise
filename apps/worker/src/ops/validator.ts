// The nightly validator, as functions.
//
// Two checks run every night, and they answer two different questions.
//
// **The run-log validator** (`@hermes/shared`, `validateRunLog`) asks whether
// the event stream we served clients is a sequence that the state machine can
// actually produce: no step after a stop, no delta after a final, no two finals
// for one turn, ids monotonic. A violation means either a bug in the engine or
// an event written by something that is not the engine. The same validator runs
// in the client's reducer and in the M3 tests; running it nightly over the real
// stream is what turns "our tests pass" into "production agrees with our tests".
//
// **The human-only-decisions query** asks the question the whole product rests
// on: did a human decide every decision? Two halves, because there are two ways
// it could be false —
//
//   every `decisions.decided_by` is a real user with an active membership, and
//   no `events` row with `actor_type = 'agent'` has a decision-shaped kind.
//
// The first catches a decision attributed to nobody or to a ghost; the second
// catches the agent role writing an audit row that *claims* a decision. Three
// layers already make both impossible (grants, the `AgentDb` interface, the
// block validator), which is exactly why this query matters: it is the one that
// would tell us a layer had failed, and the pilot exit criterion in plan
// section 11 is that it runs daily and stays green.
//
// Everything here is a plain function over a `Tx` so it can be tested in Node
// against Docker Postgres. The Workflow in `src/workflows-long/` is a wrapper
// that pages and calls these.
import { validateRunLog, type RunLogViolation } from '@hermes/shared';
import type { Tx } from '../db/client.js';

/** How many runs one `step.do` covers. Plan section 5: "one step.do per 200 runs". */
export const RUNS_PER_STEP = 200;

export interface RunLogPage {
  readonly runsChecked: number;
  readonly violations: readonly (RunLogViolation & { readonly run_id: string })[];
  /** The last run id examined, for the next page's cursor. */
  readonly cursor: string | null;
}

interface RunRow {
  id: string;
  status: string;
}

/**
 * Validate one page of runs.
 *
 * Paged by `(created_at, id)` rather than by OFFSET: the table grows while the
 * validator walks it, and OFFSET would skip or repeat rows as it did. The
 * cursor is the last id of the previous page.
 *
 * `requireFinalPerTurn` is on only for terminal runs, because a run still
 * working has every right to have emitted deltas with no final yet — and a
 * validator that flagged that would cry wolf every night at a busy workspace.
 */
export async function validateRunLogPage(
  tx: Tx,
  workspaceId: string,
  cursor: string | null,
  limit = RUNS_PER_STEP,
): Promise<RunLogPage> {
  const { rows: runs } = await tx.query<RunRow>(
    `SELECT id, status FROM runs
      WHERE workspace_id = $1
        AND ($2::uuid IS NULL OR (created_at, id) > (SELECT created_at, id FROM runs WHERE id = $2::uuid))
      ORDER BY created_at, id
      LIMIT $3`,
    [workspaceId, cursor, limit],
  );
  if (runs.length === 0) return { runsChecked: 0, violations: [], cursor: null };

  const violations: (RunLogViolation & { run_id: string })[] = [];
  for (const run of runs) {
    // One run's slice of the outbox, in id order — which is the order clients
    // received it, because the hub fans out in id order and the replay route
    // reads the same column.
    const { rows: events } = await tx.query<{
      id: string;
      kind: string;
      payload: Record<string, unknown>;
      session_id: string | null;
      trace_id: string | null;
      created_at: Date;
    }>(
      `SELECT e.id::text AS id, e.kind, e.payload, e.session_id, e.trace_id, e.created_at
         FROM stream_events e
        WHERE e.workspace_id = $1
          AND e.payload->>'run_id' = $2
        ORDER BY e.id`,
      [workspaceId, run.id],
    );
    if (events.length === 0) continue;

    const terminal = run.status === 'completed' || run.status === 'error' || run.status === 'stopped';
    const result = validateRunLog(
      events.map((row) => ({
        id: row.id,
        workspace_id: workspaceId,
        session_id: row.session_id,
        kind: row.kind,
        payload: row.payload,
        schema_version: 1,
        trace_id: row.trace_id ?? 'unknown',
        at: row.created_at.toISOString(),
      })),
      { requireFinalPerTurn: terminal },
    );
    for (const violation of result.violations) violations.push({ ...violation, run_id: run.id });
  }

  return {
    runsChecked: runs.length,
    violations,
    cursor: runs.length < limit ? null : (runs[runs.length - 1]?.id ?? null),
  };
}

export interface HumanOnlyDecisionsResult {
  readonly decisionsChecked: number;
  /** Decisions whose `decided_by` is not a human member of the workspace. */
  readonly nonHumanDecisions: readonly { readonly decision_id: string; readonly reason: string }[];
  /** `events` rows written as the agent that claim a decision. */
  readonly agentDecisionEvents: readonly { readonly event_id: string; readonly kind: string }[];
  readonly ok: boolean;
}

/** Audit kinds that mean "a decision happened". An agent may write none of them. */
export const DECISION_EVENT_KINDS = ['decision.recorded', 'effect.executed', 'effect.assigned'] as const;

/**
 * The daily human-only-decisions query.
 *
 * Deliberately written as two SELECTs rather than one join with a CASE: the two
 * findings have different remediations. A decision attributed to a non-member
 * is a membership or migration problem; an agent-authored decision event is a
 * security incident, and conflating them in one count would let the second hide
 * inside the first.
 *
 * `decided_by` is NOT NULL in the schema, so the interesting failure is not a
 * null but a uuid that is not a user, or a user who is not a member here. The
 * test forges exactly that — as `owner`, because no role the product runs as
 * can write such a row, which is the point.
 */
export async function humanOnlyDecisions(tx: Tx, workspaceId: string): Promise<HumanOnlyDecisionsResult> {
  const { rows: decisions } = await tx.query<{ decision_id: string; reason: string }>(
    `SELECT d.id AS decision_id,
            CASE
              WHEN u.id IS NULL THEN 'decided_by is not a user'
              WHEN m.user_id IS NULL THEN 'decided_by is not a member of this workspace'
              ELSE 'unknown'
            END AS reason
       FROM decisions d
       LEFT JOIN users u ON u.id = d.decided_by
       LEFT JOIN members m ON m.user_id = d.decided_by AND m.workspace_id = d.workspace_id
      WHERE d.workspace_id = $1
        AND (u.id IS NULL OR m.user_id IS NULL)`,
    [workspaceId],
  );

  const { rows: counted } = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM decisions WHERE workspace_id = $1`,
    [workspaceId],
  );

  const { rows: agentEvents } = await tx.query<{ event_id: string; kind: string }>(
    `SELECT id AS event_id, kind FROM events
      WHERE workspace_id = $1 AND actor_type = 'agent' AND kind = ANY($2::text[])`,
    [workspaceId, [...DECISION_EVENT_KINDS]],
  );

  return {
    decisionsChecked: Number(counted[0]?.n ?? '0') || 0,
    nonHumanDecisions: decisions,
    agentDecisionEvents: agentEvents,
    ok: decisions.length === 0 && agentEvents.length === 0,
  };
}

export interface ValidatorSummary {
  readonly workspaces: number;
  readonly runsChecked: number;
  readonly violations: number;
  readonly decisionsChecked: number;
  readonly forgedDecisions: number;
  readonly ok: boolean;
  /** Ids and counts only. A test asserts this carries no free text. */
  readonly detail: Record<string, unknown>;
}

/**
 * Open the summary row, so a run that dies halfway leaves evidence that it
 * started. A nightly check whose only trace is a success row is a nightly check
 * that silently stops running.
 */
export async function openValidatorRun(tx: Tx): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(`INSERT INTO validator_runs DEFAULT VALUES RETURNING id`);
  return rows[0]?.id ?? '';
}

export async function closeValidatorRun(tx: Tx, id: string, summary: ValidatorSummary): Promise<void> {
  await tx.query(
    `UPDATE validator_runs
        SET finished_at = now(), workspaces = $2, runs_checked = $3, violations = $4,
            decisions_checked = $5, forged_decisions = $6, ok = $7, detail = $8::jsonb
      WHERE id = $1`,
    [
      id,
      summary.workspaces,
      summary.runsChecked,
      summary.violations,
      summary.decisionsChecked,
      summary.forgedDecisions,
      summary.ok,
      JSON.stringify(summary.detail),
    ],
  );
}

/** The most recent summary, for `/health` and the runbook's "was it green". */
export async function lastValidatorRun(tx: Tx): Promise<{
  id: string;
  ok: boolean;
  started_at: Date;
  finished_at: Date | null;
} | null> {
  const { rows } = await tx.query<{ id: string; ok: boolean; started_at: Date; finished_at: Date | null }>(
    `SELECT id, ok, started_at, finished_at FROM validator_runs ORDER BY started_at DESC LIMIT 1`,
  );
  return rows[0] ?? null;
}
