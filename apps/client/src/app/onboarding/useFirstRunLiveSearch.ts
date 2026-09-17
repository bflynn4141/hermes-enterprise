import { useCallback, useEffect, useState } from 'react';
import type { PartnerScreeningSnapshot } from '@hermes/shared';
import { RestError, type Rest } from '../../model/rest.js';
import {
  getLivePartnerSearch,
  handoffLivePartnerSearch,
  startLivePartnerSearch,
  type LiveSearchView,
} from './FirstRunLiveSearch.js';

function stored(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function remember(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* This page can continue in memory. */ }
}

function forget(key: string): void {
  try { window.localStorage.removeItem(key); } catch { /* A retry can continue in memory. */ }
}

function onboardingSearchKey(key: string): string {
  const storageKey = `${key}:idempotency`;
  const existing = stored(storageKey);
  if (existing) return existing;
  const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `00000000-0000-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12)}`;
  const value = `onboarding:${id}`;
  remember(storageKey, value);
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof RestError) {
    if (error.status === 401) return 'Sign in again, then resume the live search.';
    if (error.status === 403) return 'An Admin must start live partner discovery.';
    if (error.reason === 'partner_source_not_configured') return 'Live search is not configured for this environment.';
    if (error.reason === 'partner_source_rate_limited') return 'GitHub’s rate reserve was reached. Retry after it resets.';
    if (error.reason === 'missing_provider_key') return 'Connect Nous Portal so Iris can screen the saved evidence.';
  }
  return error instanceof Error && error.message
    ? error.message
    : 'The live search could not continue. Any committed evidence is still saved.';
}

const ACTIVE_RUNS = new Set(['working', 'waiting', 'stopping']);

/** Runs one bounded live search, then hands its stored evidence to Iris. */
export function useFirstRunLiveSearch({
  enabled,
  providerReady,
  rest,
  agentId,
  workspaceId,
  storageKey,
}: {
  enabled: boolean;
  providerReady: boolean;
  rest: Rest;
  agentId: string;
  workspaceId: string;
  storageKey: string;
}) {
  const [view, setView] = useState<LiveSearchView>({ phase: 'idle', snapshot: null, message: null });
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    setView({ phase: 'idle', snapshot: null, message: null });
  }, [storageKey]);

  useEffect(() => {
    if (!enabled || !workspaceId || !agentId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let recoveredMissingRun = false;
    let handoffEnsured = false;
    const runKey = `${storageKey}:run`;

    const show = (next: LiveSearchView): void => {
      if (!cancelled) setView(next);
    };

    const load = async (runId: string): Promise<void> => {
      try {
        await accept(await getLivePartnerSearch(rest, workspaceId, runId));
      } catch (error) {
        if (error instanceof RestError && error.status === 404 && !recoveredMissingRun) {
          recoveredMissingRun = true;
          forget(runKey);
          await begin();
          return;
        }
        show({ phase: 'error', snapshot: null, message: errorMessage(error) });
      }
    };

    const schedule = (runId: string): void => {
      timer = setTimeout(() => void load(runId), 1_200);
    };

    const accept = async (snapshot: PartnerScreeningSnapshot): Promise<void> => {
      remember(runKey, snapshot.run.id);
      if (snapshot.run.status === 'failed') {
        show({ phase: 'error', snapshot, message: snapshot.run.error_detail ?? 'The source search failed.' });
        return;
      }
      if (snapshot.handoff.candidate_ids.length === 0 &&
          !(snapshot.run.source === 'agentcash_people' && snapshot.run.status === 'running')) {
        show({ phase: 'complete', snapshot, message: null });
        return;
      }
      const agentRun = snapshot.handoff.agent_run;
      if (!agentRun) {
        if (!providerReady) {
          show({ phase: 'awaiting_provider', snapshot, message: null });
          return;
        }
        show({ phase: 'starting_iris', snapshot, message: null });
        handoffEnsured = true;
        try {
          await accept(await handoffLivePartnerSearch(rest, workspaceId, snapshot.run.id));
        } catch (error) {
          handoffEnsured = false;
          show({ phase: 'error', snapshot, message: errorMessage(error) });
        }
        return;
      }
      if (ACTIVE_RUNS.has(agentRun.status)) {
        // Re-entering onboarding also heals the narrow seam where the run row
        // committed but Workflow creation failed. The handoff endpoint is
        // idempotent and reconstructs the same Workflow instance in that case.
        if (providerReady && !handoffEnsured) {
          handoffEnsured = true;
          show({ phase: 'starting_iris', snapshot, message: null });
          try {
            await accept(await handoffLivePartnerSearch(rest, workspaceId, snapshot.run.id));
          } catch (error) {
            handoffEnsured = false;
            show({ phase: 'error', snapshot, message: errorMessage(error) });
          }
          return;
        }
        show({ phase: 'screening', snapshot, message: null });
        schedule(snapshot.run.id);
        return;
      }
      if (agentRun.status === 'completed') {
        show({ phase: 'complete', snapshot, message: null });
        return;
      }
      show({ phase: 'error', snapshot, message: `Iris stopped with status “${agentRun.status}”. The live evidence remains saved.` });
    };

    const begin = async (): Promise<void> => {
      show({ phase: 'searching', snapshot: null, message: null });
      try {
        const snapshot = await startLivePartnerSearch(
          rest,
          workspaceId,
          agentId,
          onboardingSearchKey(storageKey),
        );
        await accept(snapshot);
      } catch (error) {
        show({ phase: 'error', snapshot: null, message: errorMessage(error) });
      }
    };

    const runId = stored(runKey);
    if (runId) void load(runId);
    else void begin();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [agentId, enabled, providerReady, rest, retry, storageKey, workspaceId]);

  return { view, retry: useCallback(() => setRetry((value) => value + 1), []) };
}
