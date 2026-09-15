// What a model call cost, and whether the workspace may make another.
//
// `model_calls` is the only record of spend, so the insert happens on the same
// path as the call rather than in a job: a job that fails to run turns into a
// workspace with an unmetered agent, and the cap is the thing standing between
// a runaway tool loop and a bill. It carries `key_id` and `trace_id` and no key
// material — the plan's rule is that audit carries the id only.
//
// `checkCaps` is read by the engine before it creates an instance, which is the
// only place where refusing is cheap: refusing mid-run would mean a half-written
// transcript and a user who cannot tell what happened.
import type { Tx } from '../db/client.js';
import { estimateCostUsd, loadModel, type CatalogModel } from './catalog.js';
import type { Usage } from './types.js';

export interface ModelCallRecord {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly turn: number | null;
  readonly modelId: string;
  readonly provider: string;
  /** Which key paid for it. The id, never the key. */
  readonly keyId: string | null;
  readonly usage: Usage;
  readonly latencyMs: number | null;
  readonly status: 'ok' | 'error' | 'stopped';
  readonly traceId: string | null;
}

/**
 * Insert one `model_calls` row, pricing it from the catalog.
 *
 * The price is looked up rather than passed in, so a caller cannot report a
 * cost that disagrees with the catalog. `model` may be supplied when the caller
 * already has the row, which the engine does — it read it to choose a transport.
 */
export async function recordModelCall(
  tx: Tx,
  record: ModelCallRecord,
  model?: CatalogModel | null,
): Promise<{ id: string; cost_usd_estimate: number }> {
  const row = model ?? (await loadModel(tx, record.modelId));
  const cost =
    row === null
      ? 0
      : estimateCostUsd(row.pricing, {
          input_tokens: record.usage.input_tokens,
          output_tokens: record.usage.output_tokens,
          cached_input_tokens: record.usage.cached_input_tokens,
        });

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO model_calls
       (workspace_id, run_id, turn, model_id, provider, key_id,
        input_tokens, output_tokens, cached_input_tokens, reasoning_tokens,
        cost_usd_estimate, latency_ms, status, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id`,
    [
      record.workspaceId,
      record.runId,
      record.turn,
      record.modelId,
      record.provider,
      record.keyId,
      record.usage.input_tokens,
      record.usage.output_tokens,
      record.usage.cached_input_tokens,
      record.usage.reasoning_tokens,
      cost,
      record.latencyMs,
      record.status,
      record.traceId,
    ],
  );
  return { id: rows[0]?.id ?? '', cost_usd_estimate: cost };
}

export interface CapState {
  readonly allowed: boolean;
  readonly reason: 'daily_token_cap' | 'max_concurrent_runs' | null;
  readonly dailyTokenCap: number | null;
  readonly tokensToday: number;
  readonly maxConcurrentRuns: number;
  readonly activeRuns: number;
  /** True once spend passes 80 percent of the cap: the warning job's trigger. */
  readonly warn: boolean;
}

const WARN_AT = 0.8;

/**
 * The two tenant caps, read together.
 *
 * "Today" is the workspace's own timezone, not UTC: a cap that resets at
 * midnight in a timezone the Admin does not live in is a cap they cannot
 * reason about. `waiting` runs are excluded from the concurrency count because
 * a waiting Workflow instance holds no compute and does not count toward
 * Cloudflare's concurrency either; counting it would stop a workspace whose
 * runs are all blocked on a human.
 */
export async function checkCaps(tx: Tx, workspaceId: string): Promise<CapState> {
  const { rows } = await tx.query<{
    daily_token_cap: string | null;
    max_concurrent_runs: number;
    tokens_today: string;
    active_runs: string;
  }>(
    `WITH s AS (
       SELECT COALESCE(daily_token_cap, NULL) AS daily_token_cap,
              COALESCE(max_concurrent_runs, 3) AS max_concurrent_runs,
              COALESCE(timezone, 'UTC') AS tz
         FROM workspace_settings WHERE workspace_id = $1
     )
     SELECT s.daily_token_cap,
            s.max_concurrent_runs,
            COALESCE((
              SELECT sum(m.input_tokens + m.output_tokens)
                FROM model_calls m
               WHERE m.workspace_id = $1
                 AND m.created_at >= date_trunc('day', now() AT TIME ZONE s.tz) AT TIME ZONE s.tz
            ), 0)::text AS tokens_today,
            (SELECT count(*) FROM runs r
              WHERE r.workspace_id = $1 AND r.status = 'working')::text AS active_runs
       FROM s`,
    [workspaceId],
  );

  const row = rows[0];
  // No settings row means no cap has been configured. Defaults from the schema.
  const dailyTokenCap = row?.daily_token_cap == null ? null : Number(row.daily_token_cap);
  const maxConcurrentRuns = row?.max_concurrent_runs ?? 3;
  const tokensToday = Number(row?.tokens_today ?? '0');
  const activeRuns = Number(row?.active_runs ?? '0');

  const overTokens = dailyTokenCap !== null && tokensToday >= dailyTokenCap;
  const overRuns = activeRuns >= maxConcurrentRuns;

  return {
    allowed: !overTokens && !overRuns,
    // Token cap first: it is the one the Admin set, and naming the other when
    // both are hit would send them to the wrong settings screen.
    reason: overTokens ? 'daily_token_cap' : overRuns ? 'max_concurrent_runs' : null,
    dailyTokenCap,
    tokensToday,
    maxConcurrentRuns,
    activeRuns,
    warn: dailyTokenCap !== null && tokensToday >= dailyTokenCap * WARN_AT,
  };
}
