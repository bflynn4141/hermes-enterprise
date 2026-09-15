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
// Two other jobs ride along because they are the `app`-role half of things the
// engine cannot do itself: the `agent` role has no UPDATE on
// `workspace_provider_keys` and only SELECT on `run_queue`, and widening either
// grant would break invariant 2. See decision 41 in docs/DECISIONS.md.
import type { Env } from '../env.js';
import { isEnginePaused } from '../env.js';
import { connect } from '../db/client.js';
import { publishEvents, runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import { ORPHAN_NO_EVENT_MINUTES, DEFAULT_MAX_TURNS } from '../engine/constants.js';
import { runAttemptInstanceId } from './workflow.js';

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
  model_id: string;
}

type Verdict = { kind: 'ok' } | { kind: 'stopped' } | { kind: 'error'; reason: string; message: string };

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

  let status: string | null;
  try {
    status = await instanceStatus();
  } catch {
    // `get()` throws on an unknown id, and instances are retained 30 days.
    return { kind: 'error', reason: 'instance_missing', message: 'the run attempt no longer exists' };
  }
  if (status === null) {
    return { kind: 'error', reason: 'instance_missing', message: 'the run attempt no longer exists' };
  }
  if (status === 'errored' || status === 'terminated' || status === 'unknown') {
    return { kind: 'error', reason: 'instance_dead', message: `the run attempt is ${status}` };
  }

  // A `waiting` run is legitimately idle for up to 30 days, so the silence rule
  // applies only to a run that claims to be working.
  if (run.stale && run.status !== 'waiting') {
    return {
      kind: 'error',
      reason: 'no_progress',
      message: `no progress for ${ORPHAN_NO_EVENT_MINUTES} minutes`,
    };
  }
  return { kind: 'ok' };
}

async function sweepWorkspace(env: Env, workspaceId: string, result: { checked: number; errored: number; stopped: number }): Promise<void> {
  const currentEngineVersion = Number(env.ENGINE_VERSION ?? '1') || 1;

  const runs = await withWorkspaceTransaction(env, workspaceId, async (tx) => {
    const { rows } = await tx.query<LiveRun>(
      `SELECT id, session_id, status, attempt, engine_version, workflow_instance_id, stop_requested, model_id,
              (updated_at < now() - ($2 || ' minutes')::interval) AS stale
         FROM runs
        WHERE workspace_id = $1 AND status IN ('working', 'waiting', 'stopping')
        ORDER BY updated_at
        LIMIT 200`,
      [workspaceId, String(ORPHAN_NO_EVENT_MINUTES)],
    );
    return rows;
  });

  for (const run of runs) {
    result.checked += 1;
    const verdict = await verdictFor(run, currentEngineVersion, async () => {
      if (!run.workflow_instance_id) return null;
      const instance = await env.RUN_ATTEMPT.get(run.workflow_instance_id);
      const status = await instance.status();
      return (status as { status?: string }).status ?? null;
    });
    if (verdict.kind === 'ok') continue;

    const jobIds = await withWorkspaceTransaction(env, workspaceId, async (tx) => {
      const error =
        verdict.kind === 'error'
          ? { class: 'transient', retryable: true, reason: verdict.reason, message: verdict.message, step_id: null }
          : null;
      const status = verdict.kind === 'stopped' ? 'stopped' : 'error';
      const { rowCount } = await tx.query(
        `UPDATE runs SET status = $3, error = $4::jsonb, ended_at = now()
          WHERE workspace_id = $1 AND id = $2 AND status IN ('working', 'waiting', 'stopping')`,
        [workspaceId, run.id, status, error ? JSON.stringify(error) : null],
      );
      if (!rowCount) return [];
      if (verdict.kind === 'error') {
        await tx.query(
          `INSERT INTO events (workspace_id, actor_type, kind, run_id, session_id)
           VALUES ($1, 'system', 'run.errored', $2, $3)`,
          [workspaceId, run.id, run.session_id],
        );
      }
      return publishEvents(tx, workspaceId, [
        {
          kind: 'run.status',
          sessionId: run.session_id,
          payload: { run_id: run.id, attempt: run.attempt, status, error },
        },
      ]);
    });
    if (verdict.kind === 'stopped') result.stopped += 1;
    else result.errored += 1;
    if (jobIds.length > 0) await runJobsAfterCommit(env, workspaceId, jobIds);
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

      const session = await tx.query<{ owner_id: string; model_id: string; effort: string | null }>(
        `SELECT owner_id, model_id, effort FROM sessions WHERE id = $1 AND workspace_id = $2 AND read_only = false`,
        [item.session_id, workspaceId],
      );
      const row = session.rows[0];
      if (!row) continue;

      const runId = crypto.randomUUID();
      const traceId = crypto.randomUUID();
      const engineVersion = Number(env.ENGINE_VERSION ?? '1') || 1;
      await tx.query(
        `INSERT INTO runs (id, workspace_id, session_id, status, model_id, effort, max_turns,
                           trace_id, workflow_instance_id, attempt, engine_version, client_turn_id)
         VALUES ($1, $2, $3, 'working', $4, $5, $6, $7, $8, 1, $9, $10)`,
        [
          runId,
          workspaceId,
          item.session_id,
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
    } catch (error) {
      console.log(JSON.stringify({ at: 'cron.queue', ok: false, run_id: start.runId, error: String(error) }));
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
    } catch (error) {
      // One workspace's failure must not stop the others: the next minute runs
      // them all again from wherever this one stopped.
      console.log(JSON.stringify({ at: 'cron.orphans', workspace_id: workspaceId, ok: false, error: String(error) }));
    }
  }
  return { ...tally, keysMarked, queueStarted };
}
