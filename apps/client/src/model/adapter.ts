// The adapter: the one object the components talk to.
//
// It owns everything the reducer must not: the REST client, the two hub
// sockets, the 4-minute session refresh, the entity fetches that answer a cache
// miss, and the step-up dance. Components keep calling `adapter.send(...)` the
// way they did in the demo; what changed is that the work now happens on a
// server and comes back as events.
//
// Two things it deliberately does not do: it never decides (a decision is a
// REST call to the guarded route, and the result is only observed through
// `decision.recorded`), and it never auto-replays a decision after a step-up
// redirect — the pane re-renders and waits for a second click (spec §6).
import {
  isModelCommand,
  validateModelBlocks,
  type Block,
  type BlockCommand,
  type Ref,
  type StreamEvent,
} from '@hermes/shared';
import type { AttachmentRef, DecisionResult } from '@hermes/shared';
import { createRest, RestError, type FetchLike, type Rest } from './rest.js';
import { createHub, type Hub, type SocketFactory } from './hub.js';
import { actionsFor, newClientTurnId, uuid, type Action, type AppState, type EntityKind, type Store } from './store.js';
import { clearStepUp, createAuth, readStepUp, storeStepUp, type AuthAdapter, type StepUpIntent } from './auth.js';
import { draftsKey } from './constants.js';

export const AUTH_REFRESH_MS = 4 * 60 * 1000;

export interface AdapterOptions {
  store: Store;
  workspaceId: string;
  auth?: AuthAdapter;
  fetchImpl?: FetchLike;
  socketFactory?: SocketFactory;
  baseUrl?: string;
  wsBase?: string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  now?: () => number;
  random?: () => number;
  /** Test seam; in the browser this is `document`. */
  visibility?: { addEventListener(type: string, fn: () => void): void; removeEventListener(type: string, fn: () => void): void; hidden: boolean };
}

export interface Adapter {
  readonly rest: Rest;
  readonly auth: AuthAdapter;
  start(): Promise<void>;
  send(sessionId: string, text: string, opts?: { attachments?: AttachmentRef[] }): Promise<void>;
  stop(sessionId: string): Promise<void>;
  retry(sessionId: string, runId: string): Promise<void>;
  guide(sessionId: string, text: string): Promise<void>;
  queue(sessionId: string, text: string): Promise<void>;
  editQueued(sessionId: string, itemId: string, text: string): Promise<void>;
  removeQueued(sessionId: string, itemId: string): Promise<void>;
  decide(requestId: string, decision: 'approve' | 'decline', note?: string): Promise<DecisionResult | 'reauth_required'>;
  applyCommand(sessionId: string, command: BlockCommand): void;
  openSession(sessionId: string): void;
  ensure(kind: EntityKind, id: string, force?: boolean): void;
  ensureList(key: string, load: () => Promise<{ ids: string[]; cursor: string | null; total: number | null; rows: { kind: EntityKind; id: string; data: unknown; version?: number }[] }>): void;
  createSession(opts?: { title?: string; mode?: string; runtime?: 'cloud' | 'local' }): Promise<string>;
  loadEarlier(sessionId: string): Promise<void>;
  refreshAuth(): Promise<void>;
  pendingStepUp(): StepUpIntent | null;
  clearStepUp(): void;
  resync(): Promise<void>;
  dispose(): void;
}

/** Validate model-authored blocks before they are rendered (commands.ts). */
export function safeBlocks(blocks: unknown): { ok: true; blocks: readonly Block[] } | { ok: false; reason: string } {
  const result = validateModelBlocks(blocks);
  if (result.ok) return result;
  return { ok: false, reason: result.rejections.map((r) => r.reason).join('; ') };
}

export function createAdapter(options: AdapterOptions): Adapter {
  const { store, workspaceId } = options;
  const auth = options.auth ?? createAuth();
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const setIntervalImpl = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalImpl = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));

  const rest = createRest({
    auth,
    baseUrl: options.baseUrl ?? '',
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    onSignedOut: () => signOut(),
  });

  const state = (): AppState => store.getState();
  const dispatch = (action: Action): void => {
    store.dispatch(action);
  };

  let workspaceHub: Hub | null = null;
  let sessionHub: Hub | null = null;
  let sessionHubId: string | null = null;
  let refreshHandle: unknown = null;
  let ticket = '';
  let disposed = false;
  const inFlight = new Set<string>();
  const turnIds = new Map<string, string>();

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  function applyEvent(event: StreamEvent): void {
    // A `resync` event is not just a cache drop: the cursor cannot be replayed,
    // so the client refetches bootstrap and re-attaches both sockets (spec §5.5).
    if (event.kind === 'resync') {
      void resync();
      return;
    }
    for (const action of actionsFor(event, state())) {
      dispatch(action);
      // A `loading` upsert is the reducer saying "I do not have this row"; the
      // fetch that answers it belongs here, not in a component's effect.
      if (action.type === 'entity/loading') ensure(action.kind, action.id);
    }
  }

  function signOut(): void {
    dispatch({ type: 'link/state', kind: 'workspace', patch: { status: 'signed-out' } });
    dispatch({ type: 'link/state', kind: 'session', patch: { status: 'signed-out' } });
    workspaceHub?.close();
    sessionHub?.close();
    workspaceHub = null;
    sessionHub = null;
    if (refreshHandle) clearIntervalImpl(refreshHandle);
    refreshHandle = null;
    // Drafts stay in localStorage: signing out must not lose typed text.
    persistDrafts();
  }

  function evicted(): void {
    dispatch({ type: 'ui/set', patch: { banner: 'evicted' } });
  }

  const wsBase =
    options.wsBase ?? (typeof window === 'undefined' ? 'ws://127.0.0.1' : `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`);

  function attachWorkspaceHub(): void {
    workspaceHub?.close();
    workspaceHub = createHub({
      kind: 'workspace',
      url: `${wsBase}/w/${workspaceId}/hub/workspace`,
      ticket,
      after: state().cursors.workspace,
      onEvent: (event) => applyEvent(event),
      onState: (link) => dispatch({ type: 'link/state', kind: 'workspace', patch: link }),
      onResync: () => void resync(),
      replay: async (after) => {
        const page = await rest.events(workspaceId, 'workspace', after);
        return { events: page.events, resync: page.resync };
      },
      onSignedOut: signOut,
      onEvicted: evicted,
      ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
      ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
      ...(options.random ? { random: options.random } : {}),
      now,
    });
  }

  function openSession(sessionId: string): void {
    // Opening a session loads its most recent window once; "Load earlier" pages
    // backwards from `oldestSeq` after that.
    const session = state().sessions[sessionId];
    if (session && session.messages.length === 0 && !inFlight.has(`messages:${sessionId}`)) {
      inFlight.add(`messages:${sessionId}`);
      void rest
        .messages(workspaceId, sessionId, null, 100)
        .then((page) => dispatch({ type: 'message/prepend', sessionId, messages: page.items, hasEarlier: page.cursor !== null }))
        .catch(() => undefined)
        .finally(() => inFlight.delete(`messages:${sessionId}`));
    }
    if (sessionHubId === sessionId && sessionHub) return;
    sessionHub?.close();
    sessionHubId = sessionId;
    sessionHub = createHub({
      kind: 'session',
      url: `${wsBase}/w/${workspaceId}/hub/session/${sessionId}`,
      ticket,
      after: state().cursors.session[sessionId] ?? 0n,
      onEvent: (event) => applyEvent(event),
      onState: (link) => dispatch({ type: 'link/state', kind: 'session', patch: link }),
      onResync: () => void resync(),
      replay: async (after) => {
        const page = await rest.events(workspaceId, `session:${sessionId}`, after);
        return { events: page.events, resync: page.resync };
      },
      onSignedOut: signOut,
      onEvicted: evicted,
      ...(options.socketFactory ? { socketFactory: options.socketFactory } : {}),
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
      ...(options.clearTimer ? { clearTimer: options.clearTimer } : {}),
      ...(options.random ? { random: options.random } : {}),
      now,
    });
  }

  // -------------------------------------------------------------------------
  // Entity fetching
  // -------------------------------------------------------------------------

  const FETCHERS: Partial<Record<EntityKind, (id: string) => Promise<unknown>>> = {
    request: (id) => rest.getRequest(workspaceId, id),
    document: (id) => rest.getDocument(workspaceId, id),
    trace: (id) => rest.getTrace(workspaceId, id),
  };

  /**
   * Fetch one entity if the cache does not have it. `force` is for the case
   * where the client knows the row changed but the event carries only part of
   * it — a decision, whose event says `resulting_status` and nothing else.
   */
  function ensure(kind: EntityKind, id: string, force = false): void {
    const key = `${kind}:${id}`;
    if (inFlight.has(key)) return;
    const record = state().entities[kind]?.[id];
    if (!force && record && record.state === 'ready') return;
    const fetcher = FETCHERS[kind];
    if (!fetcher) return;
    inFlight.add(key);
    dispatch({ type: 'entity/loading', kind, id });
    fetcher(id)
      .then((data) => {
        const version = typeof (data as { version?: number }).version === 'number' ? (data as { version: number }).version : 1;
        dispatch({ type: 'entity/upsert', kind, id, version, data });
      })
      .catch((error: unknown) => {
        // "Request not found" is shown only after a completed fetch that 404s,
        // never as the first thing a cross-socket race produces (spec §7).
        if (error instanceof RestError && error.status === 404) dispatch({ type: 'entity/missing', kind, id });
      })
      .finally(() => inFlight.delete(key));
  }

  function ensureList(key: string, load: () => Promise<{ ids: string[]; cursor: string | null; total: number | null; rows: { kind: EntityKind; id: string; data: unknown; version?: number }[] }>): void {
    if (inFlight.has(`list:${key}`)) return;
    if (state().entities.lists[key]?.state === 'ready') return;
    inFlight.add(`list:${key}`);
    load()
      .then((page) => {
        for (const row of page.rows) dispatch({ type: 'entity/upsert', kind: row.kind, id: row.id, version: row.version ?? 1, data: row.data });
        dispatch({ type: 'list/set', key, ids: page.ids, cursor: page.cursor, total: page.total });
      })
      .catch(() => {
        dispatch({ type: 'list/set', key, ids: [], cursor: null, total: 0 });
      })
      .finally(() => inFlight.delete(`list:${key}`));
  }

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  let persistHandle: unknown = null;
  function persistDrafts(): void {
    const s = state();
    if (!s.workspace.id || !s.user.id) return;
    const drafts: Record<string, { text: string; attachments: { id: string; label: string }[] }> = {};
    for (const [id, session] of Object.entries(s.sessions)) {
      if (session.draft.text || session.draft.attachments.length) drafts[id] = session.draft;
    }
    try {
      localStorage.setItem(draftsKey(s.workspace.id, s.user.id), JSON.stringify(drafts));
    } catch {
      /* a full or blocked store is not worth failing a keystroke over */
    }
  }

  store.subscribe((_s, action) => {
    if (action.type !== 'session/draft' && action.type !== 'session/attach' && action.type !== 'session/detach' && action.type !== 'session/draft-clear') return;
    if (persistHandle) clearTimer(persistHandle);
    persistHandle = setTimer(persistDrafts, 200);
  });

  function restoreDrafts(): void {
    const s = state();
    if (!s.workspace.id || !s.user.id) return;
    try {
      const raw = localStorage.getItem(draftsKey(s.workspace.id, s.user.id));
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, { text: string; attachments: { id: string; label: string }[] }>;
      dispatch({ type: 'session/drafts-restore', drafts: parsed });
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async function refreshAuth(): Promise<void> {
    try {
      const session = await rest.authSession();
      ticket = session.hub_ticket;
      dispatch({ type: 'auth/refreshed', at: now() });
      workspaceHub?.extend(ticket);
      sessionHub?.extend(ticket);
      // A client behind the head replays over HTTP even though no socket noticed.
      const head = BigInt(session.stream_heads.workspace);
      if (head > state().cursors.workspace) {
        const page = await rest.events(workspaceId, 'workspace', state().cursors.workspace);
        if (page.resync) await resync();
        else for (const event of page.events) applyEvent(event);
      }
    } catch (error) {
      if (error instanceof RestError && error.signedOut) signOut();
    }
  }

  const onVisibility = (): void => {
    const doc = options.visibility ?? (typeof document === 'undefined' ? null : document);
    if (!doc || doc.hidden) return;
    if (now() - state().connection.authRefreshedAt > AUTH_REFRESH_MS) void refreshAuth();
  };

  async function start(): Promise<void> {
    const boot = await rest.bootstrap(workspaceId);
    let extra: Awaited<ReturnType<typeof rest.bootstrapExtra>> | null = null;
    try {
      extra = await rest.bootstrapExtra(workspaceId);
    } catch {
      // The M1 worker serves only the core bootstrap; the client degrades to
      // empty lists rather than refusing to boot.
      extra = null;
    }
    ticket = extra?.hub_ticket ?? '';

    // A re-bootstrap (a resync) must not take the draft with it: what the
    // person typed is theirs, and the server has never seen it.
    const existing = state().sessions;
    const sessions = Object.fromEntries(
      boot.sessions.map((row) => {
        const previous = existing[row.id];
        const seed = sessionSeed(row);
        return [row.id, previous ? { ...seed, draft: previous.draft, scrollTop: previous.scrollTop, unread: previous.unread } : seed];
      }),
    );

    dispatch({
      type: 'bootstrap/apply',
      patch: {
        workspace: { id: boot.workspace.id, name: boot.workspace.name, role: boot.viewer.role, jurisdiction: boot.workspace.jurisdiction },
        user: { id: boot.viewer.user_id, name: extra?.agent?.name ?? '', email: '', role: boot.viewer.role },
        agent: {
          id: extra?.agent?.id ?? null,
          name: extra?.agent?.name ?? 'Iris',
          email: extra?.agent?.email ?? '',
          summary: extra?.agent?.summary ?? '',
          setupStep: extra?.agent?.setup_step ?? null,
        },
        sessions,
        sessionOrder: boot.sessions.map((row) => row.id),
        activeSessionId: boot.sessions[0]?.id ?? null,
        counts: { inbox: boot.counts.inbox, pendingGrants: boot.counts.pending_grants, createdDocuments: boot.counts.created_documents, decisions: boot.counts.decisions },
        settings: { ...boot.workspace.settings },
        cursors: { workspace: BigInt(boot.heads.workspace), session: {} },
        ready: true,
      },
    });

    for (const row of boot.catalog) dispatch({ type: 'entity/upsert', kind: 'catalog', id: row.model_id, version: 1, data: row });
    for (const row of boot.requests) {
      // Bootstrap carries only the list shape; the full row is fetched when the
      // request is opened. Marking it `loading` is what keeps the skeleton rule.
      dispatch({ type: 'entity/loading', kind: 'request', id: row.id });
    }
    dispatch({ type: 'list/set', key: 'inbox:needs-review', ids: boot.requests.filter((r) => r.status === 'pending').map((r) => r.id), cursor: null, total: boot.counts.inbox });
    for (const row of extra?.members ?? []) dispatch({ type: 'entity/upsert', kind: 'member', id: row.id, version: row.version, data: row });
    if (extra?.members) dispatch({ type: 'list/set', key: 'members', ids: extra.members.map((m) => m.id), cursor: null, total: extra.members.length });
    for (const row of extra?.invitations ?? []) dispatch({ type: 'entity/upsert', kind: 'invitation', id: row.id, version: row.version, data: row });
    if (extra?.invitations) dispatch({ type: 'list/set', key: 'invitations', ids: extra.invitations.map((i) => i.id), cursor: null, total: extra.invitations.length });
    for (const row of extra?.provider_keys ?? []) dispatch({ type: 'entity/upsert', kind: 'provider_key', id: row.id, version: 1, data: row });
    if (extra?.provider_keys) dispatch({ type: 'list/set', key: 'provider-keys', ids: extra.provider_keys.map((k) => k.id), cursor: null, total: extra.provider_keys.length });

    restoreDrafts();
    attachWorkspaceHub();
    const active = state().activeSessionId;
    if (active) openSession(active);
    refreshHandle = setIntervalImpl(() => void refreshAuth(), AUTH_REFRESH_MS);
    const doc = options.visibility ?? (typeof document === 'undefined' ? null : document);
    doc?.addEventListener('visibilitychange', onVisibility);
  }

  async function resync(): Promise<void> {
    dispatch({ type: 'cache/clear' });
    try {
      await start();
    } catch (error) {
      if (error instanceof RestError && error.signedOut) signOut();
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async function send(sessionId: string, text: string, opts: { attachments?: AttachmentRef[] } = {}): Promise<void> {
    const session = state().sessions[sessionId];
    const trimmed = text.trim();
    if (!session || !trimmed) return;
    // One client_turn_id per composer draft, reused across retries of the POST
    // and discarded on a 2xx, so a duplicate POST returns the existing run.
    const turnId = turnIds.get(sessionId) ?? newClientTurnId();
    turnIds.set(sessionId, turnId);
    dispatch({ type: 'session/draft-clear', id: sessionId });
    try {
      await rest.sendTurn(workspaceId, sessionId, {
        text: trimmed,
        client_turn_id: turnId,
        attachments: opts.attachments ?? session.draft.attachments.map((a) => ({ id: a.id, label: a.label, kind: 'file' as const, status: 'ready' as const })),
        mode: session.mode,
        model_id: session.model,
        effort: session.effort,
      });
      turnIds.delete(sessionId);
    } catch (error) {
      // The draft comes back so the text is never lost.
      dispatch({ type: 'session/draft', id: sessionId, text: trimmed });
      throw error;
    }
  }

  async function createSession(opts: { title?: string; mode?: string; runtime?: 'cloud' | 'local' } = {}): Promise<string> {
    const localId = `local-${uuid()}`;
    dispatch({ type: 'session/create', id: localId, ...opts, pending: true });
    try {
      const row = await rest.createSession(workspaceId, opts);
      dispatch({ type: 'session/reconcile', localId, serverId: row.id });
      dispatch({ type: 'session/upsert', session: row });
      openSession(row.id);
      return row.id;
    } catch (error) {
      dispatch({ type: 'session/rollback', id: localId });
      throw error;
    }
  }

  async function loadEarlier(sessionId: string): Promise<void> {
    const session = state().sessions[sessionId];
    if (!session) return;
    const page = await rest.messages(workspaceId, sessionId, session.oldestSeq, 100);
    dispatch({ type: 'message/prepend', sessionId, messages: page.items, hasEarlier: page.cursor !== null });
  }

  async function decide(requestId: string, decision: 'approve' | 'decline', note?: string): Promise<DecisionResult | 'reauth_required'> {
    try {
      const result = await rest.decide(workspaceId, requestId, note ? { decision, note } : { decision });
      // The event carries `resulting_status` only; the review pane needs the
      // whole row, so the cached one is refetched rather than patched here.
      ensure('request', requestId, true);
      return result;
    } catch (error) {
      if (error instanceof RestError && error.reauthRequired) {
        storeStepUp({ kind: 'decision', requestId, decision, ...(note ? { note } : {}), returnTo: typeof window === 'undefined' ? '/' : window.location.href });
        if (typeof window !== 'undefined') window.location.assign(auth.stepUpUrl(window.location.href, 'decision'));
        return 'reauth_required';
      }
      throw error;
    }
  }

  function applyCommand(sessionId: string, command: BlockCommand): void {
    if (!command) return;
    // The client-side second line after the server validator: a command that is
    // not in MODEL_COMMANDS is dropped, never dispatched.
    if (!isModelCommand(command.type)) return;
    switch (command.type) {
      case 'batch':
        for (const nested of command.commands ?? []) applyCommand(sessionId, nested);
        return;
      case 'nav':
      case 'set_focus':
        if (command.object) dispatch({ type: 'nav/app', object: command.object as Ref, manual: true });
        return;
      case 'open_request':
        if (command.id) {
          ensure('request', command.id);
          dispatch({ type: 'nav/app', object: { section: 'inbox', view: 'request', id: command.id }, manual: true });
        }
        return;
      case 'open_document':
        if (command.id) {
          ensure('document', command.id);
          dispatch({ type: 'nav/app', object: { section: 'library', view: 'documents', id: command.id }, manual: true });
        }
        return;
      case 'open_source':
        if (command.object) dispatch({ type: 'nav/app', object: command.object as Ref, manual: true });
        return;
      case 'chat/prompt':
        if (command.text) dispatch({ type: 'session/draft', id: sessionId, text: command.text });
        return;
      case 'chat/say':
        // A model-authored `chat/say` is the model talking; it arrives as a
        // message from the server, so there is nothing for the client to do.
        return;
      case 'apply_prepared_proposal':
        if (command.id) void rest.saveInstruction(workspaceId, command.id).catch(() => undefined);
        return;
      default:
        return;
    }
  }

  return {
    rest,
    auth,
    start,
    send,
    stop: (sessionId) => rest.stop(workspaceId, sessionId),
    retry: (sessionId, runId) => rest.retry(workspaceId, sessionId, runId),
    guide: (sessionId, text) => rest.guide(workspaceId, sessionId, text),
    queue: (sessionId, text) => rest.enqueue(workspaceId, sessionId, text),
    editQueued: (sessionId, itemId, text) => rest.editQueued(workspaceId, sessionId, itemId, text),
    removeQueued: (sessionId, itemId) => rest.removeQueued(workspaceId, sessionId, itemId),
    decide,
    applyCommand,
    openSession,
    ensure,
    ensureList,
    createSession,
    loadEarlier,
    refreshAuth,
    pendingStepUp: readStepUp,
    clearStepUp,
    resync,
    dispose() {
      disposed = true;
      workspaceHub?.close();
      sessionHub?.close();
      if (refreshHandle) clearIntervalImpl(refreshHandle);
      const doc = options.visibility ?? (typeof document === 'undefined' ? null : document);
      doc?.removeEventListener('visibilitychange', onVisibility);
      void disposed;
    },
  };
}

/** Bootstrap rows carry fewer fields than a full session row; fill the rest. */
function sessionSeed(row: import('@hermes/shared').Bootstrap['sessions'][number]) {
  return {
    id: row.id,
    title: row.title,
    subtitle: null,
    mode: row.mode,
    model: row.model_id,
    effort: row.effort,
    runtime: 'cloud' as const,
    pinned: row.pinned,
    archived: row.archived,
    status: row.status,
    messages: [],
    oldestSeq: null,
    hasEarlier: true,
    draft: { text: '', attachments: [] },
    run: null,
    stream: null,
    focus: row.focus_ref,
    context: null,
    scrollTop: null,
    share: null,
    unread: false,
    pending: false,
    lastActivity: row.last_activity_at ? Date.parse(row.last_activity_at) : Date.now(),
    carried: null,
  };
}
