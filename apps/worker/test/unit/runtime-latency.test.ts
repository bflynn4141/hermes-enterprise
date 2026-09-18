import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeLatency, type RuntimeLatency } from '../../src/runtime/latency.js';

afterEach(() => vi.restoreAllMocks());

describe('runtime startup timing', () => {
  it('includes admission and queue time without calling it execution time', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const points: RuntimeLatency[] = [];
    const clock = runtimeLatency(500, 100, (point) => points.push(point));
    await clock.measure('native_submit', async () => { now += 80; });
    expect(points).toEqual([{
      phase: 'native_submit', duration_ms: 80, elapsed_ms: 580, turn_elapsed_ms: 980,
    }]);
  });

  it('records failed phases while preserving the original error if reporting fails', async () => {
    const problem = new Error('native unavailable');
    const points: RuntimeLatency[] = [];
    const clock = runtimeLatency(Date.now(), undefined, (point) => {
      points.push(point);
      throw new Error('analytics unavailable');
    });
    await expect(clock.measure('submit_capabilities', async () => { throw problem; })).rejects.toBe(problem);
    expect(points).toHaveLength(1);
    expect(points[0]?.turn_elapsed_ms).toBeNull();
  });
});
