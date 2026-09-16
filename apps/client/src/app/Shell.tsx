// The shell. 1840 is 240 + 800 + 800 and below 1000 the two panes switch
// explicitly with their state preserved, both from the demo. Three things are
// not the demo's: the connection banner (client-port spec §2, §5.4), the Iris
// panel's three states (decision C33), and the navigation column, whose grid
// width now follows SidebarNav's own open/rail disclosure (decision C36).
//
// The grid is written here rather than in CSS because the middle column is now
// a number a person can drag. The `--iris-w` token stays as the fallback the
// stylesheet's own rules still read.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppState, useDispatch } from './store-context.js';
import { Sidebar } from './Sidebar.js';
import { ChatPane } from './chat/ChatPane.js';
import { IrisRail } from './chat/IrisRail.js';
import { AppPane } from './views/AppPane.js';
import { PanelResizer } from './PanelResizer.js';
import { ConnectionBanner } from './Banners.js';
import { IS_MAC, TOGGLE_SHORTCUT, irisShortcut, readIrisPrefs, requestComposerFocus, writeIrisPrefs } from './panel.js';
import { agentName } from './selectors.js';
import {
  IRIS_RAIL_WIDTH,
  PANE_SWITCH_BREAKPOINT,
  navWidthFor,
  resolveIrisWidth,
  workAreaFor,
} from '../model/store.js';
import { useFirstRunExperience } from './onboarding/FirstRunExperience.js';

export function Shell() {
  const state = useAppState();
  const dispatch = useDispatch();
  const [width, setWidth] = useState(() => window.innerWidth);
  const [dragging, setDragging] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<HTMLElement>(null);
  const agent = agentName(state);
  const firstRunActive = state.ui.app.section === 'agents' && state.ui.app.view === 'setup';
  const firstRun = useFirstRunExperience(firstRunActive);

  useEffect(() => {
    const on = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  const panel = state.ui.irisPanel;
  const narrow = width < PANE_SWITCH_BREAKPOINT && panel === 'open';
  const pane = state.ui.pane;
  const navWidth = navWidthFor(width, state.ui.navCollapsed);
  const workArea = workAreaFor(width, state.ui.navCollapsed);
  const irisWidth = resolveIrisWidth(state.ui.irisWidth, width);
  // `is-compact` used to be a fact about the window, which was the same thing as
  // a fact about the chat pane when the chat pane was always half of it. Now
  // that it is draggable it is not: a 460 px pane in a 1840 px window needs the
  // tighter paddings whatever the window says (decision C33).
  const compact = width < 1560 || (panel === 'open' && !narrow && irisWidth < 640);
  // Below the pane-switch breakpoint there is no room for a 56 px strip beside
  // a usable app pane, so the rail is not shown and the app header's button is
  // the way back — which is what `hidden` already does.
  const railShown = panel === 'rail' && width >= PANE_SWITCH_BREAKPOINT;
  const resizable = panel === 'open' && !narrow;

  // --- the preference, per workspace and user -------------------------------
  const workspaceId = state.workspace.id;
  const userId = state.user.id;
  const restored = useRef(false);
  useEffect(() => {
    if (!workspaceId || !userId || restored.current) return;
    restored.current = true;
    const prefs = readIrisPrefs(workspaceId, userId, window.innerWidth);
    if (prefs.panel !== 'open') dispatch({ type: 'iris/panel', panel: prefs.panel });
    if (prefs.width !== null) dispatch({ type: 'iris/width', width: prefs.width, workArea: workAreaFor(window.innerWidth, state.ui.navCollapsed) });
  }, [dispatch, workspaceId, userId, state.ui.navCollapsed]);
  useEffect(() => {
    if (!workspaceId || !userId || !restored.current) return;
    writeIrisPrefs(workspaceId, userId, panel, state.ui.irisWidth);
  }, [workspaceId, userId, panel, state.ui.irisWidth]);

  // --- the shortcut ---------------------------------------------------------
  const focusApp = useCallback(() => appRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const verdict = irisShortcut(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          target: event.target as HTMLElement | null,
        },
        IS_MAC,
      );
      if (verdict === 'ignore') return;
      event.preventDefault();
      if (verdict === 'collapse-from-composer') {
        dispatch({ type: 'iris/panel', panel: 'rail' });
        // Focus cannot stay in a pane that is about to be 56 px wide.
        window.requestAnimationFrame(focusApp);
        return;
      }
      dispatch({ type: 'iris/toggle' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dispatch, focusApp, state.ui.irisPanel]);

  // Reopening from any control returns focus to the composer — the shortcut, the
  // rail's mark, the app header's button, New session. One effect rather than
  // four call sites, so no control can be added that forgets.
  const previous = useRef(panel);
  useEffect(() => {
    if (previous.current !== 'open' && panel === 'open') requestComposerFocus();
    previous.current = panel;
  }, [panel]);

  const columns = narrow
    ? `${navWidth}px minmax(0, 1fr)`
    : panel === 'open'
      ? `${navWidth}px ${irisWidth}px minmax(0, 1fr)`
      : railShown
        ? `${navWidth}px ${IRIS_RAIL_WIDTH}px minmax(0, 1fr)`
        : `${navWidth}px minmax(0, 1fr)`;

  return (
    <div className="shell-outer">
      <ConnectionBanner />
      <div
        ref={gridRef}
        className={`shell ${narrow ? 'is-narrow' : ''} ${compact ? 'is-compact' : ''}`}
        data-iris={panel}
        style={{
          gridTemplateColumns: columns,
          // A drag must not animate: the column would lag the pointer by the
          // whole 160 ms and the handle would appear to come unstuck.
          transition: dragging ? 'none' : 'grid-template-columns var(--dur-layout) var(--ease-out)',
        }}
      >
        <Sidebar />
        {panel === 'open' && <ChatPane narrow={narrow} active={!narrow || pane === 'chat'} firstRun={firstRun?.conversation} />}
        {railShown && <IrisRail shortcut={TOGGLE_SHORTCUT} />}
        <AppPane narrow={narrow} active={!narrow || pane === 'app'} paneRef={appRef} firstRun={firstRun?.agreement} />
        {resizable && (
          <PanelResizer
            left={navWidth + irisWidth}
            width={irisWidth}
            workArea={workArea}
            originRef={gridRef}
            label={`Resize the ${agent} panel`}
            onDragging={setDragging}
            onWidth={(next) => dispatch({ type: 'iris/width', width: next, workArea })}
            onReset={() => dispatch({ type: 'iris/width', width: null })}
          />
        )}
      </div>
    </div>
  );
}
