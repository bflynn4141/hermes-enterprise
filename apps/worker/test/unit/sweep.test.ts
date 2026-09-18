// The orphan sweep's decision, on its own.
//
// `verdictFor` is separated from the queries around it because the decision is
// the part with the interesting ordering: Stop is read before anything else, a
// waiting run is legitimately silent for up to thirty days, and an engine
// version bump outranks whatever the instance says about itself.
import { describe, expect, it, vi } from 'vitest';
import { verdictFor, SWEEP_LOOKUP_TIMEOUT_MS } from '../../src/runs/sweep.js';
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
  in_grace: false,
  progress_at: '2026-09-18 12:00:00.123456+00',
  model_id: 'deepseek-flash',
  ...overrides,
});

const running = () => Promise.resolve('running');

describe('the orphan sweep', () => {
  it.each([
    Object.assign(new Error('temporary service failure'), { status: 503 }),
    Object.assign(new Error('request timed out'), { name: 'TimeoutError' }),
  ])('defers a failed lookup instead of declaring the workflow missing', async (error) => {
    expect(await verdictFor(run({ stale: true }), 1, () => Promise.reject(error)))
      .toMatchObject({ kind: 'deferred' });
  });

  it('does not classify an unknown workflow status as a dead instance', async () => {
    expect(await verdictFor(run({ stale: true }), 1, () => Promise.resolve('unknown')))
      .toMatchObject({ kind: 'deferred' });
  });

  it('bounds a hung lookup and defers without treating the timeout as absence', async () => {
    vi.useFakeTimers();
    try {
      const verdict = verdictFor(run({ stale: true }), 1, () => new Promise(() => undefined));
      await vi.advanceTimersByTimeAsync(SWEEP_LOOKUP_TIMEOUT_MS);
      expect(await verdict).toEqual({ kind: 'deferred', reason: 'timeout' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('treats only the explicit Workflow not-found code as a missing observation', async () => {
    for (const error of [new Error('(instance.not_found) Instance does not exist'), { code: 'instance.not_found' }]) {
      expect(await verdictFor(run(), 1, () => Promise.reject(error))).toEqual({ kind: 'missing' });
    }
    for (const error of [new Error('unknown id'), new Error('not found'), new Error('instance.not_found'), { status: 404 }, 'instance.not_found']) {
      expect(await verdictFor(run(), 1, () => Promise.reject(error))).toMatchObject({ kind: 'deferred' });
    }
    expect(await verdictFor(run({ workflow_instance_id: null }), 1, () => Promise.resolve(null)))
      .toEqual({ kind: 'deferred', reason: 'unknown_status' });
  });

  it('errors a run whose instance is dead', async () => {
    for (const status of ['errored', 'terminated']) {
      expect(await verdictFor(run(), 1, () => Promise.resolve(status))).toMatchObject({
        kind: 'error',
        reason: 'instance_dead',
      });
    }
  });

  it('leaves a fresh admission or retry alone before looking up an instance', async () => {
    const lookup = vi.fn(() => Promise.reject(new Error('(instance.not_found) Instance does not exist')));
    expect(await verdictFor(run({ in_grace: true, workflow_instance_id: null }), 1, lookup))
      .toEqual({ kind: 'deferred', reason: 'startup_grace' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('honors Stop during startup grace without needing a successful lookup', async () => {
    const lookup = vi.fn(() => Promise.reject(new Error('503')));
    expect(await verdictFor(run({ in_grace: true, stop_requested: true }), 1, lookup)).toEqual({ kind: 'stopped' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(['queued', 'paused', 'waiting', 'waitingForPause'])('does not mistake the Workflow %s state for lack of progress', async (status) => {
    expect(await verdictFor(run({ stale: true }), 1, () => Promise.resolve(status))).toEqual({ kind: 'ok' });
  });

  it.each([null, 'unknown', 'new-unrecognized-state', ''])('defers an uncertain status %s even if the run looks stale', async (status) => {
    expect(await verdictFor(run({ stale: true }), 1, () => Promise.resolve(status))).toMatchObject({ kind: 'deferred' });
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
