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
import type {
  Attachment,
  AttachmentRef,
  DecisionResult,
  InvitationEntity,
  MaskedProviderKey,
  MemberEntity,
} from '@hermes/shared';

/** What `loadExtra` composes out of the routes the Worker actually serves. */
interface BootstrapExtra {
  user: { id: string; name: string; email: string; role: 'admin' | 'member' } | null;
  members: MemberEntity[];
  invitations: InvitationEntity[];
  providerKeys: MaskedProviderKey[];
  /** True when the key list needs a step-up before it can be read at all. */
  providerKeysLocked: boolean;
  hubTicket: string;
  sessionHead: string | null;
}
import { createRest, RestError, type FetchLike, type Rest } from './rest.js';
import { createHub, type Hub, type SocketFactory } from './hub.js';
import {
  DEFAULT_SESSION_TITLE,
  actionsFor,
  autoTitleFrom,
  entityData,
  isBlankSession,
  newClientTurnId,
  uuid,
  visibleSessions,
  type Action,
  type AppState,
  type EntityKind,
  type Store,
} from './store.js';
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
  /** Answer the question an `ask_for_context` step parked the run on. */
  answerContext(sessionId: string, key: string, value: string): Promise<void>;
  /** Declare, put the bytes, complete. Returns the ready row. */
  upload(file: File, opts?: { kind?: 'attachment' | 'agent_file'; sessionId?: string }): Promise<Attachment>;
  decide(requestId: string, decision: 'approve' | 'decline', note?: string): Promise<DecisionResult | 'reauth_required'>;
  applyCommand(sessionId: string, command: BlockCommand): void;
  openSession(sessionId: string): void;
  ensure(kind: EntityKind, id: string, force?: boolean): void;
  ensureList(key: string, load: () => Promise<{ ids: string[]; cursor: string | null; total: number | null; rows: { kind: EntityKind; id: string; data: unknown; version?: number }[] }>): void;
  /**
   * Drop a list so the next render fetches it again.
   *
   * `ensureList` is idempotent by design — a list that is `ready` costs
   * nothing — which is exactly wrong after a mutation the server owns the
   * consequences of. Accepting an instruction moves three rows (`proposed`
   * becomes `saved`, the old `current` becomes `saved`), and only the server
   * knows which; refetching is the only honest way to find out.
   */
  invalidateList(key: string): void;
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
  /** `heads.session` from the last bootstrap; where a new session hub starts. */
  let sessionHead = 0n;
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
      // The row a queued title refinement was waiting for.
      if (action.type === 'entity/upsert' && action.kind === 'request' && titleWaiting.size > 0) {
        for (const id of [...titleWaiting]) refineTitle(id);
      }
    }
    // A completed run may have named its session better than its first turn did.
    if (event.kind === 'run.status' && event.payload.status === 'completed' && event.session_id) refineTitle(event.session_id);
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

  /**
   * How often the polling fallback asks, when it is in use.
   *
   * Fast while any session has a live run, because that is the transcript
   * moving under the reader's eyes; slow otherwise, because an idle workspace
   * polling three times a second is a bill and a battery.
   */
  const POLL_ACTIVE_MS = 600;
  const POLL_IDLE_MS = 4_000;
  function pollCadence(): number {
    const active = Object.values(state().sessions).some(
      (session) => session.run && (session.run.status === 'working' || session.run.status === 'stopping'),
    );
    return active ? POLL_ACTIVE_MS : POLL_IDLE_MS;
  }

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
        return { events: page.events, resync: page.resync, head: page.head };
      },
      onSignedOut: signOut,
      onEvicted: evicted,
      pollMs: pollCadence,
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
      // The head at bootstrap, not zero.
      //
      // `GET /w/:ws/events?stream=session` is not scoped to one session — it
      // answers with every session the caller may see — so starting a fresh
      // session hub at 0 replays the whole workspace's session history, 500
      // rows at a time, before it can deliver anything live. The transcript
      // itself comes from `GET .../messages`; the socket only ever needs what
      // happens from now on.
      after: state().cursors.session[sessionId] ?? sessionHead,
      accept: (event) => event.session_id === sessionId,
      onEvent: (event) => applyEvent(event),
      onState: (link) => dispatch({ type: 'link/state', kind: 'session', patch: link }),
      onResync: () => void resync(),
      replay: async (after) => {
        const page = await rest.events(workspaceId, 'session', after);
        return { events: page.events, resync: page.resync, head: page.head };
      },
      onSignedOut: signOut,
      onEvicted: evicted,
      pollMs: pollCadence,
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
        // A title refinement parked on this row (decision C34).
        if (kind === 'request' && titleWaiting.size > 0) for (const sessionId of [...titleWaiting]) refineTitle(sessionId);
      })
      .catch((error: unknown) => {
        // "Request not found" is shown only after a completed fetch that 404s,
        // never as the first thing a cross-socket race produces (spec §7).
        if (!(error instanceof RestError) || error.status !== 404) return;
        // `unknown_route` is the Worker saying "this build has no such route",
        // which is a different sentence from "no such row".
        if (error.reason === 'unknown_route') dispatch({ type: 'entity/unavailable', kind, id });
        else dispatch({ type: 'entity/missing', kind, id });
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
      const session = await rest.authSession(workspaceId);
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

  /**
   * Everything bootstrap does not carry, from the routes that do carry it.
   *
   * The port spec asked for one `GET /w/:ws/bootstrap/client`. The Worker as
   * built has no such route, and adding one is the server's to do, so the
   * client composes the same object out of four routes it already has — and
   * they are exactly the four the shell would have to call anyway on its first
   * render. Each is independently optional: a workspace whose Admin has not
   * added a key still boots, and a Member who may not read the key rows gets
   * the list the Provider keys tab renders as "Admin decision required" rather
   * than a failed bootstrap.
   */
  async function loadExtra(): Promise<BootstrapExtra> {
    const [session, members, invitations, keys] = await Promise.all([
      rest.authSession(workspaceId).catch(() => null),
      rest.listMembers(workspaceId).catch(() => null),
      rest.listInvitations(workspaceId).catch(() => null),
      // A 401 here is `reauth_required`, not "signed out": reading provider
      // keys is a step-up action. The tab asks again behind the step-up flow.
      rest.providerKeys(workspaceId).then(
        (page) => ({ keys: page.keys, locked: false }),
        (error: unknown) => ({ keys: [], locked: error instanceof RestError && error.reauthRequired }),
      ),
    ]);
    return {
      user: session?.user ?? null,
      members: members?.items ?? [],
      invitations: invitations?.items ?? [],
      providerKeys: keys.keys,
      providerKeysLocked: keys.locked,
      hubTicket: session?.hub_ticket ?? '',
      sessionHead: session?.stream_heads.session ?? null,
    };
  }

  async function start(): Promise<void> {
    const boot = await rest.bootstrap(workspaceId);
    const extra = await loadExtra();
    ticket = extra.hubTicket;
    sessionHead = BigInt(boot.heads.session);

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
        user: {
          id: boot.viewer.user_id,
          name: extra.user?.name ?? '',
          email: extra.user?.email ?? '',
          role: boot.viewer.role,
        },
        agent: {
          id: boot.agent.id,
          name: boot.agent.name,
          email: boot.agent.email,
          summary: boot.agent.responsibility ?? '',
          setupStep: boot.agent.setup_step,
        },
        capabilities: {
          emailIngress: boot.capabilities.email_ingress,
          turnAttachments: boot.capabilities.turn_attachments,
          automatedTriggers: boot.capabilities.automated_triggers,
        },
        sessions,
        sessionOrder: boot.sessions.map((row) => row.id),
        activeSessionId: boot.sessions[0]?.id ?? null,
        counts: {
          inbox: boot.counts.inbox,
          pendingForMe: boot.counts.pending_for_me ?? boot.counts.inbox,
          pendingForOthers: boot.counts.pending_for_others ?? 0,
          pendingGrants: boot.counts.pending_grants,
          createdDocuments: boot.counts.created_documents,
          decisions: boot.counts.decisions,
        },
        settings: { ...boot.workspace.settings },
        cursors: { workspace: BigInt(boot.heads.workspace), session: {} },
        ...(!state().ready && boot.sessions[0]?.focus_ref
          ? { ui: { ...state().ui, app: boot.sessions[0].focus_ref, follow: true } }
          : {}),
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
    for (const row of extra.members) dispatch({ type: 'entity/upsert', kind: 'member', id: row.id, version: row.version, data: row });
    dispatch({ type: 'list/set', key: 'members', ids: extra.members.map((m) => m.id), cursor: null, total: extra.members.length });
    for (const row of extra.invitations) dispatch({ type: 'entity/upsert', kind: 'invitation', id: row.id, version: row.version, data: row });
    dispatch({ type: 'list/set', key: 'invitations', ids: extra.invitations.map((i) => i.id), cursor: null, total: extra.invitations.length });
    for (const row of extra.providerKeys) dispatch({ type: 'entity/upsert', kind: 'provider_key', id: row.id, version: 1, data: row });
    dispatch({ type: 'list/set', key: 'provider-keys', ids: extra.providerKeys.map((k) => k.id), cursor: null, total: extra.providerKeys.length });
    dispatch({ type: 'ui/set', patch: { providerKeysLocked: extra.providerKeysLocked } });

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

  /**
   * Set a session's title from the client, and persist it.
   *
   * Refuses to touch a manually renamed session — the reducer refuses too, so
   * this is the second of two lines, and the PATCH is the reason it is needed
   * here as well: a write the reducer discarded must not still reach the
   * server.
   */
  function autoTitle(sessionId: string, source: string, { onlyIfPlaceholder = true } = {}): void {
    const session = state().sessions[sessionId];
    if (!session || session.titleSource === 'manual') return;
    if (onlyIfPlaceholder && session.title !== DEFAULT_SESSION_TITLE && session.title.trim() !== '') return;
    const title = autoTitleFrom(source);
    if (!title || title === session.title) return;
    dispatch({ type: 'session/auto-title', id: sessionId, title });
    persistTitle(sessionId, title);
  }

  /** A local id has no row to PATCH yet, so the title waits for `session/reconcile`. */
  const pendingTitles = new Map<string, string>();
  function persistTitle(sessionId: string, title: string): void {
    if (sessionId.startsWith('local-')) pendingTitles.set(sessionId, title);
    else void rest.patchSession(workspaceId, sessionId, { title }).catch(() => undefined);
  }

  /**
   * Once a run finishes, the object it produced is a better name than the first
   * six words of the question that started it — "Ada Ling · application" rather
   * than "Screen the applicant in the". It is derived entirely from rows the
   * client already has: the session's focus ref and the request in the entity
   * cache. No route was added for this.
   */
  const titleWaiting = new Set<string>();
  function refineTitle(sessionId: string): void {
    const session = state().sessions[sessionId];
    if (!session || session.titleSource === 'manual') {
      titleWaiting.delete(sessionId);
      return;
    }
    const focus = session.focus;
    if (!focus || focus.section !== 'inbox' || focus.view !== 'request' || !focus.id) return;
    const request = entityData<import('@hermes/shared').RequestEntity>(state(), 'request', focus.id);
    if (!request) {
      // The run finished before the request row arrived, which is the ordinary
      // case: the focus event and the entity fetch are two different round
      // trips. Ask for the row, and retry when it lands.
      titleWaiting.add(sessionId);
      ensure('request', focus.id);
      return;
    }
    titleWaiting.delete(sessionId);
    const subject = request.subject?.trim() || request.label.trim();
    if (!subject) return;
    const title = `${subject} · ${request.kind}`;
    if (title === session.title) return;
    dispatch({ type: 'session/auto-title', id: sessionId, title });
    persistTitle(sessionId, title);
  }

  async function send(sessionId: string, text: string, opts: { attachments?: AttachmentRef[] } = {}): Promise<void> {
    const session = state().sessions[sessionId];
    const trimmed = text.trim();
    if (!session || !trimmed) return;
    // One client_turn_id per composer draft, reused across retries of the POST
    // and discarded on a 2xx, so a duplicate POST returns the existing run.
    const turnId = turnIds.get(sessionId) ?? newClientTurnId();
    turnIds.set(sessionId, turnId);
    dispatch({ type: 'session/draft-clear', id: sessionId });
    // The first turn names the session. It is dispatched before the POST so the
    // sidebar stops saying "New session" the moment Enter is pressed, and
    // PATCHed so a reload agrees; a failed PATCH leaves the local title, which
    // is a better answer than a placeholder. Both of these run *before* the
    // await below, while `sessionId` is still the id the store is keyed on.
    //
    // The title it replaces is kept, because a turn the server refuses never
    // happened: a session called "testing" whose only turn was rejected for
    // having no provider key is a name for something that does not exist
    // (decision C45).
    const titleBefore = session.title;
    autoTitle(sessionId, trimmed);
    // The route needs a real id. A person who types their first sentence faster
    // than the create POST answers used to lose the turn to a 400 `bad_id`.
    const routeId = await serverSessionId(sessionId);
    try {
      await rest.sendTurn(workspaceId, routeId, {
        text: trimmed,
        client_turn_id: turnId,
        attachments: state().capabilities.turnAttachments
          ? opts.attachments ?? session.draft.attachments.map((a) => ({ id: a.id, label: a.label, kind: 'file' as const, status: 'ready' as const }))
          : [],
        mode: session.mode,
        model_id: session.model,
        effort: session.effort,
      });
      turnIds.delete(sessionId);
    } catch (error) {
      // The draft comes back so the text is never lost — under whichever id the
      // store is keyed on now, which is the server's if the await reconciled.
      const id = state().sessions[routeId] ? routeId : sessionId;
      dispatch({ type: 'session/draft', id, text: trimmed });
      // And the name goes back, unless a person has renamed it in between: a
      // manual rename wins permanently (decision C34), and that is still true
      // when the thing being undone is the client's own guess.
      const now = state().sessions[id];
      if (now && now.titleSource !== 'manual' && now.title !== titleBefore) {
        dispatch({ type: 'session/rename', id, title: titleBefore });
        persistTitle(id, titleBefore);
      }
      throw error;
    }
  }

  /**
   * Local ids that are still becoming server ids.
   *
   * An optimistic session exists in the store as `local-…` until `POST
   * /w/:ws/sessions` answers. Anything that needs a *route* — a turn, a rename —
   * has to wait for the real id rather than putting `local-…` in a URL, which
   * the Worker answers `400 bad_id` to. That used to be unreachable because
   * nothing focused the composer on New session; it is reachable now, and the
   * failure was a turn that vanished (decision C34).
   */
  const creating = new Map<string, Promise<string>>();

  /** The server id for a session, waiting for its creation if it is still local. */
  async function serverSessionId(sessionId: string): Promise<string> {
    if (!sessionId.startsWith('local-')) return sessionId;
    const pending = creating.get(sessionId);
    if (!pending) return sessionId;
    return pending;
  }

  async function createSession(opts: { title?: string; mode?: string; runtime?: 'cloud' | 'local'; reuse?: boolean } = {}): Promise<string> {
    // "New session" clicked three times used to be three blank sessions, all
    // titled "New session", all identical in the sidebar (decision C34). A
    // blank one is already a new session, so it is opened rather than joined by
    // a twin. `reuse: false` is the escape hatch for a caller that genuinely
    // wants a second one; nothing uses it yet, and the option exists so the
    // rule is visible rather than assumed.
    if (opts.reuse !== false && !opts.title) {
      // A *pending* blank session counts. It is the whole race: the first click
      // inserts a local row and posts, the second click arrives before the POST
      // answers, and if "pending" disqualified the row the second click would
      // create a twin — which is exactly the bug this rule exists to stop.
      const blank = visibleSessions(state()).find(isBlankSession);
      if (blank) {
        dispatch({ type: 'session/select', id: blank.id });
        if (!blank.pending) openSession(blank.id);
        return blank.id;
      }
    }
    const localId = `local-${uuid()}`;
    dispatch({ type: 'session/create', id: localId, ...opts, pending: true });
    const settled = (async () => {
      const agentId = state().agent.id;
      const row = await rest.createSession(workspaceId, { ...opts, ...(agentId ? { agent_id: agentId } : {}) });
      dispatch({ type: 'session/reconcile', localId, serverId: row.id });
      dispatch({ type: 'session/upsert', session: row });
      openSession(row.id);
      // A title chosen while the row was still local (decision C34). Somebody
      // who types their first sentence fast enough beats this POST, and the
      // PATCH that would have persisted their title had nowhere to go.
      const parked = pendingTitles.get(localId);
      if (parked) {
        pendingTitles.delete(localId);
        dispatch({ type: 'session/auto-title', id: row.id, title: parked });
        void rest.patchSession(workspaceId, row.id, { title: parked }).catch(() => undefined);
      }
      return row.id;
    })();
    creating.set(localId, settled);
    try {
      return await settled;
    } catch (error) {
      dispatch({ type: 'session/rollback', id: localId });
      throw error;
    } finally {
      creating.delete(localId);
    }
  }

  async function loadEarlier(sessionId: string): Promise<void> {
    const session = state().sessions[sessionId];
    if (!session) return;
    const page = await rest.messages(workspaceId, sessionId, session.oldestSeq, 100);
    dispatch({ type: 'message/prepend', sessionId, messages: page.items, hasEarlier: page.cursor !== null });
  }


  // -------------------------------------------------------------------------
  // The four run controls
  // -------------------------------------------------------------------------

  /**
   * Which run a control acts on.
   *
   * The Worker scopes Stop, Guide, Queue and Retry to `/runs/:runId`, so the
   * client has to name one. It is always the session's current run — the
   * reducer holds exactly one, set by `run.started` and cleared by `run/clear`
   * — and a control pressed when there is none is a no-op rather than an
   * error, because the button is already disabled in that state and a race
   * between the last delta and a click should not raise anything.
   */
  function currentRunId(sessionId: string): string | null {
    return state().sessions[sessionId]?.run?.id ?? null;
  }

  async function stop(sessionId: string): Promise<void> {
    const runId = currentRunId(sessionId);
    if (!runId) return;
    await rest.stop(workspaceId, sessionId, runId);
  }

  async function guide(sessionId: string, text: string): Promise<void> {
    const runId = currentRunId(sessionId);
    if (!runId) return;
    // Optimistic only as far as the copy goes: "Guidance queued" is what the
    // route confirms, and `run.guidance.applied` is what promotes it.
    dispatch({ type: 'run/guide', sessionId, text, id: `pending-${uuid()}` });
    try {
      await rest.guide(workspaceId, sessionId, runId, text);
    } catch (error) {
      dispatch({ type: 'run/guide-remove', sessionId });
      throw error;
    }
  }

  async function enqueue(sessionId: string, text: string): Promise<void> {
    const runId = currentRunId(sessionId);
    if (!runId) return;
    const page = await rest.enqueue(workspaceId, sessionId, runId, text);
    dispatch({ type: 'run/queue', sessionId, items: page.items });
  }

  async function editQueued(sessionId: string, itemId: string, text: string): Promise<void> {
    const runId = currentRunId(sessionId);
    if (!runId) return;
    const page = await rest.editQueued(workspaceId, sessionId, runId, itemId, text);
    dispatch({ type: 'run/queue', sessionId, items: page.items });
  }

  async function removeQueued(sessionId: string, itemId: string): Promise<void> {
    const runId = currentRunId(sessionId);
    if (!runId) return;
    const page = await rest.removeQueued(workspaceId, sessionId, runId, itemId);
    dispatch({ type: 'run/queue', sessionId, items: page.items });
  }

  async function answerContext(sessionId: string, key: string, value: string): Promise<void> {
    const runId = currentRunId(sessionId);
    if (!runId) return;
    await rest.answerContext(workspaceId, sessionId, runId, key, value);
  }

  /**
   * An upload, in the three steps the Worker's routes describe.
   *
   * The middle step is the one worth naming: in a deployed environment the
   * bytes go straight to R2 through a presigned PUT and never touch a Worker
   * request, and in `wrangler dev --local` there are no S3 credentials, so the
   * same call goes to the Worker's own dev-only direct route. `upload.direct`
   * is the server telling the client which, so the client never parses a URL to
   * find out.
   */
  async function upload(file: File, opts: { kind?: 'attachment' | 'agent_file'; sessionId?: string } = {}): Promise<Attachment> {
    const kind = opts.kind ?? 'attachment';
    const declared = await rest.declareUpload(workspaceId, kind, {
      name: file.name,
      size: file.size,
      mime: file.type || 'text/plain',
      ...(opts.sessionId && kind === 'attachment' ? { session_id: opts.sessionId } : {}),
    });
    dispatch({ type: 'entity/upsert', kind: 'attachment', id: declared.attachment.id, version: 1, data: declared.attachment });
    await rest.putBytes(declared.upload, file);
    const ready = await rest.completeUpload(workspaceId, kind, declared.attachment.id);
    dispatch({ type: 'entity/upsert', kind: 'attachment', id: ready.id, version: 2, data: ready });
    return ready;
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
        // A mode with nowhere to send the browser leaves the intent stored and
        // the pane in its "Re-authenticated — confirm to continue" state; it
        // does not navigate into a 503 and lose the note the reviewer typed.
        const url = typeof window === 'undefined' ? null : auth.stepUpUrl(window.location.href, 'decision');
        if (url) window.location.assign(url);
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
      // `apply_prepared_proposal` used to be dispatched here. It is a
      // HUMAN_ONLY_COMMAND now (server: packages/shared/src/commands.ts), so the
      // guard above drops it before this switch and the case would be dead
      // code. Saving a proposal happens on Agent → Skills, which renders the
      // body from server data and posts `X-Requested-From: skills`.
      default:
        return;
    }
  }

  return {
    rest,
    auth,
    start,
    send,
    stop,
    retry: async (sessionId, runId) => {
      await rest.retry(workspaceId, sessionId, runId);
    },
    guide,
    queue: enqueue,
    editQueued,
    removeQueued,
    answerContext,
    upload,
    decide,
    applyCommand,
    openSession,
    ensure,
    ensureList,
    invalidateList: (key: string) => dispatch({ type: 'list/invalidate', key }),
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
    agentId: row.agent_id,
    title: row.title,
    subtitle: null,
    mode: row.mode,
    model: row.model_id,
    effort: row.effort,
    runtime: row.runtime ?? 'cloud' as const,
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
    titleSource: (row.title === DEFAULT_SESSION_TITLE ? 'auto' : 'manual') as 'auto' | 'manual',
  };
}
