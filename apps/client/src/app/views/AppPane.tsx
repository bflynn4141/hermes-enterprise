// The app pane: a compact breadcrumb and the view the current ref names.
//
// `describe()` reads the entity cache rather than a fixture map, so a ref whose
// entity has not arrived yet renders the 300 ms skeleton and then either the
// object or its empty copy — never "Request not found" as a first impression.
// Manual navigation still pauses automatic focus changes; re-selecting the
// conversation resumes them without adding persistent controls to this header.
import { useMemo, type ReactNode, type RefObject } from 'react';
import { motion } from 'motion/react';
import type { RequestEntity } from '@hermes/shared';
import { useAppState, useDispatch } from '../store-context.js';
import { Icon } from '../ui/icons.js';
import { Button, IconButton } from '../ui/primitives.js';
import { AgentOverview, AgentContext, AgentSkills, AgentTraces, TraceDetail, Setup } from './Agent.js';
import { InboxList, RequestReview } from './Inbox.js';
import { History, Members, Library, Settings } from './Workspace.js';
import { agentName } from '../selectors.js';
import { TOGGLE_SHORTCUT } from '../panel.js';
import { entityData } from '../../model/store.js';
import type { AppState } from '../../model/store.js';
import { SETTINGS_TABS } from '../../model/constants.js';

const SECTION_LABEL: Record<string, string> = { agents: 'Agents', inbox: 'Inbox', members: 'Members', history: 'History', library: 'Library', settings: 'Settings' };

function describe(state: AppState): string {
  const app = state.ui.app;
  const agent = agentName(state);
  const section = app.section;
  const view = app.view;
  if (section === 'agents') {
    return agent;
  }
  if (section === 'inbox') {
    if (view === 'request') {
      const request = entityData<RequestEntity>(state, 'request', app.id);
      return request?.label ?? 'Request';
    }
    const label = state.ui.inboxTab === 'resolved' ? 'Resolved' : state.ui.inboxTab === 'rules' ? 'Rules' : 'Needs review';
    return label;
  }
  if (section === 'members') return 'Team';
  if (section === 'history') return 'History';
  if (section === 'library') {
    const label = { skills: 'Shared skills', documents: 'Documents', connections: 'Connections', intelligence: 'Shared Intelligence' }[view ?? 'skills'] ?? 'Skills';
    return label;
  }
  if (section === 'settings') {
    const label = SETTINGS_TABS.find((tab) => tab === app.view) ?? 'Notifications';
    return label;
  }
  return '';
}

export function AppPane({ narrow, active, paneRef, firstRun = null }: { narrow: boolean; active: boolean; paneRef?: RefObject<HTMLElement | null>; firstRun?: ReactNode }) {
  const state = useAppState();
  const dispatch = useDispatch();
  const app = state.ui.app;
  const agent = agentName(state);
  const crumb = describe(state);
  const key = `${app.section}/${app.view ?? ''}/${app.id ?? ''}/${app.sub ?? ''}/${app.step ?? ''}/${app.field ?? ''}`;

  const view = useMemo(() => {
    if (app.section === 'agents') {
      if (app.view === 'setup') return <Setup step={app.step ?? 'ready'} />;
      if (app.view === 'context') return <AgentContext field={app.field ?? null} />;
      if (app.view === 'skills') return <AgentSkills />;
      if (app.view === 'traces') return <AgentTraces />;
      if (app.view === 'trace') return <TraceDetail id={app.id ?? null} />;
      return <AgentOverview />;
    }
    if (app.section === 'inbox') return app.view === 'request' ? <RequestReview id={app.id ?? null} /> : <InboxList />;
    if (app.section === 'members') return <Members />;
    if (app.section === 'history') return <History />;
    if (app.section === 'library') return <Library view={app.view ?? 'skills'} id={app.id ?? null} />;
    if (app.section === 'settings') return <Settings view={app.view ?? 'Notifications'} />;
    return <AgentOverview />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    // `tabIndex={-1}` is not decoration: collapsing the panel with the composer
    // focused has to put focus somewhere, and "the thing that now owns the
    // screen" is the only defensible answer.
    <section ref={paneRef} tabIndex={-1} className="pane pane-app" data-active={active} aria-label="Application">
      <header className="pane-header">
        <span className="breadcrumb">
          <span>{SECTION_LABEL[app.section] ?? 'Agents'}</span>
          <span>/</span>
          <span className="current truncate">{crumb}</span>
        </span>
        <span className="grow" />
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
      <motion.div key={key} className={`object-view${firstRun ? ' object-view-first-run' : ''}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}>
        {firstRun ?? view}
      </motion.div>
    </section>
  );
}
