// The sessions popover. Rename, Pin and Archive are optimistic with rollback;
// the authoritative value arrives as `entity.updated`.
//
// The demo's `RECENCY` fixture map is deleted: the status label is
// `v_session_status`, served on the session row, and the "when" column is the
// real `last_activity_at`. Search uses `SearchList` from
// `@hermes/motion-components` (plan §10b, M2).
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { SearchList } from '@hermes/motion-components';
import { useAdapter, useAppState, useDispatch } from '../store-context.js';
import { Glass, Icon } from '../ui/icons.js';
import { MenuItem, Popover, Tabs } from '../ui/primitives.js';
import { EMPTY } from '../../model/constants.js';
import { sessionRowTitle, visibleSessions } from '../../model/store.js';

function ago(ts: number): string {
  const d = Date.now() - ts;
  if (d < 90_000) return 'Now';
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / 86_400_000)}d`;
}

export function SessionsPopover({ open, onClose, anchorRef, focusSearch }: { open: boolean; onClose: () => void; anchorRef: RefObject<HTMLElement | null>; focusSearch: boolean }) {
  const state = useAppState();
  const dispatch = useDispatch();
  const adapter = useAdapter();
  const [tab, setTab] = useState('recent');
  const [query, setQuery] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const moreRefs = useRef<Record<string, { current: HTMLElement | null }>>({});
  const anchorFor = (id: string): { current: HTMLElement | null } => (moreRefs.current[id] ??= { current: null });

  useEffect(() => {
    if (open && focusSearch) setTimeout(() => searchRef.current?.focus(), 0);
  }, [open, focusSearch]);

  const list = useMemo(() => visibleSessions(state, tab === 'archived').filter((session) => session.title.toLowerCase().includes(query.toLowerCase())), [state, tab, query]);

  const patch = (id: string, body: Record<string, unknown>): void => {
    void adapter.rest.patchSession(state.workspace.id, id, body).catch(() => undefined);
  };

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} width={460} label="Sessions" offset={6}>
      <div className="row">
        <span className="p-title">Sessions</span>
        <span className="grow" />
        <button
          type="button"
          className="text-btn light"
          onClick={() => {
            void adapter.createSession();
            onClose();
          }}
        >
          + New session
        </button>
      </div>
      <div className="search">
        <Icon name="search" />
        <input ref={searchRef} placeholder="Search sessions…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search sessions" />
      </div>
      <Tabs
        tabs={[
          { id: 'recent', label: 'Recent' },
          { id: 'archived', label: 'Archived' },
        ]}
        value={tab}
        onChange={setTab}
        label="Session lists"
      />
      <div className="col" role="list" aria-label={tab === 'archived' ? 'Archived sessions' : 'Recent sessions'} style={{ maxHeight: 360, overflowY: 'auto' }}>
        {list.length === 0 && <div className="p-meta" style={{ padding: 12 }}>{tab === 'archived' ? EMPTY.sessionsArchived : EMPTY.sessions}</div>}
        {list.map((session) => {
          const selected = session.id === state.activeSessionId;
          return (
            <div key={session.id} className={`session-row ${selected ? 'selected' : ''}`} role="listitem" aria-current={selected ? 'true' : undefined}>
              <Glass name="loop" size={22} className="s-icon" />
              {renaming === session.id ? (
                <input
                  className="grow"
                  value={title}
                  aria-label="Session title"
                  autoFocus
                  onChange={(event) => setTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      dispatch({ type: 'session/rename', id: session.id, title });
                      patch(session.id, { title });
                      setRenaming(null);
                    }
                    if (event.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={() => {
                    dispatch({ type: 'session/rename', id: session.id, title });
                    patch(session.id, { title });
                    setRenaming(null);
                  }}
                  style={{ background: 'transparent', border: '1px solid var(--line)', borderRadius: 6, padding: '6px 10px', color: 'inherit', fontSize: 12.8 }}
                />
              ) : (
                <button
                  type="button"
                  className="sr-body"
                  onClick={() => {
                    dispatch({ type: 'session/select', id: session.id });
                    adapter.openSession(session.id);
                    onClose();
                  }}
                >
                  <span className="sr-title truncate">
                    {session.pinned && <Icon name="pin" size={14} style={{ marginRight: 6, verticalAlign: -2 }} />}
                    {sessionRowTitle(session)}
                    {session.unread && <span className="unread-dot" aria-label="Unread" />}
                  </span>
                  <span className="sr-status">{session.status}</span>
                </button>
              )}
              <span className="sr-when">
                <span>{ago(session.lastActivity)}</span>
                <span style={{ position: 'relative', display: 'inline-flex' }}>
                  <button
                    type="button"
                    className="icon-btn"
                    ref={(el) => {
                      anchorFor(session.id).current = el;
                    }}
                    aria-label={`Session actions for ${sessionRowTitle(session)}`}
                    aria-expanded={menuFor === session.id}
                    onClick={() => setMenuFor(menuFor === session.id ? null : session.id)}
                  >
                    <Icon name="more" size={16} />
                  </button>
                  <Popover open={menuFor === session.id} onClose={() => setMenuFor(null)} anchorRef={anchorFor(session.id) as RefObject<HTMLElement | null>} className="menu" width={180} label="Session actions">
                    <MenuItem
                      small
                      icon="rename"
                      onClick={() => {
                        setMenuFor(null);
                        setRenaming(session.id);
                        setTitle(session.title);
                      }}
                    >
                      Rename
                    </MenuItem>
                    <MenuItem
                      small
                      icon="pin"
                      onClick={() => {
                        const pinned = !session.pinned;
                        dispatch({ type: 'session/pin', id: session.id, pinned });
                        patch(session.id, { pinned });
                        setMenuFor(null);
                      }}
                    >
                      {session.pinned ? 'Unpin' : 'Pin'}
                    </MenuItem>
                    <MenuItem
                      small
                      icon="archive"
                      onClick={() => {
                        const archived = !session.archived;
                        dispatch({ type: 'session/archive', id: session.id, archived });
                        patch(session.id, { archived });
                        setMenuFor(null);
                      }}
                    >
                      {session.archived ? 'Restore' : 'Archive'}
                    </MenuItem>
                  </Popover>
                </span>
              </span>
            </div>
          );
        })}
      </div>
      {query.length > 1 && (
        <div className="hermes-ui">
          <SearchList
            items={list.map((session) => session.title)}
            labels={{ placeholder: 'Search sessions…', ariaLabel: 'Search sessions', emptyTitle: EMPTY.sessions, emptyHint: 'Start one from the composer.' }}
            onSelect={(item) => {
              const match = list.find((session) => session.title === item);
              if (match) {
                dispatch({ type: 'session/select', id: match.id });
                adapter.openSession(match.id);
                onClose();
              }
            }}
          />
        </div>
      )}
      <div className="p-meta">Archiving changes organization only; runs and approvals are unaffected.</div>
    </Popover>
  );
}
