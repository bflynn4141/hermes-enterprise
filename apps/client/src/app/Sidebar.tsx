// The sidebar. The list rendering is `SidebarNav` from
// `@hermes/motion-components` (plan §10b, M2): the six sections become its
// `navItems`, the Inbox badge comes from `v_inbox_count` through
// `counts.inbox`, `recents` are the sessions page, and `workspace` and
// `footerLabel` come from bootstrap. `onNavigate` and `onPick` dispatch the
// same `nav/app … manual: true` every other control uses, so the follow rule
// does not acquire a second code path.
//
// Two demo affordances are gone: the `Demo` pill and the Presenter entry point.
// The reduce-motion toggle the Presenter hosted moved into the account menu
// below, which also carries the dev account switcher — and that switcher exists
// only when `__AUTH_MODE__` is `fake`, a build-time constant, so neither it nor
// the string `x-dev-user` survives into a production bundle (spec §12.8).
import { useEffect, useRef, useState } from 'react';
import { SidebarNav } from '@hermes/motion-components';
import { HISTORY, INBOX, LIB, MEMBERS, OV, SETTINGS, type Ref } from '@hermes/shared';
import { useAppState, useAdapter, useDispatch, useNav } from './store-context.js';
import { Glass, Icon } from './ui/icons.js';
import { Avatar, MenuItem, Popover, Toggle } from './ui/primitives.js';
import { DEV_USERS } from '../model/auth.js';
import { sessionRowTitle, sessionStatusLabel, visibleSessions, type SessionState } from '../model/store.js';
import { requestComposerFocus } from './panel.js';

const SECTIONS: { key: string; label: string; icon: string; ref: Ref }[] = [
  { key: 'agents', label: 'Agents', icon: 'iris', ref: OV },
  { key: 'inbox', label: 'Inbox', icon: 'inbox', ref: INBOX },
  { key: 'members', label: 'Members', icon: 'people', ref: MEMBERS },
  { key: 'history', label: 'History', icon: 'trace', ref: HISTORY() },
  { key: 'library', label: 'Library', icon: 'context', ref: LIB('skills') },
  { key: 'settings', label: 'Settings', icon: 'settings', ref: SETTINGS() },
];

export function Sidebar() {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const dispatch = useDispatch();
  const [menu, setMenu] = useState(false);
  const accountBtn = useRef<HTMLElement>(null);
  const accountMarker = useRef<HTMLSpanElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const go = (ref: Ref): void => {
    setMenu(false);
    nav(ref);
  };

  const navItems = SECTIONS.map((section) => ({
    key: section.key,
    label: section.label,
    icon: <Glass name={section.icon} size={18} />,
    ...(section.key === 'inbox' && state.counts.inbox ? { count: String(state.counts.inbox) } : {}),
  }));

  // The status label belongs on the row — the demo showed it and people steer by
  // it — and `SidebarNav` renders `label` and nothing else: `prompt` reaches
  // `onPick` and is never drawn, and there is no slot for a second span. So the
  // status is part of the label, and `activeTitle` is decorated the same way,
  // because the library decides which row is current by comparing those two
  // strings. The library is not ours to edit (decision C35).
  const rowLabel = (session: SessionState): string => {
    const status = sessionStatusLabel(session);
    return status ? `${sessionRowTitle(session)} · ${status}` : sessionRowTitle(session);
  };
  const sessions = visibleSessions(state);
  const recents = sessions.map((session) => ({ id: session.id, label: rowLabel(session) }));
  const active = state.activeSessionId ? state.sessions[state.activeSessionId] : null;

  // SidebarNav owns its disclosure state, but the shell owns the grid column
  // around it. Mirror the component's public data attribute so collapsing the
  // 52 px rail also releases the other 188 px to the workspace.
  useEffect(() => {
    const host = sidebarRef.current;
    if (!host) return;
    const sync = (): void => {
      const collapsed = host.querySelector('[data-sidebar-collapsed="true"]') !== null;
      if (collapsed !== state.ui.navCollapsed) dispatch({ type: 'ui/set', patch: { navCollapsed: collapsed } });
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(host, { attributes: true, subtree: true, attributeFilter: ['data-sidebar-collapsed'] });
    return () => observer.disconnect();
  }, [dispatch, state.ui.navCollapsed]);

  // SidebarNav owns the visible footer button, while this client owns the
  // account menu. Use a marker inside the public footerIcon slot to recover
  // that exact button as the popover anchor instead of rendering a second,
  // hidden account button after a full-height sidebar.
  useEffect(() => {
    const button = accountMarker.current?.closest<HTMLButtonElement>('button') ?? null;
    accountBtn.current = button;
    if (!button) return;
    button.setAttribute('aria-label', 'Your account');
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', String(menu));
  }, [menu]);

  return (
    // `SidebarNav` renders its own <aside> with its own collapse control; this
    // wrapper is the grid cell. It clips during the shared width transition so
    // neither state can paint over the neighboring pane (decision C36).
    <aside ref={sidebarRef} className="sidebar hermes-ui" aria-label="Workspace navigation">
      <SidebarNav
        className="workspace-sidebar-nav"
        fill
        workspace={{ key: state.workspace.id || 'workspace', name: state.workspace.name || 'Workspace', monogram: (state.workspace.name || 'W').slice(0, 1).toUpperCase() }}
        navItems={navItems}
        activeNav={state.ui.app.section}
        activeTitle={active ? rowLabel(active) : null}
        recents={recents}
        // Name only. The member counts live in the Members header and in the
        // workspace menu; a headcount pinned under your own avatar is a number
        // about other people in the one place that is about you (decision C47).
        footerLabel={state.user.name || 'You'}
        footerIcon={
          <span ref={accountMarker} className="account-trigger-marker" aria-hidden="true">
            <Avatar person={{ name: state.user.name || 'You' }} size={20} />
          </span>
        }
        onNavigate={(key) => {
          const section = SECTIONS.find((item) => item.key === key);
          if (!section) return;
          nav(section.ref);
          if (key === 'inbox') dispatch({ type: 'nav/tab', key: 'inboxTab', value: 'needs-review' });
        }}
        onPick={(id) => {
          dispatch({ type: 'session/select', id });
          dispatch({ type: 'iris/panel', panel: 'open' });
          requestComposerFocus();
        }}
        onNewChat={() => {
          // One control, three effects: reuse-or-create (the adapter's rule),
          // open the panel, and put the cursor in the composer. A New session
          // that leaves you looking at a collapsed rail is a New session you
          // have to click twice.
          dispatch({ type: 'iris/panel', panel: 'open' });
          requestComposerFocus();
          void adapter.createSession();
        }}
        onWorkspaceAction={(action) => {
          if (action === 'Switch workspace') window.location.assign('/');
          if (action === 'Workspace settings') go(SETTINGS('Organization'));
          if (action === 'Invite team members') go(MEMBERS);
        }}
        onFooterClick={() => {
          accountBtn.current = accountMarker.current?.closest<HTMLButtonElement>('button') ?? null;
          setMenu((open) => !open);
        }}
      />
      <Popover open={menu} onClose={() => setMenu(false)} anchorRef={accountBtn} align="left" above width={280} label="Your account" portal className="menu account-menu">
        <div className="row account-head">
          <Avatar person={{ name: state.user.name }} size={36} />
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <span className="p-title">{state.user.name || 'You'}</span>
            <span className="p-meta">
              {state.user.email || state.workspace.name} · {state.user.role === 'admin' ? 'Admin' : 'Member'}
            </span>
          </div>
        </div>
        <div className="divider" />
        <MenuItem small icon="mail" onClick={() => go(SETTINGS('Notifications'))}>
          Notification settings
        </MenuItem>
        <MenuItem small icon="key" onClick={() => go(SETTINGS('Provider keys'))}>
          Provider keys
        </MenuItem>
        <MenuItem small icon="shield" onClick={() => go(SETTINGS('Data and privacy'))}>
          Data and privacy
        </MenuItem>
        <div className="row account-toggle">
          <span className="grow">Reduce motion</span>
          <Toggle
            checked={state.ui.reduceMotion}
            label="Reduce motion"
            // Client-local, and only client-local. It used to PATCH
            // `{ reduce_motion }` at the settings route as well, where it
            // matched no workspace field and was silently discarded; the
            // route answers 422 for an unknown key now, so the call would be
            // an error for a preference the server has never stored.
            onChange={(value) => dispatch({ type: 'ui/set', patch: { reduceMotion: value } })}
          />
        </div>
        {__AUTH_MODE__ === 'fake' && <DevAccountSwitcher />}
        <div className="divider" />
        <button type="button" className="menu-item small" onClick={() => window.location.assign(adapter.auth.signInUrl(window.location.href))}>
          <Icon name="external" />
          <span className="mi-body">
            <span>Sign out</span>
          </span>
        </button>
      </Popover>
    </aside>
  );
}

/**
 * Two seeded users — an Admin and a Member — which is exactly what the
 * two-browser-context Playwright scenarios need (spec §6).
 */
function DevAccountSwitcher() {
  const adapter = useAdapter();
  const current = adapter.auth.devUser();
  return (
    <div className="dev-switcher" aria-label="Development account">
      <span className="p-meta">Dev account</span>
      <div className="row" style={{ gap: 6 }}>
        {DEV_USERS.map((user) => (
          <button
            key={user.id}
            type="button"
            className="text-btn light"
            aria-pressed={current === user.id}
            onClick={() => {
              adapter.auth.setDevUser(user.id);
              window.location.reload();
            }}
          >
            {user.label}
          </button>
        ))}
      </div>
    </div>
  );
}
