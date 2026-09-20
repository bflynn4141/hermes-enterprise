// The chat pane. Header, sessions popover, breadcrumb, find-in-session bar,
// transcript and composer — the demo's layout and interactions, rewired.
//
// What changed: Share posts to the shares route and shows the real
// `/shared/:token` URL (once — it is never re-readable), Rename PATCHes the
// session, and find-in-session keeps the CSS Custom Highlight implementation
// and gains "Load earlier to search more", because a find that silently only
// searches the loaded window is a find that lies.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { SHARE_AUDIENCE } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch } from '../store-context.js';
import { Glass, Icon } from '../ui/icons.js';
import { Ack, Button, Dialog, IconButton, IrisMark, MenuItem, Popover } from '../ui/primitives.js';
import { SessionsPopover } from './SessionsPopover.js';
import { Transcript } from './Transcript.js';
import { Composer } from './Composer.js';
import { agentName } from '../selectors.js';
import { TOGGLE_SHORTCUT } from '../panel.js';
import type { SessionState } from '../../model/store.js';
import { EMPTY } from '../../model/constants.js';

export function ChatPane({ narrow, active, firstRun = null, readOnly = false }: { narrow: boolean; active: boolean; firstRun?: ReactNode; readOnly?: boolean }) {
  const state = useAppState();
  const dispatch = useDispatch();
  const adapter = useAdapter();
  const session = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
  const agent = readOnly ? 'Session history' : agentName(state);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [focusSearch, setFocusSearch] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [rename, setRename] = useState<string | null>(null);
  const [share, setShare] = useState(false);
  const [find, setFind] = useState<string | null>(null);
  const [findIndex, setFindIndex] = useState(0);
  const [findCount, setFindCount] = useState(0);
  const sessionsBtn = useRef<HTMLButtonElement>(null);
  const searchBtn = useRef<HTMLButtonElement>(null);
  const moreBtn = useRef<HTMLButtonElement>(null);
  const findInput = useRef<HTMLInputElement>(null);

  const onCount = useCallback((n: number) => setFindCount(n), []);
  const closeFind = useCallback((): void => {
    setFind(null);
    setFindIndex(0);
    setFindCount(0);
  }, []);
  useEffect(() => {
    closeFind();
  }, [session?.id, closeFind]);
  // The rail's Sessions icon opens the panel and then asks the header — which
  // did not exist when it was clicked — to open the popover it owns.
  useEffect(() => {
    const open = (): void => {
      setFocusSearch(false);
      setSessionsOpen(true);
    };
    window.addEventListener('hermes:open-sessions', open);
    return () => window.removeEventListener('hermes:open-sessions', open);
  }, []);

  if (!session) {
    return (
      <section className="pane pane-iris" data-active={active} aria-label={readOnly ? 'Session history' : `${agent} conversation`}>
        <div className="chat-welcome chat-welcome-standalone">
          {readOnly ? <Glass name="loop" size={48} className="mark" /> : <IrisMark size={48} className="mark" />}
          <p>{readOnly ? 'Choose a previous session to read its history.' : EMPTY.chatReady(agent)}</p>
          {!readOnly && <Button primary onClick={() => void adapter.createSession()}>Start</Button>}
        </div>
      </section>
    );
  }

  const run = session.run;
  const markState =
    run?.status === 'working' ? 'reading' : run?.status === 'waiting' ? 'waiting' : run?.status === 'stopped' || run?.status === 'error' ? 'stopped' : 'static';
  const openFind = (): void => {
    setOverflow(false);
    setFind((value) => value ?? '');
    setTimeout(() => findInput.current?.focus(), 0);
  };
  const step = (dir: number): void => {
    if (!findCount) return;
    setFindIndex((i) => (i + dir + findCount) % findCount);
  };

  return (
    <section
      className="pane pane-iris"
      data-active={active}
      aria-label={readOnly ? 'Session history' : `${agent} conversation`}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !event.shiftKey) {
          event.preventDefault();
          openFind();
        }
      }}
    >
      <header className="pane-header iris-header">
        {readOnly ? <Glass name="loop" size={28} className="mark" /> : <IrisMark size={28} state={markState} className="mark" />}
        <span className="name">{agent}</span>
        <span className="grow" />
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <button
            ref={sessionsBtn}
            type="button"
            className="text-btn"
            aria-label="Sessions"
            aria-haspopup="dialog"
            aria-expanded={sessionsOpen}
            onClick={() => {
              setFocusSearch(false);
              setSessionsOpen((open) => !open);
            }}
          >
            <Icon name="history" /> <span className="header-action-label">Sessions</span>
          </button>
          <SessionsPopover open={sessionsOpen} onClose={() => setSessionsOpen(false)} anchorRef={sessionsBtn} focusSearch={focusSearch} readOnly={readOnly} />
        </span>
        <IconButton
          anchorRef={searchBtn}
          name="search"
          label="Search sessions"
          onClick={() => {
            setFocusSearch(true);
            setSessionsOpen(true);
          }}
        />
        {!readOnly && <button type="button" className="text-btn" aria-label="New session" onClick={() => void adapter.createSession()}>
          <Icon name="plus" /> <span className="header-action-label">New session</span>
        </button>}
        {narrow && (
          <span className="pane-switch" role="group" aria-label="Pane">
            <button type="button" aria-pressed onClick={() => dispatch({ type: 'ui/set', patch: { pane: 'chat' } })}>
              Chat
            </button>
            <button type="button" aria-pressed={false} onClick={() => dispatch({ type: 'ui/set', patch: { pane: 'app' } })}>
              App
            </button>
          </span>
        )}
        <IconButton name="hide" label={`Hide ${agent} ${TOGGLE_SHORTCUT}`} onClick={() => dispatch({ type: 'iris/panel', panel: 'rail' })} />
      </header>

      <div className="pane-subheader">
        <Glass name="loop" size={20} />
        <span className="breadcrumb">
          <span>{session.context?.label ?? state.workspace.name}</span>
          <span>/</span>
          <span className="current truncate">{firstRun ? `Set up ${agent}` : session.title}</span>
        </span>
        {session.share && (
          <span className="share-tag" title={`${SHARE_AUDIENCE} · View only`}>
            <Icon name="external" size={14} /> Shared
          </span>
        )}
        <span className="grow" />
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <IconButton anchorRef={moreBtn} name="more" label="Session options" onClick={() => setOverflow((open) => !open)} />
          <Popover open={overflow} onClose={() => setOverflow(false)} anchorRef={moreBtn} className="menu" width={240} label="Session options">
            {!readOnly && <MenuItem
              small
              icon="rename"
              onClick={() => {
                setOverflow(false);
                setRename(session.title);
              }}
            >
              Rename session
            </MenuItem>}
            <MenuItem small icon="search" onClick={openFind}>
              Find in session
            </MenuItem>
            {/* The rail is the ordinary collapse; this is the one that takes
                the affordance away too, so it lives where the rarely-wanted
                things live rather than beside Hide. Cursor put the same choice
                in a "More Actions" ellipsis (cursor.com/changelog/2-3). */}
            {!readOnly && <MenuItem
              small
              icon="expand"
              sub="No rail. Reopen from the app header."
              onClick={() => {
                setOverflow(false);
                dispatch({ type: 'iris/panel', panel: 'hidden' });
              }}
            >
              Hide completely
            </MenuItem>}
            {!readOnly && <MenuItem
              small
              icon="external"
              onClick={() => {
                setOverflow(false);
                setShare(true);
              }}
            >
              {session.share ? 'Sharing…' : 'Share session'}
            </MenuItem>}
            {!readOnly && <MenuItem
              small
              icon="archive"
              onClick={() => {
                const archived = !session.archived;
                dispatch({ type: 'session/archive', id: session.id, archived });
                void adapter.rest.patchSession(state.workspace.id, session.id, { archived }).catch(() => dispatch({ type: 'session/archive', id: session.id, archived: !archived }));
                setOverflow(false);
              }}
            >
              {session.archived ? 'Restore session' : 'Archive session'}
            </MenuItem>}
          </Popover>
        </span>
      </div>

      {find !== null && (
        <div className="find-bar" role="search" aria-label="Find in session">
          <Icon name="search" size={16} />
          <input
            ref={findInput}
            autoFocus
            value={find}
            placeholder="Find in session…"
            aria-label="Find text"
            onChange={(event) => {
              setFind(event.target.value);
              setFindIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                closeFind();
              }
            }}
          />
          <span className="count" aria-live="polite">
            {find ? (findCount ? `${findIndex + 1} of ${findCount}` : 'No matches') : ''}
          </span>
          {session.hasEarlier && (
            <Button link small onClick={() => void adapter.loadEarlier(session.id)}>
              Load earlier to search more
            </Button>
          )}
          <IconButton name="chevron" label="Previous match" className="flip" size={16} disabled={!findCount} onClick={() => step(-1)} />
          <IconButton name="chevron" label="Next match" size={16} disabled={!findCount} onClick={() => step(1)} />
          <IconButton name="close" label="Close find" size={16} onClick={closeFind} />
        </div>
      )}

      {firstRun ?? (
        <>
          <Transcript key={session.id} session={session} find={find ? { query: find, index: findIndex, onCount } : null} readOnly={readOnly} />
          {readOnly ? <p className="meta" style={{ padding: '10px 24px 18px' }}>Read-only history. No agent is currently available for new work.</p> : <Composer session={session} />}
        </>
      )}

      <RenameDialog
        open={rename !== null}
        initial={rename ?? ''}
        onClose={() => setRename(null)}
        onSave={(title) => {
          const previous = session.title;
          dispatch({ type: 'session/rename', id: session.id, title });
          void adapter.rest.patchSession(state.workspace.id, session.id, { title }).catch(() => dispatch({ type: 'session/rename', id: session.id, title: previous }));
          setRename(null);
        }}
      />
      <ShareDialog open={share} session={session} onClose={() => setShare(false)} />
    </section>
  );
}

function RenameDialog({ open, initial, onClose, onSave }: { open: boolean; initial: string; onClose: () => void; onSave: (title: string) => void }) {
  const [title, setTitle] = useState(initial);
  useEffect(() => {
    if (open) setTitle(initial);
  }, [open, initial]);
  const ok = title.trim().length > 0;
  return (
    <Dialog
      open={open}
      title="Rename session"
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button primary disabled={!ok} onClick={() => ok && onSave(title)}>
            Save
          </Button>
        </>
      }
    >
      <label className="field">
        <span className="sr-only">Session title</span>
        <input
          value={title}
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && ok) onSave(title);
          }}
        />
      </label>
      <p className="meta">Titles are local to this workspace. Runs and approvals are unaffected.</p>
    </Dialog>
  );
}

/**
 * A share is a read-only link into this workspace. The URL comes back from the
 * server once and is never re-readable, so the dialog shows it while it has it
 * and says so.
 */
export async function revokeSharedSession(revoke: () => Promise<void>, markRevoked: () => void): Promise<void> {
  await revoke();
  markRevoked();
}

export function ShareDialog({ open, session, onClose }: { open: boolean; session: SessionState; onClose: () => void }) {
  const state = useAppState();
  const adapter = useAdapter();
  const dispatch = useDispatch();
  const [copied, setCopied] = useState(false);
  const [copyFail, setCopyFail] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      setCopied(false);
      setCopyFail(false);
      setUrl(session.share?.url ?? null);
      setError(null);
      setRevoking(false);
    }
  }, [open, session.share?.url]);

  const create = async (): Promise<void> => {
    setError(null);
    try {
      const share = await adapter.rest.share(state.workspace.id, session.id);
      dispatch({ type: 'session/share', id: session.id, share: { id: share.id, url: share.url, audience: SHARE_AUDIENCE } });
      setUrl(share.url);
    } catch {
      setError('Could not create the link. Try again.');
    }
  };

  const revoke = async (): Promise<void> => {
    if (!session.share || revoking) return;
    const shareId = session.share.id;
    setRevoking(true);
    setError(null);
    try {
      await revokeSharedSession(
        () => adapter.rest.unshare(state.workspace.id, session.id, shareId),
        () => dispatch({ type: 'session/unshare', id: session.id }),
      );
      setUrl(null);
    } catch {
      setError('Could not stop sharing. The link is still active. Try again.');
    } finally {
      setRevoking(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setCopyFail(false);
    } catch {
      setCopyFail(true);
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
      setCopyFail(false);
    }, 1800);
  };

  const shared = session.share;
  return (
    <Dialog
      open={open}
      title="Share session"
      onClose={onClose}
      actions={
        shared ? (
          <>
            <Button
              disabled={revoking}
              onClick={() => void revoke()}
            >
              {revoking ? 'Stopping…' : 'Stop sharing'}
            </Button>
            <Button primary onClick={onClose}>
              Done
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button primary onClick={() => void create()}>
              Create link
            </Button>
          </>
        )
      }
    >
      {shared ? (
        <>
          <p>
            {SHARE_AUDIENCE} can view this read-only snapshot. Viewers see the transcript up to the moment it was shared.
          </p>
          <div className="row" style={{ gap: 8 }}>
            <span className="field" style={{ minHeight: 48, padding: '10px 14px', fontSize: 11.2, color: 'var(--muted)' }}>
              <span className="truncate">{url ?? 'The link is shown once, when it is created.'}</span>
            </span>
            <span style={{ position: 'relative' }}>
              <Button onClick={() => void copy()} disabled={!url}>
                Copy
              </Button>
              <Ack show={copied} style={{ right: 0, top: -40 }}>
                Copied
              </Ack>
              <Ack show={copyFail} style={{ right: 0, top: -40 }}>
                Clipboard unavailable
              </Ack>
            </span>
          </div>
          <p className="meta">Possession of the link grants access. It is not restricted to workspace members. Viewers cannot send messages, decide requests or change context.</p>
          {error && <p className="meta" role="alert">{error}</p>}
        </>
      ) : (
        <>
          <p className="meta">Creates a read-only bearer link. Anyone who has the link can view this snapshot.</p>
          {error && <p className="meta">{error}</p>}
        </>
      )}
    </Dialog>
  );
}
