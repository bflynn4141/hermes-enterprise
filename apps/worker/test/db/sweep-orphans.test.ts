// What the sweep does to the instance behind a run it declares dead.
//
// Security review O2: for the `engine_version_changed` and `no_progress`
// verdicts the sweep wrote `runs.status = 'error'` and stopped there. It did not
// set `stop_requested` — which is the only thing the live Workflow polls — and
// nothing called `terminate()`. So the instance kept going: more tools, more
// `requests` rows, and on completion a `setRunStatus(run.id, 'completed')` whose
// UPDATE had no status guard, silently resurrecting a run a human had been told
// was dead. Deploy a new ENGINE_VERSION with runs in flight and that is every
// one of them.
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { sweepWorkspace, SWEEP_STARTUP_GRACE_SECONDS, SWEEP_MISSING_CONFIRM_SECONDS } from '../../src/runs/sweep.js';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import { makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

async function seedRun(
  fixture: Fixture, engineVersion: number, instanceId: string | null,
  options: { ageSeconds?: number; stopRequested?: boolean; status?: string } = {},
): Promise<string> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fixture.workspaceId, fixture.adminId);
    const session = await c.query<{ id: string }>(
      `INSERT INTO sessions (workspace_id, owner_id, title, model_id)
       VALUES ($1, $2, 'Sweeping', 'deepseek-flash') RETURNING id`,
      [fixture.workspaceId, fixture.adminId],
    );
    const run = await c.query<{ id: string }>(
      `INSERT INTO runs (workspace_id, session_id, status, model_id, client_turn_id, engine_version,
                         workflow_instance_id, attempt, updated_at, stop_requested)
       VALUES ($1, $2, $8, 'deepseek-flash', $3, $4, $5, 1,
               now() - ($6 || ' seconds')::interval, $7) RETURNING id`,
      [fixture.workspaceId, session.rows[0]!.id, `turn-${randomUUID()}`, engineVersion, instanceId,
        String(options.ageSeconds ?? SWEEP_STARTUP_GRACE_SECONDS + 1), options.stopRequested ?? false, options.status ?? 'working'],
    );
    await c.query('COMMIT');
    return run.rows[0]!.id;
  });
}

interface RunState {
  status: string;
  stop_requested: boolean;
  attempt: number;
  workflow_instance_id: string | null;
  progress_at: string;
  error: { reason: string } | null;
}

async function readRun(fixture: Fixture, runId: string): Promise<RunState> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fixture.workspaceId, fixture.adminId);
    const { rows } = await c.query<RunState>(
      `SELECT status, stop_requested, attempt, workflow_instance_id, updated_at::text AS progress_at, error FROM runs WHERE id = $1`,
      [runId],
    );
    await c.query('COMMIT');
    return rows[0]!;
  });
}

/** A RUN_ATTEMPT binding that records what the sweep asked of it. */
function workflowBinding(status: string | (() => Promise<unknown>)): { binding: Env['RUN_ATTEMPT']; terminated: string[] } {
  const terminated: string[] = [];
  const binding = {
    get: (id: string) =>
      Promise.resolve({
        id,
        status: () => typeof status === 'string' ? Promise.resolve({ status }) : status(),
        terminate: () => {
          terminated.push(id);
          return Promise.resolve();
        },
      }),
    create: () => Promise.resolve({ id: 'unused' }),
  } as unknown as Env['RUN_ATTEMPT'];
  return { binding, terminated };
}

async function inFixture<T>(fixture: Fixture, fn: (client: import('pg').Client) => Promise<T>): Promise<T> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fixture.workspaceId, fixture.adminId);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  });
}
const tally = () => ({ checked: 0, errored: 0, stopped: 0 });
const missing = () => Promise.reject(new Error('(instance.not_found) Instance does not exist'));

async function observations(fixture: Fixture, runId: string): Promise<number> {
  return inFixture(fixture, async (c) => (await c.query(`SELECT 1 FROM run_sweep_observations WHERE run_id = $1`, [runId])).rowCount ?? 0);
}

async function ageObservation(fixture: Fixture, runId: string): Promise<void> {
  await inFixture(fixture, async (c) => {
    await c.query(`UPDATE run_sweep_observations SET first_missing_at = now() - ($2 || ' seconds')::interval WHERE run_id = $1`,
      [runId, String(SWEEP_MISSING_CONFIRM_SECONDS + 1)]);
  });
}

async function expectNoTerminalEvents(fixture: Fixture, runId: string): Promise<void> {
  await inFixture(fixture, async (c) => {
    expect((await c.query(`SELECT 1 FROM events WHERE run_id = $1 AND kind = 'run.errored'`, [runId])).rowCount).toBe(0);
    expect((await c.query(`SELECT 1 FROM stream_events WHERE payload->>'run_id' = $1`, [runId])).rowCount).toBe(0);
    expect((await c.query(`SELECT 1 FROM jobs`)).rowCount).toBe(0);
  });
}

describe('a monitoring failure cannot terminate a healthy run', () => {
  it.each(['status_503', 'timeout', 'get_503', 'ambiguous_missing', 'unknown', 'unrecognized', 'malformed'] as const)('preserves a stale working run after %s', async (failure) => {
    const fixture = await seedWorkspace();
    const runId = await seedRun(fixture, 1, `inst-${randomUUID()}`, { ageSeconds: 3600 });
    const before = await readRun(fixture, runId);
    const status = async () => {
      if (failure === 'status_503' || failure === 'get_503') throw Object.assign(new Error('private service response'), { status: 503 });
      if (failure === 'timeout') throw Object.assign(new Error('private timeout response'), { name: 'TimeoutError' });
      if (failure === 'ambiguous_missing') throw new Error('instance.not_found');
      return failure === 'malformed' ? {} : { status: failure === 'unknown' ? 'unknown' : 'new-platform-state' };
    };
    const { binding, terminated } = workflowBinding(status);
    const { env } = makeEnv({ RUN_ATTEMPT: failure === 'get_503'
      ? { get: status } as unknown as Env['RUN_ATTEMPT'] : binding });
    const result = tally();

    await sweepWorkspace(env, fixture.workspaceId, result);

    expect(await readRun(fixture, runId)).toEqual(before);
    expect(terminated).toEqual([]);
    expect(result).toEqual({ checked: 1, errored: 0, stopped: 0 });
    expect(await observations(fixture, runId)).toBe(0);
    await expectNoTerminalEvents(fixture, runId);
  });

  it.each([null, 'known-instance-id'])('allows a fresh admission with instance %s to become visible', async (instanceId) => {
    const fixture = await seedWorkspace();
    const runId = await seedRun(fixture, 1, instanceId === null ? null : `inst-${randomUUID()}`, { ageSeconds: 0 });
    const get = vi.fn(missing);
    const { env } = makeEnv({ RUN_ATTEMPT: { get } as unknown as Env['RUN_ATTEMPT'] });
    await sweepWorkspace(env, fixture.workspaceId, tally());
    expect((await readRun(fixture, runId)).status).toBe('working');
    expect(get).not.toHaveBeenCalled();
    expect(await observations(fixture, runId)).toBe(0);
    await expectNoTerminalEvents(fixture, runId);
  });

  it('logs bounded categories and identifiers without upstream error contents', async () => {
    const fixture = await seedWorkspace();
    await seedRun(fixture, 1, `inst-${randomUUID()}`);
    const { binding } = workflowBinding(() => Promise.reject(Object.assign(new Error(`private-payload-${'x'.repeat(2000)}`), { status: 503 })));
    const { env } = makeEnv({ RUN_ATTEMPT: binding });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await sweepWorkspace(env, fixture.workspaceId, tally());
      const lines = log.mock.calls.map(([line]) => String(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toContain('private-payload');
      expect(lines[0]!.length).toBeLessThan(400);
      expect(JSON.parse(lines[0]!)).toMatchObject({ at: 'cron.orphans.lookup', category: 'http_5xx', attempt: 1 });
    } finally {
      log.mockRestore();
    }
  });
});

describe('confirmed missing instances need durable repeated evidence', () => {
  it('waits for a second spaced observation without changing run progress', async () => {
    const fixture = await seedWorkspace();
    const instanceId = `inst-${randomUUID()}`;
    const runId = await seedRun(fixture, 1, instanceId);
    const before = await readRun(fixture, runId);
    const { binding, terminated } = workflowBinding(missing);
    const { env } = makeEnv({ RUN_ATTEMPT: binding });

    for (let index = 0; index < 2; index += 1) {
      const result = tally();
      await sweepWorkspace(env, fixture.workspaceId, result);
      expect(result.errored).toBe(0);
      expect(await readRun(fixture, runId)).toEqual(before);
    }
    expect(await observations(fixture, runId)).toBe(1);
    expect(terminated).toEqual([]);
    await expectNoTerminalEvents(fixture, runId);

    await ageObservation(fixture, runId);
    // A new binding simulates a later invocation with no in-memory counter.
    const later = workflowBinding(missing);
    const next = makeEnv({ RUN_ATTEMPT: later.binding });
    const result = tally();
    await sweepWorkspace(next.env, fixture.workspaceId, result);
    expect(await readRun(fixture, runId)).toMatchObject({ status: 'error', stop_requested: true, error: { reason: 'instance_missing' } });
    expect(result.errored).toBe(1);
    expect(later.terminated).toEqual([instanceId]);
    expect(await observations(fixture, runId)).toBe(0);
  });

  it.each(['running', 'unknown', 'outage', 'progress', 'retry'] as const)('resets missing evidence after %s', async (next) => {
    const fixture = await seedWorkspace();
    const runId = await seedRun(fixture, 1, `inst-${randomUUID()}`);
    const first = makeEnv({ RUN_ATTEMPT: workflowBinding(missing).binding });
    await sweepWorkspace(first.env, fixture.workspaceId, tally());
    await ageObservation(fixture, runId);
    expect(await observations(fixture, runId)).toBe(1);

    if (next === 'progress' || next === 'retry') {
      await inFixture(fixture, (c) => c.query(next === 'progress'
        ? `UPDATE runs SET active_ms = active_ms + 1 WHERE id = $1`
        : `UPDATE runs SET attempt = 2, workflow_instance_id = id::text || '-a2' WHERE id = $1`, [runId]));
    }
    const nextStatus = next === 'outage'
      ? () => Promise.reject(Object.assign(new Error('unavailable'), { status: 503 }))
      : next === 'progress' || next === 'retry' ? missing : next;
    const second = workflowBinding(nextStatus);
    await sweepWorkspace(makeEnv({ RUN_ATTEMPT: second.binding }).env, fixture.workspaceId, tally());
    expect(await observations(fixture, runId)).toBe(0);
    expect((await readRun(fixture, runId)).status).toBe('working');
    expect(second.terminated).toEqual([]);

    if (next === 'running' || next === 'unknown' || next === 'outage') {
      await sweepWorkspace(first.env, fixture.workspaceId, tally());
      expect(await observations(fixture, runId)).toBe(1);
      expect((await readRun(fixture, runId)).status).toBe('working');
    }
  });
});

describe('a terminal sweep applies only to the unchanged run snapshot', () => {
  it('still stops a confirmed running instance after the existing no-progress window', async () => {
    const fixture = await seedWorkspace();
    const instanceId = `inst-${randomUUID()}`;
    const runId = await seedRun(fixture, 1, instanceId, { ageSeconds: 3600 });
    const { binding, terminated } = workflowBinding('running');
    const result = tally();
    await sweepWorkspace(makeEnv({ RUN_ATTEMPT: binding }).env, fixture.workspaceId, result);
    expect(await readRun(fixture, runId)).toMatchObject({ status: 'error', stop_requested: true, error: { reason: 'no_progress' } });
    expect(terminated).toEqual([instanceId]);
    expect(result.errored).toBe(1);
  });

  it('lets only one concurrent sweep own a terminal transition and termination', async () => {
    const fixture = await seedWorkspace();
    const instanceId = `inst-${randomUUID()}`;
    await seedRun(fixture, 1, instanceId);
    const { binding, terminated } = workflowBinding('errored');
    const { env } = makeEnv({ RUN_ATTEMPT: binding });
    const first = tally(), second = tally();
    await Promise.all([sweepWorkspace(env, fixture.workspaceId, first), sweepWorkspace(env, fixture.workspaceId, second)]);
    expect(first.errored + second.errored).toBe(1);
    expect(terminated).toEqual([instanceId]);
  });

  it.each(['progress', 'retry', 'completed', 'stop'] as const)('loses safely when %s changes during status lookup', async (change) => {
    const fixture = await seedWorkspace();
    const instanceId = `inst-${randomUUID()}`;
    const runId = await seedRun(fixture, 1, instanceId);
    const mutation = {
      progress: `UPDATE runs SET active_ms = active_ms + 1 WHERE id = $1`,
      retry: `UPDATE runs SET attempt = 2, workflow_instance_id = id::text || '-a2' WHERE id = $1`,
      completed: `UPDATE runs SET status = 'completed', ended_at = now() WHERE id = $1`,
      stop: `UPDATE runs SET status = 'stopping', stop_requested = true WHERE id = $1`,
    }[change];
    const { binding, terminated } = workflowBinding(async () => {
      await inFixture(fixture, (c) => c.query(mutation, [runId]));
      return { status: 'errored' };
    });
    const result = tally();
    await sweepWorkspace(makeEnv({ RUN_ATTEMPT: binding }).env, fixture.workspaceId, result);

    expect(result).toEqual({ checked: 1, errored: 0, stopped: 0 });
    expect(terminated).toEqual([]);
    expect((await readRun(fixture, runId)).status).toBe(change === 'completed' ? 'completed' : change === 'stop' ? 'stopping' : 'working');
    if (change === 'retry') expect((await readRun(fixture, runId)).attempt).toBe(2);
    await expectNoTerminalEvents(fixture, runId);
  });

  it('commits explicit Stop before attempting termination, even during grace and a status outage', async () => {
    const fixture = await seedWorkspace();
    const instanceId = `inst-${randomUUID()}`;
    const runId = await seedRun(fixture, 1, instanceId, { ageSeconds: 0, status: 'stopping', stopRequested: true });
    const status = vi.fn(() => Promise.reject(new Error('control plane unavailable')));
    const terminate = vi.fn(async () => {
      expect(await readRun(fixture, runId)).toMatchObject({ status: 'stopped', stop_requested: true });
    });
    const binding = { get: async () => ({ status, terminate }) } as unknown as Env['RUN_ATTEMPT'];
    const result = tally();
    await sweepWorkspace(makeEnv({ RUN_ATTEMPT: binding }).env, fixture.workspaceId, result);
    expect(status).not.toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ checked: 1, errored: 0, stopped: 1 });
  });

  it('records explicit Stop even when the Workflow binding itself is unavailable', async () => {
    const fixture = await seedWorkspace();
    const runId = await seedRun(fixture, 1, null, { ageSeconds: 0, status: 'stopping', stopRequested: true });
    const get = vi.fn(() => Promise.reject(Object.assign(new Error('unavailable'), { status: 503 })));
    const result = tally();
    await sweepWorkspace(makeEnv({ RUN_ATTEMPT: { get } as unknown as Env['RUN_ATTEMPT'] }).env, fixture.workspaceId, result);
    expect((await readRun(fixture, runId)).status).toBe('stopped');
    expect(get).toHaveBeenCalledTimes(1);
    expect(result.stopped).toBe(1);
  });
});

describe('G2 · the orphan sweep', () => {
  it('sets stop_requested and terminates the instance when it errors a run', async () => {
    const fixture = await seedWorkspace();
    const instanceId = `inst-${randomUUID()}`;
    // engine_version 0 against a deployed ENGINE_VERSION of 1: the
    // `engine_version_changed` verdict, which is the one a deploy produces for
    // every run in flight and the one that wrote no flag at all.
    const runId = await seedRun(fixture, 0, instanceId);
    const { binding, terminated } = workflowBinding('running');
    const { env } = makeEnv({ ENGINE_VERSION: '1', RUN_ATTEMPT: binding });

    const tally = { checked: 0, errored: 0, stopped: 0 };
    await sweepWorkspace(env, fixture.workspaceId, tally);

    const row = await readRun(fixture, runId);
    expect(row.status).toBe('error');
    expect(row.stop_requested).toBe(true);
    expect(terminated).toContain(instanceId);
  });

  it('survives a terminate that throws, because a reaped instance usually has', async () => {
    const fixture = await seedWorkspace();
    const instanceId = `inst-${randomUUID()}`;
    const runId = await seedRun(fixture, 0, instanceId);
    const binding = {
      get: (id: string) =>
        Promise.resolve({
          id,
          status: () => Promise.resolve({ status: 'running' }),
          terminate: () => Promise.reject(new Error('instance is not running')),
        }),
      create: () => Promise.resolve({ id: 'unused' }),
    } as unknown as Env['RUN_ATTEMPT'];
    const { env } = makeEnv({ ENGINE_VERSION: '1', RUN_ATTEMPT: binding });

    await expect(
      sweepWorkspace(env, fixture.workspaceId, { checked: 0, errored: 0, stopped: 0 }),
    ).resolves.toBeUndefined();
    expect((await readRun(fixture, runId)).status).toBe('error');
  });

  it('refuses to let the zombie resurrect itself: a terminal run stays terminal', async () => {
    const fixture = await seedWorkspace();
    const instanceId = `inst-${randomUUID()}`;
    const runId = await seedRun(fixture, 0, instanceId);
    const { binding } = workflowBinding('running');
    const { env } = makeEnv({ ENGINE_VERSION: '1', RUN_ATTEMPT: binding });
    await sweepWorkspace(env, fixture.workspaceId, { checked: 0, errored: 0, stopped: 0 });

    // The engine's own final write, from the instance that never noticed. This
    // is the call that used to move the run back to `completed`.
    const db = new PgAgentDb(env, fixture.workspaceId, randomUUID());
    try {
      await db.setRunStatus(runId, 'completed');
    } finally {
      await db.close();
    }

    expect((await readRun(fixture, runId)).status).toBe('error');
  });
});
