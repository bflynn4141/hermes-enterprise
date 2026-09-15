// What this workspace spent, read out of `model_calls`.
//
// One table, three groupings, and a word that appears on every one of them:
// *estimated*. `model_calls.cost_usd_estimate` is our arithmetic over the
// catalog's published prices at the time of the call; the invoice comes from
// the provider, against the customer's own key, and the two will differ —
// cached-token discounts, promotional pricing, a price change we have not
// re-verified, rounding. A usage screen that said "$4.12" without saying whose
// number that is would be a usage screen someone eventually brings to a billing
// dispute. So the copy is fixed here, in the server, and shipped with the
// numbers rather than written into the client, because a client that forgot it
// would be a client that quietly made a claim we cannot stand behind.
//
// "Today" and every other day boundary is the workspace's own timezone
// (`workspace_settings.timezone`), for the same reason the daily token cap uses
// it: a day that turns over at a time the Admin does not live in is a day they
// cannot reconcile against anything.
import type { Tx } from '../db/client.js';
import { checkCaps } from '../model/usage.js';

/** The sentence every usage number is shipped with. Asserted by a test. */
export const ESTIMATE_DISCLAIMER =
  'Estimated, billed by your provider. These figures are our arithmetic over published prices; ' +
  'your provider invoices your own key and is the authority.';

export type UsageRange = '7d' | '30d' | '90d' | 'today';

export const USAGE_RANGES: readonly UsageRange[] = ['today', '7d', '30d', '90d'];

/** Days of history a range asks for. `today` is the current tenant day. */
const RANGE_DAYS: Record<UsageRange, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90 };

export function parseRange(value: string | undefined | null): UsageRange {
  const candidate = (value ?? '30d').trim();
  return (USAGE_RANGES as readonly string[]).includes(candidate) ? (candidate as UsageRange) : '30d';
}

export interface UsageDay {
  /** `YYYY-MM-DD` in the workspace's timezone. */
  readonly day: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens: number;
  readonly reasoning_tokens: number;
  readonly total_tokens: number;
  readonly cost_usd_estimate: number;
  readonly calls: number;
  readonly errors: number;
}

export interface UsageBySession {
  readonly session_id: string | null;
  readonly title: string | null;
  readonly runs: number;
  readonly total_tokens: number;
  readonly cost_usd_estimate: number;
  readonly last_call_at: string | null;
}

export interface UsageByKey {
  readonly key_id: string | null;
  readonly provider: string | null;
  readonly label: string | null;
  readonly last4: string | null;
  readonly status: string | null;
  readonly total_tokens: number;
  readonly cost_usd_estimate: number;
  readonly calls: number;
}

export interface UsageReport {
  readonly range: UsageRange;
  readonly timezone: string;
  readonly from: string;
  readonly to: string;
  readonly disclaimer: string;
  readonly totals: {
    readonly input_tokens: number;
    readonly output_tokens: number;
    readonly cached_input_tokens: number;
    readonly reasoning_tokens: number;
    readonly total_tokens: number;
    readonly cost_usd_estimate: number;
    readonly calls: number;
    readonly errors: number;
  };
  readonly by_day: readonly UsageDay[];
  readonly by_session: readonly UsageBySession[];
  readonly by_key: readonly UsageByKey[];
  readonly caps: {
    readonly daily_token_cap: number | null;
    readonly tokens_today: number;
    readonly fraction_used: number | null;
    readonly warn: boolean;
    readonly max_concurrent_runs: number;
    readonly active_runs: number;
  };
}

const int = (value: string | number | null | undefined): number => Number(value ?? 0) || 0;
/** Money is summed in the database as numeric; six decimals is the column. */
const money = (value: string | number | null | undefined): number =>
  Math.round((Number(value ?? 0) || 0) * 1e6) / 1e6;

/** The workspace's timezone, defaulted the same way `checkCaps` defaults it. */
async function timezoneOf(tx: Tx, workspaceId: string): Promise<string> {
  const { rows } = await tx.query<{ tz: string }>(
    `SELECT COALESCE(timezone, 'UTC') AS tz FROM workspace_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  return rows[0]?.tz ?? 'UTC';
}

/**
 * Per day, per session and per key over one range.
 *
 * Three queries rather than one with three grouping sets: they return different
 * shapes, they join different tables, and a single clever query would be the
 * kind of SQL that is rewritten from scratch the first time someone has to
 * change one of the three.
 *
 * Every one of them is filtered on `workspace_id` as well as running inside the
 * tenant transaction. That is belt and braces on purpose: the policy is the
 * thing that makes it safe, and the predicate is the thing that makes it
 * obvious to the next reader which rows this is meant to touch.
 */
export async function usageReport(tx: Tx, workspaceId: string, range: UsageRange): Promise<UsageReport> {
  const tz = await timezoneOf(tx, workspaceId);
  // The caps ride along with the usage rather than sitting on a second route:
  // "what have I spent" and "what am I allowed to spend" are one question, and
  // two routes would let a client render a number beside a stale limit.
  const caps = await checkCaps(tx, workspaceId);
  const days = RANGE_DAYS[range];

  // The window, expressed once and reused: the start of the tenant day
  // `days - 1` days ago, in the tenant's timezone, converted back to an
  // absolute instant for the index scan on (workspace_id, created_at).
  const windowSql = `(date_trunc('day', now() AT TIME ZONE $2) - make_interval(days => $3::int - 1)) AT TIME ZONE $2`;

  const byDay = await tx.query<{
    day: string;
    input_tokens: string;
    output_tokens: string;
    cached_input_tokens: string;
    reasoning_tokens: string;
    cost: string;
    calls: string;
    errors: string;
  }>(
    `SELECT to_char(date_trunc('day', m.created_at AT TIME ZONE $2), 'YYYY-MM-DD') AS day,
            sum(m.input_tokens)::text         AS input_tokens,
            sum(m.output_tokens)::text        AS output_tokens,
            sum(m.cached_input_tokens)::text  AS cached_input_tokens,
            sum(m.reasoning_tokens)::text     AS reasoning_tokens,
            sum(m.cost_usd_estimate)::text    AS cost,
            count(*)::text                    AS calls,
            count(*) FILTER (WHERE m.status = 'error')::text AS errors
       FROM model_calls m
      WHERE m.workspace_id = $1 AND m.created_at >= ${windowSql}
      GROUP BY 1
      ORDER BY 1`,
    [workspaceId, tz, days],
  );

  const bySession = await tx.query<{
    session_id: string | null;
    title: string | null;
    runs: string;
    total_tokens: string;
    cost: string;
    last_call_at: Date | null;
  }>(
    // Through `runs`, because a model call knows its run and a run knows its
    // session. A call with no run (there are none today, and the column is
    // nullable) groups under a null session rather than disappearing, so the
    // per-session figures always add up to the totals.
    `SELECT r.session_id,
            s.title,
            count(DISTINCT m.run_id)::text                  AS runs,
            sum(m.input_tokens + m.output_tokens)::text     AS total_tokens,
            sum(m.cost_usd_estimate)::text                  AS cost,
            max(m.created_at)                               AS last_call_at
       FROM model_calls m
       LEFT JOIN runs r ON r.id = m.run_id AND r.workspace_id = m.workspace_id
       LEFT JOIN sessions s ON s.id = r.session_id AND s.workspace_id = m.workspace_id
      WHERE m.workspace_id = $1 AND m.created_at >= ${windowSql}
      GROUP BY r.session_id, s.title
      ORDER BY sum(m.cost_usd_estimate) DESC, sum(m.input_tokens + m.output_tokens) DESC
      LIMIT 100`,
    [workspaceId, tz, days],
  );

  const byKey = await tx.query<{
    key_id: string | null;
    provider: string | null;
    label: string | null;
    last4: string | null;
    status: string | null;
    total_tokens: string;
    cost: string;
    calls: string;
  }>(
    // `last4` and the fingerprint-free columns only. The key row is joined for
    // its label, never for its material, and a deleted key still shows its
    // spend under a null label rather than vanishing from the total.
    `SELECT m.key_id,
            COALESCE(k.provider, m.provider) AS provider,
            k.label,
            k.last4,
            k.status,
            sum(m.input_tokens + m.output_tokens)::text AS total_tokens,
            sum(m.cost_usd_estimate)::text              AS cost,
            count(*)::text                              AS calls
       FROM model_calls m
       LEFT JOIN workspace_provider_keys k
              ON k.id = m.key_id AND k.workspace_id = m.workspace_id
      WHERE m.workspace_id = $1 AND m.created_at >= ${windowSql}
      GROUP BY m.key_id, COALESCE(k.provider, m.provider), k.label, k.last4, k.status
      ORDER BY sum(m.cost_usd_estimate) DESC`,
    [workspaceId, tz, days],
  );

  // Its own parameter numbering, because this one has no workspace id in it
  // and Postgres refuses a statement whose $1 is never referenced.
  const bounds = await tx.query<{ from_at: Date; to_at: Date }>(
    `SELECT (date_trunc('day', now() AT TIME ZONE $1) - make_interval(days => $2::int - 1)) AT TIME ZONE $1
              AS from_at,
            now() AS to_at`,
    [tz, days],
  );

  const daysOut: UsageDay[] = byDay.rows.map((row) => ({
    day: row.day,
    input_tokens: int(row.input_tokens),
    output_tokens: int(row.output_tokens),
    cached_input_tokens: int(row.cached_input_tokens),
    reasoning_tokens: int(row.reasoning_tokens),
    total_tokens: int(row.input_tokens) + int(row.output_tokens),
    cost_usd_estimate: money(row.cost),
    calls: int(row.calls),
    errors: int(row.errors),
  }));

  const totals = daysOut.reduce(
    (acc, day) => ({
      input_tokens: acc.input_tokens + day.input_tokens,
      output_tokens: acc.output_tokens + day.output_tokens,
      cached_input_tokens: acc.cached_input_tokens + day.cached_input_tokens,
      reasoning_tokens: acc.reasoning_tokens + day.reasoning_tokens,
      total_tokens: acc.total_tokens + day.total_tokens,
      cost_usd_estimate: money(acc.cost_usd_estimate + day.cost_usd_estimate),
      calls: acc.calls + day.calls,
      errors: acc.errors + day.errors,
    }),
    {
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      reasoning_tokens: 0,
      total_tokens: 0,
      cost_usd_estimate: 0,
      calls: 0,
      errors: 0,
    },
  );

  return {
    range,
    timezone: tz,
    from: (bounds.rows[0]?.from_at ?? new Date()).toISOString(),
    to: (bounds.rows[0]?.to_at ?? new Date()).toISOString(),
    disclaimer: ESTIMATE_DISCLAIMER,
    totals,
    by_day: daysOut,
    by_session: bySession.rows.map((row) => ({
      session_id: row.session_id,
      title: row.title,
      runs: int(row.runs),
      total_tokens: int(row.total_tokens),
      cost_usd_estimate: money(row.cost),
      last_call_at: row.last_call_at ? row.last_call_at.toISOString() : null,
    })),
    by_key: byKey.rows.map((row) => ({
      key_id: row.key_id,
      provider: row.provider,
      label: row.label,
      last4: row.last4,
      status: row.status,
      total_tokens: int(row.total_tokens),
      cost_usd_estimate: money(row.cost),
      calls: int(row.calls),
    })),
    caps: {
      daily_token_cap: caps.dailyTokenCap,
      tokens_today: caps.tokensToday,
      fraction_used:
        caps.dailyTokenCap === null || caps.dailyTokenCap === 0
          ? null
          : Math.round((caps.tokensToday / caps.dailyTokenCap) * 1000) / 1000,
      warn: caps.warn,
      max_concurrent_runs: caps.maxConcurrentRuns,
      active_runs: caps.activeRuns,
    },
  };
}
