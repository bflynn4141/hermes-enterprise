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
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { sweepWorkspace } from '../../src/runs/sweep.js';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import { makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

async function seedRun(fixture: Fixture, engineVersion: number, instanceId: string): Promise<string> {
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
                         workflow_instance_id, attempt)
       VALUES ($1, $2, 'working', 'deepseek-flash', $3, $4, $5, 1) RETURNING id`,
      [fixture.workspaceId, session.rows[0]!.id, `turn-${randomUUID()}`, engineVersion, instanceId],
    );
    await c.query('COMMIT');
    return run.rows[0]!.id;
  });
}

async function readRun(fixture: Fixture, runId: string): Promise<{ status: string; stop_requested: boolean }> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fixture.workspaceId, fixture.adminId);
    const { rows } = await c.query<{ status: string; stop_requested: boolean }>(
      `SELECT status, stop_requested FROM runs WHERE id = $1`,
      [runId],
    );
    await c.query('COMMIT');
    return rows[0]!;
  });
}

/** A RUN_ATTEMPT binding that records what the sweep asked of it. */
function workflowBinding(status: string): { binding: Env['RUN_ATTEMPT']; terminated: string[] } {
  const terminated: string[] = [];
  const binding = {
    get: (id: string) =>
      Promise.resolve({
        id,
        status: () => Promise.resolve({ status }),
        terminate: () => {
          terminated.push(id);
          return Promise.resolve();
        },
      }),
    create: () => Promise.resolve({ id: 'unused' }),
  } as unknown as Env['RUN_ATTEMPT'];
  return { binding, terminated };
}

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
