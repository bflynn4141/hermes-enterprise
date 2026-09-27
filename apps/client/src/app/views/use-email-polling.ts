import { useCallback, useEffect, useRef } from 'react';

export const EMAIL_REFRESH_MS = 5000;

interface Visibility {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** One request at a time; mutations invalidate older reads before changing a row. */
export function startEmailPolling<T>(load: () => Promise<T>, receive: (value: T) => void, fail: (error: unknown) => void, visibility: Visibility) {
  let stopped = false;
  let busy = false;
  let suspended = false;
  let pending = false;
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = (): void => { clearTimeout(timer); timer = undefined; };
  const visible = (): boolean => visibility.visibilityState !== 'hidden';
  const run = async (): Promise<void> => {
    if (stopped || suspended || !visible()) return;
    if (busy) { pending = true; return; }
    busy = true;
    pending = false;
    const started = revision;
    try {
      const value = await load();
      if (!stopped && started === revision) receive(value);
    } catch (error) {
      if (!stopped && started === revision) fail(error);
    } finally {
      busy = false;
      if (!stopped && !suspended && visible()) {
        if (pending) void run();
        else timer = setTimeout(() => void run(), EMAIL_REFRESH_MS);
      }
    }
  };
  const refresh = (): void => {
    revision += 1;
    suspended = false;
    clear();
    void run();
  };
  const changed = (): void => { if (visible() && !suspended) refresh(); else clear(); };
  visibility.addEventListener('visibilitychange', changed);
  void run();
  return {
    refresh,
    suspend(): void { revision += 1; suspended = true; pending = false; clear(); },
    stop(): void { stopped = true; clear(); visibility.removeEventListener('visibilitychange', changed); },
  };
}

export function useEmailPolling<T>(load: () => Promise<T>, receive: (value: T) => void, fail: (error: unknown) => void) {
  const callbacks = useRef({ receive, fail });
  callbacks.current = { receive, fail };
  const poller = useRef<ReturnType<typeof startEmailPolling<T>> | null>(null);
  useEffect(() => {
    const active = startEmailPolling(load, (value) => callbacks.current.receive(value), (error) => callbacks.current.fail(error), document);
    poller.current = active;
    return () => { active.stop(); poller.current = null; };
  }, [load]);
  const refresh = useCallback(() => poller.current?.refresh(), []);
  const suspend = useCallback(() => poller.current?.suspend(), []);
  return { refresh, suspend };
}
