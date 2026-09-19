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
import { Avatar, Button, EmptyState, Skeleton } from './app/ui/primitives.js';

const route = currentRoute();
const store = createStore(initialState());

/** `mockUuid(1)`, inlined so the mock module is not pulled into the main chunk. */
const MOCK_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const MOCK_WORKSPACE_NAME_KEY = 'hermes:mock-workspace-name';

function readMockWorkspaceName(): string | undefined {
  try {
    return sessionStorage.getItem(MOCK_WORKSPACE_NAME_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

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
    const recovery = params.get('recovery');
    const backend = createMockBackend({
      recovery: recovery === 'working' || recovery === 'retryable' || recovery === 'retry_scheduled' || recovery === 'blocked' || recovery === 'stopped' || recovery === 'idle' ? recovery : undefined,
      activity: params.get('activity') === 'completed-tool' ? 'completed-tool' : params.get('activity') === 'completed' ? 'completed' : undefined,
      seat: params.get('seat') === 'member' ? 'member' : 'admin',
      data: params.get('data') === 'empty' ? 'empty' : 'seeded',
      providerKey: params.get('key') === 'none' ? 'none' : params.get('key') === 'invalid' ? 'invalid' : 'verified',
      providerKeysLocked: params.get('providerKeys') === 'locked',
      reply: params.get('reply') === 'markdown' ? 'markdown' : 'seeded',
      scenario: params.get('scenario') === 'approvals' ? 'approvals' : 'legacy',
      communicationDraft: params.get('communicationDraft') === '1',
      workspaceName: readMockWorkspaceName(),
      memberWrites: params.get('memberWrites') === 'fail' ? 'fail' : 'ok',
      slack: params.get('slack') === 'connected' ? 'connected' : 'disconnected',
      email: params.get('email') === 'connected' ? 'connected' : 'disconnected',
      partnerWorkflow: params.get('partnerWorkflow') === '1',
      partnerWorkflowNative: params.get('workflowExecution') === 'native',
      workflowRole: params.get('workflowRole') === 'partnerships' ? 'partnerships'
        : params.get('workflowRole') === 'finance' ? 'finance'
          : params.get('workflowRole') === 'unrelated' ? 'unrelated'
            : params.get('workflowRole') === 'admin' ? 'admin' : undefined,
    });
    return createAdapter({ store, workspaceId: backend.workspaceId, auth: createAuth('fake'), fetchImpl: backend.fetchImpl, socketFactory: backend.socketFactory, baseUrl: '' });
  }
  return createAdapter({ store, workspaceId, auth: createAuth() });
}

/** Onboarding uses the same credential-free backend as the shell in mock mode. */
function MockOnboarding({ step, token }: { step: 'create-workspace' | 'join-workspace'; token: string | null }) {
  const [fetchImpl, setFetchImpl] = useState<typeof fetch | null>(null);
  useEffect(() => {
    let live = true;
    void import('./model/mock.js').then((module) => {
      if (!live) return;
      const backend = module.createMockBackend({ workspaceName: readMockWorkspaceName() });
      setFetchImpl(() => backend.fetchImpl);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!fetchImpl)
    return (
      <div className="portal">
        <div className="portal-body" style={{ paddingTop: 140 }}>
          <Skeleton rows={3} label="Loading onboarding" />
        </div>
      </div>
    );
  return <Onboarding route={step} token={token} fetchImpl={fetchImpl} />;
}

function Bootstrap({ route: current }: { route: Extract<Route, { kind: 'workspace' }> }) {
  const [adapter, setAdapter] = useState<Adapter | null>(null);
  const [error, setError] = useState<'signed-out' | 'not-found' | 'failed' | null>(null);

  useEffect(() => {
    let live = true;
    let active: Adapter | null = null;
    void (async () => {
      try {
        const next = await buildAdapter(current.workspaceId);
        if (!live) {
          next.dispose();
          return;
        }
        active = next;
        await next.start();
        if (!live) {
          next.dispose();
          return;
        }
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
        if (!live) return;
        if (caught instanceof RestError && caught.status === 401) setError('signed-out');
        else if (caught instanceof RestError && caught.status === 404) setError('not-found');
        else setError('failed');
      }
    })();
    return () => {
      live = false;
      active?.dispose();
    };
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
  const [workspaces, setWorkspaces] = useState<
    {
      id: string;
      name: string;
      role: string;
      members: { id: string; name: string; avatar_url: string | null }[];
      member_count: number;
    }[]
  >([]);

  useEffect(() => {
    let live = true;
    const rest = createRest({ auth: createAuth() });
    void rest
      .authWorkspaces()
      .then((session) => {
        if (!live) return;
        setWorkspaces(session.workspaces);
        setState('ready');
      })
      .catch((caught: unknown) => {
        if (!live) return;
        const error = caught as { status?: number };
        // 404 is "signed in, in no workspace": a real answer, and the screen
        // for it is the empty picker with its onboarding action.
        setState(error.status === 401 ? 'signed-out' : error.status === 404 ? 'ready' : 'failed');
      });
    return () => {
      live = false;
    };
  }, []);

  if (state === 'signed-out') return <SignIn returnTo={null} />;
  if (state === 'loading')
    return (
      <div className="portal">
        <div className="portal-body" style={{ paddingTop: 140 }}>
          <Skeleton rows={3} label="Finding your workspaces" />
        </div>
      </div>
    );
  if (state === 'failed')
    return (
      <div className="portal">
        <div className="portal-body" style={{ paddingTop: 140, width: 560 }}>
          <EmptyState
            icon="trace"
            title="Could not load your workspaces"
            detail="The server did not answer. Check your connection and try again."
            action={<Button primary onClick={() => window.location.reload()}>Try again</Button>}
          />
        </div>
      </div>
    );

  return (
    <div className="portal workspace-picker">
      <main className="workspace-picker-body">
        <header className="workspace-picker-heading">
          <h1>Your workspaces</h1>
          <p>Choose where Hermes should work.</p>
        </header>
        {workspaces.length === 0 ? (
          <EmptyState
            icon="context"
            title="You are not in a workspace yet"
            detail="Create one, or open the invitation somebody sent you."
            action={<Button primary onClick={() => window.location.assign('/onboarding/create')}>Create a workspace</Button>}
          />
        ) : (
          <div className="workspace-card-grid">
            {workspaces.map((workspace, index) => {
              const lowered = workspace.name.toLocaleLowerCase();
              const artwork = lowered.includes('interview')
                ? 'interview-signal'
                : lowered.includes('finance') || lowered.includes('account')
                  ? 'finance-ledger'
                  : index % 3 === 2
                    ? 'finance-ledger'
                    : 'partner-network';
              const visibleNames = workspace.members.map((member) => member.name).join(', ');
              const overflow = Math.max(0, workspace.member_count - workspace.members.length);
              return (
                <button
                  className="workspace-card"
                  type="button"
                  key={workspace.id}
                  onClick={() => window.location.assign(`/${SHELL_PREFIX}/${workspace.id}`)}
                  aria-label={`Open ${workspace.name}`}
                >
                  <span className="workspace-card-art" aria-hidden="true">
                    <img src={`/assets/workspaces/${artwork}.webp`} alt="" />
                    <span className="workspace-card-art-shade" />
                    <span className="workspace-card-index">{String(index + 1).padStart(2, '0')}</span>
                  </span>
                  <span className="workspace-card-content">
                    <span className="workspace-card-copy">
                      <strong>{workspace.name}</strong>
                      <span className="workspace-card-meta">
                        <span>{workspace.role === 'admin' ? 'Admin' : 'Member'}</span>
                        <i aria-hidden="true" />
                        <span>{workspace.member_count === 1 ? '1 member' : `${workspace.member_count} members`}</span>
                      </span>
                    </span>
                    <span className="workspace-card-footer">
                      <span className="workspace-member-stack" aria-label={visibleNames ? `Members: ${visibleNames}` : 'No member previews available'}>
                        {workspace.members.map((member) => (
                          <span className="workspace-member" title={member.name} key={member.id}>
                            <Avatar person={{ name: member.name, avatar: member.avatar_url ?? undefined }} size={32} />
                          </span>
                        ))}
                        {overflow > 0 ? <span className="workspace-member-more" aria-label={`${overflow} more members`}>+{overflow}</span> : null}
                      </span>
                      <span className="workspace-card-open">Open <span aria-hidden="true">↗</span></span>
                    </span>
                  </span>
                </button>
              );
            })}
            <button className="workspace-create-card" type="button" onClick={() => window.location.assign('/onboarding/create')}>
              <span className="workspace-create-icon" aria-hidden="true">+</span>
              <span>
                <strong>Create a workspace</strong>
                <small>Set up a new team and its agents</small>
              </span>
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function Root() {
  if (route.kind === 'shared') return <SharedRoute token={route.token} />;
  if (route.kind === 'onboarding') return __MOCK__ ? <MockOnboarding step={route.step} token={route.token} /> : <Onboarding route={route.step} token={route.token} />;
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
  // Browser tests can exercise the real picker state machine while the rest of
  // the mock bundle still opens directly into its seeded workspace.
  if (__MOCK__ && new URL(window.location.href).searchParams.get('picker') === '1') return <WorkspacePicker />;
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
