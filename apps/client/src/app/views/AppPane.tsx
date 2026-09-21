// The app pane: breadcrumb and the view the current ref names.
//
// The pane moves only when a person moves it. Iris's focus is recorded on the
// session and offered as a link in its reply (see `FocusLink`); there is no
// follow mode and nothing here is pinned or unpinned.
import { useMemo, type ReactNode, type RefObject } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useAppState, useDispatch } from '../store-context.js';
import { Icon } from '../ui/icons.js';
import { Button, IconButton } from '../ui/primitives.js';
import { AgentOverview, AgentTraces, TraceDetail, Setup } from './Agent.js';
import { AgentSkillsSettings } from './AgentSkillsSettings.js';
import { AgentContextSettings } from './AgentContextSettings.js';
import { AgentPermissions } from './AgentPermissions.js';
import { InboxList, RequestReview } from './Inbox.js';
import { AdminSettings, History, Members, Library, Settings } from './Workspace.js';
import { SECTION_LABEL, agentName, describeRef } from '../selectors.js';
import { TOGGLE_SHORTCUT } from '../panel.js';

export function AppPane({ narrow, active, paneRef, firstRun = null }: { narrow: boolean; active: boolean; paneRef?: RefObject<HTMLElement | null>; firstRun?: ReactNode }) {
  const state = useAppState();
  const systemReduceMotion = useReducedMotion();
  const dispatch = useDispatch();
  const app = state.ui.app;
  const agent = agentName(state);
  const [crumb, sub] = describeRef(state, app);
  // Keep settings tabs mounted across section changes so keyboard focus and
  // scroll position survive navigation. Individual content panels still unmount.
  const key = app.section === 'admin' || app.section === 'settings'
    ? app.section
    : `${app.section}/${app.view ?? ''}/${app.id ?? ''}/${app.sub ?? ''}/${app.step ?? ''}/${app.field ?? ''}`;

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
    if (app.section === 'library') return <Library view={app.view ?? 'handoffs'} id={app.id ?? null} />;
    if (app.section === 'settings') return <Settings view={app.view ?? 'Notifications'} />;
    return <AgentOverview />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, app.view]);

  const agentView = app.section === 'agents';
  const requestView = app.section === 'inbox' && app.view === 'request';

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
        {state.agent.id && (state.ui.irisPanel === 'open' ? (
          <IconButton name="expand" label={`Hide ${agent} ${TOGGLE_SHORTCUT}`} onClick={() => dispatch({ type: 'iris/panel', panel: 'rail' })} />
        ) : (
          <Button small onClick={() => dispatch({ type: 'iris/panel', panel: 'open' })}>
            <Icon name="open" size={16} /> Open {agent}
          </Button>
        ))}
      </header>
      {!agentView && !requestView && <div className="pane-subheader">
        <span className="truncate">{sub}</span>
        <span className="grow" />
      </div>}
      <motion.div key={key} className={`object-view${firstRun ? ' object-view-first-run' : ''}`} initial={systemReduceMotion || state.ui.reduceMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}>
        {firstRun ?? view}
      </motion.div>
    </section>
  );
}
