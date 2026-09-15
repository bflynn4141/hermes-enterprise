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
import { useRef, useState } from 'react';
import { SidebarNav } from '@hermes/motion-components';
import { HISTORY, INBOX, LIB, MEMBERS, OV, SETTINGS, type Ref } from '@hermes/shared';
import { useAppState, useAdapter, useDispatch, useNav } from './store-context.js';
import { Glass, Icon } from './ui/icons.js';
import { Avatar, MenuItem, Popover, Toggle } from './ui/primitives.js';
import { memberCounts } from './selectors.js';
import { DEV_USERS } from '../model/auth.js';
import { visibleSessions } from '../model/store.js';

const SECTIONS: { key: string; label: string; icon: string; ref: Ref }[] = [
  { key: 'agents', label: 'Agents', icon: 'iris', ref: OV },
  { key: 'inbox', label: 'Inbox', icon: 'inbox', ref: INBOX },
  { key: 'members', label: 'Members', icon: 'people', ref: MEMBERS },
  { key: 'history', label: 'History', icon: 'trace', ref: HISTORY() },
  { key: 'library', label: 'Library', icon: 'context', ref: LIB('skills') },
  { key: 'settings', label: 'Settings', icon: 'settings', ref: SETTINGS() },
];

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const dispatch = useDispatch();
  const [menu, setMenu] = useState(false);
  const meBtn = useRef<HTMLButtonElement>(null);
  const counts = memberCounts(state);
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

  const recents = visibleSessions(state).map((session) => ({ id: session.id, label: session.title }));

  return (
    <aside className="sidebar hermes-ui" aria-label="Workspace navigation" data-collapsed={collapsed}>
      <SidebarNav
        fill
        workspace={{ key: state.workspace.id || 'workspace', name: state.workspace.name || 'Workspace', monogram: (state.workspace.name || 'W').slice(0, 1).toUpperCase() }}
        navItems={navItems}
        activeNav={state.ui.app.section}
        activeTitle={state.activeSessionId ? state.sessions[state.activeSessionId]?.title ?? null : null}
        recents={recents}
        footerLabel={`${state.user.name || 'You'} · ${counts.joined} joined`}
        onNavigate={(key) => {
          const section = SECTIONS.find((item) => item.key === key);
          if (!section) return;
          nav(section.ref);
          if (key === 'inbox') dispatch({ type: 'nav/tab', key: 'inboxTab', value: 'needs-review' });
        }}
        onPick={(id) => dispatch({ type: 'session/select', id })}
        onNewChat={() => void adapter.createSession()}
        onWorkspaceAction={(action) => {
          if (action === 'settings') go(SETTINGS('Organization'));
          if (action === 'members') go(MEMBERS);
        }}
        onFooterClick={() => setMenu((open) => !open)}
      />
      <div className="profile" style={{ position: 'relative' }}>
        <button ref={meBtn} type="button" className="profile-btn" aria-haspopup="dialog" aria-expanded={menu} aria-label="Your account" onClick={() => setMenu((open) => !open)}>
          <Avatar person={{ name: state.user.name || 'You' }} />
          <span className="profile-name">{state.user.name || 'You'}</span>
        </button>
        <Popover open={menu} onClose={() => setMenu(false)} anchorRef={meBtn} align="left" above width={280} label="Your account">
          <div className="row">
            <Avatar person={{ name: state.user.name }} size={40} />
            <div className="col" style={{ gap: 2 }}>
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
          <div className="row" style={{ padding: '8px 10px', fontSize: 14 }}>
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
          <button type="button" className="menu-item small" onClick={() => window.location.assign(adapter.auth.signInUrl(window.location.href))}>
            <Icon name="external" />
            <span className="mi-body">
              <span>Sign out</span>
            </span>
          </button>
        </Popover>
      </div>
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
