// The app pane: breadcrumb, the follow/pin control, and the view the current
// ref names.
//
// `describe()` reads the entity cache rather than a fixture map, so a ref whose
// entity has not arrived yet renders the 300 ms skeleton and then either the
// object or its empty copy — never "Request not found" as a first impression.
// Follow/pin behaviour is unchanged from the demo.
import { useMemo, type ReactNode, type RefObject } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import type { RequestEntity } from '@hermes/shared';
import { useAppState, useDispatch } from '../store-context.js';
import { Icon } from '../ui/icons.js';
import { Button, IconButton } from '../ui/primitives.js';
import { AgentOverview, AgentTraces, TraceDetail, Setup } from './Agent.js';
import { AgentSkillsSettings } from './AgentSkillsSettings.js';
import { AgentContextSettings } from './AgentContextSettings.js';
import { AgentPermissions } from './AgentPermissions.js';
import { InboxList, RequestReview } from './Inbox.js';
import { AdminSettings, History, Members, Library, Settings } from './Workspace.js';
import { agentName } from '../selectors.js';
import { TOGGLE_SHORTCUT } from '../panel.js';
import { entityData } from '../../model/store.js';
import type { AppState } from '../../model/store.js';
import { ADMIN_SETTINGS_LABELS } from '../../model/constants.js';

const SECTION_LABEL: Record<string, string> = { agents: 'Agents', inbox: 'Inbox', members: 'Members', admin: 'Admin', history: 'History', library: 'Library', settings: 'Settings' };

function describe(state: AppState): [string, string] {
  const app = state.ui.app;
  const agent = agentName(state);
  const section = app.section;
  const view = app.view;
  if (section === 'agents') {
    if (view === 'setup') return [agent, `${agent} / Ready to start`];
    if (view === 'trace') return [agent, `${agent} / Run detail`];
    if (view === 'traces') return [agent, `${agent} / Traces`];
    if (view === 'context') return [agent, app.field ? `${agent} / ${app.field}` : `${agent} / Context`];
    if (view === 'skills') return [agent, `${agent} / Skills`];
    if (view === 'permissions') return [agent, `${agent} / Permissions`];
    return [agent, `${agent} / Overview`];
  }
  if (section === 'inbox') {
    if (view === 'request') {
      const request = entityData<RequestEntity>(state, 'request', app.id);
      return [request?.kind === 'approval' ? 'Approval' : request?.kind === 'invoice' ? 'Invoice' : request?.kind === 'agreement' ? 'Agreement' : request?.label ?? 'Request', 'Review'];
    }
    const label = state.ui.inboxTab === 'resolved' ? 'Resolved' : state.ui.inboxTab === 'rules' ? 'Rules' : 'Needs review';
    return [label, label];
  }
  if (section === 'members') return ['Team', 'Members and invitations'];
  if (section === 'admin') {
    const label = ADMIN_SETTINGS_LABELS[app.view ?? 'Organization'] ?? 'Organization';
    return [label, label];
  }
  if (section === 'history') return ['History', { all: 'All activity', decisions: 'Decisions', blocked: 'Blocked' }[state.ui.historyTab] ?? 'Decisions'];
  if (section === 'library') {
    const label = { skills: 'Shared skills', documents: 'Documents', connections: 'Connections', intelligence: 'Shared Intelligence' }[view ?? 'skills'] ?? 'Skills';
    return [label, label];
  }
  if (section === 'settings') return [app.view ?? 'Notifications', app.view ?? 'Notifications'];
  return ['', ''];
}

export function AppPane({ narrow, active, paneRef, firstRun = null }: { narrow: boolean; active: boolean; paneRef?: RefObject<HTMLElement | null>; firstRun?: ReactNode }) {
  const state = useAppState();
  const systemReduceMotion = useReducedMotion();
  const dispatch = useDispatch();
  const app = state.ui.app;
  const session = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
  const following = state.ui.follow;
  const agent = agentName(state);
  const [crumb, sub] = describe(state);
  const key = `${app.section}/${app.view ?? ''}/${app.id ?? ''}/${app.sub ?? ''}/${app.step ?? ''}/${app.field ?? ''}`;

  const view = useMemo(() => {
    if (app.section === 'agents') {
      if (app.view === 'setup') return <Setup step={app.step ?? 'ready'} />;
      if (app.view === 'context') return <AgentContextSettings field={app.field ?? null} />;
      if (app.view === 'permissions') return <AgentPermissions />;
      if (app.view === 'skills') return <AgentSkillsSettings />;
      if (app.view === 'traces') return <AgentTraces />;
      if (app.view === 'trace') return <TraceDetail id={app.id ?? null} />;
      return <AgentOverview />;
    }
    if (app.section === 'inbox') return app.view === 'request' ? <RequestReview id={app.id ?? null} /> : <InboxList />;
    if (app.section === 'members') return <Members />;
    if (app.section === 'admin') return <AdminSettings view={app.view ?? 'Organization'} />;
    if (app.section === 'history') return <History />;
    if (app.section === 'library') return <Library view={app.view ?? 'skills'} id={app.id ?? null} />;
    if (app.section === 'settings') return <Settings view={app.view ?? 'Notifications'} />;
    return <AgentOverview />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const agentView = app.section === 'agents';
  const requestView = app.section === 'inbox' && app.view === 'request';
  const followControl = following ? (
    <button type="button" className="follow-btn" aria-label={`Following ${agent}`} aria-pressed onClick={() => dispatch({ type: 'ui/set', patch: { follow: false } })} title={`The app follows ${agent}'s object changes · Click to pin this view`}>
      Following {agent}
    </button>
  ) : (
    <>
      <span className="follow-btn follow-status" title="Manual navigation pinned this view">View pinned</span>
      <button type="button" className="follow-btn ghost" aria-label={`Follow ${agent}`} onClick={() => dispatch({ type: 'follow/resume' })} title={session?.focus ? `Return to the object ${agent} is working on` : `Resume following ${agent}`}>
        Follow {agent}
      </button>
    </>
  );

  return (
    // `tabIndex={-1}` is not decoration: collapsing the panel with the composer
    // focused has to put focus somewhere, and "the thing that now owns the
    // screen" is the only defensible answer.
    <section ref={paneRef} tabIndex={-1} className="pane pane-app" data-active={active} aria-label="Application">
      <header className={`pane-header${requestView ? ' request-pane-header' : ''}`}>
        <span className="breadcrumb">
          <span>{SECTION_LABEL[app.section] ?? 'Agents'}</span>
          <span>/</span>
          <span className="current truncate">{crumb}</span>
        </span>
        <span className="grow" />
        {(agentView || requestView) && followControl}
        {narrow && (
          <span className="pane-switch" role="group" aria-label="Pane">
            <button type="button" aria-pressed={false} onClick={() => dispatch({ type: 'ui/set', patch: { pane: 'chat' } })}>
              Chat
            </button>
            <button type="button" aria-pressed>
              App
            </button>
          </span>
        )}
        {state.ui.irisPanel === 'open' ? (
          <IconButton name="expand" label={`Hide ${agent} ${TOGGLE_SHORTCUT}`} onClick={() => dispatch({ type: 'iris/panel', panel: 'rail' })} />
        ) : (
          <Button small onClick={() => dispatch({ type: 'iris/panel', panel: 'open' })}>
            <Icon name="open" size={16} /> Open {agent}
          </Button>
        )}
      </header>
      {!agentView && !requestView && <div className="pane-subheader">
        <span className="truncate">{sub}</span>
        <span className="grow" />
        {followControl}
      </div>}
      <motion.div key={key} className={`object-view${firstRun ? ' object-view-first-run' : ''}`} initial={systemReduceMotion || state.ui.reduceMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}>
        {firstRun ?? view}
      </motion.div>
    </section>
  );
}
