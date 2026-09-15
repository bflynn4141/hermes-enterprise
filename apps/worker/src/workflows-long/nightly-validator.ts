// NightlyValidator: one `step.do` per 200 runs, plus the daily human-only
// decisions query.
//
// Plan section 5: "`NightlyValidator` is a Workflow (one `step.do` per 200
// runs) because a Cron handler caps at 15 minutes (**verified**)." That is the
// whole reason this is not a Cron handler: a Cron handler that ran out of time
// would fail silently at whatever workspace it had reached, and the nightly
// check nobody notices stopping is worse than no nightly check, because
// somebody is relying on it.
//
// Paging is per workspace and per 200 runs. Each page is its own step, so a
// night that dies at three in the morning resumes at the page it died on rather
// than re-reading a hundred thousand stream events.
//
// The summary row is opened before the first page and closed after the last, so
// a run that never finished leaves a row with a null `finished_at` — which is
// exactly the signal "the validator stopped running" that a success-only record
// could never give.
import type { Env } from '../env.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { connect } from '../db/client.js';
import {
  RUNS_PER_STEP,
  closeValidatorRun,
  humanOnlyDecisions,
  openValidatorRun,
  validateRunLogPage,
  type ValidatorSummary,
} from '../ops/validator.js';
import { listWorkspaceIds } from './kek-rotation.js';
import { logEvent } from '../keys/redact.js';

export interface ValidatorStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

/** Guard against a pathological workspace holding the night open forever. */
export const MAX_PAGES_PER_WORKSPACE = 200;

/**
 * Open and close the summary as `app` with no tenant key: `validator_runs` is a
 * platform table (0012), one row for the whole night across every tenant, which
 * is the only shape the question has.
 */
async function withPlatform<T>(env: Env, fn: (tx: import('../db/client.js').Tx) => Promise<T>): Promise<T> {
  const client = await connect(env, 'app');
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

export interface NightlyValidatorDeps {
  listWorkspaces(): Promise<readonly string[]>;
}

export async function runNightlyValidator(
  env: Env,
  step: ValidatorStep,
  deps: NightlyValidatorDeps = { listWorkspaces: () => listWorkspaceIds(env) },
): Promise<ValidatorSummary> {
  const summaryId = await step.do('open-summary', () => withPlatform(env, (tx) => openValidatorRun(tx)));
  const workspaces = await step.do('list-workspaces', () => deps.listWorkspaces().then((ids) => [...ids]));

  let runsChecked = 0;
  let violations = 0;
  let decisionsChecked = 0;
  let forgedDecisions = 0;
  // Ids and counts. Never a payload, never a message: the validator reads
  // stream event payloads, and a detail blob that quoted one would put
  // applicant text into a table the erasure inventory does not cover.
  const offendingRuns: string[] = [];
  const offendingDecisions: string[] = [];

  for (const workspaceId of workspaces) {
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES_PER_WORKSPACE; page += 1) {
      // The step name carries the page number, not the cursor: a checkpoint key
      // has to be deterministic, and the cursor is a uuid that would differ
      // between an original run and a resumed one only if rows were inserted in
      // between — which is precisely when a stable name matters.
      const result = await step.do(`runlog-${workspaceId}-${page}`, () =>
        withWorkspaceTransaction(env, workspaceId, (tx) =>
          validateRunLogPage(tx, workspaceId, cursor, RUNS_PER_STEP),
        ),
      );
      runsChecked += result.runsChecked;
      violations += result.violations.length;
      for (const violation of result.violations) {
        if (offendingRuns.length < 50 && !offendingRuns.includes(violation.run_id)) {
          offendingRuns.push(violation.run_id);
        }
      }
      cursor = result.cursor;
      if (cursor === null) break;
    }

    const human = await step.do(`human-only-${workspaceId}`, () =>
      withWorkspaceTransaction(env, workspaceId, (tx) => humanOnlyDecisions(tx, workspaceId)),
    );
    decisionsChecked += human.decisionsChecked;
    forgedDecisions += human.nonHumanDecisions.length + human.agentDecisionEvents.length;
    for (const row of human.nonHumanDecisions) {
      if (offendingDecisions.length < 50) offendingDecisions.push(row.decision_id);
    }
    for (const row of human.agentDecisionEvents) {
      if (offendingDecisions.length < 50) offendingDecisions.push(row.event_id);
    }

    if (!human.ok) {
      // The one finding that is an incident rather than a bug report. It gets
      // its own audit row in the workspace it was found in, so the Admin sees
      // it in History and not only we see it in a log.
      await step.do(`alert-${workspaceId}`, async () => {
        await withWorkspaceTransaction(env, workspaceId, async (tx) => {
          await tx.query(
            `INSERT INTO events (workspace_id, actor_type, kind) VALUES ($1, 'system', 'validator.failed')`,
            [workspaceId],
          );
        });
        return true;
      });
    }
  }

  const summary: ValidatorSummary = {
    workspaces: workspaces.length,
    runsChecked,
    violations,
    decisionsChecked,
    forgedDecisions,
    ok: violations === 0 && forgedDecisions === 0,
    detail: { runs: offendingRuns, decisions: offendingDecisions },
  };

  await step.do('close-summary', async () => {
    await withPlatform(env, (tx) => closeValidatorRun(tx, summaryId, summary));
    return true;
  });

  logEvent({ at: 'validator.nightly', id: summaryId, ...summary, detail: undefined });
  return summary;
}
