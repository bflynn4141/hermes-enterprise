import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { INBOX } from '@hermes/shared';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import {
  FirstRunConversation,
  FirstRunProgress,
  FirstRunWorkingAgreement,
  createFirstRunState,
  firstRunReducer,
  type FirstRunAction,
  type FirstRunState,
  type IrisReadyStatus,
} from './FirstRunSetup.js';
import './FirstRunSetup.css';

interface FirstRunExperience {
  conversation: ReactNode;
  agreement: ReactNode;
}

const isFirstRunState = (value: unknown): value is FirstRunState => {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<FirstRunState>;
  return ['intro', 'criteria', 'boundaries', 'ready'].includes(state.step ?? '')
    && typeof state.partnerCriteria === 'string'
    && !!state.reviewers && typeof state.reviewers === 'object';
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

/** The invited-member flow configures work; infrastructure was reserved before email delivery. */
export function useFirstRunExperience(active: boolean): FirstRunExperience | null {
  const app = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const storageKey = `hermes:first-run:${app.workspace.id}:${app.user.id}`;
  const [state, setState] = useState<FirstRunState>(() => loadState(storageKey));
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupPersisted, setSetupPersisted] = useState(() => loadState(storageKey).step === 'ready');
  const [provisioningStatus, setProvisioningStatus] = useState(app.agent.provisioningStatus);

  useEffect(() => {
    const saved = loadState(storageKey);
    setState(saved);
    setSetupPersisted(saved.step === 'ready');
    setProvisioningStatus(app.agent.provisioningStatus);
  }, [app.agent.provisioningStatus, storageKey]);

  useEffect(() => {
    if (!active || !setupPersisted || !app.agent.id || provisioningStatus === null || provisioningStatus === 'ready') return;
    let live = true;
    const poll = (): void => {
      void adapter.rest.agentProvisioning(app.workspace.id, app.agent.id!).then(({ provisioning }) => {
        if (live) setProvisioningStatus(provisioning?.status ?? null);
      }).catch(() => undefined);
    };
    poll();
    const timer = window.setInterval(poll, 4000);
    return () => { live = false; window.clearInterval(timer); };
  }, [active, adapter, app.agent.id, app.workspace.id, provisioningStatus, setupPersisted]);

  const onAction = useCallback((action: FirstRunAction): void => {
    const next = firstRunReducer(state, action);
    const completing = action.type === 'reviewers/confirm' && !!app.agent.id;
    if (!completing) {
      try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep in-memory state. */ }
    }
    setState(next);
    if (!completing || !app.agent.id) return;
    setSetupError(null);
    setSetupPersisted(false);
    void adapter.rest.patchAgent(app.workspace.id, app.agent.id, {
      first_run: {
        role_id: 'partner-program',
        role_label: 'Partner Program',
        loop_id: 'screen-partners',
        partner_criteria: next.partnerCriteria,
        reviewers: next.reviewers,
      },
    }).then(() => {
      try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep in-memory state. */ }
      setSetupPersisted(true);
    }).catch(() => {
      const rolledBack = { ...next, step: 'boundaries' as const };
      setSetupError('I could not save this working agreement. Try again.');
      setState(rolledBack);
      try { window.localStorage.setItem(storageKey, JSON.stringify(rolledBack)); } catch { /* Keep in memory. */ }
    });
  }, [adapter, app.agent.id, app.workspace.id, state, storageKey]);

  const irisStatus: IrisReadyStatus = !setupPersisted
    ? state.step === 'ready' ? 'getting_ready' : 'idle'
    : provisioningStatus === 'ready' || provisioningStatus === null
      ? 'ready'
      : provisioningStatus === 'retrying'
        ? 'retrying'
        : 'getting_ready';

  if (!active) return null;
  return {
    conversation: <FirstRunConversation state={state} onAction={onAction} agentName={app.agent.name}
      setupError={setupError} irisStatus={irisStatus} onOpenInbox={() => nav(INBOX)} />,
    agreement: <div className="first-run-app-surface"><FirstRunProgress current={state.step} />
      <FirstRunWorkingAgreement state={state} /></div>,
  };
}
