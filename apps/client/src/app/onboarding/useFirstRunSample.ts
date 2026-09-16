import { useCallback, useEffect, useState } from 'react';
import { RestError, type Rest } from '../../model/rest.js';
import {
  getSampleRun,
  startSampleRun,
  type SampleRunSnapshot,
  type SampleRunView,
} from './FirstRunSampleRun.js';

function stored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The run still works for this page when browser storage is unavailable.
  }
}

function forget(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // A stale identifier cannot block an in-memory retry.
  }
}

function setupAttemptId(key: string): string {
  const existing = stored(`${key}:setup-attempt`);
  if (existing) return existing;
  const value = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `00000000-0000-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12)}`;
  remember(`${key}:setup-attempt`, value);
  return value;
}

function message(error: unknown): string {
  if (error instanceof RestError) {
    if (error.status === 401) return 'Sign in again, then resume the sample run.';
    if (error.status === 403) return 'This workspace does not allow the sample run.';
    if (error.status >= 500) return 'The sample service is unavailable. Your last results are saved.';
  }
  return error instanceof Error && error.message
    ? error.message
    : 'The sample run could not continue. Your last results are saved.';
}

function viewFor(snapshot: SampleRunSnapshot): SampleRunView {
  if (snapshot.status === 'completed') return { phase: 'complete', snapshot, message: null };
  if (snapshot.status === 'failed') return { phase: 'error', snapshot, message: snapshot.error ?? 'The sample run stopped before it finished.' };
  return { phase: 'running', snapshot, message: null };
}

/**
 * Starts the labeled sample exactly once and resumes it by run id after a
 * refresh. The worker owns all timing and state changes; this hook never moves
 * an application forward on a client timer.
 */
export function useFirstRunSample({
  enabled,
  rest,
  agentId,
  workspaceId,
  storageKey,
}: {
  enabled: boolean;
  rest: Rest;
  agentId: string;
  workspaceId: string;
  storageKey: string;
}) {
  const [view, setView] = useState<SampleRunView>({ phase: 'idle', snapshot: null, message: null });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setView({ phase: 'idle', snapshot: null, message: null });
  }, [storageKey]);

  useEffect(() => {
    if (!enabled || !workspaceId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let recoveredMissingRun = false;
    const runKey = `${storageKey}:run`;

    const schedule = (runId: string, delay: number): void => {
      timer = setTimeout(() => void load(runId), delay);
    };

    const accept = (snapshot: SampleRunSnapshot): void => {
      remember(runKey, snapshot.runId);
      if (cancelled) return;
      setView((current) => {
        // GET requests after=0 and should be a full snapshot. Preserve prior
        // applications if a server optimization returns an events-only page.
        const merged = snapshot.applications.length === 0 && current.snapshot?.applications.length
          ? { ...snapshot, applications: current.snapshot.applications }
          : snapshot;
        return viewFor(merged);
      });
      if (snapshot.status === 'starting' || snapshot.status === 'running') schedule(snapshot.runId, snapshot.nextPollMs);
    };

    const begin = async (): Promise<void> => {
      if (!cancelled) setView((current) => ({ phase: 'starting', snapshot: current.snapshot, message: null }));
      try {
        const snapshot = await startSampleRun(rest, workspaceId, agentId, setupAttemptId(storageKey));
        accept(snapshot);
      } catch (error) {
        if (!cancelled) setView((current) => ({ phase: 'error', snapshot: current.snapshot, message: message(error) }));
      }
    };

    const load = async (runId: string): Promise<void> => {
      try {
        const snapshot = await getSampleRun(rest, workspaceId, runId);
        accept(snapshot);
      } catch (error) {
        if (error instanceof RestError && error.status === 404 && !recoveredMissingRun) {
          recoveredMissingRun = true;
          forget(runKey);
          await begin();
          return;
        }
        if (!cancelled) setView((current) => ({ phase: 'error', snapshot: current.snapshot, message: message(error) }));
      }
    };

    const runId = stored(runKey);
    if (runId) {
      setView((current) => ({ phase: 'resuming', snapshot: current.snapshot, message: null }));
      void load(runId);
    } else {
      void begin();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, enabled, rest, retry, storageKey, workspaceId]);

  const retryRun = useCallback(() => setRetry((value) => value + 1), []);
  return { view, retry: retryRun };
}
