// The entry point.
//
// What the demo did here and this does not: load state from `localStorage`,
// validate it, rehydrate it, persist the whole store every 120 ms, and hang the
// store off `window`. The server is the state now. What is kept is the drafts
// slice, which is persisted by the adapter and survives a 401 — signing out
// must not lose typed text.
//
// `MotionConfig` plus the `data-reduce-motion` effect are replaced by
// `HermesMotionProvider`, which honours the OS setting and the member
// preference together.
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HermesMotionProvider } from '@hermes/motion-components';
import { createStore, initialState } from './model/store.js';
import { createAdapter, type Adapter } from './model/adapter.js';
import { createAuth } from './model/auth.js';
import { RestError } from './model/rest.js';
import { createRest } from './model/rest.js';
import { currentRoute, parseRef, serialiseRef, SHELL_PREFIX, type Route } from './model/routes.js';
import { activeSessionKey } from './model/constants.js';
import { StoreProvider, useAppState } from './app/store-context.js';
import { Shell } from './app/Shell.js';
import { Onboarding, SignIn } from './app/onboarding/Onboarding.js';
import { SharedViewer } from './app/shared/SharedViewer.js';
import { Button, EmptyState, Skeleton } from './app/ui/primitives.js';

const route = currentRoute();
const store = createStore(initialState());

/** `mockUuid(1)`, inlined so the mock module is not pulled into the main chunk. */
const MOCK_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Mock mode. The adapter is handed a `fetch` and a socket factory instead of
 * the browser's, so every call still goes through the same REST client and the
 * same zod parse. `__MOCK__` is a build-time constant, so a real build drops
 * the whole module.
 */
async function buildAdapter(workspaceId: string): Promise<Adapter> {
  if (__MOCK__) {
    const { createMockBackend } = await import('./model/mock.js');
    const params = new URL(window.location.href).searchParams;
    const backend = createMockBackend({
      seat: params.get('seat') === 'member' ? 'member' : 'admin',
      data: params.get('data') === 'empty' ? 'empty' : 'seeded',
      providerKey: params.get('key') === 'none' ? 'none' : params.get('key') === 'invalid' ? 'invalid' : 'verified',
      reply: params.get('reply') === 'markdown' ? 'markdown' : 'seeded',
    });
    return createAdapter({ store, workspaceId: backend.workspaceId, auth: createAuth('fake'), fetchImpl: backend.fetchImpl, socketFactory: backend.socketFactory, baseUrl: '' });
  }
  return createAdapter({ store, workspaceId, auth: createAuth() });
}

function Bootstrap({ route: current }: { route: Extract<Route, { kind: 'workspace' }> }) {
  const [adapter, setAdapter] = useState<Adapter | null>(null);
  const [error, setError] = useState<'signed-out' | 'not-found' | 'failed' | null>(null);

  useEffect(() => {
    let disposed: Adapter | null = null;
    void (async () => {
      try {
        const next = await buildAdapter(current.workspaceId);
        disposed = next;
        await next.start();
        // The URL is the authority on what to show; bootstrap only supplies the
        // default when it names nothing.
        const hashRef = parseRef(window.location.hash);
        const sessionId = current.sessionId ?? readActiveSession(current.workspaceId);
        if (sessionId && store.getState().sessions[sessionId]) {
          store.dispatch({ type: 'session/select', id: sessionId });
          next.openSession(sessionId);
        }
        if (hashRef) store.dispatch({ type: 'nav/app', object: hashRef, manual: true });
        setAdapter(next);
      } catch (caught) {
        if (caught instanceof RestError && caught.status === 401) setError('signed-out');
        else if (caught instanceof RestError && caught.status === 404) setError('not-found');
        else setError('failed');
      }
    })();
    return () => disposed?.dispose();
  }, [current.workspaceId, current.sessionId]);

  if (error === 'signed-out') return <SignIn returnTo={window.location.href} />;
  if (error === 'not-found')
    return (
      <div className="portal">
        <div className="portal-body" style={{ paddingTop: 140, alignItems: 'center' }}>
          <EmptyState icon="context" title="This workspace is not available" detail="It may not exist, or you may not be a member of it." />
        </div>
      </div>
    );
  if (error === 'failed')
    return (
      <div className="portal">
        <div className="portal-body" style={{ paddingTop: 140, alignItems: 'center' }}>
          <EmptyState icon="trace" title="Could not load this workspace" detail="The server did not answer. Reload to try again." />
        </div>
      </div>
    );
  if (!adapter)
    return (
      <div className="portal">
        <div className="portal-body" style={{ paddingTop: 140 }}>
          <Skeleton rows={4} label="Loading the workspace" />
        </div>
      </div>
    );

  return (
    <StoreProvider store={store} adapter={adapter}>
      <App />
    </StoreProvider>
  );
}

/** In mock mode the share viewer polls the mock backend, not a real server. */
function SharedRoute({ token }: { token: string }) {
  const [fetchImpl, setFetchImpl] = useState<((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) | null>(null);
  useEffect(() => {
    if (!__MOCK__) return;
    void import('./model/mock.js').then((module) => setFetchImpl(() => module.createMockBackend().fetchImpl));
  }, []);
  if (__MOCK__ && !fetchImpl) return null;
  return <SharedViewer token={token} {...(fetchImpl ? { fetchImpl } : {})} />;
}

function readActiveSession(workspaceId: string): string | null {
  try {
    return localStorage.getItem(activeSessionKey(workspaceId));
  } catch {
    return null;
  }
}

function App() {
  const state = useAppState();
  // The URL follows the app pane and the active session, so a deep link and a
  // reload land on the same object.
  useEffect(() => {
    if (!state.workspace.id) return;
    try {
      if (state.activeSessionId) localStorage.setItem(activeSessionKey(state.workspace.id), state.activeSessionId);
    } catch {
      /* ignore */
    }
  }, [state.workspace.id, state.activeSessionId]);

  useEffect(() => {
    if (!state.workspace.id) return;
    // Replace, rather than push: each streamed focus or search keystroke is
    // not a new browser-history entry. Preserve existing query flags in demos.
    const url = new URL(window.location.href);
    url.pathname = `/${SHELL_PREFIX}/${state.workspace.id}${state.activeSessionId ? `/s/${state.activeSessionId}` : ''}`;
    url.hash = serialiseRef(state.ui.app);
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  }, [state.workspace.id, state.activeSessionId, state.ui.app]);

  return (
    <HermesMotionProvider reducedMotion={state.ui.reduceMotion}>
      <Shell />
    </HermesMotionProvider>
  );
}

/**
 * The root path: which workspace?
 *
 * `GET /auth/session` with no `?ws=` used to walk `workspace_directory`, which
 * only the WorkOS mirror writes, and answer 404 for a seeded workspace — so
 * there was nothing to build a picker on and the root path went straight to a
 * sign-in screen even for someone already signed in. Server decision F7 made
 * the bare route answer who you are and which workspaces you are in, which is
 * exactly this screen.
 *
 * Three answers, three screens: a 401 is the sign-in, a 404 (signed in, in no
 * workspace) offers the two onboarding routes, and a list is the picker. One
 * workspace is not auto-opened: a redirect nobody asked for is a redirect
 * somebody has to undo, and the row is one click away.
 */
function WorkspacePicker() {
  const [state, setState] = useState<'loading' | 'signed-out' | 'ready' | 'failed'>('loading');
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string; role: string }[]>([]);

  useEffect(() => {
    let live = true;
    const rest = createRest({ auth: createAuth() });
    void rest
      .authWorkspaces()
      .then((session) => {
        if (!live) return;
        setWorkspaces(session.workspaces.map((row) => ({ id: row.id, name: row.name, role: row.role })));
        setState('ready');
      })
      .catch((caught: unknown) => {
        if (!live) return;
        const error = caught as { status?: number };
        // 404 is "signed in, in no workspace": a real answer, and the screen
        // for it is the empty picker with the two onboarding routes on it.
        setState(error.status === 401 ? 'signed-out' : 'ready');
      });
    return () => {
      live = false;
    };
  }, []);

  if (state === 'signed-out') return <SignIn returnTo={null} />;
  if (state === 'loading' || state === 'failed')
    return (
      <div className="portal">
        <div className="portal-body" style={{ paddingTop: 140 }}>
          <Skeleton rows={3} label="Finding your workspaces" />
        </div>
      </div>
    );

  return (
    <div className="portal">
      <div className="portal-body" style={{ paddingTop: 120, width: 560, gap: 20 }}>
        <h1 style={{ font: '500 32px/35.2px var(--font-display)' }}>Your workspaces</h1>
        {workspaces.length === 0 ? (
          <EmptyState
            icon="context"
            title="You are not in a workspace yet"
            detail="Create one, or open the invitation somebody sent you."
            action={<Button primary onClick={() => window.location.assign('/onboarding/create')}>Create a workspace</Button>}
          />
        ) : (
          <div className="col" role="list">
            {workspaces.map((workspace) => (
              <div className="list-row" role="listitem" key={workspace.id}>
                <div className="row-main">
                  <span className="t">{workspace.name}</span>
                  <span className="s">{workspace.role === 'admin' ? 'Admin' : 'Member'}</span>
                </div>
                <Button onClick={() => window.location.assign(`/${SHELL_PREFIX}/${workspace.id}`)}>Open →</Button>
              </div>
            ))}
          </div>
        )}
        <div className="row">
          <Button onClick={() => window.location.assign('/onboarding/create')}>Create a workspace</Button>
        </div>
      </div>
    </div>
  );
}

function Root() {
  if (route.kind === 'shared') return <SharedRoute token={route.token} />;
  if (route.kind === 'onboarding') return <Onboarding route={route.step} token={route.token} />;
  if (route.kind === 'signin' || route.kind === 'callback') {
    // `/auth/callback` lands back inside the workspace; the pending step-up
    // intent is read there and always requires a second click.
    if (route.kind === 'callback' && route.returnTo) {
      window.location.replace(route.returnTo);
      return null;
    }
    return <SignIn returnTo={route.kind === 'signin' ? route.returnTo : null} />;
  }
  if (route.kind === 'workspace') return <Bootstrap route={route} />;
  // In mock mode the root path is the mock workspace, so the bundle can be
  // opened straight from a file server with no worker and no URL to remember.
  if (__MOCK__) return <Bootstrap route={{ kind: 'workspace', workspaceId: MOCK_WORKSPACE_ID, sessionId: null, app: null }} />;
  return <WorkspacePicker />;
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}
