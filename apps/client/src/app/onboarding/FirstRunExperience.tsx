import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_PROVIDER } from '../../model/constants.js';
import { useAdapter, useAppState } from '../store-context.js';
import { ProviderConnect, type ProviderConnectStatus } from '../providers/ProviderConnect.js';
import {
  FirstRunConversation,
  FirstRunProgress,
  FirstRunWorkingAgreement,
  createFirstRunState,
  firstRunReducer,
  type FirstRunAction,
  type FirstRunState,
  type ProviderStatus,
} from './FirstRunSetup.js';
import './FirstRunSetup.css';

interface FirstRunExperience {
  conversation: ReactNode;
  agreement: ReactNode;
}

const isFirstRunState = (value: unknown): value is FirstRunState => {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<FirstRunState>;
  return (
    ['role', 'loop', 'boundaries', 'test'].includes(state.step ?? '') &&
    typeof state.roleLabel === 'string' &&
    typeof state.loopConfirmed === 'boolean' &&
    !!state.reviewers &&
    typeof state.reviewers === 'object'
  );
};

function loadState(key: string): FirstRunState {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return createFirstRunState();
    const parsed: unknown = JSON.parse(raw);
    return isFirstRunState(parsed) ? parsed : createFirstRunState();
  } catch {
    return createFirstRunState();
  }
}

function providerPhase(status: ProviderConnectStatus, ready: boolean): ProviderStatus {
  if (ready || status.kind === 'connected') return 'ready';
  if (status.kind === 'connecting') return 'verifying';
  if (status.kind === 'retrying') return 'verifying';
  if (status.kind === 'error' || status.kind === 'invalid') return 'error';
  return 'disconnected';
}

/**
 * Preview-branch controller for the guided first run.
 *
 * The durable workspace/agent/session creation contract lives in main. This
 * controller intentionally keeps the evolving UX answers in workspace-scoped
 * browser storage until the setup endpoint proposed in the design note is
 * reviewed. Provider state is real and comes from the existing encrypted-key
 * routes; no progress state is simulated.
 */
export function useFirstRunExperience(active: boolean): FirstRunExperience | null {
  const app = useAppState();
  const adapter = useAdapter();
  const storageKey = `hermes:first-run:${app.workspace.id}:${app.user.id}`;
  const [state, setState] = useState<FirstRunState>(() => loadState(storageKey));
  const [apiKey, setApiKey] = useState('');
  const [connectStatus, setConnectStatus] = useState<ProviderConnectStatus>({ kind: 'idle' });
  const [storedKeyId, setStoredKeyId] = useState<string | null>(null);
  const [providerReady, setProviderReady] = useState(false);

  useEffect(() => {
    setState(loadState(storageKey));
  }, [storageKey]);

  useEffect(() => {
    if (!active || !app.workspace.id) return;
    let live = true;
    void adapter.rest.providerKeys(app.workspace.id).then(({ keys }) => {
      if (!live) return;
      const key = keys.find((row) => row.provider === DEFAULT_PROVIDER && row.status !== 'revoked');
      const ready = key?.status === 'verified' || key?.status === 'verified_scoped';
      setProviderReady(ready);
      setStoredKeyId(key?.id ?? null);
      if (ready) setConnectStatus({ kind: 'connected', modelCount: key.synced_model_count });
      else if (key?.status === 'invalid') setConnectStatus({ kind: 'invalid', message: 'Nous Portal did not accept the saved key. Check it in Nous Portal, then retry verification.' });
      else if (key) setConnectStatus({ kind: 'pending', message: 'The key is saved but verification has not finished. Try again; you do not need to paste it again.' });
    }).catch((caught: unknown) => {
      if (!live) return;
      const error = caught as { status?: number; reason?: string };
      // A stale session cannot inspect stored key metadata, but it can still
      // begin the connection flow. Do not turn that privacy boundary into a
      // frightening first-run error.
      if (error.status === 401 && error.reason === 'reauth_required') {
        setConnectStatus({ kind: 'idle' });
        return;
      }
      setConnectStatus({ kind: 'error', message: 'Nous Portal status could not be loaded. Try again.' });
    });
    return () => {
      live = false;
    };
  }, [active, adapter, app.workspace.id]);

  const onAction = useCallback((action: FirstRunAction): void => {
    setState((current) => {
      const next = firstRunReducer(current, action);
      try {
        window.localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        // A blocked storage write should not make the setup controls unusable.
      }
      return next;
    });
  }, [storageKey]);

  const onConnect = useCallback((): void => {
    const key = apiKey.trim();
    if (!key) return;
    setConnectStatus({ kind: 'connecting' });
    void adapter.rest.addProviderKey(app.workspace.id, { provider: DEFAULT_PROVIDER, key }).then((result) => {
      setApiKey('');
      setStoredKeyId(result.key.id);
      const ready = result.verification.status === 'verified' || result.verification.status === 'verified_scoped';
      setProviderReady(ready);
      if (ready) setConnectStatus({ kind: 'connected', modelCount: result.key.synced_model_count });
      else if (result.verification.status === 'invalid' || result.verification.reason === 'rejected') {
        setConnectStatus({ kind: 'invalid', message: 'Nous Portal did not accept this key. Check it in Nous Portal, then retry verification.' });
      } else {
        setConnectStatus({ kind: 'pending', message: 'The key is encrypted and saved, but verification has not finished. Try again; you do not need to paste it again.' });
      }
    }).catch((caught: unknown) => {
      const error = caught as { reason?: string };
      setConnectStatus({
        kind: 'error',
        message: error.reason === 'not_admin'
          ? 'A workspace Admin must connect the Nous Portal key.'
          : error.reason === 'reauth_required'
            ? 'A recent sign-in is required. Open Settings → Organization to connect Nous Portal.'
            : 'The key could not be saved. Check it in Nous Portal and try again.',
      });
    });
  }, [adapter, apiKey, app.workspace.id]);

  const onRetry = useCallback((): void => {
    if (!storedKeyId) return;
    setConnectStatus({ kind: 'retrying', message: 'Checking the saved key with Nous Portal…' });
    void adapter.rest.verifyProviderKey(app.workspace.id, storedKeyId).then((result) => {
      const ready = result.status === 'verified' || result.status === 'verified_scoped';
      setProviderReady(ready);
      setConnectStatus(ready
        ? { kind: 'connected', modelCount: result.synced?.count ?? null }
        : result.status === 'invalid' || result.reason === 'rejected'
          ? { kind: 'invalid', message: 'Nous Portal did not accept the saved key. Check it in Nous Portal, then retry verification.' }
          : { kind: 'pending', message: 'The saved key is still waiting for verification. Try again shortly.' });
    }).catch(() => setConnectStatus({ kind: 'pending', message: 'Verification did not finish. The key remains encrypted and saved; try again shortly.' }));
  }, [adapter, app.workspace.id, storedKeyId]);

  const phase = providerPhase(connectStatus, providerReady);
  const providerSlot = useMemo(() => (
    <ProviderConnect
      apiKey={apiKey}
      onApiKeyChange={(value) => {
        setApiKey(value);
        if (connectStatus.kind === 'error') setConnectStatus({ kind: 'idle' });
      }}
      status={connectStatus}
      onConnect={onConnect}
      onRetry={storedKeyId ? onRetry : undefined}
      connectLabel="Connect and continue"
    />
  ), [apiKey, connectStatus, onConnect, onRetry, storedKeyId]);

  if (!active) return null;
  return {
    conversation: (
      <FirstRunConversation
        state={state}
        onAction={onAction}
        agentName={app.agent.name}
        ownerName={app.user.name || 'You'}
        providerStatus={phase}
        providerSlot={providerSlot}
      />
    ),
    agreement: (
      <div className="first-run-app-surface">
        <FirstRunProgress current={state.step} />
        <FirstRunWorkingAgreement state={state} />
      </div>
    ),
  };
}
