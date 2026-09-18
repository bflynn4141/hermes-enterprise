// Transaction boundary failures need a controlled adapter: a lost UPDATE or
// failed COMMIT must never turn into a Workflow termination or a success count.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import type { Tx } from '../../src/db/client.js';

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), publish: vi.fn(), jobs: vi.fn() }));
vi.mock('../../src/jobs.js', () => ({
  withWorkspaceTransaction: mocks.transaction,
  publishEvents: mocks.publish,
  runJobsAfterCommit: mocks.jobs,
}));
import { sweepWorkspace } from '../../src/runs/sweep.js';

const run = {
  id: 'run-id', session_id: 'session-id', status: 'stopping', attempt: 7,
  engine_version: 1, workflow_instance_id: 'run-id-a7', stop_requested: true,
  stale: false, in_grace: true, progress_at: '2026-09-18 12:34:56.123456+00', model_id: 'deepseek-flash',
};

function setup(options: { lostUpdate?: boolean; commitFails?: boolean } = {}) {
  const order: string[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith('SELECT id, session_id')) return { rowCount: 1, rows: [run] };
    if (sql.startsWith('SELECT id FROM runs')) return { rowCount: 1, rows: [{ id: run.id }] };
    if (sql.startsWith('DELETE FROM run_sweep_observations')) return { rowCount: 0, rows: [] };
    if (sql.startsWith('UPDATE runs')) {
      order.push('update');
      return { rowCount: options.lostUpdate ? 0 : 1, rows: [] };
    }
    throw new Error('unexpected SQL');
  });
  let transactions = 0;
  mocks.transaction.mockImplementation(async (_env: Env, _workspace: string, fn: (tx: Tx) => Promise<unknown>) => {
    transactions += 1;
    const value = await fn({ query } as unknown as Tx);
    if (transactions === 2) {
      if (options.commitFails) throw new Error('commit failed');
      order.push('commit');
    }
    return value;
  });
  mocks.publish.mockResolvedValue(['publish-job']);
  mocks.jobs.mockImplementation(async () => { order.push('jobs'); });
  const terminate = vi.fn(async () => { order.push('terminate'); });
  const get = vi.fn(async () => ({ terminate }));
  const env = { ENGINE_VERSION: '1', RUN_ATTEMPT: { get } } as unknown as Env;
  return { order, query, terminate, get, env, result: { checked: 0, errored: 0, stopped: 0 } };
}

beforeEach(() => vi.resetAllMocks());

describe('the sweep owns the transition it terminates', () => {
  it('does not terminate, publish or count a terminal UPDATE that changed zero rows', async () => {
    const test = setup({ lostUpdate: true });
    await sweepWorkspace(test.env, 'workspace-id', test.result);
    expect(test.result).toEqual({ checked: 1, errored: 0, stopped: 0 });
    expect(test.get).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.jobs).not.toHaveBeenCalled();
  });

  it('does not terminate or count a transition whose transaction failed to commit', async () => {
    const test = setup({ commitFails: true });
    await expect(sweepWorkspace(test.env, 'workspace-id', test.result)).rejects.toThrow('commit failed');
    expect(test.result).toEqual({ checked: 1, errored: 0, stopped: 0 });
    expect(test.get).not.toHaveBeenCalled();
    expect(mocks.jobs).not.toHaveBeenCalled();
  });

  it('matches the complete snapshot and terminates only its instance after the commit', async () => {
    const test = setup();
    await sweepWorkspace(test.env, 'workspace-id', test.result);
    expect(test.order).toEqual(['update', 'commit', 'terminate', 'jobs']);
    expect(test.get).toHaveBeenCalledExactlyOnceWith('run-id-a7');
    expect(test.result).toEqual({ checked: 1, errored: 0, stopped: 1 });
    const update = test.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE runs'));
    expect(update?.[0]).toMatch(/attempt = \$3/);
    expect(update?.[0]).toMatch(/workflow_instance_id IS NOT DISTINCT FROM \$4/);
    expect(update?.[0]).toMatch(/status = \$5/);
    expect(update?.[0]).toMatch(/updated_at = \$6::timestamptz/);
    expect(update?.[0]).toMatch(/stop_requested = \$7/);
  });
});
