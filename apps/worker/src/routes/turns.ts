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
import { requireRecoveryAgent, retryTask } from '../runs/recovery.js';
import { HermesClient } from '../runtime/client.js';
import { getSession, requireCsrf, requireOrigin } from '../auth.js';
import { connect } from '../db/client.js';
import { consumeRate, type RateLimit } from '../auth/rate-limit.js';
import {
  deliverPreparedPublications,
  enqueueJob,
  finishJobsAfterCommit,
  publishEvents,
  publishEventsForImmediateDelivery,
  runJobsAfterCommit,
} from '../jobs.js';
import { checkCaps } from '../model/usage.js';
import { maybeQueueCapWarning } from '../ops/cap-warning.js';
import { requireInstanceCapacity } from '../ops/instance-cap.js';
import { providerLabel } from '../model/catalog.js';
import { requireAllowedProvider } from '../model/allowed.js';
import { pickDevScript, runAttemptInstanceId } from '../runs/workflow.js';
import { createRunInstance, type RunInstanceParams } from '../runs/submit.js';
import { CONTEXT_ANSWERED_EVENT, DEFAULT_MAX_TURNS } from '../engine/constants.js';
import {
  inWorkspace,
  jsonBody,
  pathUuid,
  RouteError,
  type TenantWork,
} from './tenant.js';
import { VISIBLE } from './sessions.js';
import { logEvent } from '../keys/redact.js';
import { parseExpectedSettings, requireExpectedSettings } from '../domain/session-settings.js';

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

async function loadSessionForWrite(work: TenantWork, sessionId: string, lock = false): Promise<SessionRow> {
  const { rows } = await work.tx.query<SessionRow>(
    `SELECT s.id, s.agent_id, s.owner_id, s.read_only, s.mode, s.model_id, s.effort FROM sessions s
      WHERE s.workspace_id = $1 AND s.id = $3 AND ${VISIBLE} ${lock ? 'FOR UPDATE OF s' : ''}`,
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
  trace_id: string | null;
}

interface TurnAdmissionRow extends SessionRow {
  existing_id: string | null;
  existing_agent_id: string | null;
  existing_status: string | null;
  existing_attempt: number | null;
  existing_engine_version: number | null;
  existing_workflow_instance_id: string | null;
  existing_session_id: string | null;
  existing_model_id: string | null;
  existing_waiting_for: string | null;
  existing_trace_id: string | null;
}

async function loadTurnAdmission(
  work: TenantWork,
  sessionId: string,
  clientTurnId: string,
): Promise<{ session: SessionRow; existing: RunRow | null }> {
  const { rows } = await work.tx.query<TurnAdmissionRow>(
    `WITH agent_lock AS MATERIALIZED (
       SELECT a.id FROM agents a JOIN sessions s ON s.workspace_id=a.workspace_id AND s.agent_id=a.id
        WHERE s.workspace_id=$1 AND s.id=$3 AND ${VISIBLE} FOR KEY SHARE OF a
     )
     SELECT s.id, s.agent_id, s.owner_id, s.read_only, s.mode, s.model_id, s.effort,
            existing.id AS existing_id, existing.agent_id AS existing_agent_id,
            existing.status AS existing_status, existing.attempt AS existing_attempt,
            existing.engine_version AS existing_engine_version,
            existing.workflow_instance_id AS existing_workflow_instance_id,
            existing.session_id AS existing_session_id, existing.model_id AS existing_model_id,
            existing.waiting_for AS existing_waiting_for, existing.trace_id AS existing_trace_id
       FROM sessions s
       JOIN agent_lock locked_agent ON locked_agent.id=s.agent_id
       LEFT JOIN LATERAL (
         SELECT r.id, r.agent_id, r.status, r.attempt, r.engine_version,
                r.workflow_instance_id, r.session_id, r.model_id, r.waiting_for, r.trace_id
           FROM runs r
          WHERE r.workspace_id=s.workspace_id AND r.session_id=s.id AND r.client_turn_id=$4
          LIMIT 1
       ) existing ON true
      WHERE s.workspace_id=$1 AND s.id=$3 AND ${VISIBLE} FOR UPDATE OF s`,
    [work.workspaceId, work.userId, sessionId, clientTurnId],
  );
  const row = rows[0];
  if (!row) throw new RouteError('no such session', 'unknown_session', 404);
  if (row.owner_id !== work.userId) throw new RouteError('this is the owner\'s to do', 'not_owner', 403);
  if (row.read_only) throw new RouteError('this session is read-only', 'read_only', 409);
  const session: SessionRow = {
    id: row.id,
    agent_id: row.agent_id,
    owner_id: row.owner_id,
    read_only: row.read_only,
    mode: row.mode,
    model_id: row.model_id,
    effort: row.effort,
  };
  let existing: RunRow | null = row.existing_id ? {
    id: row.existing_id,
    agent_id: row.existing_agent_id!,
    status: row.existing_status!,
    attempt: row.existing_attempt!,
    engine_version: row.existing_engine_version!,
    workflow_instance_id: row.existing_workflow_instance_id,
    session_id: row.existing_session_id!,
    model_id: row.existing_model_id!,
    waiting_for: row.existing_waiting_for,
    trace_id: row.existing_trace_id,
  } : null;
  if (!existing) {
    // The statement snapshot can precede a concurrent identical admission's
    // commit even though its session-row lock made us wait. A fresh read after
    // that wait must recognize the duplicate before checking mutable caps.
    const committed = await work.tx.query<RunRow>(
      `SELECT id,agent_id,status,attempt,engine_version,workflow_instance_id,session_id,model_id,waiting_for,trace_id
         FROM runs WHERE workspace_id=$1 AND session_id=$2 AND client_turn_id=$3`,
      [work.workspaceId, sessionId, clientTurnId],
    );
    existing = committed.rows[0] ?? null;
  }
  return { session, existing };
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

/** GET /w/:ws/sessions/:id/runs/:runId — authoritative reconciliation. */
export async function getRunRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const sessionId = pathUuid(c, 'id');
  const runId = pathUuid(c, 'runId');
  const body = await inWorkspace(c, async (work) => {
    const { rows } = await work.tx.query<{ id: string; status: string; attempt: number }>(
      `SELECT r.id, r.status, r.attempt
         FROM runs r
         JOIN sessions s ON s.workspace_id = r.workspace_id AND s.id = r.session_id
        WHERE r.workspace_id = $1 AND s.owner_id = $2 AND r.session_id = $3 AND r.id = $4`,
      [work.workspaceId, work.userId, sessionId, runId],
    );
    const run = rows[0];
    if (!run) throw new RouteError('no such run', 'unknown_run', 404);
    return runView(run);
  });
  return c.json(body);
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
  const receivedAt = Date.now();
  let capabilityMs: number | null = null;
  const workspaceTimings = {
    authenticationMs: null as number | null,
    transactionMs: null as number | null,
    afterCommitJobsMs: null as number | null,
  };
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const input = await jsonBody<{ client_turn_id?: string; text?: string; attachments?: unknown; expected_settings?: unknown }>(c);
  const expectedSettings = parseExpectedSettings(input.expected_settings);
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
    // Serialized session authorization and fresh idempotency come before
    // every mutable cap, settings conflict or provider refusal.
    const admission = await loadTurnAdmission(work, sessionId, clientTurnId);
    const session = admission.session;
    const already = admission.existing;
    if (already) return { status: 200 as const, run: already, duplicate: true };
    requireExpectedSettings(session, expectedSettings);

    if (c.env.AGENT_RUNTIME === 'hermes' && c.env.MODEL_SCRIPTED !== '1') {
      const binding = await resolveRuntimeBinding(c.env, work.tx, work.workspaceId, session.agent_id);
      const capabilityStartedAt = Date.now();
      try {
        await new HermesClient(binding.baseUrl, binding.apiKey, undefined, binding.transport).capabilities();
      } catch (error) {
        console.error(JSON.stringify({ at: 'runtime.admission', ok: false, error: String(error) }));
        throw new RouteError(
          'The official Hermes runtime is not healthy enough to accept this turn.',
          'runtime_unhealthy',
          503,
        );
      } finally {
        capabilityMs = Math.max(0, Date.now() - capabilityStartedAt);
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
    const modelResult = await work.tx.query<{ provider: string; key_status: string | null }>(
      `SELECT c.provider,
              (SELECT k.status FROM workspace_provider_keys k
                WHERE k.workspace_id=$1 AND k.provider=c.provider AND k.revoked_at IS NULL
                LIMIT 1) AS key_status
         FROM catalog c WHERE c.model_id=$2`,
      [work.workspaceId, session.model_id],
    );
    const model = modelResult.rows[0];
    if (!model) throw new RouteError('this session names a model the catalog does not have', 'unknown_model', 409);
    requireAllowedProvider(c.env, model.provider);

    if (c.env.MODEL_SCRIPTED !== '1') {
      const status = model.key_status;
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
         RETURNING id, agent_id, status, attempt, engine_version, workflow_instance_id, session_id, model_id, waiting_for, trace_id`,
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
          `SELECT id, agent_id, status, attempt, engine_version, workflow_instance_id, session_id, model_id, waiting_for, trace_id
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

    // The user message, engine turn and draft cleanup are one statement. This
    // keeps their all-or-nothing transaction while removing three Hyperdrive
    // round trips from the admission path.
    const initial = await work.tx.query<{ id: string; seq: number }>(
      `WITH next_message AS (
         UPDATE sessions SET next_seq=next_seq+1, last_activity_at=now()
          WHERE workspace_id=$1 AND id=$3
          RETURNING next_seq-1 AS seq
       ), new_message AS (
         INSERT INTO messages (workspace_id, session_id, seq, role, text, status, client_id, run_id, turn)
         SELECT $1, $3, seq, 'user', $4, 'complete', $5, $6, 0 FROM next_message
         RETURNING id, seq
       ), new_turn AS (
         INSERT INTO run_turns (workspace_id, run_id, turn, seq, role, provider_message)
         VALUES ($1, $6, 0, 0, 'user', $7::jsonb)
         RETURNING 1
       ), cleared_draft AS (
         DELETE FROM session_drafts WHERE session_id=$3 AND user_id=$2 RETURNING 1
       )
       SELECT m.id, m.seq
         FROM new_message m
         CROSS JOIN (SELECT count(*) FROM new_turn) committed_turn
         CROSS JOIN (SELECT count(*) FROM cleared_draft) cleared`,
      [
        work.workspaceId,
        work.userId,
        sessionId,
        text,
        clientTurnId,
        runId,
        JSON.stringify({ role: 'user', content: text }),
      ],
    );
    const message = initial.rows[0];
    if (!message) throw new RouteError('the user message was not created', 'create_failed', 409);
    const seq = message.seq;

    // Keep the exact committed envelope so the request can publish it without
    // three more claim/read transactions. The durable job remains queued until
    // the hub acknowledges, covering a crash at every following boundary.
    const publications = await publishEventsForImmediateDelivery(work.tx, work.workspaceId, [
      {
        kind: 'message.appended',
        sessionId,
        traceId,
        payload: {
          message_id: message.id,
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
    ]);
    const publishJobId = publications[0]?.jobId;
    if (!publishJobId) throw new RouteError('the message delivery was not queued', 'create_failed', 409);

    const create: RunInstanceParams = {
      runId,
      workspaceId: work.workspaceId,
      sessionId,
      attempt: 1,
      engineVersion,
      traceId,
      receivedAt,
      ...(scriptedScript ? { scriptedScript } : {}),
    };
    // Workflow creation is durable too. A background/Cron retry is allowed
    // only after the initial message publish job is done, preserving global
    // stream ordering even when the direct handoff fails halfway through.
    const launchJobId = await enqueueJob(
      work.tx,
      work.workspaceId,
      'run_launch',
      `run-launch:${runId}:1`,
      { ...create, afterPublishJobId: publishJobId },
    );
    if (!launchJobId) throw new RouteError('the run launch was not queued', 'create_failed', 409);

    return {
      status: 201 as const,
      run,
      duplicate: false,
      create,
      publications,
      publishJobId,
      launchJobId,
    };
  }, {
    onTimings: (timings) => {
      workspaceTimings.authenticationMs = timings.authenticationMs;
      workspaceTimings.transactionMs = timings.transactionMs;
      workspaceTimings.afterCommitJobsMs = timings.afterCommitJobsMs;
    },
  }));

  if (!outcome.duplicate && 'create' in outcome && outcome.create) {
    const admissionMs = Math.max(0, Date.now() - receivedAt);
    let orderedPublishMs: number | null = null;
    let workflowCreateMs: number | null = null;
    let handoffDeferred = false;
    const background = (work: () => Promise<void>) => {
      c.executionCtx.waitUntil(work().catch((error) => {
        try {
          logEvent({
            at: 'hermes.turn_handoff_retry', run_id: outcome.run.id,
            trace_id: outcome.create.traceId, ok: false, error: String(error),
          });
        } catch { /* Durable jobs remain for Cron even if logging fails. */ }
      }));
    };

    const publishStartedAt = Date.now();
    try {
      await deliverPreparedPublications(c.env, outcome.create.workspaceId, outcome.publications);
      orderedPublishMs = Math.max(0, Date.now() - publishStartedAt);
    } catch (error) {
      orderedPublishMs = Math.max(0, Date.now() - publishStartedAt);
      handoffDeferred = true;
      // The queued launch names the publish job as a prerequisite. Even if a
      // Cron races this background attempt, it cannot create the Workflow
      // before the lower stream id has been acknowledged.
      background(() => runJobsAfterCommit(c.env, outcome.create.workspaceId, [
        outcome.publishJobId,
        outcome.launchJobId,
      ]));
      try {
        logEvent({
          at: 'hermes.turn_direct_publish', run_id: outcome.run.id,
          trace_id: outcome.create.traceId, ok: false, error: String(error),
        });
      } catch { /* The durable handoff is already scheduled. */ }
    }

    if (!handoffDeferred) {
      const workflowStartedAt = Date.now();
      try {
        await createRunInstance(c.env, outcome.create);
        workflowCreateMs = Math.max(0, Date.now() - workflowStartedAt);
        background(() => finishJobsAfterCommit(c.env, outcome.create.workspaceId, [
          outcome.publishJobId,
          outcome.launchJobId,
        ]));
      } catch (error) {
        workflowCreateMs = Math.max(0, Date.now() - workflowStartedAt);
        handoffDeferred = true;
        // The message is already visible. Retire that publish job first, then
        // let the durable launch runner retry the idempotent Workflow create.
        background(async () => {
          await finishJobsAfterCommit(c.env, outcome.create.workspaceId, [outcome.publishJobId]);
          await runJobsAfterCommit(c.env, outcome.create.workspaceId, [outcome.launchJobId]);
        });
        try {
          logEvent({
            at: 'hermes.turn_direct_launch', run_id: outcome.run.id,
            trace_id: outcome.create.traceId, ok: false, error: String(error),
          });
        } catch { /* The durable launch is already scheduled. */ }
      }
    }

    try {
      logEvent({
        at: 'hermes.turn_admitted', run_id: outcome.run.id, trace_id: outcome.create.traceId,
        model_id: outcome.run.model_id, capability_ms: capabilityMs,
        authentication_ms: workspaceTimings.authenticationMs,
        transaction_ms: workspaceTimings.transactionMs,
        after_commit_jobs_ms: workspaceTimings.afterCommitJobsMs,
        admission_ms: admissionMs,
        ordered_publish_ms: orderedPublishMs,
        workflow_create_ms: workflowCreateMs,
        handoff_deferred: handoffDeferred,
        handoff_ms: Math.max(0, Date.now() - receivedAt - admissionMs),
      });
    } catch { /* Telemetry cannot turn an admitted run into a failed POST. */ }
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
      `UPDATE runs SET stop_requested = true, status = 'stopping', recovery_cancelled=true, recovery_next_at=NULL WHERE workspace_id = $1 AND id = $2`,
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
  const input = await jsonBody<{ expected_attempt?: number; expected_settings?: unknown }>(c);
  const expectedSettings = parseExpectedSettings(input.expected_settings);
  if (!Number.isInteger(input.expected_attempt) || input.expected_attempt! < 1) {
    throw new RouteError('Refresh this task before retrying.', 'expected_attempt_required', 422);
  }


  const result = await inWorkspace(c, async (work) => {
    const session = await loadSessionForWrite(work, sessionId);
    // Match the recovery service's agent → run → session lock order, including
    // automatic retries. An already admitted attempt wins before settings CAS.
    await requireRecoveryAgent(work, session.agent_id, true);
    const previous = await loadRun(work, sessionId, runId);
    if (previous.attempt === input.expected_attempt! + 1) return previous;
    const currentSession = await loadSessionForWrite(work, sessionId, true);
    requireExpectedSettings(currentSession, expectedSettings);
    const run = await retryTask(work, c.env, session.agent_id, runId, input.expected_attempt);
    if (run.session_id !== sessionId) throw new RouteError('No such task.', 'unknown_run', 404);
    return { id: run.id, status: run.status, attempt: run.attempt };
  });
  return c.json(runView(result), 201);
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
