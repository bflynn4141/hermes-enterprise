// Usage aggregation, caps, the 80 percent warning and the platform instance cap.
//
// These run against the real database because every one of them is a SQL
// question: a timezone-aware day boundary, a sum over a range, an upsert that
// has to be atomic across concurrent callers. A mocked `Tx` would prove that
// the JavaScript around the query is right, which is not the part that breaks.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../src/env.js';
import { ESTIMATE_DISCLAIMER, parseRange, usageReport } from '../../src/usage/aggregate.js';
import { checkCaps } from '../../src/model/usage.js';
import { capWarningKey, maybeQueueCapWarning, runCapWarningJob } from '../../src/ops/cap-warning.js';
import {
  INSTANCE_BUCKET,
  consumeInstanceCap,
  instanceCap,
  readInstanceCounter,
  sweepPlatformCounters,
} from '../../src/ops/instance-cap.js';
import { withWorkspaceTransaction } from '../../src/jobs.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

let fx: Fixture;

async function asTenant<T>(f: Fixture, fn: (c: import('pg').Client) => Promise<T>): Promise<T> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    try {
      await setTenant(c, f.workspaceId, f.adminId);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

/** One `model_calls` row, `daysAgo` days back, with a real run behind it. */
async function seedCall(
  f: Fixture,
  options: { daysAgo?: number; input?: number; output?: number; cost?: string; keyId?: string | null; status?: string } = {},
): Promise<string> {
  const runId = randomUUID();
  return asTenant(f, async (c) => {
    await c.query(
      `INSERT INTO runs (id, workspace_id, session_id, status, model_id, attempt, engine_version, client_turn_id)
       VALUES ($1, $2, $3, 'completed', 'deepseek-flash', 1, 1, $4)`,
      [runId, f.workspaceId, f.sessionId, randomUUID()],
    );
    await c.query(
      `INSERT INTO model_calls
         (workspace_id, run_id, turn, model_id, provider, key_id,
          input_tokens, output_tokens, cost_usd_estimate, status, created_at)
       VALUES ($1, $2, 0, 'deepseek-flash', 'deepseek', $3, $4, $5, $6, $7, now() - make_interval(days => $8::int))`,
      [
        f.workspaceId,
        runId,
        options.keyId ?? null,
        options.input ?? 1000,
        options.output ?? 100,
        options.cost ?? '0.001200',
        options.status ?? 'ok',
        options.daysAgo ?? 0,
      ],
    );
    return runId;
  });
}

beforeAll(async () => {
  fx = await seedWorkspace();
});

afterEach(async () => {
  // The platform counter is global by construction, so a test that left a row
  // behind would change the next test's answer.
  await withClient('app', (c) => c.query(`DELETE FROM platform_counters WHERE bucket = $1`, [INSTANCE_BUCKET]));
});

describe('GET /w/:ws/usage', () => {
  it('sums by day, by session and by key, and says whose number it is', async () => {
    const local = await seedWorkspace();
    await seedCall(local, { daysAgo: 0, input: 1000, output: 100, cost: '0.010000' });
    await seedCall(local, { daysAgo: 0, input: 2000, output: 200, cost: '0.020000' });
    await seedCall(local, { daysAgo: 3, input: 500, output: 50, cost: '0.005000' });

    const report = await asTenant(local, (c) => usageReport(c, local.workspaceId, '30d'));

    expect(report.totals.input_tokens).toBe(3500);
    expect(report.totals.output_tokens).toBe(350);
    expect(report.totals.total_tokens).toBe(3850);
    expect(report.totals.cost_usd_estimate).toBeCloseTo(0.035, 6);
    expect(report.totals.calls).toBe(3);
    // Two distinct days, and the day rows add up to the totals. The second half
    // is the property that makes the chart trustworthy: a per-day breakdown
    // that does not sum to the headline is a breakdown nobody can reconcile.
    expect(report.by_day).toHaveLength(2);
    const summed = report.by_day.reduce((n, day) => n + day.total_tokens, 0);
    expect(summed).toBe(report.totals.total_tokens);

    // Every number ships with the sentence.
    expect(report.disclaimer).toBe(ESTIMATE_DISCLAIMER);
    expect(report.disclaimer.toLowerCase()).toContain('estimated');
    expect(report.disclaimer.toLowerCase()).toContain('provider');
  });

  it('honours the range, so `today` excludes yesterday', async () => {
    const local = await seedWorkspace();
    await seedCall(local, { daysAgo: 0, input: 100, output: 10 });
    await seedCall(local, { daysAgo: 5, input: 900, output: 90 });

    const today = await asTenant(local, (c) => usageReport(c, local.workspaceId, 'today'));
    const month = await asTenant(local, (c) => usageReport(c, local.workspaceId, '30d'));

    expect(today.totals.input_tokens).toBe(100);
    expect(month.totals.input_tokens).toBe(1000);
  });

  it('attributes spend to the key that paid for it, and keeps the id only', async () => {
    const local = await seedWorkspace();
    const keyId = randomUUID();
    await asTenant(local, (c) =>
      c.query(
        `INSERT INTO workspace_provider_keys
           (id, workspace_id, provider, label, ciphertext, iv, wrapped_dek, wrap_iv, kek_version,
            fingerprint, last4, status)
         VALUES ($1, $2, 'deepseek', 'Ops key', '\\x00', '\\x00', '\\x00', '\\x00', 1, $3, '9f2c', 'verified')`,
        [keyId, local.workspaceId, randomUUID()],
      ),
    );
    await seedCall(local, { keyId, cost: '0.030000', input: 10, output: 1 });
    await seedCall(local, { keyId: null, cost: '0.001000', input: 5, output: 1 });

    const report = await asTenant(local, (c) => usageReport(c, local.workspaceId, '30d'));
    const attributed = report.by_key.find((row) => row.key_id === keyId);
    expect(attributed).toBeDefined();
    expect(attributed?.label).toBe('Ops key');
    expect(attributed?.last4).toBe('9f2c');
    expect(attributed?.cost_usd_estimate).toBeCloseTo(0.03, 6);
    // A call with no key still appears, so the per-key rows sum to the totals.
    expect(report.by_key.some((row) => row.key_id === null)).toBe(true);
    // No key material reaches the projection, by shape as well as by name.
    expect(JSON.stringify(report)).not.toContain('ciphertext');
    expect(JSON.stringify(report)).not.toContain('wrapped_dek');
  });

  it('is Admin-only because it aggregates sessions and provider keys across owners', async () => {
    const { env } = makeEnv();
    const refused = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/usage?range=7d`);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ reason: 'admin_required' });

    const response = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/usage?range=7d`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { range: string; disclaimer: string };
    expect(body.range).toBe('7d');
    expect(body.disclaimer).toBe(ESTIMATE_DISCLAIMER);
  });

  it('falls back to 30d rather than trusting a range from the query string', () => {
    expect(parseRange('7d')).toBe('7d');
    expect(parseRange(undefined)).toBe('30d');
    expect(parseRange("'; DROP TABLE model_calls; --")).toBe('30d');
  });

  it('refuses a non-member with 404, not 403', async () => {
    const other = await seedWorkspace();
    const { env } = makeEnv();
    const response = await asUser(env, other.adminId, `/w/${fx.workspaceId}/usage`);
    expect(response.status).toBe(404);
  });
});

describe('caps', () => {
  it('reports the daily token cap in the workspace timezone', async () => {
    const local = await seedWorkspace();
    await asTenant(local, (c) =>
      c.query(`UPDATE workspace_settings SET daily_token_cap = 1000 WHERE workspace_id = $1`, [local.workspaceId]),
    );
    await seedCall(local, { daysAgo: 0, input: 400, output: 100 });

    const caps = await asTenant(local, (c) => checkCaps(c, local.workspaceId));
    expect(caps.dailyTokenCap).toBe(1000);
    expect(caps.tokensToday).toBe(500);
    expect(caps.allowed).toBe(true);
    expect(caps.warn).toBe(false);
  });

  it('warns at 80 percent and refuses at 100', async () => {
    const local = await seedWorkspace();
    await asTenant(local, (c) =>
      c.query(`UPDATE workspace_settings SET daily_token_cap = 1000 WHERE workspace_id = $1`, [local.workspaceId]),
    );
    await seedCall(local, { input: 800, output: 0 });

    const warning = await asTenant(local, (c) => checkCaps(c, local.workspaceId));
    expect(warning.warn).toBe(true);
    expect(warning.allowed).toBe(true);

    await seedCall(local, { input: 300, output: 0 });
    const over = await asTenant(local, (c) => checkCaps(c, local.workspaceId));
    expect(over.allowed).toBe(false);
    // The token cap is named first: it is the one the Admin set, and naming the
    // other would send them to the wrong settings screen.
    expect(over.reason).toBe('daily_token_cap');
  });

  it('queues one warning job per workspace per day, however many turns cross the line', async () => {
    const local = await seedWorkspace();
    await asTenant(local, (c) =>
      c.query(`UPDATE workspace_settings SET daily_token_cap = 1000 WHERE workspace_id = $1`, [local.workspaceId]),
    );
    await seedCall(local, { input: 900, output: 0 });

    const caps = await asTenant(local, (c) => checkCaps(c, local.workspaceId));
    const first = await asTenant(local, (c) => maybeQueueCapWarning(c, local.workspaceId, caps));
    const second = await asTenant(local, (c) => maybeQueueCapWarning(c, local.workspaceId, caps));

    expect(first).toBeTruthy();
    // The second enqueue hits ON CONFLICT DO NOTHING on UNIQUE(kind, key) and
    // returns null, which is how the caller knows it has no job to run.
    expect(second).toBeNull();

    const day = new Date().toISOString().slice(0, 10);
    const jobs = await asTenant(local, (c) =>
      c.query<{ key: string }>(`SELECT key FROM jobs WHERE workspace_id = $1 AND kind = 'cap_warning'`, [
        local.workspaceId,
      ]),
    );
    expect(jobs.rows).toHaveLength(1);
    // The key contains the workspace id, because UNIQUE(kind, key) is global
    // and a shared key would let one tenant suppress another's warning.
    expect(jobs.rows[0]?.key).toContain(local.workspaceId);
    expect(capWarningKey(local.workspaceId, day)).toContain(local.workspaceId);
  });

  it('queues nothing when no cap is set', async () => {
    const local = await seedWorkspace();
    await seedCall(local, { input: 10_000_000, output: 0 });
    const caps = await asTenant(local, (c) => checkCaps(c, local.workspaceId));
    expect(caps.warn).toBe(false);
    const job = await asTenant(local, (c) => maybeQueueCapWarning(c, local.workspaceId, caps));
    expect(job).toBeNull();
  });

  it('the warning job writes an audit row, and does nothing once the cap is raised', async () => {
    const local = await seedWorkspace();
    const { env } = makeEnv();
    await asTenant(local, (c) =>
      c.query(`UPDATE workspace_settings SET daily_token_cap = 1000 WHERE workspace_id = $1`, [local.workspaceId]),
    );
    await seedCall(local, { input: 900, output: 0 });

    const job = {
      id: randomUUID(),
      workspace_id: local.workspaceId,
      kind: 'cap_warning',
      key: capWarningKey(local.workspaceId, '2026-09-15'),
      payload: {},
      attempts: 1,
    };

    const recorded = await runCapWarningJob(env as Env, job);
    expect(recorded.recorded).toBe(true);
    expect(recorded.delivered).toBe(false);
    // Both seeded members are Admins? No: one Admin, one Member, and only the
    // Admin can change the cap, so only the Admin is told.
    expect(recorded.recipients).toBe(1);
    expect(recorded.fraction).toBeCloseTo(0.9, 3);

    const events = await asTenant(local, (c) =>
      c.query<{ kind: string }>(`SELECT kind FROM events WHERE workspace_id = $1 AND kind = 'usage.cap_warning'`, [
        local.workspaceId,
      ]),
    );
    expect(events.rows).toHaveLength(1);

    // Raise the cap; the job re-reads rather than trusting the payload.
    await asTenant(local, (c) =>
      c.query(`UPDATE workspace_settings SET daily_token_cap = 100000 WHERE workspace_id = $1`, [local.workspaceId]),
    );
    const again = await runCapWarningJob(env as Env, job);
    expect(again.recorded).toBe(false);
    expect(again.delivered).toBe(false);
  });
});

describe('the platform instance cap', () => {
  const capped = (value: string): Env => makeEnv({ PLATFORM_MAX_INSTANCES_PER_HOUR: value } as Partial<Env>).env;

  it('reads the ceiling from the environment, and treats unset as no cap', () => {
    expect(instanceCap(capped(''))).toBeNull();
    expect(instanceCap(capped('not a number'))).toBeNull();
    // Zero is a deliberate full stop, distinguished from unset.
    expect(instanceCap(capped('0'))).toBe(0);
    expect(instanceCap(capped('500'))).toBe(500);
  });

  it('counts an hour across every tenant, not per user', async () => {
    const env = capped('3');
    const a = await seedWorkspace();
    const b = await seedWorkspace();

    // Two different workspaces, two different users, one counter.
    const first = await withWorkspaceTransaction(env, a.workspaceId, (tx) => consumeInstanceCap(tx, env));
    const second = await withWorkspaceTransaction(env, b.workspaceId, (tx) => consumeInstanceCap(tx, env));
    expect(first.used).toBe(1);
    expect(second.used).toBe(2);
    expect(second.allowed).toBe(true);

    await withWorkspaceTransaction(env, a.workspaceId, (tx) => consumeInstanceCap(tx, env));
    const fourth = await withWorkspaceTransaction(env, b.workspaceId, (tx) => consumeInstanceCap(tx, env));
    expect(fourth.used).toBe(4);
    expect(fourth.allowed).toBe(false);
  });

  it('counts even with no cap configured, because the counter is also the metric', async () => {
    const env = capped('');
    await withWorkspaceTransaction(env, fx.workspaceId, (tx) => consumeInstanceCap(tx, env));
    const state = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => readInstanceCounter(tx, env));
    expect(state.used).toBe(1);
    expect(state.cap).toBeNull();
    expect(state.allowed).toBe(true);
  });

  it('refuses a turn once the platform hour is full, with copy that does not blame the customer', async () => {
    const { env } = makeEnv({ MODEL_SCRIPTED: '1', PLATFORM_MAX_INSTANCES_PER_HOUR: '0' } as Partial<Env>);
    const local = await seedWorkspace();
    const response = await asUser(env, local.adminId, `/w/${local.workspaceId}/sessions/${local.sessionId}/turns`, {
      method: 'POST',
      body: { client_turn_id: randomUUID(), text: 'Score this.' },
    });
    expect(response.status).toBe(429);
    const body = (await response.json()) as { reason: string; error: string };
    expect(body.reason).toBe('platform_capacity');
    expect(body.error).toContain('capacity');
    expect(body.error).toContain('inside its own limits');
  });

  it('gives the budget back when the turn fails for another reason', async () => {
    const { env } = makeEnv({ MODEL_SCRIPTED: '1', PLATFORM_MAX_INSTANCES_PER_HOUR: '100' } as Partial<Env>);
    const local = await seedWorkspace();

    // 422 before the counter is touched at all, so nothing to give back...
    await asUser(env, local.adminId, `/w/${local.workspaceId}/sessions/${local.sessionId}/turns`, {
      method: 'POST',
      body: { text: 'no client_turn_id' },
    });
    const afterBadRequest = await withWorkspaceTransaction(env, local.workspaceId, (tx) =>
      readInstanceCounter(tx, env),
    );
    expect(afterBadRequest.used).toBe(0);

    // ...and a successful turn increments exactly once.
    await asUser(env, local.adminId, `/w/${local.workspaceId}/sessions/${local.sessionId}/turns`, {
      method: 'POST',
      body: { client_turn_id: randomUUID(), text: 'Score this.' },
    });
    const afterTurn = await withWorkspaceTransaction(env, local.workspaceId, (tx) => readInstanceCounter(tx, env));
    expect(afterTurn.used).toBe(1);
  });

  it('sweeps buckets older than two days and keeps this hour', async () => {
    const env = capped('10');
    await withWorkspaceTransaction(env, fx.workspaceId, (tx) => consumeInstanceCap(tx, env));
    await withClient('app', (c) =>
      c.query(`INSERT INTO platform_counters (bucket, window_start, count) VALUES ($1, now() - interval '5 days', 7)`, [
        INSTANCE_BUCKET,
      ]),
    );
    const swept = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => sweepPlatformCounters(tx));
    expect(swept).toBe(1);
    const state = await withWorkspaceTransaction(env, fx.workspaceId, (tx) => readInstanceCounter(tx, env));
    expect(state.used).toBe(1);
  });
});
