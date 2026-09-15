// The shell. Width rules are unchanged from the demo — 1840 is 240 + 800 + 800;
// below 1180 the navigation collapses to icons; below 1000 the two panes switch
// explicitly with their state preserved — and one row is new: the connection
// banner (client-port spec §2, §5.4).
import { useEffect, useState } from 'react';
import { useAppState, useDispatch } from './store-context.js';
import { Sidebar } from './Sidebar.js';
import { ChatPane } from './chat/ChatPane.js';
import { AppPane } from './views/AppPane.js';
import { ConnectionBanner } from './Banners.js';

export function Shell() {
  const state = useAppState();
  const dispatch = useDispatch();
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = (): void => setWidth(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  useEffect(() => {
    dispatch({ type: 'ui/set', patch: { navCollapsed: width < 1180 } });
  }, [dispatch, width]);

  const irisOpen = state.ui.irisOpen;
  const narrow = width < 1000 && irisOpen;
  const collapsed = width < 1180;
  const compact = width < 1560;
  const pane = state.ui.pane;

  return (
    <div className="shell-outer">
      <ConnectionBanner />
      <div
        className={`shell ${narrow ? 'is-narrow' : ''} ${collapsed ? 'nav-collapsed' : ''} ${compact ? 'is-compact' : ''}`}
        data-iris={irisOpen ? 'open' : 'closed'}
        style={{ transition: 'grid-template-columns var(--dur-layout) var(--ease-out)' }}
      >
        <Sidebar collapsed={collapsed} />
        {irisOpen && <ChatPane narrow={narrow} active={!narrow || pane === 'chat'} />}
        <AppPane narrow={narrow} active={!narrow || pane === 'app'} />
      </div>
    </div>
  );
}
