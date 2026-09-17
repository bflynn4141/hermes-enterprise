import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { INBOX } from '@hermes/shared';
import { DEFAULT_PROVIDER } from '../../model/constants.js';
import { storeStepUp } from '../../model/auth.js';
import { useAdapter, useAppState, useNav } from '../store-context.js';
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
import { FirstRunLiveSearch, type LiveSearchPhase } from './FirstRunLiveSearch.js';
import { useFirstRunLiveSearch } from './useFirstRunLiveSearch.js';
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
 * The controller caches in-progress answers in workspace-scoped browser
 * storage, then persists the confirmed agreement before any source call.
 * Provider state is real and comes from the encrypted-key routes. The first
 * search is also real: the Worker persists bounded, approved-source evidence
 * before Iris is allowed to read it.
 */
export function useFirstRunExperience(active: boolean): FirstRunExperience | null {
  const app = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const storageKey = `hermes:first-run:${app.workspace.id}:${app.user.id}`;
  const [state, setState] = useState<FirstRunState>(() => loadState(storageKey));
  const [apiKey, setApiKey] = useState('');
  const [connectStatus, setConnectStatus] = useState<ProviderConnectStatus>({ kind: 'idle' });
  const [manualProviderFlow, setManualProviderFlow] = useState(false);
  const [storedKeyId, setStoredKeyId] = useState<string | null>(null);
  const [providerReady, setProviderReady] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupPersisted, setSetupPersisted] = useState(() => loadState(storageKey).step === 'test');
  const [provisioningStatus, setProvisioningStatus] = useState(app.agent.provisioningStatus);
  const provisioningReady = provisioningStatus === null || provisioningStatus === 'ready';
  // Bootstrap already projects whether a workspace model is runnable without
  // exposing provider-key rows. Members use that safe projection; only Admins
  // may inspect or change the underlying credential.
  const workspaceProviderReady = useMemo(() => Object.values(app.entities.catalog).some((entry) => {
    const model = entry.data as { enabled?: boolean; provider?: string } | null;
    return model?.provider === DEFAULT_PROVIDER && model.enabled === true;
  }), [app.entities.catalog]);
  const liveSearch = useFirstRunLiveSearch({
    enabled: active && setupPersisted && provisioningReady && state.step === 'test' && state.loopId === 'screen-partners' && Boolean(app.agent.id),
    providerReady,
    rest: adapter.rest,
    agentId: app.agent.id ?? '',
    workspaceId: app.workspace.id,
    storageKey: `${storageKey}:live-partner-screening`,
  });

  useEffect(() => {
    const saved = loadState(storageKey);
    setState(saved);
    setSetupPersisted(saved.step === 'test');
    setProvisioningStatus(app.agent.provisioningStatus);
  }, [app.agent.provisioningStatus, storageKey]);

  useEffect(() => {
    if (!active || !setupPersisted || !app.agent.id || provisioningReady) return;
    let live = true;
    const poll = (): void => {
      void adapter.rest.agentProvisioning(app.workspace.id, app.agent.id!).then(({ provisioning }) => {
        if (live) setProvisioningStatus(provisioning?.status ?? null);
      }).catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 4000);
    return () => { live = false; window.clearInterval(timer); };
  }, [active, adapter, app.agent.id, app.workspace.id, provisioningReady, setupPersisted]);

  useEffect(() => {
    if (!active) return;
    const intent = adapter.pendingStepUp();
    if (intent?.kind !== 'provider_key' || intent.providerFlow !== 'oauth') return;
    setManualProviderFlow(false);
    setConnectStatus({ kind: 'notice', message: 'Sign-in confirmed. Continue with Nous to approve this workspace.' });
    adapter.clearStepUp();
  }, [active, adapter]);

  useEffect(() => {
    if (!active || !app.workspace.id) return;
    if (app.workspace.role === 'member') {
      setProviderReady(workspaceProviderReady);
      setStoredKeyId(null);
      setManualProviderFlow(false);
      setConnectStatus(workspaceProviderReady ? { kind: 'connected', modelCount: null } : { kind: 'idle' });
      return;
    }
    let live = true;
    void adapter.rest.providerKeys(app.workspace.id).then(({ keys }) => {
      if (!live) return;
      const key = keys.find((row) => row.provider === DEFAULT_PROVIDER && row.status !== 'revoked');
      setManualProviderFlow(key?.credential_kind === 'api_key');
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
  }, [active, adapter, app.workspace.id, app.workspace.role, workspaceProviderReady]);

  const onAction = useCallback((action: FirstRunAction): void => {
    const next = firstRunReducer(state, action);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // A blocked storage write should not make the setup controls unusable.
    }
    setState(next);
    if (action.type === 'reviewers/confirm' && app.agent.id && next.roleId && next.loopId) {
      setSetupError(null);
      setSetupPersisted(false);
      void adapter.rest.patchAgent(app.workspace.id, app.agent.id, {
          first_run: {
            role_id: next.roleId,
            role_label: next.roleLabel,
            loop_id: next.loopId,
            reviewers: next.reviewers,
          },
        }).then(() => {
          setSetupPersisted(true);
          if (app.agent.provisioningStatus) setProvisioningStatus('queued');
        }).catch(() => {
          const rolledBack = { ...next, step: 'boundaries' as const };
          setSetupError('I could not save this setup. Try again.');
          setState(rolledBack);
          try { window.localStorage.setItem(storageKey, JSON.stringify(rolledBack)); } catch { /* Keep the in-memory rollback. */ }
        });
    }
  }, [adapter, app.agent.id, app.workspace.id, state, storageKey]);

  const onConnect = useCallback((): void => {
    const key = apiKey.trim();
    if (!key) return;
    setConnectStatus({ kind: 'connecting' });
    setManualProviderFlow(true);
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

  const onOAuthStart = useCallback((): void => {
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setManualProviderFlow(false);
    setConnectStatus({ kind: 'connecting' });
    void adapter.rest.startNousOAuth(app.workspace.id).then(async (started) => {
      if (started.status === 'unavailable') {
        popup?.close();
        setManualProviderFlow(true);
        setConnectStatus({ kind: 'oauth_unavailable', message: 'Hosted Nous sign-in is not enabled here yet. A workspace Admin can use an API key below.' });
        return;
      }
      if (popup) popup.location.href = started.verification_uri;
      setConnectStatus({ kind: 'authorizing', userCode: started.user_code, verificationUri: started.verification_uri });
      let delay = started.poll_after_ms;
      while (Date.now() < new Date(started.expires_at).getTime()) {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        const polled = await adapter.rest.pollNousOAuth(app.workspace.id, started.session_id);
        if (polled.status === 'pending') { delay = polled.poll_after_ms; continue; }
        popup?.close();
        if (polled.status === 'connected') {
          setStoredKeyId(polled.key.id); setProviderReady(true);
          setConnectStatus({ kind: 'connected', modelCount: polled.synced?.count ?? polled.key.synced_model_count });
        } else {
          setConnectStatus({ kind: 'error', message: polled.status === 'expired' ? 'Nous sign-in expired. Start again.' : 'Nous could not connect this workspace. Start again.' });
        }
        return;
      }
      popup?.close(); setConnectStatus({ kind: 'error', message: 'Nous sign-in expired. Start again.' });
    }).catch((caught: unknown) => {
      popup?.close();
      const error = caught as { status?: number; reason?: string };
      if (error.status === 401 && error.reason === 'reauth_required') {
        storeStepUp({ kind: 'provider_key', providerFlow: 'oauth', returnTo: window.location.href });
        const url = adapter.auth.stepUpUrl(window.location.href, 'provider_key');
        if (url) {
          window.location.assign(url);
          return;
        }
      }
      setConnectStatus(error.reason === 'oauth_not_configured'
        ? { kind: 'oauth_unavailable', message: 'Hosted Nous sign-in is not enabled here yet. A workspace Admin can use an API key below.' }
        : { kind: 'error', message: 'Could not start Nous sign-in. Try again.' });
      if (error.reason === 'oauth_not_configured') setManualProviderFlow(true);
    });
  }, [adapter, app.workspace.id]);

  const phase = providerPhase(connectStatus, providerReady);
  const liveSearchStatus = useMemo(() => {
    if (setupPersisted && !provisioningReady) {
      if (provisioningStatus === 'failed') return 'provisioning_error' as const;
      return 'provisioning' as const;
    }
    const byPhase: Record<LiveSearchPhase, 'idle' | 'searching' | 'awaiting_provider' | 'screening' | 'complete' | 'error'> = {
      idle: setupPersisted && state.step === 'test' && state.loopId === 'screen-partners' && app.agent.id ? 'searching' : 'idle',
      searching: 'searching',
      awaiting_provider: 'awaiting_provider',
      starting_iris: 'screening',
      screening: 'screening',
      complete: 'complete',
      error: 'error',
    };
    return byPhase[liveSearch.view.phase];
  }, [app.agent.id, liveSearch.view.phase, provisioningReady, provisioningStatus, setupPersisted, state.loopId, state.step]);
  const completedLiveStages = useMemo(() => {
    const snapshot = liveSearch.view.snapshot;
    const stages: string[] = [];
    if (snapshot?.candidates.length) stages.push('Discovery');
    if (snapshot?.handoff.agent_run) stages.push('Public research');
    if (snapshot?.candidates.some((item) => item.existing_request_id)) stages.push('Evidence brief');
    return stages;
  }, [liveSearch.view.snapshot]);
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
      onOAuthStart={onOAuthStart}
      preferManual={manualProviderFlow}
      connectLabel="Connect and continue"
    />
  ), [apiKey, connectStatus, manualProviderFlow, onConnect, onOAuthStart, onRetry, storedKeyId]);

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
        setupError={setupError}
        liveSearchStatus={liveSearchStatus}
        completedLiveStages={completedLiveStages}
        onRetryLiveSearch={liveSearch.retry}
        onOpenInbox={() => nav(INBOX)}
      />
    ),
    agreement: (
      <div className="first-run-app-surface">
        <FirstRunProgress current={state.step} />
        {state.step === 'test' && state.loopId === 'screen-partners' && provisioningReady ? (
          <FirstRunLiveSearch view={liveSearch.view} onRetry={liveSearch.retry} onOpenInbox={() => nav(INBOX)} />
        ) : <FirstRunWorkingAgreement state={state} />}
      </div>
    ),
  };
}
