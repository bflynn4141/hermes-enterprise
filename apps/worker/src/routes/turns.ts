// Turns and the four controls: Stop, Guide, Queue, Retry. Plus the one route a
// waiting run needs, the context answer.
//
// The interesting part is the first twenty lines of `createTurn`. `create()`
// throws if the instance id already exists and only `createBatch()` is
// idempotent, so the Workflow cannot be the idempotency record. The `runs` row
// is: it is inserted first under UNIQUE(session_id, client_turn_id), a
// duplicate POST returns the existing run with 200, and only then is the
// instance created, with a duplicate-id error treated as a no-op. The row also
// outlives the 30-day instance retention, so a stale re-POST cannot start a
// fresh run months later.
//
// Everything a control writes is a row first and an RPC second. Stop writes
// `stop_requested` and `status = 'stopping'` in one transaction and *then* calls
// `SessionHub.requestStop`; if that call is lost the engine still reads the flag
// from the row at the next step boundary.
import type { Context } from 'hono';
import { ACTIVE_RUN_STATUSES } from '@hermes/shared';
import type { Env } from '../env.js';
import { isEnginePaused } from '../env.js';
import { resolveRuntimeBinding } from '../runtime/config.js';
import { approvalContinuationRetryBlock } from '../runtime/continuation.js';
import { HermesClient } from '../runtime/client.js';
import { getSession, requireCsrf, requireOrigin } from '../auth.js';
import { connect } from '../db/client.js';
import { consumeRate, type RateLimit } from '../auth/rate-limit.js';
import { publishEvents } from '../jobs.js';
import { checkCaps } from '../model/usage.js';
import { maybeQueueCapWarning } from '../ops/cap-warning.js';
import { requireInstanceCapacity } from '../ops/instance-cap.js';
import { loadModel, providerLabel } from '../model/catalog.js';
import { requireAllowedProvider } from '../model/allowed.js';
import { pickDevScript, runAttemptInstanceId } from '../runs/workflow.js';
import { CONTEXT_ANSWERED_EVENT, DEFAULT_MAX_TURNS } from '../engine/constants.js';
import { inWorkspace, jsonBody, pathUuid, RouteError, type TenantWork } from './tenant.js';
import { VISIBLE } from './sessions.js';

/** Plan section 5: "Per-user limits (30 turns/min ...)". */
const TURN_LIMIT: RateLimit = { action: 'run.turn', limit: 30, windowSeconds: 60 };

// `VISIBLE` is imported rather than copied. It used to be a third verbatim copy
// of a predicate that has since changed meaning (security review O1): a share is
// redeemed at `GET /shared/:token`, never here.

interface SessionRow {
  id: string;
  agent_id: string;
  owner_id: string;
  read_only: boolean;
  mode: string;
  model_id: string;
  effort: string | null;
}

async function loadSessionForWrite(work: TenantWork, sessionId: string): Promise<SessionRow> {
  const { rows } = await work.tx.query<SessionRow>(
    `SELECT s.id, s.agent_id, s.owner_id, s.read_only, s.mode, s.model_id, s.effort FROM sessions s
      WHERE s.workspace_id = $1 AND s.id = $3 AND ${VISIBLE}`,
    [work.workspaceId, work.userId, sessionId],
  );
  const session = rows[0];
  if (!session) throw new RouteError('no such session', 'unknown_session', 404);
  if (session.owner_id !== work.userId) throw new RouteError('this is the owner\'s to do', 'not_owner', 403);
  if (session.read_only) throw new RouteError('this session is read-only', 'read_only', 409);
  return session;
}

interface RunRow {
  id: string;
  agent_id: string;
  status: string;
  attempt: number;
  engine_version: number;
  workflow_instance_id: string | null;
  session_id: string;
  model_id: string;
  waiting_for: string | null;
}

/**
 * The run, locked for the length of this transaction.
 *
 * `FOR UPDATE` is the whole fix for the Stop/Queue race (client finding 15).
 * Every control below is a read-then-write on one `runs` row: Stop reads the
 * status and writes `stopping` plus a sweep of the queue; Queue reads the same
 * status and decides whether the new item is `queued` or `paused`. With nothing
 * serialising them, an enqueue that read `working` before Stop committed
 * inserted a `queued` row *after* Stop's sweep had run, and that row stayed
 * `queued` forever — never sent, and not shown as paused either. It is what
 * made P7 fail about one full-suite run in three.
 *
 * Taking the lock here rather than at each call site means a control added next
 * year gets it by construction. Every caller locks `runs` first and touches
 * `run_queue` second, so the lock order is the same everywhere and there is no
 * deadlock to find. Under READ COMMITTED the row this returns is the version
 * that exists *after* whatever transaction we waited for, which is the point:
 * Queue sees `stopping` and parks the item.
 */
async function loadRun(work: TenantWork, sessionId: string, runId: string): Promise<RunRow> {
  const { rows } = await work.tx.query<RunRow>(
    `SELECT id, agent_id, status, attempt, engine_version, workflow_instance_id, session_id, model_id, waiting_for
       FROM runs WHERE workspace_id = $1 AND id = $2 AND session_id = $3
       FOR UPDATE`,
    [work.workspaceId, runId, sessionId],
  );
  const run = rows[0];
  if (!run) throw new RouteError('no such run', 'unknown_run', 404);
  return run;
}

const runView = (run: { id: string; status: string; attempt: number }): Record<string, unknown> => ({
  run_id: run.id,
  status: run.status,
  attempt: run.attempt,
});

/**
 * Create the Workflow instance for a run that already has a row.
 *
 * A duplicate-id error is a no-op, not a failure: it means a concurrent POST
 * of the same `client_turn_id` won the race and already created it. Two tabs
 * therefore yield one instance and two 200s.
 */
async function createInstance(
  env: Env,
  params: {
    runId: string;
    workspaceId: string;
    sessionId: string;
    attempt: number;
    engineVersion: number;
    traceId: string;
    scriptedScript?: string;
  },
): Promise<{ created: boolean; instanceId: string }> {
  const instanceId = runAttemptInstanceId(params.runId, params.attempt);
  try {
    await env.RUN_ATTEMPT.create({ id: instanceId, params });
    return { created: true, instanceId };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already exists|duplicate|instance.*id/i.test(message)) return { created: false, instanceId };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// POST /w/:ws/sessions/:id/turns
// ---------------------------------------------------------------------------

/**
 * Turn refusals cost the caller their budget; our own failures do not.
 *
 * `consumeRate` is counted inside the tenant transaction so that a 500 of ours
 * does not punish the person who hit it. The cost of that is a refund on *every*
 * failing path, including the ones that are the caller's own: a workspace with
 * no provider key, or one over its daily cap, could POST turns as fast as it
 * liked and every attempt rolled its own count back (security review O17). Each
 * attempt is still a connection, a caps query and a catalog read.
 *
 * So the refusals a caller can repeat are charged after the rollback, on a
 * plain client, where nothing can take the count back. Only 409 and 429: a 404
 * or a 403 is an authorization answer and metering those would be a way to lock
 * somebody out of a workspace they are in. The charge is best-effort and never
 * replaces the original error — being rate-limited while being told "add a key"
 * should still say "add a key".
 */
const METERED_REFUSAL_STATUS: readonly number[] = [409, 429];

async function withRefusalMetered<T>(c: Context<{ Bindings: Env }>, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const carried = error as { status?: unknown; reason?: unknown };
    if (
      error instanceof RouteError &&
      METERED_REFUSAL_STATUS.includes(Number(carried.status)) &&
      carried.reason !== 'rate_limited'
    ) {
      try {
        const session = await getSession(c);
        const client = await connect(c.env, 'app');
        try {
          await consumeRate(client, session.userId, c.req.param('ws') ?? null, TURN_LIMIT);
        } finally {
          await client.end();
        }
      } catch {
        // Over the limit, or the counter was unreachable. Either way the
        // caller's own refusal is the answer they need.
      }
    }
    throw error;
  }
}

export async function createTurn(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const input = await jsonBody<{ client_turn_id?: string; text?: string; attachments?: unknown }>(c);
  if (input.attachments !== undefined && (!Array.isArray(input.attachments) || input.attachments.length > 0)) {
    throw new RouteError(
      'Attachments are not supported for agent turns yet. Remove them and try again.',
      'attachments_unsupported',
      422,
    );
  }
  // Development only, and gated twice: `MODEL_SCRIPTED=1` is itself refused
  // outside `ENVIRONMENT=development`, so a deployed environment cannot be
  // asked for a scripted failure by header. See decision F6.
  const scriptedScript =
    c.env.MODEL_SCRIPTED === '1'
      ? pickDevScript(c.req.header('x-scripted-script'), input.text)
      : undefined;
  const clientTurnId = (input.client_turn_id ?? '').trim();
  if (!clientTurnId || clientTurnId.length > 128) {
    // Required, not generated here: it is the client's idempotency key, and a
    // server-generated one would make a retried POST a second run.
    throw new RouteError('client_turn_id is required', 'client_turn_id_required', 422);
  }
  const text = (input.text ?? '').slice(0, 20_000);

  const outcome = await withRefusalMetered(c, async () => inWorkspace(c, async (work) => {
    const session = await loadSessionForWrite(work, sessionId);

    // The duplicate check comes before every refusal below: a re-POST of a turn
    // that already started must return that run, not "you are over your cap".
    const existing = await work.tx.query<RunRow>(
      `SELECT id, agent_id, status, attempt, engine_version, workflow_instance_id, session_id, model_id, waiting_for
         FROM runs WHERE workspace_id = $1 AND session_id = $2 AND client_turn_id = $3`,
      [work.workspaceId, sessionId, clientTurnId],
    );
    const already = existing.rows[0];
    if (already) return { status: 200 as const, run: already, duplicate: true };

    if (c.env.AGENT_RUNTIME === 'hermes' && c.env.MODEL_SCRIPTED !== '1') {
      const binding = await resolveRuntimeBinding(c.env, work.tx, work.workspaceId, session.agent_id);
      try {
        await new HermesClient(binding.baseUrl, binding.apiKey, undefined, binding.transport).capabilities();
      } catch (error) {
        console.error(JSON.stringify({ at: 'runtime.admission', ok: false, error: String(error) }));
        throw new RouteError(
          'The official Hermes runtime is not healthy enough to accept this turn.',
          'runtime_unhealthy',
          503,
        );
      }
    }

    if (isEnginePaused(c.env)) {
      throw new RouteError('the engine is paused for a deploy', 'engine_paused', 409);
    }
    await consumeRate(work.tx, work.userId, work.workspaceId, TURN_LIMIT);

    const caps = await checkCaps(work.tx, work.workspaceId);
    if (!caps.allowed) {
      throw new RouteError(
        caps.reason === 'daily_token_cap'
          ? 'this workspace has reached its daily token cap'
          : 'this workspace already has as many runs as it allows',
        caps.reason ?? 'cap_exceeded',
        429,
      );
    }
    // Inside the tenant caps, and now the platform's: the most Workflow
    // instances this deployment creates in an hour, across every tenant (plan
    // section 5). Counted here rather than at `create()` because the count has
    // to roll back with the transaction if this turn fails for another reason.
    await requireInstanceCapacity(work.tx, c.env, work.workspaceId);
    // Warn at 80 percent, once per workspace per tenant day. Queued in this
    // transaction and delivered by the job runner, like every other post-commit
    // effect; it costs no extra query when the workspace is nowhere near.
    const warning = await maybeQueueCapWarning(work.tx, work.workspaceId, caps);
    if (warning) work.jobs.push(warning);

    // Two questions about this session's model, and they are asked in this
    // order because the first one is true of the *deployment* and the second
    // only of the workspace.
    //
    //   1. Does this deployment offer that provider at all? Asked even under
    //      `MODEL_SCRIPTED`, because a run against a model nobody can reach in
    //      production is not a run worth rehearsing (decision R12).
    //   2. Is there a verified key for it? Refused at creation, which is the
    //      only place refusing is cheap: mid-run it would mean a half-written
    //      transcript (plan section 4, key failures).
    const model = await loadModel(work.tx, session.model_id);
    if (!model) throw new RouteError('this session names a model the catalog does not have', 'unknown_model', 409);
    requireAllowedProvider(c.env, model.provider);

    if (c.env.MODEL_SCRIPTED !== '1') {
      const key = await work.tx.query<{ status: string }>(
        `SELECT status FROM workspace_provider_keys
          WHERE workspace_id = $1 AND provider = $2 AND revoked_at IS NULL LIMIT 1`,
        [work.workspaceId, model.provider],
      );
      const status = key.rows[0]?.status ?? null;
      // The provider's *label*, because this sentence is rendered verbatim in
      // the composer (decision C45) and "Add a openrouter key" is not a
      // sentence anybody wrote on purpose.
      const label = providerLabel(model.provider);
      if (status === null) throw new RouteError(`Add your ${label} key in Settings to start`, 'no_key', 409);
      if (status === 'invalid') throw new RouteError(`Your ${label} key was rejected`, 'key_invalid', 409);
      if (status !== 'verified' && status !== 'verified_scoped') {
        throw new RouteError(`Your ${label} key has not been verified`, 'key_unverified', 409);
      }
    }

    const runId = crypto.randomUUID();
    const traceId = crypto.randomUUID();
    const engineVersion = Number(c.env.ENGINE_VERSION ?? '1') || 1;
    const instanceId = runAttemptInstanceId(runId, 1);

    let inserted: RunRow | undefined;
    // A savepoint, because a unique violation aborts the whole transaction in
    // Postgres and everything after it — including the query that tells the two
    // possible violations apart — would fail with 25P02 instead.
    await work.tx.query('SAVEPOINT run_insert');
    try {
      const result = await work.tx.query<RunRow>(
        // `mode` is copied onto the row here, not joined from the session at
        // read time: a person switching the selector mid-run must change the
        // next run rather than what this one may already have started doing.
        `INSERT INTO runs (id, workspace_id, session_id, agent_id, status, model_id, effort, max_turns,
                           trace_id, workflow_instance_id, attempt, engine_version, client_turn_id, mode)
         VALUES ($1, $2, $3, $4, 'working', $5, $6, $7, $8, $9, 1, $10, $11, $12)
         RETURNING id, agent_id, status, attempt, engine_version, workflow_instance_id, session_id, model_id, waiting_for`,
        [
          runId,
          work.workspaceId,
          sessionId,
          session.agent_id,
          session.model_id,
          session.effort,
          DEFAULT_MAX_TURNS,
          traceId,
          instanceId,
          engineVersion,
          clientTurnId,
          session.mode,
        ],
      );
      inserted = result.rows[0];
      await work.tx.query('RELEASE SAVEPOINT run_insert');
    } catch (error) {
      await work.tx.query('ROLLBACK TO SAVEPOINT run_insert');
      const code = (error as { code?: string }).code;
      if (code === '23505') {
        // Either the same client_turn_id raced us, or this session already has
        // a live run. The two are different answers to the caller.
        const raced = await work.tx.query<RunRow>(
          `SELECT id, agent_id, status, attempt, engine_version, workflow_instance_id, session_id, model_id, waiting_for
             FROM runs WHERE workspace_id = $1 AND session_id = $2 AND client_turn_id = $3`,
          [work.workspaceId, sessionId, clientTurnId],
        );
        const row = raced.rows[0];
        if (row) return { status: 200 as const, run: row, duplicate: true };
        throw new RouteError('this session already has a run in flight', 'run_in_flight', 409);
      }
      throw error;
    }
    const run = inserted;
    if (!run) throw new RouteError('the run was not created', 'create_failed', 409);

    // The person's own message, and the first `run_turns` row the engine reads.
    const seqRow = await work.tx.query<{ seq: number }>(
      `UPDATE sessions SET next_seq = next_seq + 1, last_activity_at = now()
        WHERE id = $1 RETURNING next_seq - 1 AS seq`,
      [sessionId],
    );
    const seq = seqRow.rows[0]?.seq ?? 0;
    const message = await work.tx.query<{ id: string }>(
      `INSERT INTO messages (workspace_id, session_id, seq, role, text, status, client_id, run_id, turn)
       VALUES ($1, $2, $3, 'user', $4, 'complete', $5, $6, 0) RETURNING id`,
      [work.workspaceId, sessionId, seq, text, clientTurnId, runId],
    );
    await work.tx.query(
      `INSERT INTO run_turns (workspace_id, run_id, turn, seq, role, provider_message)
       VALUES ($1, $2, 0, 0, 'user', $3::jsonb)`,
      [work.workspaceId, runId, JSON.stringify({ role: 'user', content: text })],
    );
    await work.tx.query(`DELETE FROM session_drafts WHERE session_id = $1 AND user_id = $2`, [sessionId, work.userId]);

    work.jobs.push(
      ...(await publishEvents(work.tx, work.workspaceId, [
        {
          kind: 'message.appended',
          sessionId,
          traceId,
          payload: {
            message_id: message.rows[0]?.id ?? '',
            session_id: sessionId,
            seq,
            role: 'user',
            kind: null,
            text,
            blocks: [],
            status: 'complete',
            run_id: runId,
            client_turn_id: clientTurnId,
          },
        },
      ])),
    );

    return {
      status: 201 as const,
      run,
      duplicate: false,
      create: {
        runId,
        workspaceId: work.workspaceId,
        sessionId,
        attempt: 1,
        engineVersion,
        traceId,
        ...(scriptedScript ? { scriptedScript } : {}),
      },
    };
  }));

  if (!outcome.duplicate && 'create' in outcome && outcome.create) {
    await createInstance(c.env, outcome.create);
  }
  return c.json(runView(outcome.run), outcome.status);
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

export async function stopRun(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const runId = pathUuid(c, 'runId');

  const result = await inWorkspace(c, async (work) => {
    await loadSessionForWrite(work, sessionId);
    const run = await loadRun(work, sessionId, runId);
    if (!(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
      return { run, alreadyDone: true, nativeId: null };
    }
    // One transaction: the flag and the status. A reader that saw `stopping`
    // without the flag would resume the run.
    await work.tx.query(
      `UPDATE runs SET stop_requested = true, status = 'stopping' WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, runId],
    );
    // A Stop pauses the queue rather than dropping it: the human's queued
    // messages are still theirs, and a Stop that ate them is a Stop people
    // learn not to press.
    await work.tx.query(
      `UPDATE run_queue SET status = 'paused' WHERE workspace_id = $1 AND run_id = $2 AND status = 'queued'`,
      [work.workspaceId, runId],
    );
    work.jobs.push(
      ...(await publishEvents(work.tx, work.workspaceId, [
        {
          kind: 'run.status',
          sessionId,
          payload: { run_id: runId, attempt: run.attempt, status: 'stopping' },
        },
      ])),
    );
    const native = await work.tx.query<{ runtime_run_id: string | null }>(
      `SELECT runtime_run_id FROM runs WHERE id = $1 AND runtime_kind = 'hermes' AND runtime_attempt = attempt`, [runId]);
    const nativeId = native.rows[0]?.runtime_run_id ?? null;
    const binding = nativeId ? await resolveRuntimeBinding(c.env, work.tx, work.workspaceId, run.agent_id) : null;
    return { run: { ...run, status: 'stopping' }, alreadyDone: false, nativeId, binding };
  });

  if (!result.alreadyDone) {
    if (result.nativeId) {
      // Reach the native interruption flag immediately. The persisted Stop is
      // still authoritative if this request is lost; Workflow polling retries.
      try {
        if (result.binding) await new HermesClient(result.binding.baseUrl, result.binding.apiKey, undefined, result.binding.transport).stop(result.nativeId);
      } catch { /* The committed flag prevents further enterprise tool calls. */ }
    }
    // The hub's copy is a cache with one reader: the engine reads it from every
    // delta reply, which is what makes Stop land inside a streaming turn rather
    // than at the end of it.
    const stub = c.env.SESSION_HUB.get(c.env.SESSION_HUB.idFromName(sessionId));
    await stub.requestStop(runId);
  }
  return c.json(runView(result.run));
}

// ---------------------------------------------------------------------------
// Guide
// ---------------------------------------------------------------------------

/**
 * Guidance is a row the next provider step reads, not an interrupt.
 *
 * It is stored as a `messages` row with `kind = 'guidance'` and status
 * `streaming` (meaning queued), which is also how the run-log validator learns
 * that a `run.guidance.applied` was legitimate: the guidance id is the message
 * id, and the validator refuses an "applied" for an id it never saw recorded.
 */
/**
 * What the client tells the person when their guidance arrived too late for the
 * run they aimed it at. The plan names this copy; it is here so the route, the
 * client and the test all read the same string.
 */
export const GUIDANCE_CARRIED_COPY = 'Applied to your next message';

export async function guideRun(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const runId = pathUuid(c, 'runId');
  const input = await jsonBody<{ text?: string }>(c);
  const text = (input.text ?? '').trim().slice(0, 4000);
  if (!text) throw new RouteError('text is required', 'empty_guidance', 422);

  const body = await inWorkspace(c, async (work) => {
    await loadSessionForWrite(work, sessionId);
    const run = await loadRun(work, sessionId, runId);
    // Guidance typed while the run was in its final step arrives after the last
    // provider step has already read its guidance: there is no next step of
    // this run to apply it to. Refusing it would throw away what the person
    // just said, so it is parked on the session with `run_id` null and the
    // response says where it went. `PgAgentDb.loadGuidance` is the other end:
    // the next run in this session reads it before its first provider step.
    const carries = !(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status);
    const seqRow = await work.tx.query<{ seq: number }>(
      `UPDATE sessions SET next_seq = next_seq + 1, last_activity_at = now()
        WHERE id = $1 RETURNING next_seq - 1 AS seq`,
      [sessionId],
    );
    const seq = seqRow.rows[0]?.seq ?? 0;
    const { rows } = await work.tx.query<{ id: string }>(
      `INSERT INTO messages (workspace_id, session_id, seq, role, kind, text, status, run_id)
       VALUES ($1, $2, $3, 'user', 'guidance', $4, 'streaming', $5) RETURNING id`,
      [work.workspaceId, sessionId, seq, text, carries ? null : runId],
    );
    const guidanceId = rows[0]?.id ?? '';
    work.jobs.push(
      ...(await publishEvents(work.tx, work.workspaceId, [
        {
          kind: 'message.appended',
          sessionId,
          payload: {
            message_id: guidanceId,
            session_id: sessionId,
            seq,
            role: 'user',
            kind: 'guidance',
            text,
            blocks: [],
            status: 'streaming',
            run_id: carries ? null : runId,
          },
        },
      ])),
    );
    return carries
      ? { guidance_id: guidanceId, status: 'next_message', copy: GUIDANCE_CARRIED_COPY }
      : { guidance_id: guidanceId, status: 'queued' };
  });
  return c.json(body, 201);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

async function queueState(work: TenantWork, runId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await work.tx.query<{ id: string; text: string; status: string; position: number }>(
    `SELECT id, text, status, position FROM run_queue WHERE workspace_id = $1 AND run_id = $2 ORDER BY position`,
    [work.workspaceId, runId],
  );
  return rows.map((row) => ({ id: row.id, text: row.text, status: row.status, position: row.position }));
}

export async function queueMessage(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const runId = pathUuid(c, 'runId');
  const input = await jsonBody<{ text?: string }>(c);
  const text = (input.text ?? '').trim().slice(0, 4000);
  if (!text) throw new RouteError('text is required', 'empty_queue_item', 422);

  const body = await inWorkspace(c, async (work) => {
    await loadSessionForWrite(work, sessionId);
    const run = await loadRun(work, sessionId, runId);
    // A stopped run's queue is paused, not queued: the item is kept and the
    // client shows it as paused rather than pretending it will be sent.
    const status = run.status === 'stopping' || run.status === 'stopped' ? 'paused' : 'queued';
    await work.tx.query(
      `INSERT INTO run_queue (workspace_id, run_id, session_id, text, status, position, created_by)
       VALUES ($1, $2, $3, $4, $5,
               COALESCE((SELECT max(position) + 1 FROM run_queue WHERE run_id = $2), 0), $6)`,
      [work.workspaceId, runId, sessionId, text, status, work.userId],
    );
    const items = await queueState(work, runId);
    work.jobs.push(
      ...(await publishEvents(work.tx, work.workspaceId, [
        { kind: 'run.queue.updated', sessionId, payload: { run_id: runId, items } },
      ])),
    );
    return { items };
  });
  return c.json(body, 201);
}

export async function editQueueItem(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const runId = pathUuid(c, 'runId');
  const itemId = pathUuid(c, 'itemId');
  const input = await jsonBody<{ text?: string }>(c);
  const text = (input.text ?? '').trim().slice(0, 4000);
  if (!text) throw new RouteError('text is required', 'empty_queue_item', 422);

  const body = await inWorkspace(c, async (work) => {
    await loadSessionForWrite(work, sessionId);
    await loadRun(work, sessionId, runId);
    const { rowCount } = await work.tx.query(
      `UPDATE run_queue SET text = $4 WHERE workspace_id = $1 AND run_id = $2 AND id = $3
         AND status IN ('queued', 'paused')`,
      [work.workspaceId, runId, itemId, text],
    );
    if (!rowCount) throw new RouteError('no such queued item', 'unknown_queue_item', 404);
    const items = await queueState(work, runId);
    work.jobs.push(
      ...(await publishEvents(work.tx, work.workspaceId, [
        { kind: 'run.queue.updated', sessionId, payload: { run_id: runId, items } },
      ])),
    );
    return { items };
  });
  return c.json(body);
}

export async function removeQueueItem(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const runId = pathUuid(c, 'runId');
  const itemId = pathUuid(c, 'itemId');

  const body = await inWorkspace(c, async (work) => {
    await loadSessionForWrite(work, sessionId);
    await loadRun(work, sessionId, runId);
    // Marked `removed`, never deleted: the transcript has to keep explaining
    // itself, and a vanished row is a question nobody can answer later.
    const { rowCount } = await work.tx.query(
      `UPDATE run_queue SET status = 'removed'
        WHERE workspace_id = $1 AND run_id = $2 AND id = $3 AND status IN ('queued', 'paused')`,
      [work.workspaceId, runId, itemId],
    );
    if (!rowCount) throw new RouteError('no such queued item', 'unknown_queue_item', 404);
    const items = await queueState(work, runId);
    work.jobs.push(
      ...(await publishEvents(work.tx, work.workspaceId, [
        { kind: 'run.queue.updated', sessionId, payload: { run_id: runId, items } },
      ])),
    );
    return { items };
  });
  return c.json(body);
}

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

/**
 * A user Retry is a new attempt, not a new run.
 *
 * The row keeps its id and its `client_turn_id`, `attempt` goes up by one, and
 * the new instance id is `${run_id}-a${attempt+1}`. The engine resumes at the
 * failed turn, because the partial assistant message for that turn is keyed
 * `(run_id, turn)` and the provider step replaces it rather than appending.
 */
export async function retryRun(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const runId = pathUuid(c, 'runId');

  const outcome = await inWorkspace(c, async (work) => {
    await loadSessionForWrite(work, sessionId);
    const run = await loadRun(work, sessionId, runId);
    if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
      throw new RouteError('this run is still going', 'run_active', 409);
    }
    if (isEnginePaused(c.env)) {
      throw new RouteError('the engine is paused for a deploy', 'engine_paused', 409);
    }
    const attempt = run.attempt + 1;
    const approvalRetryBlock = await approvalContinuationRetryBlock(work.tx, runId, attempt);
    if (approvalRetryBlock) {
      throw new RouteError('this approved continuation cannot be retried under its current authorization and budget', approvalRetryBlock, 409);
    }
    const engineVersion = Number(c.env.ENGINE_VERSION ?? '1') || 1;
    const traceId = crypto.randomUUID();
    const instanceId = runAttemptInstanceId(runId, attempt);
    await work.tx.query(
      `UPDATE runs
          SET attempt = $3, status = 'working', stop_requested = false, error = NULL,
              ended_at = NULL, engine_version = $4, trace_id = $5, workflow_instance_id = $6
        WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, runId, attempt, engineVersion, traceId, instanceId],
    );
    work.jobs.push(
      ...(await publishEvents(work.tx, work.workspaceId, [
        { kind: 'run.status', sessionId, traceId, payload: { run_id: runId, attempt, status: 'working' } },
      ])),
    );
    return {
      run: { id: runId, status: 'working', attempt },
      create: { runId, workspaceId: work.workspaceId, sessionId, attempt, engineVersion, traceId },
    };
  });

  await createInstance(c.env, outcome.create);
  return c.json(runView(outcome.run), 201);
}

// ---------------------------------------------------------------------------
// The context answer a waiting run is parked on
// ---------------------------------------------------------------------------

/**
 * Answer the question `ask_for_context` asked.
 *
 * The value is written to `agent_context_fields` and the event sent to the
 * instance carries ids only — the step reads the answer back from Postgres,
 * because Workflow instance state is retained for 30 days and the erasure
 * inventory asserts it holds no free text.
 */
export async function answerContext(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const runId = pathUuid(c, 'runId');
  const input = await jsonBody<{ key?: string; value?: string }>(c);
  const key = (input.key ?? '').trim().slice(0, 64);
  const value = (input.value ?? '').slice(0, 2000);
  if (!key) throw new RouteError('key is required', 'key_required', 422);

  const outcome = await inWorkspace(c, async (work) => {
    await loadSessionForWrite(work, sessionId);
    const run = await loadRun(work, sessionId, runId);
    if (run.status !== 'waiting') throw new RouteError('this run is not waiting', 'run_not_waiting', 409);
    if (run.waiting_for !== key) {
      throw new RouteError(`this run is waiting for ${run.waiting_for ?? 'nothing'}`, 'wrong_key', 409);
    }
    await work.tx.query(
      `INSERT INTO agent_context_fields (workspace_id, agent_id, key, value, scope, set_by, run_id)
       VALUES ($1, $2, $3, $4, 'reply', $5, $6)
       ON CONFLICT (agent_id, key) DO UPDATE SET value = EXCLUDED.value, set_by = EXCLUDED.set_by, updated_at = now()`,
      [work.workspaceId, run.agent_id, key, value, work.userId, runId],
    );
    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, run_id, session_id)
       VALUES ($1, 'user', $2, 'context.set', $3, $4)`,
      [work.workspaceId, work.userId, runId, sessionId],
    );
    return { instanceId: run.workflow_instance_id, key };
  });

  if (outcome.instanceId) {
    const instance = await c.env.RUN_ATTEMPT.get(outcome.instanceId);
    await instance.sendEvent({
      type: CONTEXT_ANSWERED_EVENT,
      payload: { run_id: runId, key: outcome.key },
    });
  }
  return c.json({ ok: true, key: outcome.key });
}
