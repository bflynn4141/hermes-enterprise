// Analytics Engine: the eight numbers plan section 5 names.
//
//   run duration, tool error rate, provider p95, socket reconnects,
//   Stop latency, subrequests per instance, daily spend
//
// (seven, plus the instance-cap counter that turned out to be the one that
// tells you the platform is about to be expensive).
//
// Why a separate dataset rather than reading them out of Postgres: these are
// questions about the platform, and no connection in this system can read two
// tenants' rows (migration 0008). "What is the p95 provider latency across
// every workspace" is not a question our database can answer at all, and
// building a role that could would hand every route the same reach. Analytics
// Engine takes unsampled writes and answers aggregate queries over them, and
// what is written here is ids and numbers — never a prompt, a name or a key.
//
// The binding is optional and guarded at every call. `wrangler dev --local`,
// the Node test project and any environment where the dataset has not been
// created yet simply have no `ANALYTICS` binding, and a metric helper that
// threw there would turn "we have not set up analytics" into "the run engine
// crashes". Every function here is a no-op without it and returns false so a
// caller can tell.
import type { Env } from '../env.js';

/**
 * Cloudflare's shape: up to 20 blobs (strings), 20 doubles (numbers), one
 * index (the sampling key). The index is the workspace id, so a query can ask
 * about one tenant without the dataset holding anything else about them.
 */
export interface AnalyticsPoint {
  readonly blobs: readonly string[];
  readonly doubles: readonly number[];
  /** Cloudflare names it `indexes`; exactly one entry is allowed today. */
  readonly index: string;
}

export const METRICS = [
  'run.duration',
  'tool.result',
  'provider.latency',
  'socket.reconnect',
  'stop.latency',
  'instance.subrequests',
  'spend.daily',
  'instance.created',
  'hermes.stream',
  'hermes.terminal_failure',
] as const;
export type Metric = (typeof METRICS)[number];

/** True when this environment has a dataset to write to. */
export const analyticsAvailable = (env: Env): boolean => Boolean(env.ANALYTICS);

/**
 * Write one point.
 *
 * Failures are swallowed and reported as `false`, never thrown. A metric is not
 * worth an error path: the alternative is a Worker whose run engine fails
 * because a telemetry binding was misconfigured, which is precisely the
 * observability tooling causing the outage it exists to explain.
 */
export function writePoint(env: Env, metric: Metric, workspaceId: string, point: Partial<AnalyticsPoint>): boolean {
  const dataset = env.ANALYTICS;
  if (!dataset) return false;
  try {
    dataset.writeDataPoint({
      blobs: [metric, workspaceId, ...(point.blobs ?? [])].slice(0, 20),
      doubles: (point.doubles ?? []).slice(0, 20),
      indexes: [point.index ?? workspaceId],
    });
    return true;
  } catch {
    return false;
  }
}

/** How long a run took, and how it ended. `status` is an enum, never a message. */
export const recordRunDuration = (
  env: Env,
  workspaceId: string,
  fields: { runId: string; status: string; ms: number; turns: number },
): boolean =>
  writePoint(env, 'run.duration', workspaceId, {
    blobs: [fields.runId, fields.status],
    doubles: [fields.ms, fields.turns],
  });

/**
 * One tool result. The error *rate* is a query over these, not a counter here:
 * a rate computed at write time cannot be re-sliced by tool or by day, and
 * those are the two slices anyone actually asks for.
 */
export const recordToolResult = (
  env: Env,
  workspaceId: string,
  fields: { tool: string; ok: boolean; ms: number },
): boolean =>
  writePoint(env, 'tool.result', workspaceId, {
    blobs: [fields.tool, fields.ok ? 'ok' : 'error'],
    doubles: [fields.ok ? 0 : 1, fields.ms],
  });

/** Provider latency per call. p95 is a quantile query over the double. */
export const recordProviderLatency = (
  env: Env,
  workspaceId: string,
  fields: { provider: string; modelId: string; ms: number; status: string },
): boolean =>
  writePoint(env, 'provider.latency', workspaceId, {
    blobs: [fields.provider, fields.modelId, fields.status],
    doubles: [fields.ms],
  });

/**
 * A socket reconnecting. The number that matters is not the count but whether
 * it moves after a deploy: a deploy terminates every WebSocket, and a spike
 * that does not subside is a client that cannot get back in.
 */
export const recordSocketReconnect = (
  env: Env,
  workspaceId: string,
  fields: { hub: 'session' | 'workspace'; resync: boolean },
): boolean =>
  writePoint(env, 'socket.reconnect', workspaceId, {
    blobs: [fields.hub, fields.resync ? 'resync' : 'replay'],
    doubles: [1],
  });

/**
 * Stop latency: the interval between the row being written and the engine
 * acting on it. The plan fixes a 1 s budget and says the number is recorded;
 * this is where the production number comes from, and the runbook quotes it.
 */
export const recordStopLatency = (
  env: Env,
  workspaceId: string,
  fields: { runId: string; ms: number; honouredAt: 'delta' | 'tool' | 'step' },
): boolean =>
  writePoint(env, 'stop.latency', workspaceId, {
    blobs: [fields.runId, fields.honouredAt],
    doubles: [fields.ms],
  });

/**
 * Subrequests used by one Workflow instance. The alarm is at 50 percent of the
 * 10,000 budget (engine/constants.ts); this is the series that says how close
 * the fleet runs to it, which is the number that decides whether the delta
 * batching interval is right.
 */
export const recordSubrequests = (
  env: Env,
  workspaceId: string,
  fields: { runId: string; count: number; budget: number },
): boolean =>
  writePoint(env, 'instance.subrequests', workspaceId, {
    blobs: [fields.runId],
    doubles: [fields.count, fields.budget, fields.budget === 0 ? 0 : fields.count / fields.budget],
  });

/** One workspace's estimated spend for one day. Written by the nightly Cron. */
export const recordDailySpend = (
  env: Env,
  workspaceId: string,
  fields: { day: string; costUsd: number; tokens: number },
): boolean =>
  writePoint(env, 'spend.daily', workspaceId, {
    blobs: [fields.day],
    doubles: [fields.costUsd, fields.tokens],
  });

/** One Workflow creation, with the platform cap it was counted against. */
export const recordInstanceCreated = (
  env: Env,
  workspaceId: string,
  fields: { used: number; cap: number | null },
): boolean =>
  writePoint(env, 'instance.created', workspaceId, {
    blobs: [],
    doubles: [1, fields.used, fields.cap ?? 0],
  });

/**
 * Hermes delivery health. Timings and counts are deliberately separate from
 * response content so the first-token and stream-tail SLOs remain queryable
 * without putting customer text in Analytics Engine.
 */
export const recordHermesStream = (
  env: Env,
  workspaceId: string,
  fields: {
    runId: string;
    releaseRing: 'canary' | 'stable';
    streamEnd: 'terminal' | 'eof' | 'disconnected' | 'drain_timeout' | 'not_opened';
    firstDeltaMs: number | null;
    firstPreviewMs: number | null;
    firstCheckpointMs: number | null;
    deltaCount: number;
    deltaCharacters: number;
  },
): boolean =>
  writePoint(env, 'hermes.stream', workspaceId, {
    blobs: [fields.runId, fields.releaseRing, fields.streamEnd],
    doubles: [
      fields.firstDeltaMs ?? -1,
      fields.firstPreviewMs ?? -1,
      fields.firstCheckpointMs ?? -1,
      fields.deltaCount,
      fields.deltaCharacters,
    ],
  });

/** Safe, versioned terminal classification only; provider prose is forbidden. */
export const recordHermesTerminalFailure = (
  env: Env,
  workspaceId: string,
  fields: {
    runId: string;
    releaseRing: 'canary' | 'stable';
    code: string;
    source: string;
    structured: boolean;
    retryable: boolean;
    workedMs: number;
    partialCharacters: number;
  },
): boolean =>
  writePoint(env, 'hermes.terminal_failure', workspaceId, {
    blobs: [fields.runId, fields.releaseRing, fields.code, fields.source, fields.structured ? 'structured' : 'contract_violation'],
    doubles: [fields.retryable ? 1 : 0, fields.workedMs, fields.partialCharacters],
  });
