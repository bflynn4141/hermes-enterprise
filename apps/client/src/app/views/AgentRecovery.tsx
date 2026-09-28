// A wake is a durable admission request. Only the server can say whether Iris
// is queued, working, blocked or eligible to retry; a click is never progress.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TRACE, type AgentRecoveryView, type AgentWakeInput, type TraceEntity } from '@hermes/shared';
import type { Adapter } from '../../model/adapter.js';
import { RestError } from '../../model/rest.js';
import { entityData, uuid, type Store } from '../../model/store.js';
import { useAdapter, useAppState, useNav, useStore } from '../store-context.js';
import { catalogRows, LIST_KEYS } from '../selectors.js';
import { Button } from '../ui/primitives.js';
import { modelName } from '../copy/names.js';
import { runErrorSentence } from '../tool-copy.js';

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

/** Refusals the wake route writes, by reason. The server's text is never shown (docs/DESIGN.md). */
const WAKE_REFUSALS: Readonly<Record<string, string>> = {
  stale_attempt: 'This task changed. Refresh its status and try again.',
  expected_attempt_required: 'This task changed. Refresh its status and try again.',
  run_active: 'This task is already running.',
  run_completed: 'This task has already finished.',
  engine_paused: 'Hermes is updating. Try again in a moment.',
  unknown_run: 'This task isn’t available anymore.',
  platform_capacity: 'Hermes is at capacity right now. Try again in a few minutes.',
  max_concurrent_runs: 'This workspace is already running as many tasks as it allows. Try again when one finishes.',
  daily_token_cap: 'This workspace has used its daily allowance. Try again after it resets.',
  rate_limited: 'Too many requests right now. Wait a minute, then try again.',
};

function errorCopy(error: unknown, mutation: boolean): string {
  if (error instanceof RestError) {
    if (error.reason === 'unknown_route') return 'Recovery controls aren’t available yet. Refresh after the update finishes.';
    if (error.signedOut) return 'Sign in again to check or resume the agent.';
    if (error.reason === 'forbidden' || error.status === 403) return 'You do not have permission to resume this task.';
    if (error.reason === 'contract_violation') return 'The task’s status couldn’t be read. Refresh to check it.';
    const known = WAKE_REFUSALS[error.reason];
    if (known) return known;
  }
  return mutation
    ? 'Could not confirm the request. Refresh status or try again; the same request will be reused.'
    : 'Could not refresh the agent’s status. Try again shortly.';
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
        if (mounted.current) setError('The agent’s status is current, but the task details could not refresh. Refresh status to try again.');
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

/**
 * Server sentences on the recovery view that use words docs/DESIGN.md keeps off
 * the screen, rewritten. Everything else the recovery route writes is already
 * a plain sentence and is shown as written.
 */
const RECOVERY_REWRITES: Readonly<Record<string, string>> = {
  'The engine is paused for a deployment. Retry when it is ready.': 'Hermes is updating. Retry in a moment.',
  'The workspace reached its daily token limit. Retry after the limit resets or is updated.': 'This workspace has used its daily allowance. Retry after it resets or an Admin raises it.',
  'The provider requested an extended wait. Automatic retry is paused; check the model connection before retrying.': 'The model asked for a longer wait, so automatic retries are paused. Check the model connection before retrying.',
  'Reconnect the model provider in Settings before retrying.': 'Reconnect Nous Portal in Admin → Models before retrying.',
  'The failed attempt’s model settings are no longer available. Start a new turn instead.': 'The model this task used isn’t available anymore. Send a new message instead.',
  'This task already created reviewed work. Open its trace to continue without duplicating it.': 'This task already created reviewed work. Open what it did to continue without repeating it.',
  'This task reached a tool that may have changed something. Review its trace before starting another attempt.': 'This task may have already changed something. Review what it did before trying again.',
  'Scheduled work is not enabled in this environment.': 'Scheduled work isn’t turned on for this workspace.',
};

/** Words that mean the sentence was written for an operator, not a person. */
const TECHNICAL = /[a-z]+_[a-z_]+|ECONN|\b[45]\d\d\b|https?:|\bruntime\b|\bengine\b|\bprovider\b|\btoken\b|[{}]|Error:|failed with|\bHTTP\b/i;

const STATE_SENTENCE: Record<AgentRecoveryView['state'], string> = {
  idle: 'Nothing is running right now.',
  queued: 'Waiting to start.',
  working: 'Working on this task now.',
  waiting: 'Waiting for you.',
  retryable: 'This task stopped before it finished. You can retry it.',
  retry_scheduled: 'This task stopped before it finished. It will try again on its own.',
  blocked: 'This task can’t continue yet. Open what it did to see why.',
  stopped: 'This task was stopped. You can retry it when you’re ready.',
};

/**
 * The recovery view's sentence as a person should read it. When the server
 * fell back to the run's own error text, the run's reason is mapped instead;
 * a sentence written for an operator gets the plain one for its state.
 */
export function recoverySentence(view: AgentRecoveryView, runError?: { reason?: string | null; message?: string | null } | null): string {
  const message = view.message.trim();
  const rewritten = RECOVERY_REWRITES[message];
  if (rewritten) return rewritten;
  if (runError && runError.message?.trim() === message) return runErrorSentence(runError);
  if (!message || TECHNICAL.test(message)) return runError && view.state !== 'idle' ? runErrorSentence(runError) : STATE_SENTENCE[view.state];
  return message;
}

interface RecoveryControlsProps {
  view: AgentRecoveryView | null;
  /** The run's error, when the client has it, so its reason can be put into words. */
  runError?: { reason?: string | null; message?: string | null } | null;
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

export function AgentRecoveryControls({ view, runError, modelLabel, error, busy, loading, historical, now, onAction, onRefresh, onTrace }: RecoveryControlsProps) {
  const disabled = busy !== null || loading;
  return (
    <div className="agent-recovery" aria-label="Task recovery" data-recovery-state={view?.state ?? 'loading'} aria-busy={busy !== null || loading}>
      {loading && !view && <p className="meta">Checking task status…</p>}
      {view && <>
        <div className="agent-recovery-copy">
          <p aria-live="polite">{recoverySentence(view, runError)}</p>
          {view.state === 'retry_scheduled' && <p className="meta agent-recovery-countdown">{retryCountdown(view.next_retry_at, now)}</p>}
          {(view.attempt !== null || view.model_id) && <p className="meta">
            {view.attempt !== null && <span>{view.state === 'retry_scheduled' ? `Attempt ${view.attempt} of 3` : `Attempt ${view.attempt}`}</span>}
            {view.attempt !== null && view.model_id && ' · '}
            {view.model_id && <span>{view.can_retry ? 'Retry with ' : ''}{modelLabel ?? modelName(view.model_id)}</span>}
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
  const modelLabel = modelId ? modelName(modelId, catalogRows(state)) : null;
  const runId = recovery.view?.run_id ?? null;
  const liveRun = recovery.view?.session_id ? state.sessions[recovery.view.session_id]?.run : null;
  const runError = runId
    ? (liveRun?.id === runId ? liveRun.error : null) ?? entityData<TraceEntity>(state, 'trace', runId)?.error ?? null
    : null;
  return <AgentRecoveryControls {...recovery} runError={runError} {...(historical ? { historical } : {})} {...(modelLabel ? { modelLabel } : {})} now={now}
    onAction={(action) => void recovery.act(action)} onRefresh={() => void recovery.reload(true)} onTrace={(id) => nav(TRACE(id))} />;
}

export function AgentRecovery({ runId }: { runId: string }) {
  const recovery = useAgentRecovery(runId);
  return <RecoveryControlView recovery={recovery} historical />;
}
