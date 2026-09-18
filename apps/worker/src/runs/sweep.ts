// The minute Cron's run half: orphans, key failures, and the queue.
//
// "The instance is the resume" (plan section 5). Everything here exists because
// that sentence has an exception: an instance can die in a way that leaves no
// trace in the row it was driving. A deploy over a running class, a purged
// instance past its 30-day retention, a Worker that was evicted between the
// last step and the next — in each case `runs.status` still says `working` and
// nothing will ever move it. The sweep is what turns that into an error a human
// can Retry, which is the difference between a stuck run and a broken product.
//
// A failed monitoring request is not evidence that a Workflow died. Only a
// confirmed terminal verdict may stop a run, and only while its attempt and
// progress still match the snapshot that produced the verdict. Confirmed
// absence is retained separately so monitoring never looks like run progress.
//
// Two other jobs ride along because they are the `app`-role half of things the
// engine cannot do itself: the `agent` role has no UPDATE on
// `workspace_provider_keys` and only SELECT on `run_queue`, and widening either
// grant would break invariant 2. See decision 41 in docs/DECISIONS.md.
import type { Env } from '../env.js';
import { isEnginePaused } from '../env.js';
import { connect } from '../db/client.js';
import { publishEvents, runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import { ORPHAN_NO_EVENT_MINUTES, DEFAULT_MAX_TURNS } from '../engine/constants.js';
import { runAttemptInstanceId } from './instance-id.js';

export const SWEEP_STARTUP_GRACE_SECONDS = 120;
export const SWEEP_MISSING_CONFIRM_SECONDS = 60;
export const SWEEP_LOOKUP_TIMEOUT_MS = 5_000;

export interface SweepResult {
  readonly checked: number;
  readonly errored: number;
  readonly stopped: number;
  readonly keysMarked: number;
  readonly queueStarted: number;
}

/**
 * Every workspace, from the one table that may be read across tenants.
 *
 * `workspace_directory` holds ids and nothing else and is the only place this
 * question can be asked: every tenant table is FORCE ROW LEVEL SECURITY and all
 * three roles are NOBYPASSRLS, so no connection in this system can see two
 * workspaces' runs at once (migration 0008).
 */
async function everyWorkspace(env: Env): Promise<string[]> {
  const client = await connect(env, 'app');
  try {
    const { rows } = await client.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_directory ORDER BY created_at LIMIT 500`,
    );
    return rows.map((row) => row.workspace_id);
  } finally {
    await client.end();
  }
}

interface LiveRun {
  id: string;
  session_id: string;
  status: string;
  attempt: number;
  engine_version: number;
  workflow_instance_id: string | null;
  stop_requested: boolean;
  stale: boolean;
  in_grace: boolean;
  /** PostgreSQL text preserves microseconds; a JavaScript Date does not. */
  progress_at: string;
  model_id: string;
}

type TerminalVerdict = { kind: 'stopped' } | { kind: 'error'; reason: string; message: string };
type LookupCategory = 'timeout' | 'http_5xx' | 'http_4xx' | 'lookup_failed';
type Verdict = { kind: 'ok' } | TerminalVerdict | { kind: 'missing' }
  | { kind: 'deferred'; reason: 'startup_grace' | 'unknown_status' | LookupCategory };

function confirmedMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const detail = error as { code?: unknown; message?: unknown };
  // Cloudflare's Workflow binding uses this specific error code, represented
  // in the message by createWorkflowError in the pinned workers-sdk runtime.
  // Its get() wrapper can also collapse status failures into the bare message
  // 'instance.not_found'; that ambiguous form deliberately does not qualify.
  // A generic 404, null response or arbitrary get/status exception is not it.
  return detail.code === 'instance.not_found'
    || (typeof detail.message === 'string' && /^\(instance\.not_found\)(?:\s|$)/.test(detail.message));
}

function lookupCategory(error: unknown): LookupCategory {
  if (typeof error !== 'object' || error === null) return 'lookup_failed';
  const detail = error as { name?: unknown; code?: unknown; status?: unknown };
  if (detail.name === 'TimeoutError' || detail.name === 'AbortError' || detail.code === 'ETIMEDOUT') return 'timeout';
  if (typeof detail.status === 'number' && detail.status >= 500 && detail.status < 600) return 'http_5xx';
  if (typeof detail.status === 'number' && detail.status >= 400 && detail.status < 500) return 'http_4xx';
  return 'lookup_failed';
}

async function boundedLookup(lookup: () => Promise<string | null>): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(lookup),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Workflow status lookup timed out');
          error.name = 'TimeoutError';
          reject(error);
        }, SWEEP_LOOKUP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What the sweep concludes about one run.
 *
 * Stop is read first, always: a run whose instance vanished *after* somebody
 * pressed Stop should end as `stopped`, not as an error the person then has to
 * interpret.
 */
export async function verdictFor(
  run: LiveRun,
  currentEngineVersion: number,
  instanceStatus: () => Promise<string | null>,
): Promise<Verdict> {
  if (run.stop_requested) return { kind: 'stopped' };

  if (run.engine_version !== currentEngineVersion) {
    return {
      kind: 'error',
      reason: 'engine_version_changed',
      message: `this run was started by engine version ${run.engine_version}; the deployed version is ${currentEngineVersion}`,
    };
  }

  // Admission commits before Workflow creation. Retry and recent progress also
  // refresh updated_at, so none can be reaped during the visibility window.
  if (run.in_grace) return { kind: 'deferred', reason: 'startup_grace' };

  let status: string | null;
  try {
    status = await boundedLookup(instanceStatus);
  } catch (error) {
    return confirmedMissing(error) ? { kind: 'missing' } : { kind: 'deferred', reason: lookupCategory(error) };
  }
  if (status === 'errored' || status === 'terminated') {
    return { kind: 'error', reason: 'instance_dead', message: `the run attempt is ${status}` };
  }
  if (status === null || !['queued', 'running', 'paused', 'complete', 'waiting', 'waitingForPause'].includes(status)) {
    return { kind: 'deferred', reason: 'unknown_status' };
  }

  // A `waiting` run is legitimately idle for up to 30 days, so the silence rule
  // applies only to a run that claims to be working.
  if (run.stale && run.status !== 'waiting' && (status === 'running' || status === 'complete')) {
    return {
      kind: 'error',
      reason: 'no_progress',
      message: `no progress for ${ORPHAN_NO_EVENT_MINUTES} minutes`,
    };
  }
  return { kind: 'ok' };
}

/**
 * One workspace's orphans. Exported so a test can drive it against a seeded
 * workspace rather than against `everyWorkspace`, which is every row in the
 * shared test database.
 */
export async function sweepWorkspace(env: Env, workspaceId: string, result: { checked: number; errored: number; stopped: number }): Promise<void> {
  const currentEngineVersion = Number(env.ENGINE_VERSION ?? '1') || 1;

  const runs = await withWorkspaceTransaction(env, workspaceId, async (tx) => {
    const { rows } = await tx.query<LiveRun>(
      `SELECT id, session_id, status, attempt, engine_version, workflow_instance_id, stop_requested, model_id,
              updated_at::text AS progress_at,
              (updated_at > now() - ($3 || ' seconds')::interval) AS in_grace,
              (updated_at < now() - ($2 || ' minutes')::interval) AS stale
         FROM runs
        WHERE workspace_id = $1 AND status IN ('working', 'waiting', 'stopping')
        ORDER BY stop_requested DESC, updated_at
        LIMIT 200`,
      [workspaceId, String(ORPHAN_NO_EVENT_MINUTES), String(SWEEP_STARTUP_GRACE_SECONDS)],
    );
    return rows;
  });

  for (const run of runs) {
    result.checked += 1;
    const verdict = await verdictFor(run, currentEngineVersion, async () => {
      const instance = await env.RUN_ATTEMPT.get(run.workflow_instance_id ?? runAttemptInstanceId(run.id, run.attempt));
      const status = await instance.status();
      return typeof status?.status === 'string' ? status.status : null;
    });
    if (verdict.kind === 'deferred' || verdict.kind === 'missing') {
      console.log(JSON.stringify({
        at: 'cron.orphans.lookup', run_id: run.id, attempt: run.attempt,
        instance_id: (run.workflow_instance_id ?? runAttemptInstanceId(run.id, run.attempt)).slice(0, 100),
        category: verdict.kind === 'missing' ? 'confirmed_missing' : verdict.reason,
      }));
    }

    const transition = await withWorkspaceTransaction(env, workspaceId, async (tx) => {
      const snapshot = [workspaceId, run.id, run.attempt, run.workflow_instance_id, run.status,
        run.progress_at, run.stop_requested, run.engine_version];
      const unchanged = `workspace_id = $1 AND id = $2 AND attempt = $3
        AND workflow_instance_id IS NOT DISTINCT FROM $4 AND status = $5
        AND updated_at = $6::timestamptz AND stop_requested = $7 AND engine_version = $8`;
      // Serialize observations against run progress and competing sweeps. The
      // network lookup stays outside this lock; a changed snapshot loses here.
      const locked = await tx.query(`SELECT id FROM runs WHERE ${unchanged} FOR UPDATE`, snapshot);
      if (!locked.rowCount) return null;

      let terminal: TerminalVerdict;
      if (verdict.kind === 'missing') {
        const observed = await tx.query<{ confirmed: boolean }>(
          `INSERT INTO run_sweep_observations
             (workspace_id, run_id, attempt, workflow_instance_id, run_status, progress_at, first_missing_at)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, now())
           ON CONFLICT (run_id) DO UPDATE SET
             attempt = EXCLUDED.attempt, workflow_instance_id = EXCLUDED.workflow_instance_id,
             run_status = EXCLUDED.run_status, progress_at = EXCLUDED.progress_at,
             first_missing_at = CASE
               WHEN run_sweep_observations.attempt = EXCLUDED.attempt
                AND run_sweep_observations.workflow_instance_id IS NOT DISTINCT FROM EXCLUDED.workflow_instance_id
                AND run_sweep_observations.run_status = EXCLUDED.run_status
                AND run_sweep_observations.progress_at = EXCLUDED.progress_at
               THEN run_sweep_observations.first_missing_at ELSE now() END
           RETURNING first_missing_at <= now() - ($7 || ' seconds')::interval AS confirmed`,
          [...snapshot.slice(0, 6), String(SWEEP_MISSING_CONFIRM_SECONDS)],
        );
        if (!observed.rows[0]?.confirmed) return null;
        terminal = { kind: 'error', reason: 'instance_missing', message: 'the run attempt no longer exists' };
      } else {
        // A successful or uncertain observation breaks consecutive absence.
        // This never updates runs.updated_at or extends the no-progress timer.
        await tx.query(`DELETE FROM run_sweep_observations WHERE workspace_id = $1 AND run_id = $2`, [workspaceId, run.id]);
        if (verdict.kind === 'ok' || verdict.kind === 'deferred') return null;
        terminal = verdict;
      }
      const error =
        terminal.kind === 'error'
          ? { class: 'transient', retryable: true, reason: terminal.reason, message: terminal.message, step_id: null }
          : null;
      const status = terminal.kind === 'stopped' ? 'stopped' : 'error';
      // Keep the durable stop flag and terminal projection atomic (O2), but
      // never apply an old verdict to a newer attempt, status or progress row.
      const { rowCount } = await tx.query(
        `UPDATE runs SET status = $9, error = $10::jsonb, ended_at = now(), stop_requested = true
          WHERE ${unchanged}`,
        [...snapshot, status, error ? JSON.stringify(error) : null],
      );
      if (!rowCount) return null;
      await tx.query(`DELETE FROM run_sweep_observations WHERE workspace_id = $1 AND run_id = $2`, [workspaceId, run.id]);
      if (terminal.kind === 'error') {
        await tx.query(
          `INSERT INTO events (workspace_id, actor_type, kind, run_id, session_id)
           VALUES ($1, 'system', 'run.errored', $2, $3)`,
          [workspaceId, run.id, run.session_id],
        );
      }
      const jobIds = await publishEvents(tx, workspaceId, [
        {
          kind: 'run.status',
          sessionId: run.session_id,
          payload: { run_id: run.id, attempt: run.attempt, status, error },
        },
      ]);
      return { jobIds, status };
    });
    if (!transition) continue;
    if (transition.status === 'stopped') result.stopped += 1;
    else result.errored += 1;
    // After the commit, never before: a terminate that landed on a run whose
    // UPDATE then rolled back would have killed a live run for nothing.
    await terminateInstance(env, run);
    if (transition.jobIds.length > 0) await runJobsAfterCommit(env, workspaceId, transition.jobIds);
  }
}

/**
 * Ask the Workflow instance behind a reaped run to stop.
 *
 * Best effort, and deliberately after the commit. Two honest caveats:
 *
 *   * **It is unverified whether `terminate()` interrupts a step already in
 *     flight.** Cloudflare documents it as terminating the instance; whether a
 *     `step.do` that is mid-`await` is cut short, or runs to completion and is
 *     then discarded, is not something this repository has measured. That is
 *     why `stop_requested` is set first and why `setRunStatus` refuses to move
 *     a terminal run: the correctness of the sweep does not rest on this call.
 *   * A `get()` on an id that no longer exists throws, and an instance that has
 *     already finished refuses termination. Both are the normal case for a run
 *     the sweep is reaping, so neither is an error worth failing the sweep for
 *     — they are logged and the loop continues.
 */
async function terminateInstance(env: Env, run: LiveRun): Promise<void> {
  const instanceId = run.workflow_instance_id ?? runAttemptInstanceId(run.id, run.attempt);
  try {
    const instance = await env.RUN_ATTEMPT.get(instanceId);
    await instance.terminate();
    console.log(JSON.stringify({ at: 'cron.orphans.terminate', ok: true, run_id: run.id, attempt: run.attempt, instance_id: instanceId.slice(0, 100) }));
  } catch (error) {
    console.log(
      JSON.stringify({ at: 'cron.orphans.terminate', ok: false, run_id: run.id, attempt: run.attempt,
        instance_id: instanceId.slice(0, 100), category: confirmedMissing(error) ? 'confirmed_missing' : lookupCategory(error) }),
    );
  }
}

/**
 * Mark a provider key invalid because a run was rejected with a 401.
 *
 * The engine saw the 401 and could not write this: the `agent` role has SELECT
 * on `workspace_provider_keys` and nothing more. It recorded the reason on the
 * run instead, and this — running as `app` — is the half that closes the loop:
 * the key goes `invalid`, the catalog stops offering the model, and the turns
 * route refuses creation with `key_invalid`.
 */
async function markKeysFromRunErrors(env: Env, workspaceId: string): Promise<number> {
  return withWorkspaceTransaction(env, workspaceId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE workspace_provider_keys k
          SET status = 'invalid', updated_at = now()
        WHERE k.workspace_id = $1
          AND k.revoked_at IS NULL
          AND k.status <> 'invalid'
          AND EXISTS (
            SELECT 1 FROM runs r JOIN catalog c ON c.model_id = r.model_id
             WHERE r.workspace_id = $1
               AND c.provider = k.provider
               AND r.status = 'error'
               AND r.error->>'reason' = 'key_invalid'
               AND r.ended_at > now() - interval '1 day'
          )
        RETURNING k.id`,
      [workspaceId],
    );
    return rows.length;
  });
}

/**
 * Drain one queued message per session whose run has finished.
 *
 * Serial by construction: the partial unique index allows one live run per
 * session, so the next item can only start once the previous run is terminal.
 * Paused items are left alone — a Stop pauses the queue, and un-pausing is the
 * person's to do.
 */
async function drainRunQueues(env: Env, workspaceId: string): Promise<number> {
  if (isEnginePaused(env)) return 0;
  const started: { runId: string; sessionId: string; attempt: number; engineVersion: number; traceId: string }[] = [];

  const jobIds = await withWorkspaceTransaction(env, workspaceId, async (tx) => {
    const { rows } = await tx.query<{ id: string; run_id: string; session_id: string; text: string }>(
      `SELECT q.id, q.run_id, q.session_id, q.text
         FROM run_queue q
         JOIN runs r ON r.id = q.run_id
        WHERE q.workspace_id = $1
          AND q.status = 'queued'
          AND r.status IN ('completed', 'stopped', 'error')
          AND NOT EXISTS (
            SELECT 1 FROM runs live
             WHERE live.session_id = q.session_id AND live.status IN ('working', 'waiting', 'stopping')
          )
        ORDER BY q.position
        LIMIT 20`,
      [workspaceId],
    );

    const seen = new Set<string>();
    const jobs: string[] = [];
    for (const item of rows) {
      if (seen.has(item.session_id)) continue;
      seen.add(item.session_id);

      const session = await tx.query<{ owner_id: string; agent_id: string; model_id: string; effort: string | null }>(
        `SELECT owner_id, agent_id, model_id, effort FROM sessions WHERE id = $1 AND workspace_id = $2 AND read_only = false`,
        [item.session_id, workspaceId],
      );
      const row = session.rows[0];
      if (!row) continue;

      const runId = crypto.randomUUID();
      const traceId = crypto.randomUUID();
      const engineVersion = Number(env.ENGINE_VERSION ?? '1') || 1;
      await tx.query(
        `INSERT INTO runs (id, workspace_id, session_id, agent_id, status, model_id, effort, max_turns,
                           trace_id, workflow_instance_id, attempt, engine_version, client_turn_id)
         VALUES ($1, $2, $3, $4, 'working', $5, $6, $7, $8, $9, 1, $10, $11)`,
        [
          runId,
          workspaceId,
          item.session_id,
          row.agent_id,
          row.model_id,
          row.effort,
          DEFAULT_MAX_TURNS,
          traceId,
          runAttemptInstanceId(runId, 1),
          engineVersion,
          // The queue item's id is the idempotency key: this row can only be
          // created once per queued message, however many times the Cron runs.
          `queue:${item.id}`,
        ],
      );
      const seqRow = await tx.query<{ seq: number }>(
        `UPDATE sessions SET next_seq = next_seq + 1, last_activity_at = now() WHERE id = $1 RETURNING next_seq - 1 AS seq`,
        [item.session_id],
      );
      const seq = seqRow.rows[0]?.seq ?? 0;
      const message = await tx.query<{ id: string }>(
        `INSERT INTO messages (workspace_id, session_id, seq, role, text, status, run_id, turn)
         VALUES ($1, $2, $3, 'user', $4, 'complete', $5, 0) RETURNING id`,
        [workspaceId, item.session_id, seq, item.text, runId],
      );
      await tx.query(
        `INSERT INTO run_turns (workspace_id, run_id, turn, seq, role, provider_message)
         VALUES ($1, $2, 0, 0, 'user', $3::jsonb)`,
        [workspaceId, runId, JSON.stringify({ role: 'user', content: item.text })],
      );
      await tx.query(`UPDATE run_queue SET status = 'sent' WHERE id = $1`, [item.id]);

      const items = await tx.query<{ id: string; text: string; status: string; position: number }>(
        `SELECT id, text, status, position FROM run_queue WHERE run_id = $1 ORDER BY position`,
        [item.run_id],
      );
      jobs.push(
        ...(await publishEvents(tx, workspaceId, [
          {
            kind: 'message.appended',
            sessionId: item.session_id,
            traceId,
            payload: {
              message_id: message.rows[0]?.id ?? '',
              session_id: item.session_id,
              seq,
              role: 'user',
              kind: null,
              text: item.text,
              blocks: [],
              status: 'complete',
              run_id: runId,
            },
          },
          { kind: 'run.queue.updated', sessionId: item.session_id, payload: { run_id: item.run_id, items: items.rows } },
        ])),
      );
      started.push({ runId, sessionId: item.session_id, attempt: 1, engineVersion, traceId });
    }
    return jobs;
  });

  for (const start of started) {
    try {
      await env.RUN_ATTEMPT.create({
        id: runAttemptInstanceId(start.runId, start.attempt),
        params: { ...start, workspaceId },
      });
    } catch {
      console.log(JSON.stringify({ at: 'cron.queue', ok: false, run_id: start.runId, category: 'workflow_create_failed' }));
    }
  }
  if (jobIds.length > 0) await runJobsAfterCommit(env, workspaceId, jobIds);
  return started.length;
}

/** The whole run half of the minute Cron. Best-effort, per workspace. */
export async function sweepRuns(env: Env): Promise<SweepResult> {
  const tally = { checked: 0, errored: 0, stopped: 0 };
  let keysMarked = 0;
  let queueStarted = 0;
  for (const workspaceId of await everyWorkspace(env)) {
    try {
      await sweepWorkspace(env, workspaceId, tally);
      keysMarked += await markKeysFromRunErrors(env, workspaceId);
      queueStarted += await drainRunQueues(env, workspaceId);
    } catch {
      // One workspace's failure must not stop the others: the next minute runs
      // them all again from wherever this one stopped.
      console.log(JSON.stringify({ at: 'cron.orphans', workspace_id: workspaceId, ok: false, category: 'sweep_failed' }));
    }
  }
  return { ...tally, keysMarked, queueStarted };
}
