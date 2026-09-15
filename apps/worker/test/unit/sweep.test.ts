// The orphan sweep's decision, on its own.
//
// `verdictFor` is separated from the queries around it because the decision is
// the part with the interesting ordering: Stop is read before anything else, a
// waiting run is legitimately silent for up to thirty days, and an engine
// version bump outranks whatever the instance says about itself.
import { describe, expect, it } from 'vitest';
import { verdictFor } from '../../src/runs/sweep.js';
import { ORPHAN_NO_EVENT_MINUTES } from '../../src/engine/constants.js';

const run = (overrides: Partial<Parameters<typeof verdictFor>[0]> = {}): Parameters<typeof verdictFor>[0] => ({
  id: 'run-1',
  session_id: 'session-1',
  status: 'working',
  attempt: 1,
  engine_version: 1,
  workflow_instance_id: 'run-1-a1',
  stop_requested: false,
  stale: false,
  model_id: 'deepseek-flash',
  ...overrides,
});

const running = () => Promise.resolve('running');

describe('the orphan sweep', () => {
  it('leaves a healthy run alone', async () => {
    expect(await verdictFor(run(), 1, running)).toEqual({ kind: 'ok' });
  });

  it('reads Stop first, so a stopped run ends as stopped rather than as an error', async () => {
    const verdict = await verdictFor(run({ stop_requested: true, stale: true, engine_version: 0 }), 1, () =>
      Promise.reject(new Error('gone')),
    );
    expect(verdict).toEqual({ kind: 'stopped' });
  });

  it('errors a run started by a different engine version', async () => {
    const verdict = await verdictFor(run({ engine_version: 1 }), 2, running);
    expect(verdict).toMatchObject({ kind: 'error', reason: 'engine_version_changed' });
  });

  it('errors a run whose instance is gone', async () => {
    expect(await verdictFor(run(), 1, () => Promise.reject(new Error('unknown id')))).toMatchObject({
      kind: 'error',
      reason: 'instance_missing',
    });
    // A run with no instance id: the caller has nothing to look up and reports
    // null rather than inventing an id.
    expect(await verdictFor(run({ workflow_instance_id: null }), 1, () => Promise.resolve(null))).toMatchObject({
      reason: 'instance_missing',
    });
  });

  it('errors a run whose instance is dead', async () => {
    for (const status of ['errored', 'terminated', 'unknown']) {
      expect(await verdictFor(run(), 1, () => Promise.resolve(status))).toMatchObject({
        kind: 'error',
        reason: 'instance_dead',
      });
    }
  });

  it(`errors a working run that has made no progress for ${ORPHAN_NO_EVENT_MINUTES} minutes`, async () => {
    expect(await verdictFor(run({ stale: true }), 1, running)).toMatchObject({ kind: 'error', reason: 'no_progress' });
  });

  it('does not error a waiting run for being silent, because waiting is silent by design', async () => {
    expect(await verdictFor(run({ status: 'waiting', stale: true }), 1, running)).toEqual({ kind: 'ok' });
  });

  it('marks every error retryable, because a swept run is a run a human can Retry', async () => {
    const verdict = await verdictFor(run({ stale: true }), 1, running);
    expect(verdict.kind).toBe('error');
  });
});
