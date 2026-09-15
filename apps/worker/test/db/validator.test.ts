// The nightly validator, over a seeded stream.
//
// Two checks, and the second one is the one that matters. The run-log validator
// asks whether the events we served are a sequence the state machine can
// produce; the human-only-decisions query asks whether a human decided every
// decision, which is the property the entire product rests on.
//
// The forged row is inserted **as `owner`**, and that is the point of the test.
// No role the product runs as can write it: `app` can only insert a decision
// through the guarded route, and `agent` holds no INSERT on `decisions` at all
// (test/db/grants.test.ts). So the only way to prove the query would catch a
// breach is to commit one by hand from outside the product, which is exactly
// what a breach would look like.
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../src/env.js';
import {
  closeValidatorRun,
  humanOnlyDecisions,
  lastValidatorRun,
  openValidatorRun,
  validateRunLogPage,
} from '../../src/ops/validator.js';
import { runNightlyValidator, type ValidatorStep } from '../../src/workflows-long/nightly-validator.js';
import { makeEnv } from './harness.js';
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

/**
 * A run and the stream it produced.
 *
 * The payloads are the real ones, not sketches: the validator parses every row
 * against the shared contract before it looks at the sequence, so a test that
 * seeded a convenient shape would be testing the schema check and nothing else.
 */
type StreamRow = { kind: string; payload: Record<string, unknown> };

async function seedRun(f: Fixture, status: string, build: (runId: string) => StreamRow[]): Promise<string> {
  const runId = randomUUID();
  const events = build(runId);
  await asTenant(f, async (c) => {
    await c.query(
      `INSERT INTO runs (id, workspace_id, session_id, status, model_id, attempt, engine_version, client_turn_id)
       VALUES ($1, $2, $3, $4, 'deepseek-flash', 1, 1, $5)`,
      [runId, f.workspaceId, f.sessionId, status, randomUUID()],
    );
    for (const event of events) {
      await c.query(
        `INSERT INTO stream_events (workspace_id, session_id, kind, payload, trace_id)
         VALUES ($1, $2, $3, $4::jsonb, $5)`,
        [f.workspaceId, f.sessionId, event.kind, JSON.stringify(event.payload), randomUUID()],
      );
    }
  });
  return runId;
}

const started = (runId: string, sessionId: string): StreamRow => ({
  kind: 'run.started',
  payload: {
    run_id: runId,
    session_id: sessionId,
    attempt: 1,
    engine_version: 1,
    client_turn_id: 'ct-1',
    mode: 'work',
    model_id: 'deepseek-flash',
    effort: 'high',
    title: null,
    steps: [],
  },
});

const appended = (runId: string, sessionId: string, messageId: string): StreamRow => ({
  kind: 'message.appended',
  payload: {
    message_id: messageId,
    session_id: sessionId,
    seq: 1,
    role: 'iris',
    kind: null,
    text: '',
    blocks: [],
    status: 'streaming',
    run_id: runId,
  },
});

const delta = (runId: string, messageId: string, seq: number, text: string): StreamRow => ({
  kind: 'message.delta',
  payload: { message_id: messageId, run_id: runId, turn: 1, attempt: 1, step_attempt: 1, seq, delta: text },
});

const final = (runId: string, sessionId: string, messageId: string, text: string): StreamRow => ({
  kind: 'message.final',
  payload: { message_id: messageId, session_id: sessionId, run_id: runId, turn: 1, attempt: 1, text, blocks: [] },
});

const finished = (runId: string): StreamRow => ({
  kind: 'run.status',
  payload: { run_id: runId, attempt: 1, status: 'completed' },
});

/** Started, one delta, one final, completed. */
function cleanStream(sessionId: string): (runId: string) => StreamRow[] {
  return (runId) => {
    const messageId = randomUUID();
    return [
      started(runId, sessionId),
      appended(runId, sessionId, messageId),
      delta(runId, messageId, 0, 'hello'),
      final(runId, sessionId, messageId, 'hello'),
      finished(runId),
    ];
  };
}

const step: ValidatorStep = { do: <T>(_name: string, fn: () => Promise<T>) => fn() };

beforeAll(async () => {
  fx = await seedWorkspace();
});

describe('the run-log validator over stream_events', () => {
  it('passes a well-formed run', async () => {
    const local = await seedWorkspace();
    await seedRun(local, 'completed', cleanStream(local.sessionId));
    const page = await asTenant(local, (c) => validateRunLogPage(c, local.workspaceId, null));
    expect(page.runsChecked).toBe(1);
    expect(page.violations).toEqual([]);
  });

  it('catches a delta after the final, which the state machine cannot produce', async () => {
    const local = await seedWorkspace();
    const messageId = randomUUID();
    const runId = await seedRun(local, 'completed', (id) => [
      started(id, local.sessionId),
      appended(id, local.sessionId, messageId),
      final(id, local.sessionId, messageId, 'done'),
      delta(id, messageId, 1, 'more'),
    ]);
    const page = await asTenant(local, (c) => validateRunLogPage(c, local.workspaceId, null));
    expect(page.violations.length).toBeGreaterThan(0);
    expect(page.violations[0]?.run_id).toBe(runId);
    expect(page.violations.map((v) => v.rule)).toContain('delta_after_final');
  });

  it('pages, and stops when a page is short', async () => {
    const local = await seedWorkspace();
    for (let i = 0; i < 3; i += 1) await seedRun(local, 'completed', cleanStream(local.sessionId));

    const first = await asTenant(local, (c) => validateRunLogPage(c, local.workspaceId, null, 2));
    expect(first.runsChecked).toBe(2);
    expect(first.cursor).not.toBeNull();

    const second = await asTenant(local, (c) => validateRunLogPage(c, local.workspaceId, first.cursor, 2));
    expect(second.runsChecked).toBe(1);
    // A short page is the last page: the cursor is null and the caller stops.
    expect(second.cursor).toBeNull();
  });

  it('does not demand a final from a run that is still working', async () => {
    const local = await seedWorkspace();
    const messageId = randomUUID();
    await seedRun(local, 'working', (id) => [
      started(id, local.sessionId),
      appended(id, local.sessionId, messageId),
      delta(id, messageId, 0, 'thinking'),
    ]);
    const page = await asTenant(local, (c) => validateRunLogPage(c, local.workspaceId, null));
    expect(page.violations).toEqual([]);
  });
});

describe('the daily human-only-decisions query', () => {
  it('passes on a clean database', async () => {
    const local = await seedWorkspace();
    const requestId = randomUUID();
    await asTenant(local, async (c) => {
      await c.query(
        `INSERT INTO requests (id, workspace_id, kind, label, payload, session_id)
         VALUES ($1, $2, 'application', 'Leah Martinez', '{"kind":"application"}'::jsonb, $3)`,
        [requestId, local.workspaceId, local.sessionId],
      );
      await c.query(
        `INSERT INTO decisions (workspace_id, request_id, decision, resulting_status, decided_by)
         VALUES ($1, $2, 'approve', 'approved', $3)`,
        [local.workspaceId, requestId, local.adminId],
      );
    });

    const result = await asTenant(local, (c) => humanOnlyDecisions(c, local.workspaceId));
    expect(result.decisionsChecked).toBe(1);
    expect(result.nonHumanDecisions).toEqual([]);
    expect(result.agentDecisionEvents).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fails on a decision attributed to somebody who is not a member', async () => {
    const local = await seedWorkspace();
    const requestId = randomUUID();
    // A real user, but not a member of this workspace — the shape a migration
    // bug or a restored-out-of-order database would produce.
    const outsider = await seedWorkspace();

    await asTenant(local, async (c) => {
      await c.query(
        `INSERT INTO requests (id, workspace_id, kind, label, payload, session_id)
         VALUES ($1, $2, 'application', 'Leah Martinez', '{"kind":"application"}'::jsonb, $3)`,
        [requestId, local.workspaceId, local.sessionId],
      );
      // Inserted as `owner`, by hand. No role the product runs as can write
      // this row: `app` only reaches `decisions` through the guarded route, and
      // `agent` holds no INSERT on the table at all.
      await c.query(
        `INSERT INTO decisions (workspace_id, request_id, decision, resulting_status, decided_by)
         VALUES ($1, $2, 'approve', 'approved', $3)`,
        [local.workspaceId, requestId, outsider.adminId],
      );
    });

    const result = await asTenant(local, (c) => humanOnlyDecisions(c, local.workspaceId));
    expect(result.ok).toBe(false);
    expect(result.nonHumanDecisions).toHaveLength(1);
    expect(result.nonHumanDecisions[0]?.reason).toContain('not a member');
  });

  it('fails on an audit row the agent wrote claiming a decision', async () => {
    const local = await seedWorkspace();
    await asTenant(local, (c) =>
      // Forged as `owner`. The `agent` role has no INSERT on `events` (the
      // grant assertion pins that), so this row could only come from outside
      // the product — which is precisely the breach the query exists to name.
      c.query(`INSERT INTO events (workspace_id, actor_type, kind) VALUES ($1, 'agent', 'decision.recorded')`, [
        local.workspaceId,
      ]),
    );

    const result = await asTenant(local, (c) => humanOnlyDecisions(c, local.workspaceId));
    expect(result.ok).toBe(false);
    expect(result.agentDecisionEvents).toHaveLength(1);
    expect(result.agentDecisionEvents[0]?.kind).toBe('decision.recorded');
    // The two findings are reported separately, because they have different
    // remediations and conflating them lets the serious one hide in the count.
    expect(result.nonHumanDecisions).toEqual([]);
  });
});

describe('the NightlyValidator Workflow body', () => {
  it('opens a summary row before it starts, so a night that dies leaves evidence', async () => {
    const id = await withClient('app', async (c) => {
      await c.query('BEGIN');
      const value = await openValidatorRun(c);
      await c.query('COMMIT');
      return value;
    });
    const row = await withClient('app', (c) =>
      c.query<{ finished_at: Date | null; ok: boolean }>(
        `SELECT finished_at, ok FROM validator_runs WHERE id = $1`,
        [id],
      ),
    );
    // Open: `finished_at` is null, which is the signal "the validator stopped
    // running" that a success-only record could never give.
    expect(row.rows[0]?.finished_at).toBeNull();

    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await closeValidatorRun(c, id, {
        workspaces: 1,
        runsChecked: 2,
        violations: 0,
        decisionsChecked: 1,
        forgedDecisions: 0,
        ok: true,
        detail: { runs: [], decisions: [] },
      });
      await c.query('COMMIT');
    });

    const closed = await withClient('app', (c) =>
      c.query<{ finished_at: Date | null; ok: boolean }>(
        `SELECT finished_at, ok FROM validator_runs WHERE id = $1`,
        [id],
      ),
    );
    expect(closed.rows[0]?.finished_at).not.toBeNull();
    expect(closed.rows[0]?.ok).toBe(true);
  });

  it('runs both checks over the workspaces it is given, and records the summary', async () => {
    const clean = await seedWorkspace();
    await seedRun(clean, 'completed', cleanStream(clean.sessionId));
    const { env } = makeEnv();

    const summary = await runNightlyValidator(env as Env, step, {
      listWorkspaces: () => Promise.resolve([clean.workspaceId]),
    });

    expect(summary.workspaces).toBe(1);
    expect(summary.runsChecked).toBe(1);
    expect(summary.violations).toBe(0);
    expect(summary.forgedDecisions).toBe(0);
    expect(summary.ok).toBe(true);

    const last = await withClient('app', async (c) => {
      await c.query('BEGIN');
      const row = await lastValidatorRun(c);
      await c.query('COMMIT');
      return row;
    });
    expect(last?.ok).toBe(true);
    expect(last?.finished_at).not.toBeNull();
  });

  it('goes red and writes an audit row when a decision has no human behind it', async () => {
    const local = await seedWorkspace();
    await asTenant(local, (c) =>
      c.query(`INSERT INTO events (workspace_id, actor_type, kind) VALUES ($1, 'agent', 'effect.executed')`, [
        local.workspaceId,
      ]),
    );
    const { env } = makeEnv();

    const summary = await runNightlyValidator(env as Env, step, {
      listWorkspaces: () => Promise.resolve([local.workspaceId]),
    });
    expect(summary.ok).toBe(false);
    expect(summary.forgedDecisions).toBe(1);

    const alert = await asTenant(local, (c) =>
      c.query<{ kind: string }>(`SELECT kind FROM events WHERE workspace_id = $1 AND kind = 'validator.failed'`, [
        local.workspaceId,
      ]),
    );
    // In the Admin's own History, not only in our logs.
    expect(alert.rows).toHaveLength(1);
  });

  it('carries ids and counts in the summary detail, never free text', async () => {
    const local = await seedWorkspace();
    const messageId = randomUUID();
    await seedRun(local, 'completed', (id) => [
      started(id, local.sessionId),
      appended(id, local.sessionId, messageId),
      final(id, local.sessionId, messageId, 'Leah Martinez was approved'),
      delta(id, messageId, 1, 'Leah Martinez'),
    ]);
    const { env } = makeEnv();

    await runNightlyValidator(env as Env, step, {
      listWorkspaces: () => Promise.resolve([local.workspaceId]),
    });

    const row = await withClient('app', (c) =>
      c.query<{ detail: Record<string, unknown>; violations: number }>(
        `SELECT detail, violations FROM validator_runs ORDER BY started_at DESC LIMIT 1`,
      ),
    );
    expect(row.rows[0]?.violations).toBeGreaterThan(0);
    const detail = JSON.stringify(row.rows[0]?.detail ?? {});
    // The offending run is named by id. The applicant's name, which the
    // validator definitely read on its way past, is not in the summary.
    expect(detail).not.toContain('Leah Martinez');
    expect(detail).toContain('runs');
  });
});
