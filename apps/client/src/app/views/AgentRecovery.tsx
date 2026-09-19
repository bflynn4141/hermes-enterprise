// A wake is a durable admission request. Only the server can say whether Iris
// is queued, working, blocked or eligible to retry; a click is never progress.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TRACE, type AgentRecoveryView, type AgentWakeInput } from '@hermes/shared';
import type { Adapter } from '../../model/adapter.js';
import { RestError } from '../../model/rest.js';
import { uuid, type Store } from '../../model/store.js';
import { useAdapter, useAppState, useNav, useStore } from '../store-context.js';
import { catalogRows, LIST_KEYS } from '../selectors.js';
import { Button } from '../ui/primitives.js';

const POLL_MS = 15_000;
type WakeAction = AgentWakeInput['action'];

export const RECOVERY_STATUS: Record<AgentRecoveryView['state'], string> = {
  idle: 'Idle', queued: 'Queued', working: 'Working now', waiting: 'Waiting for you',
  retryable: 'Needs attention', retry_scheduled: 'Retry scheduled', blocked: 'Needs attention', stopped: 'Stopped',
};

export function retryCountdown(nextRetryAt: string | null, now: number): string {
  if (!nextRetryAt) return 'Retry scheduled';
  const seconds = Math.max(0, Math.ceil((Date.parse(nextRetryAt) - now) / 1000));
  if (!Number.isFinite(seconds)) return 'Retry scheduled';
  if (seconds === 0) return 'Retry due · Waiting for the scheduler';
  return seconds < 60 ? `Retrying in ${seconds}s` : `Retrying in ${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** A network failure can happen after admission, so the next click reuses its key. */
export function createRecoverySubmitter(send: (input: AgentWakeInput) => Promise<AgentRecoveryView>) {
  const keys = new Map<string, string>();
  let pending: Promise<AgentRecoveryView> | null = null;
  return {
    get pending() { return pending !== null; },
    submit(action: WakeAction, view: AgentRecoveryView): Promise<AgentRecoveryView> {
      if (pending) return pending;
      const identity = `${action}:${view.run_id ?? ''}:${view.attempt ?? ''}`;
      const idempotencyKey = keys.get(identity) ?? uuid();
      keys.set(identity, idempotencyKey);
      const input: AgentWakeInput = {
        action, idempotency_key: idempotencyKey,
        ...(action !== 'run_now' && view.run_id ? { run_id: view.run_id } : {}),
        ...(action !== 'run_now' && view.attempt !== null ? { expected_attempt: view.attempt } : {}),
      };
      pending = Promise.resolve().then(() => send(input)).then((result) => {
        keys.delete(identity);
        return result;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}

function errorCopy(error: unknown, mutation: boolean): string {
  if (error instanceof RestError) {
    if (error.reason === 'unknown_route') return 'Recovery controls are unavailable on this server. Refresh after the update finishes.';
    if (error.signedOut) return 'Sign in again to check or resume Iris.';
    if (error.reason === 'forbidden' || error.status === 403) return 'You do not have permission to resume this task.';
    if (error.reason === 'contract_violation') return 'The recovery response could not be read. Refresh to check the current status.';
    if (error.status < 500) return error.message;
  }
  return mutation
    ? 'Could not confirm the request. Refresh status or try again; the same request will be reused.'
    : 'Could not refresh Iris’s status. Try again shortly.';
}

/** Refreshes the existing cache without resetting navigation, drafts or transcript. */
export async function refreshRecoveryContext(adapter: Adapter, store: Store, workspaceId: string, agentId: string, view: AgentRecoveryView, initial = false): Promise<void> {
  const before = view.session_id ? store.getState().sessions[view.session_id]?.run : null;
  if (initial && before && (before.id !== view.run_id || before.attempt >= (view.attempt ?? 0))) return;
  if (!initial) {
    for (const key of [LIST_KEYS.traces, LIST_KEYS.requests, LIST_KEYS.documents, LIST_KEYS.history]) adapter.invalidateList(key);
    if (view.run_id) adapter.ensure('trace', view.run_id, true);
  }
  const sessions = await adapter.rest.sessions(workspaceId);
  if (store.getState().workspace.id !== workspaceId) return;
  for (const session of sessions.items) store.dispatch({ type: 'session/upsert', session });
  if (!view.run_id || !view.session_id || view.attempt === null) return;
  const snapshot = await adapter.rest.sessionSnapshot(workspaceId, view.session_id);
  const run = snapshot.run;
  if (store.getState().workspace.id !== workspaceId) return;
  const current = store.getState().sessions[view.session_id];
  if (!current || !run || run.id !== view.run_id || run.agent_id !== agentId || run.attempt < view.attempt) return;
  // A newer stream event or another task must not be overwritten by this GET.
  if (current.run && current.run.id !== view.run_id && current.run !== before) return;
  if (current.run?.id === view.run_id && current.run.attempt > run.attempt) return;
  store.dispatch({ type: 'session/snapshot', snapshot });
}

export function useAgentRecovery(runId?: string) {
  const adapter = useAdapter();
  const store = useStore();
  const state = useAppState();
  const workspaceId = state.workspace.id;
  const agentId = state.agent.id;
  const [view, setView] = useState<AgentRecoveryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<WakeAction | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const lastSignature = useRef('');
  const readPending = useRef<object | null>(null);
  const mounted = useRef(false);
  const submitter = useMemo(() => createRecoverySubmitter((input) => adapter.rest.wakeAgent(workspaceId, agentId!, input)), [adapter, workspaceId, agentId]);

  const accept = useCallback((next: AgentRecoveryView, { forceRefresh = false, refresh = true } = {}) => {
    setView(next);
    const signature = `${next.state}:${next.run_id}:${next.attempt}:${next.model_id}`;
    // A reload starts after the run.started event. Restore active run details
    // on the first read too, so the existing Stop control has its run id even
    // when the provider has not emitted output. Historical failures stay inert.
    const initialActive = !lastSignature.current && (next.state === 'working' || next.state === 'queued');
    if (refresh && (forceRefresh || initialActive || (lastSignature.current && signature !== lastSignature.current))) {
      void refreshRecoveryContext(adapter, store, workspaceId, agentId!, next, initialActive && !forceRefresh).catch(() => {
        if (mounted.current) setError('Iris’s status is current, but the task details could not refresh. Refresh status to try again.');
      });
    }
    lastSignature.current = signature;
  }, [adapter, store, workspaceId, agentId]);

  const reload = useCallback(async (refreshDetails = false) => {
    if (!agentId || readPending.current || submitter.pending) return;
    const requestGeneration = generation.current;
    const requestToken = {};
    readPending.current = requestToken;
    try {
      const next = await adapter.rest.agentRecovery(workspaceId, agentId, runId);
      if (!mounted.current || requestGeneration !== generation.current) return;
      setError(null);
      accept(next, { forceRefresh: refreshDetails });
    } catch (failure) {
      if (mounted.current && requestGeneration === generation.current) setError(errorCopy(failure, false));
    } finally {
      if (readPending.current === requestToken) readPending.current = null;
      if (mounted.current && requestGeneration === generation.current) setLoading(false);
    }
  }, [adapter, workspaceId, agentId, runId, submitter, accept]);

  useEffect(() => {
    mounted.current = true;
    generation.current += 1;
    lastSignature.current = '';
    readPending.current = null;
    setView(null);
    setLoading(Boolean(agentId));
    setError(null);
    setBusy(null);
    void reload();
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => { mounted.current = false; generation.current += 1; clearInterval(timer); };
  }, [reload, agentId]);

  // Socket status changes can beat the idle polling cadence. A tool delta is
  // deliberately excluded, so streamed output does not trigger extra reads.
  const runRevision = Object.values(state.sessions).filter((session) => session.agentId === agentId)
    .map((session) => `${session.run?.id}:${session.run?.attempt}:${session.run?.status}`).join('|');
  useEffect(() => { void reload(); }, [runRevision, reload]);

  const act = async (action: WakeAction): Promise<void> => {
    if (!view || !agentId || submitter.pending) return;
    if ((action === 'retry' && !view.can_retry) || (action === 'run_now' && (!view.can_run_now || runId)) || (action === 'cancel_retry' && !view.can_cancel)) return;
    generation.current += 1;
    const requestGeneration = generation.current;
    setBusy(action);
    setError(null);
    try {
      const next = await submitter.submit(action, view);
      if (!mounted.current || generation.current !== requestGeneration) return;
      // A successful no-op wake also refreshes the workspace's pending work.
      accept(next, { refresh: false });
      await refreshRecoveryContext(adapter, store, workspaceId, agentId, next).catch(() => {
        if (mounted.current) setError('Request accepted, but the task details could not refresh. Refresh status to try again.');
      });
    } catch (failure) {
      if (mounted.current && generation.current === requestGeneration) setError(errorCopy(failure, true));
    } finally {
      if (mounted.current && generation.current === requestGeneration) setBusy(null);
    }
  };

  return { view, error, busy, loading, reload, act };
}

interface RecoveryControlsProps {
  view: AgentRecoveryView | null;
  modelLabel?: string | null;
  error: string | null;
  busy: WakeAction | null;
  loading: boolean;
  historical?: boolean;
  now: number;
  onAction: (action: WakeAction) => void;
  onRefresh: () => void;
  onTrace: (runId: string) => void;
}

export function AgentRecoveryControls({ view, modelLabel, error, busy, loading, historical, now, onAction, onRefresh, onTrace }: RecoveryControlsProps) {
  const disabled = busy !== null || loading;
  return (
    <div className="agent-recovery" aria-label="Task recovery" data-recovery-state={view?.state ?? 'loading'} aria-busy={busy !== null || loading}>
      {loading && !view && <p className="meta">Checking task status…</p>}
      {view && <>
        <div className="agent-recovery-copy">
          <p aria-live="polite">{view.message}</p>
          {view.state === 'retry_scheduled' && <p className="meta agent-recovery-countdown">{retryCountdown(view.next_retry_at, now)}</p>}
          {(view.attempt !== null || view.model_id) && <p className="meta">
            {view.attempt !== null && <span>{view.state === 'retry_scheduled' ? `Attempt ${view.attempt} of 3` : `Attempt ${view.attempt}`}</span>}
            {view.attempt !== null && view.model_id && ' · '}
            {view.model_id && <span title={view.model_id}>{view.can_retry ? 'Retry with ' : ''}{modelLabel ?? view.model_id}</span>}
          </p>}
        </div>
        <div className="agent-recovery-actions">
          {view.can_retry && <Button primary disabled={disabled} onClick={() => onAction('retry')}>{busy === 'retry' ? 'Requesting retry…' : 'Retry task'}</Button>}
          {!historical && view.can_run_now && <Button primary disabled={disabled} onClick={() => onAction('run_now')}>{busy === 'run_now' ? 'Checking work…' : 'Run now'}</Button>}
          {view.can_cancel && <Button disabled={disabled} onClick={() => onAction('cancel_retry')}>{busy === 'cancel_retry' ? 'Cancelling retry…' : 'Cancel retry'}</Button>}
          {!historical && view.run_id && (view.state === 'working' || view.state === 'queued') && <Button link onClick={() => onTrace(view.run_id!)}>Open current task →</Button>}
        </div>
      </>}
      {error && <div className="agent-recovery-error"><p role="alert">{error}</p><Button disabled={disabled} onClick={onRefresh}>Refresh status</Button></div>}
    </div>
  );
}

export function RecoveryControlView({ recovery, historical }: { recovery: ReturnType<typeof useAgentRecovery>; historical?: boolean }) {
  const state = useAppState();
  const nav = useNav();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (recovery.view?.state !== 'retry_scheduled') return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [recovery.view?.state, recovery.view?.next_retry_at]);
  const modelId = recovery.view?.model_id;
  const modelLabel = modelId === 'nous:deepseek/deepseek-v4.1-flash'
    ? 'DeepSeek V4.1 Flash'
    : catalogRows(state).find((model) => model.model_id === modelId)?.label;
  return <AgentRecoveryControls {...recovery} {...(historical ? { historical } : {})} {...(modelLabel ? { modelLabel } : {})} now={now}
    onAction={(action) => void recovery.act(action)} onRefresh={() => void recovery.reload(true)} onTrace={(id) => nav(TRACE(id))} />;
}

export function AgentRecovery({ runId }: { runId: string }) {
  const recovery = useAgentRecovery(runId);
  return <RecoveryControlView recovery={recovery} historical />;
}
