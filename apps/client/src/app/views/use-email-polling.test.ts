import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMAIL_REFRESH_MS, startEmailPolling } from './use-email-polling.js';

class Visibility extends EventTarget {
  visibilityState = 'visible';
  change(state: string): void { this.visibilityState = state; this.dispatchEvent(new Event('visibilitychange')); }
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

describe('email polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('finds arrivals and keeps checking until triage finishes, even beyond the first retry refresh', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['received'])
      .mockResolvedValueOnce(['triaging'])
      .mockResolvedValueOnce(['suggested']);
    const receive = vi.fn();
    const polling = startEmailPolling(load, receive, vi.fn(), new Visibility());
    await settle();
    await vi.advanceTimersByTimeAsync(EMAIL_REFRESH_MS * 3);
    expect(receive.mock.calls.map(([value]) => value)).toEqual([[], ['received'], ['triaging'], ['suggested']]);
    polling.stop();
  });

  it('does not overlap slow reads or apply an older read over a retry result', async () => {
    const old = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('retry finished');
    const receive = vi.fn();
    const visibility = new Visibility();
    const polling = startEmailPolling(load, receive, vi.fn(), visibility);
    await vi.advanceTimersByTimeAsync(EMAIL_REFRESH_MS * 4);
    expect(load).toHaveBeenCalledTimes(1);
    polling.suspend();
    visibility.change('hidden');
    visibility.change('visible');
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    polling.refresh();
    polling.refresh();
    expect(load).toHaveBeenCalledTimes(1);
    old.resolve('before retry');
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls).toEqual([['retry finished']]);
    polling.stop();
  });

  it('pauses while hidden and refreshes immediately when the tab returns', async () => {
    const visibility = new Visibility();
    visibility.change('hidden');
    const load = vi.fn().mockResolvedValue('current');
    const polling = startEmailPolling(load, vi.fn(), vi.fn(), visibility);
    await vi.advanceTimersByTimeAsync(EMAIL_REFRESH_MS * 3);
    expect(load).not.toHaveBeenCalled();
    visibility.change('visible');
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    visibility.change('hidden');
    await vi.advanceTimersByTimeAsync(EMAIL_REFRESH_MS * 3);
    expect(load).toHaveBeenCalledTimes(1);
    visibility.change('visible');
    await settle();
    expect(load).toHaveBeenCalledTimes(2);
    polling.stop();
  });

  it('retains the last successful rows on a transient failure and recovers on the next poll', async () => {
    let displayed: string[] = [];
    const fail = vi.fn();
    const load = vi.fn().mockResolvedValueOnce(['reading']).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(['ready']);
    const polling = startEmailPolling<string[]>(load, (rows) => { displayed = rows; }, fail, new Visibility());
    await settle();
    await vi.advanceTimersByTimeAsync(EMAIL_REFRESH_MS);
    expect(displayed).toEqual(['reading']);
    expect(fail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EMAIL_REFRESH_MS);
    expect(displayed).toEqual(['ready']);
    polling.stop();
  });

  it('discards stale permission failures after a mutation', async () => {
    const old = deferred<string>();
    const fail = vi.fn();
    const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue('fresh');
    const receive = vi.fn();
    const polling = startEmailPolling(load, receive, fail, new Visibility());
    polling.suspend();
    polling.refresh();
    old.reject({ status: 404 });
    await settle();
    expect(fail).not.toHaveBeenCalled();
    expect(receive).toHaveBeenCalledWith('fresh');
    polling.stop();
  });

  it('ignores requests resolving after unmount and removes scheduled work and visibility listeners', async () => {
    const old = deferred<string>();
    const visibility = new Visibility();
    const load = vi.fn().mockReturnValue(old.promise);
    const receive = vi.fn();
    const fail = vi.fn();
    const polling = startEmailPolling(load, receive, fail, visibility);
    polling.stop();
    old.resolve('late');
    await settle();
    visibility.change('visible');
    await vi.advanceTimersByTimeAsync(EMAIL_REFRESH_MS * 3);
    expect(load).toHaveBeenCalledTimes(1);
    expect(receive).not.toHaveBeenCalled();
    expect(fail).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
