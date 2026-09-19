import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';
import { isEnginePaused } from '../env.js';
import { consumeRate, type RateLimit } from '../auth/rate-limit.js';
import { publishEvents } from '../jobs.js';
import { checkCaps } from '../model/usage.js';
import { maybeQueueCapWarning } from '../ops/cap-warning.js';
import { requireInstanceCapacity } from '../ops/instance-cap.js';
import { loadModel, providerLabel } from '../model/catalog.js';
import { requireAllowedProvider } from '../model/allowed.js';
import { resolveRuntimeBinding } from '../runtime/config.js';
import { HermesClient } from '../runtime/client.js';
import { DEFAULT_MAX_TURNS } from '../engine/constants.js';
import { RouteError } from '../routes/tenant.js';
import { runAttemptInstanceId } from './workflow.js';

const TURN_LIMIT: RateLimit = { action: 'run.turn', limit: 30, windowSeconds: 60 };

export interface TurnSession {
  readonly id: string;
  readonly agent_id: string;
  readonly owner_id: string;
  readonly read_only: boolean;
  readonly mode: string;
  readonly model_id: string;
  readonly effort: string | null;
}

export interface SubmittedRun {
  readonly id: string;
  readonly agent_id: string;
  readonly status: string;
  readonly attempt: number;
  readonly engine_version: number;
  readonly workflow_instance_id: string | null;
  readonly session_id: string;
  readonly model_id: string;
  readonly waiting_for: string | null;
}

export interface RunInstanceParams {
  readonly runId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly engineVersion: number;
  readonly traceId: string;
  readonly receivedAt?: number;
  readonly scriptedScript?: string;
}

export type SubmitTurnResult =
  | { status: 200; run: SubmittedRun; duplicate: true }
  | { status: 201; run: SubmittedRun; duplicate: false; create: RunInstanceParams };

export async function createRunInstance(
  env: Env,
  params: RunInstanceParams,
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

/**
 * External-channel admission mirroring the browser route. Authentication is
 * performed by the adapter; keep policy changes here and in `createTurn`
 * aligned until the browser route is migrated onto this service.
 */
export async function submitTurn(input: {
  readonly tx: Tx;
  readonly env: Env;
  readonly workspaceId: string;
  readonly userId: string;
  readonly session: TurnSession;
  readonly clientTurnId: string;
  readonly text: string;
  readonly jobIds: string[];
  readonly scriptedScript?: string;
}): Promise<SubmitTurnResult> {
  const { tx, env, workspaceId, userId, session, clientTurnId, text, jobIds } = input;
  const existing = await tx.query<SubmittedRun>(
    `SELECT id, agent_id, status, attempt, engine_version, workflow_instance_id, session_id, model_id, waiting_for
       FROM runs WHERE workspace_id=$1 AND session_id=$2 AND client_turn_id=$3`,
    [workspaceId, session.id, clientTurnId],
  );
  const already = existing.rows[0];
  if (already) return { status: 200, run: already, duplicate: true };

  if (env.AGENT_RUNTIME === 'hermes' && env.MODEL_SCRIPTED !== '1') {
    const binding = await resolveRuntimeBinding(env, tx, workspaceId, session.agent_id);
    try {
      await new HermesClient(binding.baseUrl, binding.apiKey, undefined, binding.transport).capabilities();
    } catch (error) {
      console.error(JSON.stringify({ at: 'runtime.admission', ok: false, error: String(error) }));
      throw new RouteError('The official Hermes runtime is not healthy enough to accept this turn.', 'runtime_unhealthy', 503);
    }
  }
  if (isEnginePaused(env)) throw new RouteError('the engine is paused for a deploy', 'engine_paused', 409);
  await consumeRate(tx, userId, workspaceId, TURN_LIMIT);

  const caps = await checkCaps(tx, workspaceId);
  if (!caps.allowed) {
    throw new RouteError(
      caps.reason === 'daily_token_cap'
        ? 'this workspace has reached its daily token cap'
        : 'this workspace already has as many runs as it allows',
      caps.reason ?? 'cap_exceeded',
      429,
    );
  }
  await requireInstanceCapacity(tx, env, workspaceId);
  const warning = await maybeQueueCapWarning(tx, workspaceId, caps);
  if (warning) jobIds.push(warning);

  const model = await loadModel(tx, session.model_id);
  if (!model) throw new RouteError('this session names a model the catalog does not have', 'unknown_model', 409);
  requireAllowedProvider(env, model.provider);
  if (env.MODEL_SCRIPTED !== '1') {
    const key = await tx.query<{ status: string }>(
      `SELECT status FROM workspace_provider_keys
        WHERE workspace_id=$1 AND provider=$2 AND revoked_at IS NULL LIMIT 1`,
      [workspaceId, model.provider],
    );
    const status = key.rows[0]?.status ?? null;
    const label = providerLabel(model.provider);
    if (status === null) throw new RouteError(`Add your ${label} key in Settings to start`, 'no_key', 409);
    if (status === 'invalid') throw new RouteError(`Your ${label} key was rejected`, 'key_invalid', 409);
    if (status !== 'verified' && status !== 'verified_scoped') {
      throw new RouteError(`Your ${label} key has not been verified`, 'key_unverified', 409);
    }
  }

  const runId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const engineVersion = Number(env.ENGINE_VERSION ?? '1') || 1;
  const instanceId = runAttemptInstanceId(runId, 1);
  let inserted: SubmittedRun | undefined;
  await tx.query('SAVEPOINT run_insert');
  try {
    const result = await tx.query<SubmittedRun>(
      `INSERT INTO runs (id, workspace_id, session_id, agent_id, status, model_id, effort, max_turns,
                         trace_id, workflow_instance_id, attempt, engine_version, client_turn_id, mode)
       VALUES ($1,$2,$3,$4,'working',$5,$6,$7,$8,$9,1,$10,$11,$12)
       RETURNING id, agent_id, status, attempt, engine_version, workflow_instance_id, session_id, model_id, waiting_for`,
      [runId, workspaceId, session.id, session.agent_id, session.model_id, session.effort,
       DEFAULT_MAX_TURNS, traceId, instanceId, engineVersion, clientTurnId, session.mode],
    );
    inserted = result.rows[0];
    await tx.query('RELEASE SAVEPOINT run_insert');
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT run_insert');
    if ((error as { code?: string }).code === '23505') {
      const raced = await tx.query<SubmittedRun>(
        `SELECT id, agent_id, status, attempt, engine_version, workflow_instance_id, session_id, model_id, waiting_for
           FROM runs WHERE workspace_id=$1 AND session_id=$2 AND client_turn_id=$3`,
        [workspaceId, session.id, clientTurnId],
      );
      const row = raced.rows[0];
      if (row) return { status: 200, run: row, duplicate: true };
      throw new RouteError('this session already has a run in flight', 'run_in_flight', 409);
    }
    throw error;
  }
  const run = inserted;
  if (!run) throw new RouteError('the run was not created', 'create_failed', 409);

  const seqRow = await tx.query<{ seq: number }>(
    `UPDATE sessions SET next_seq=next_seq+1, last_activity_at=now()
      WHERE id=$1 RETURNING next_seq-1 AS seq`,
    [session.id],
  );
  const seq = seqRow.rows[0]?.seq ?? 0;
  const message = await tx.query<{ id: string }>(
    `INSERT INTO messages (workspace_id, session_id, seq, role, text, status, run_id, turn)
     VALUES ($1,$2,$3,'user',$4,'complete',$5,0) RETURNING id`,
    [workspaceId, session.id, seq, text, runId],
  );
  await tx.query(
    `INSERT INTO run_turns (workspace_id, run_id, turn, seq, role, provider_message)
     VALUES ($1,$2,0,0,'user',$3::jsonb)`,
    [workspaceId, runId, JSON.stringify({ role: 'user', content: text })],
  );
  await tx.query(`DELETE FROM session_drafts WHERE session_id=$1 AND user_id=$2`, [session.id, userId]);
  jobIds.push(...(await publishEvents(tx, workspaceId, [{
    kind: 'message.appended',
    sessionId: session.id,
    traceId,
    payload: {
      message_id: message.rows[0]?.id ?? '', session_id: session.id, seq,
      role: 'user', kind: null, text, blocks: [], status: 'complete', run_id: runId,
    },
  }])));
  return {
    status: 201,
    run,
    duplicate: false,
    create: {
      runId, workspaceId, sessionId: session.id, attempt: 1, engineVersion, traceId,
      ...(input.scriptedScript ? { scriptedScript: input.scriptedScript } : {}),
    },
  };
}
