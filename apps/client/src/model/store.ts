// The client store: one pure reducer plus the same tiny subscribe/dispatch
// wrapper the demo used, so `useSyncExternalStore` still drives every render.
//
// What changed from the demo (client-port spec §4): the fixture slices are gone
// and their place is taken by `entities`, a normalised cache fed by
// `entity.updated` with version-monotonic upserts; there are two replay cursors
// rather than none; a per-turn streaming accumulator keyed by `step_attempt`;
// and `request/decide` does not exist here at all — a decision is only ever a
// `decision.recorded` event applied to the cache, because the guarded route is
// the only thing that may record one (CONVENTIONS, invariant 1).
//
// The follow/pin rule is carried over verbatim, with one fix: it compares refs
// with `sameRef` from the contract, which now includes `field`, so navigating
// from the blocker card to the destination field pins the view instead of being
// mistaken for "already the focus" (spec §4.6.1).
import {
  sameRef,
  type Block,
  type Ref,
  type Session,
  type Message,
  type Run,
  type RunQueueItem,
  type StreamEvent,
} from '@hermes/shared';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type EntityKind =
  | 'request'
  | 'decision'
  | 'effect'
  | 'document'
  | 'member'
  | 'invitation'
  | 'run'
  | 'trace'
  | 'agent_file'
  | 'context_field'
  | 'instruction_version'
  | 'skill_version'
  | 'event'
  | 'catalog'
  | 'provider_key'
  | 'attachment'
  | 'share'
  | 'session';

export const ENTITY_KINDS: readonly EntityKind[] = [
  'request', 'decision', 'effect', 'document', 'member', 'invitation', 'run', 'trace',
  'agent_file', 'context_field', 'instruction_version', 'skill_version', 'event',
  'catalog', 'provider_key', 'attachment', 'share', 'session',
];

/**
 * `unavailable` is not `missing`.
 *
 * A row the server says does not exist is "Request not found"; a *route* the
 * server has not built yet is "Not available yet". Collapsing the two would
 * tell a reviewer a request was redacted when in fact this build cannot look.
 */
export type EntityState = 'ready' | 'loading' | 'missing' | 'unavailable';
export interface EntityRecord<T = unknown> {
  data: T | null;
  version: number;
  fetchedAt: number;
  state: EntityState;
}

export interface ListRecord {
  ids: string[];
  cursor: string | null;
  total: number | null;
  state: EntityState;
}

export type EntityCache = { [K in EntityKind]: Record<string, EntityRecord> } & { lists: Record<string, ListRecord> };

export interface StreamAccumulator {
  runId: string;
  turn: number;
  stepAttempt: number;
  text: string;
  blocks: Block[];
  status: 'streaming' | 'complete' | 'incomplete';
}

export interface DraftState {
  text: string;
  attachments: { id: string; label: string; icon?: string }[];
}

export interface SessionState {
  id: string;
  title: string;
  subtitle: string | null;
  mode: string;
  model: string;
  effort: string | null;
  runtime: 'cloud' | 'local';
  pinned: boolean;
  archived: boolean;
  status: string;
  /** Loaded window, oldest-first. `oldestSeq` drives "Load earlier". */
  messages: Message[];
  oldestSeq: number | null;
  hasEarlier: boolean;
  draft: DraftState;
  run: Run | null;
  stream: StreamAccumulator | null;
  focus: Ref | null;
  context: { label: string; ref: Ref | null } | null;
  scrollTop: number | null;
  share: { id: string; url: string | null; audience: string } | null;
  unread: boolean;
  pending: boolean;
  lastActivity: number;
  carried: { from: string; context: string } | null;
}

export type LinkStatus = 'idle' | 'connecting' | 'open' | 'replaying' | 'reconnecting' | 'signed-out' | 'evicted';
export interface LinkState {
  status: LinkStatus;
  lastMessageAt: number;
  sinceMs: number;
}

export interface UiState {
  irisOpen: boolean;
  follow: boolean;
  app: Ref;
  inboxTab: string;
  historyTab: string;
  libraryTab: string;
  settingsTab: string;
  reduceMotion: boolean;
  pane: 'chat' | 'app';
  navCollapsed: boolean;
  /** Set by a 401 or a 4401 socket close; the shell blocks on it. */
  banner: 'none' | 'reconnecting' | 'redeploying' | 'signed-out' | 'evicted';
  /**
   * True when `GET /w/:ws/provider-keys` answered `reauth_required`. Reading
   * the key rows is itself a step-up action, so "no keys" and "not allowed to
   * look right now" are different screens and the tab has to tell them apart.
   */
  providerKeysLocked: boolean;
}

export interface AppState {
  workspace: { id: string; name: string; role: 'admin' | 'member'; jurisdiction: string | null };
  user: { id: string; name: string; email: string; role: 'admin' | 'member' };
  agent: { id: string | null; name: string; email: string; summary: string; setupStep: string | null };
  entities: EntityCache;
  sessions: Record<string, SessionState>;
  sessionOrder: string[];
  activeSessionId: string | null;
  counts: { inbox: number; pendingGrants: number; createdDocuments: number; decisions: number };
  settings: Record<string, unknown>;
  cursors: { session: Record<string, bigint>; workspace: bigint };
  connection: { session: LinkState; workspace: LinkState; authRefreshedAt: number };
  ui: UiState;
  ready: boolean;
}

const emptyLink = (): LinkState => ({ status: 'idle', lastMessageAt: 0, sinceMs: 0 });

export function emptyEntities(): EntityCache {
  const cache = { lists: {} } as EntityCache;
  for (const kind of ENTITY_KINDS) cache[kind] = {};
  return cache;
}

export const OVERVIEW: Ref = { section: 'agents', view: 'overview' };

export function initialState(): AppState {
  return {
    workspace: { id: '', name: '', role: 'member', jurisdiction: null },
    user: { id: '', name: '', email: '', role: 'member' },
    agent: { id: null, name: 'Iris', email: '', summary: '', setupStep: null },
    entities: emptyEntities(),
    sessions: {},
    sessionOrder: [],
    activeSessionId: null,
    counts: { inbox: 0, pendingGrants: 0, createdDocuments: 0, decisions: 0 },
    settings: {},
    cursors: { session: {}, workspace: 0n },
    connection: { session: emptyLink(), workspace: emptyLink(), authRefreshedAt: 0 },
    ui: {
      irisOpen: true,
      follow: true,
      app: OVERVIEW,
      inboxTab: 'needs-review',
      historyTab: 'decisions',
      libraryTab: 'skills',
      settingsTab: 'Notifications',
      reduceMotion: false,
      pane: 'chat',
      navCollapsed: false,
      banner: 'none',
      providerKeysLocked: false,
    },
    ready: false,
  };
}

export function sessionFrom(row: Session): SessionState {
  return {
    id: row.id,
    title: row.title,
    subtitle: null,
    mode: row.mode,
    model: row.model_id,
    effort: row.effort,
    runtime: row.runtime,
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
    context: row.context ?? null,
    scrollTop: null,
    share: row.share ? { id: row.share.id, url: row.share.url, audience: row.share.audience } : null,
    unread: false,
    pending: false,
    lastActivity: row.last_activity_at ? Date.parse(row.last_activity_at) : Date.now(),
    carried: null,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  | { type: 'bootstrap/apply'; patch: Partial<AppState> }
  | { type: 'nav/app'; object: Ref; manual?: boolean }
  | { type: 'nav/tab'; key: keyof UiState; value: string }
  | { type: 'follow/resume' }
  | { type: 'iris/focus'; sessionId: string; object: Ref }
  | { type: 'iris/toggle'; open?: boolean }
  | { type: 'ui/set'; patch: Partial<UiState> }
  | { type: 'session/create'; id: string; title?: string; mode?: string; runtime?: 'cloud' | 'local'; context?: { label: string; ref: Ref | null }; carried?: { from: string; context: string }; model?: string; effort?: string | null; pending?: boolean }
  | { type: 'session/reconcile'; localId: string; serverId: string }
  | { type: 'session/rollback'; id: string }
  | { type: 'session/upsert'; session: Session }
  | { type: 'session/select'; id: string }
  | { type: 'session/rename'; id: string; title: string }
  | { type: 'session/pin'; id: string; pinned?: boolean }
  | { type: 'session/archive'; id: string; archived?: boolean }
  | { type: 'session/share'; id: string; share: { id: string; url: string | null; audience: string } | null }
  | { type: 'session/unshare'; id: string }
  | { type: 'session/draft'; id: string; text: string }
  | { type: 'session/draft-clear'; id: string }
  | { type: 'session/drafts-restore'; drafts: Record<string, DraftState> }
  | { type: 'session/attach'; id: string; attachment: { id: string; label: string; icon?: string } }
  | { type: 'session/detach'; id: string; attachmentId: string }
  | { type: 'session/set'; id: string; patch: Partial<SessionState> }
  | { type: 'session/scroll'; id: string; scrollTop: number }
  | { type: 'message/add'; sessionId: string; message: Message }
  | { type: 'message/update'; sessionId: string; id: string; patch: Partial<Message> }
  | { type: 'message/prepend'; sessionId: string; messages: Message[]; hasEarlier: boolean }
  | { type: 'run/start'; sessionId: string; run: Run }
  | { type: 'run/step'; sessionId: string; stepId: string; label: string; state: Run['steps'][number]['state']; stepAttempt?: number }
  | { type: 'run/status'; sessionId: string; status: Run['status']; patch?: Partial<Run> }
  | { type: 'run/guide'; sessionId: string; text: string; id: string }
  | { type: 'run/guide-apply'; sessionId: string }
  | { type: 'run/guide-remove'; sessionId: string }
  | { type: 'run/queue'; sessionId: string; items: RunQueueItem[] }
  | { type: 'run/queue-edit'; sessionId: string; id: string; text: string }
  | { type: 'run/queue-remove'; sessionId: string; id: string }
  | { type: 'run/queue-status'; sessionId: string; status: RunQueueItem['status'] }
  | { type: 'run/clear'; sessionId: string }
  | { type: 'stream/reset'; sessionId: string; runId: string; turn: number; stepAttempt: number }
  | { type: 'stream/delta'; sessionId: string; runId: string; turn: number; stepAttempt: number; delta: string }
  | { type: 'stream/final'; sessionId: string; message: Message }
  | { type: 'entity/upsert'; kind: EntityKind; id: string; version?: number | null; data?: unknown; state?: EntityState }
  | { type: 'entity/loading'; kind: EntityKind; id: string }
  | { type: 'entity/missing'; kind: EntityKind; id: string }
  | { type: 'entity/unavailable'; kind: EntityKind; id: string }
  | { type: 'list/set'; key: string; ids: string[]; cursor?: string | null; total?: number | null; append?: boolean }
  | { type: 'list/prepend'; key: string; id: string }
  | { type: 'list/invalidate'; key: string }
  | { type: 'cursor/advance'; stream: 'workspace' | 'session'; sessionId?: string; id: bigint }
  | { type: 'link/state'; kind: 'session' | 'workspace'; patch: Partial<LinkState> }
  | { type: 'auth/refreshed'; at: number }
  | { type: 'counts/set'; patch: Partial<AppState['counts']> }
  | { type: 'settings/merge'; patch: Record<string, unknown> }
  | { type: 'cache/clear' };

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

export const activeSession = (s: AppState): SessionState | null => (s.activeSessionId ? s.sessions[s.activeSessionId] ?? null : null);

export function entity<T>(s: AppState, kind: EntityKind, id: string | null | undefined): EntityRecord<T> | null {
  if (!id) return null;
  return (s.entities[kind][id] as EntityRecord<T> | undefined) ?? null;
}

export function entityData<T>(s: AppState, kind: EntityKind, id: string | null | undefined): T | null {
  const record = entity<T>(s, kind, id);
  return record && record.state === 'ready' ? record.data : null;
}

export function list(s: AppState, key: string): ListRecord {
  return s.entities.lists[key] ?? { ids: [], cursor: null, total: null, state: 'loading' };
}

export function listData<T>(s: AppState, key: string, kind: EntityKind): T[] {
  return list(s, key)
    .ids.map((id) => entityData<T>(s, kind, id))
    .filter((row): row is T => row !== null);
}

export const visibleSessions = (s: AppState, archived = false): SessionState[] =>
  s.sessionOrder
    .map((id, order) => ({ session: s.sessions[id], order }))
    .filter((row): row is { session: SessionState; order: number } => !!row.session && row.session.archived === archived)
    .sort((a, b) => Number(b.session.pinned) - Number(a.session.pinned) || a.order - b.order)
    .map((row) => row.session);

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function withSession(state: AppState, id: string, fn: (s: SessionState) => SessionState): AppState {
  const session = state.sessions[id];
  if (!session) return state;
  const next = fn(session);
  if (next === session) return state;
  return { ...state, sessions: { ...state.sessions, [id]: next } };
}

function withRun(state: AppState, id: string, fn: (run: Run) => Run): AppState {
  return withSession(state, id, (session) => (session.run ? { ...session, run: fn(session.run) } : session));
}

function upsertEntity(state: AppState, kind: EntityKind, id: string, version: number | null | undefined, data: unknown, entityState: EntityState): AppState {
  const existing = state.entities[kind][id];
  const nextVersion = version ?? (existing ? existing.version : 0);
  // A replayed event must never regress a newer value: an upsert whose version
  // is below the cached one is dropped (spec §4.4.1).
  if (existing && existing.state === 'ready' && version != null && nextVersion < existing.version) return state;
  if (existing && existing.state === 'ready' && data === undefined && entityState === 'ready') return state;
  const record: EntityRecord = {
    data: data === undefined ? existing?.data ?? null : data,
    version: nextVersion,
    fetchedAt: Date.now(),
    state: entityState,
  };
  return { ...state, entities: { ...state.entities, [kind]: { ...state.entities[kind], [id]: record } } };
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'bootstrap/apply':
      return { ...state, ...action.patch };

    // --- navigation / follow (kept verbatim from the demo) ---
    case 'nav/app': {
      const target = activeSession(state)?.focus ?? null;
      const same = sameRef(target, action.object);
      return {
        ...state,
        ui: {
          ...state.ui,
          app: action.object,
          follow: action.manual ? (same ? state.ui.follow : false) : state.ui.follow,
          pane: action.manual ? 'app' : state.ui.pane,
        },
      };
    }
    case 'nav/tab':
      return { ...state, ui: { ...state.ui, [action.key]: action.value } };
    case 'follow/resume': {
      const target = activeSession(state)?.focus;
      return { ...state, ui: { ...state.ui, follow: true, app: target ?? state.ui.app } };
    }
    case 'iris/focus': {
      const next = withSession(state, action.sessionId, (session) => ({ ...session, focus: action.object }));
      if (state.ui.follow && action.sessionId === state.activeSessionId) return { ...next, ui: { ...next.ui, app: action.object } };
      return next;
    }
    case 'iris/toggle':
      return { ...state, ui: { ...state.ui, irisOpen: action.open ?? !state.ui.irisOpen } };
    case 'ui/set':
      return { ...state, ui: { ...state.ui, ...action.patch } };

    // --- sessions ---
    case 'session/create': {
      const session: SessionState = {
        id: action.id,
        title: action.title ?? 'New session',
        subtitle: null,
        mode: action.mode ?? 'ask',
        model: action.model ?? String(state.settings.default_model_id ?? ''),
        effort: action.effort ?? (state.settings.default_effort as string | null) ?? null,
        runtime: action.runtime ?? ((state.settings.default_runtime as 'cloud' | 'local') ?? 'cloud'),
        pinned: false,
        archived: false,
        status: 'Empty',
        messages: [],
        oldestSeq: null,
        hasEarlier: false,
        draft: { text: '', attachments: [] },
        run: null,
        stream: null,
        focus: null,
        context: action.context ?? null,
        scrollTop: null,
        share: null,
        unread: false,
        pending: action.pending ?? true,
        lastActivity: Date.now(),
        carried: action.carried ?? null,
      };
      return {
        ...state,
        sessions: { ...state.sessions, [action.id]: session },
        sessionOrder: [action.id, ...state.sessionOrder],
        activeSessionId: action.id,
        ui: { ...state.ui, follow: true, pane: 'chat' },
      };
    }
    case 'session/reconcile': {
      const local = state.sessions[action.localId];
      if (!local) return state;
      const sessions = { ...state.sessions };
      delete sessions[action.localId];
      sessions[action.serverId] = { ...local, id: action.serverId, pending: false };
      return {
        ...state,
        sessions,
        sessionOrder: state.sessionOrder.map((id) => (id === action.localId ? action.serverId : id)),
        activeSessionId: state.activeSessionId === action.localId ? action.serverId : state.activeSessionId,
      };
    }
    case 'session/rollback': {
      const sessions = { ...state.sessions };
      delete sessions[action.id];
      const sessionOrder = state.sessionOrder.filter((id) => id !== action.id);
      return {
        ...state,
        sessions,
        sessionOrder,
        activeSessionId: state.activeSessionId === action.id ? sessionOrder[0] ?? null : state.activeSessionId,
      };
    }
    case 'session/upsert': {
      const existing = state.sessions[action.session.id];
      const fresh = sessionFrom(action.session);
      const merged: SessionState = existing
        ? { ...existing, ...fresh, messages: existing.messages, oldestSeq: existing.oldestSeq, hasEarlier: existing.hasEarlier, draft: existing.draft, run: existing.run, stream: existing.stream, scrollTop: existing.scrollTop, unread: existing.unread }
        : fresh;
      return {
        ...state,
        sessions: { ...state.sessions, [action.session.id]: merged },
        sessionOrder: existing ? state.sessionOrder : [...state.sessionOrder, action.session.id],
      };
    }
    case 'session/select': {
      const session = state.sessions[action.id];
      if (!session) return state;
      return {
        ...state,
        activeSessionId: action.id,
        sessions: { ...state.sessions, [action.id]: { ...session, unread: false } },
        ui: { ...state.ui, follow: true, app: session.focus ?? state.ui.app, pane: 'chat' },
      };
    }
    case 'session/rename':
      return withSession(state, action.id, (s) => ({ ...s, title: action.title.trim() || s.title }));
    case 'session/pin':
      return withSession(state, action.id, (s) => ({ ...s, pinned: action.pinned ?? !s.pinned }));
    case 'session/archive': {
      const archived = action.archived ?? true;
      const next = withSession(state, action.id, (s) => ({ ...s, archived }));
      if (next.activeSessionId === action.id && archived) {
        const fallback = next.sessionOrder.find((id) => id !== action.id && !next.sessions[id]?.archived);
        if (fallback) return { ...next, activeSessionId: fallback };
      }
      return next;
    }
    case 'session/share':
      return withSession(state, action.id, (s) => ({ ...s, share: action.share }));
    case 'session/unshare':
      return withSession(state, action.id, (s) => ({ ...s, share: null }));
    case 'session/draft':
      return withSession(state, action.id, (s) => ({ ...s, draft: { ...s.draft, text: action.text } }));
    case 'session/draft-clear':
      return withSession(state, action.id, (s) => ({ ...s, draft: { text: '', attachments: [] } }));
    case 'session/drafts-restore': {
      const sessions = { ...state.sessions };
      let changed = false;
      for (const [id, draft] of Object.entries(action.drafts)) {
        const session = sessions[id];
        if (!session) continue;
        sessions[id] = { ...session, draft };
        changed = true;
      }
      return changed ? { ...state, sessions } : state;
    }
    case 'session/attach':
      return withSession(state, action.id, (s) =>
        s.draft.attachments.some((a) => a.id === action.attachment.id) ? s : { ...s, draft: { ...s.draft, attachments: [...s.draft.attachments, action.attachment] } },
      );
    case 'session/detach':
      return withSession(state, action.id, (s) => ({ ...s, draft: { ...s.draft, attachments: s.draft.attachments.filter((a) => a.id !== action.attachmentId) } }));
    case 'session/set':
      return withSession(state, action.id, (s) => ({ ...s, ...action.patch }));
    case 'session/scroll':
      return withSession(state, action.id, (s) => ({ ...s, scrollTop: action.scrollTop }));

    // --- messages ---
    case 'message/add':
      return withSession(state, action.sessionId, (s) =>
        s.messages.some((m) => m.id === action.message.id)
          ? s
          : {
              ...s,
              lastActivity: Date.now(),
              unread: action.sessionId === state.activeSessionId ? s.unread : true,
              oldestSeq: s.oldestSeq ?? action.message.seq,
              messages: [...s.messages, action.message],
            },
      );
    case 'message/update':
      return withSession(state, action.sessionId, (s) => ({ ...s, messages: s.messages.map((m) => (m.id === action.id ? { ...m, ...action.patch } : m)) }));
    case 'message/prepend':
      return withSession(state, action.sessionId, (s) => ({
        ...s,
        messages: [...action.messages, ...s.messages],
        oldestSeq: action.messages[0]?.seq ?? s.oldestSeq,
        hasEarlier: action.hasEarlier,
      }));

    // --- runs ---
    case 'run/start':
      return withSession(state, action.sessionId, (s) => ({ ...s, run: action.run, status: 'Working' }));
    case 'run/step':
      return withRun(state, action.sessionId, (run) => {
        const found = run.steps.some((step) => step.id === action.stepId);
        const steps = found
          ? run.steps.map((step) => (step.id === action.stepId ? { ...step, state: action.state, label: action.label, ...(action.stepAttempt ? { step_attempt: action.stepAttempt } : {}) } : step))
          : [...run.steps, { id: action.stepId, label: action.label, state: action.state, ...(action.stepAttempt ? { step_attempt: action.stepAttempt } : {}) }];
        return { ...run, steps };
      });
    case 'run/status':
      return withSession(state, action.sessionId, (s) => (s.run ? { ...s, status: action.status, run: { ...s.run, status: action.status, ...(action.patch ?? {}) } } : s));
    case 'run/guide':
      return withRun(state, action.sessionId, (run) => ({ ...run, guidance: { id: action.id, text: action.text, status: 'pending' } }));
    case 'run/guide-apply':
      return withRun(state, action.sessionId, (run) => (run.guidance ? { ...run, guidance: { ...run.guidance, status: 'applied' } } : run));
    case 'run/guide-remove':
      return withRun(state, action.sessionId, (run) => ({ ...run, guidance: null }));
    case 'run/queue':
      return withRun(state, action.sessionId, (run) => ({ ...run, queue: action.items }));
    case 'run/queue-edit':
      return withRun(state, action.sessionId, (run) => ({ ...run, queue: run.queue.map((q) => (q.id === action.id ? { ...q, text: action.text } : q)) }));
    case 'run/queue-remove':
      return withRun(state, action.sessionId, (run) => ({ ...run, queue: run.queue.filter((q) => q.id !== action.id) }));
    case 'run/queue-status':
      return withRun(state, action.sessionId, (run) => ({ ...run, queue: run.queue.map((q) => ({ ...q, status: action.status })) }));
    case 'run/clear':
      return withSession(state, action.sessionId, (s) => ({ ...s, run: null, stream: null, status: 'Ready' }));

    // --- streaming text, keyed by step_attempt (spec §4.5) ---
    case 'stream/reset':
      return withSession(state, action.sessionId, (s) => ({
        ...s,
        stream: { runId: action.runId, turn: action.turn, stepAttempt: action.stepAttempt, text: '', blocks: [], status: 'streaming' },
      }));
    case 'stream/delta':
      return withSession(state, action.sessionId, (s) => {
        const current = s.stream;
        // A delta from a superseded attempt is discarded; a delta from a *higher*
        // attempt is an implicit reset, in case the reset was lost across a hub
        // restart.
        if (!current || current.runId !== action.runId || current.turn !== action.turn || action.stepAttempt > current.stepAttempt) {
          return { ...s, stream: { runId: action.runId, turn: action.turn, stepAttempt: action.stepAttempt, text: action.delta, blocks: [], status: 'streaming' } };
        }
        if (action.stepAttempt < current.stepAttempt) return s;
        return { ...s, stream: { ...current, text: current.text + action.delta } };
      });
    case 'stream/final':
      return withSession(state, action.sessionId, (s) => ({
        ...s,
        stream: null,
        lastActivity: Date.now(),
        messages: s.messages.some((m) => m.id === action.message.id)
          ? s.messages.map((m) => (m.id === action.message.id ? action.message : m))
          : [...s.messages, action.message],
      }));

    // --- entity cache ---
    case 'entity/upsert':
      return upsertEntity(state, action.kind, action.id, action.version, action.data, action.state ?? 'ready');
    case 'entity/loading': {
      const existing = state.entities[action.kind][action.id];
      if (existing && existing.state === 'ready') return state;
      return upsertEntity(state, action.kind, action.id, existing?.version ?? 0, existing?.data, 'loading');
    }
    case 'entity/unavailable':
      return {
        ...state,
        entities: { ...state.entities, [action.kind]: { ...state.entities[action.kind], [action.id]: { data: null, version: 0, fetchedAt: Date.now(), state: 'unavailable' } } },
      };
    case 'entity/missing':
      return {
        ...state,
        entities: { ...state.entities, [action.kind]: { ...state.entities[action.kind], [action.id]: { data: null, version: 0, fetchedAt: Date.now(), state: 'missing' } } },
      };
    case 'list/set': {
      const existing = state.entities.lists[action.key];
      const ids = action.append && existing ? [...existing.ids, ...action.ids.filter((id) => !existing.ids.includes(id))] : action.ids;
      return {
        ...state,
        entities: { ...state.entities, lists: { ...state.entities.lists, [action.key]: { ids, cursor: action.cursor ?? null, total: action.total ?? null, state: 'ready' } } },
      };
    }
    case 'list/invalidate': {
      // Drop the record entirely rather than marking it stale: `ensureList`
      // refetches a list it does not have, and leaves a `ready` one alone.
      if (!state.entities.lists[action.key]) return state;
      const lists = { ...state.entities.lists };
      delete lists[action.key];
      return { ...state, entities: { ...state.entities, lists } };
    }
    case 'list/prepend': {
      const existing = state.entities.lists[action.key];
      // Only a loaded list is updated in place; an unloaded one is fetched when
      // it is first shown, which is where the new row would come from anyway.
      if (!existing || existing.ids.includes(action.id)) return state;
      return { ...state, entities: { ...state.entities, lists: { ...state.entities.lists, [action.key]: { ...existing, ids: [action.id, ...existing.ids] } } } };
    }

    // --- streams, links, auth ---
    case 'cursor/advance': {
      if (action.stream === 'workspace') {
        if (action.id <= state.cursors.workspace) return state;
        return { ...state, cursors: { ...state.cursors, workspace: action.id } };
      }
      const key = action.sessionId ?? '';
      const current = state.cursors.session[key] ?? 0n;
      if (action.id <= current) return state;
      return { ...state, cursors: { ...state.cursors, session: { ...state.cursors.session, [key]: action.id } } };
    }
    case 'link/state': {
      const link = { ...state.connection[action.kind], ...action.patch };
      const connection = { ...state.connection, [action.kind]: link };
      const banner =
        connection.session.status === 'signed-out' || connection.workspace.status === 'signed-out'
          ? 'signed-out'
          : connection.session.status === 'evicted' || connection.workspace.status === 'evicted'
            ? 'evicted'
            : state.ui.banner === 'redeploying'
              ? 'redeploying'
              : connection.session.status === 'reconnecting' || connection.workspace.status === 'reconnecting'
                ? 'reconnecting'
                : 'none';
      return { ...state, connection, ui: { ...state.ui, banner } };
    }
    case 'auth/refreshed':
      return { ...state, connection: { ...state.connection, authRefreshedAt: action.at } };
    case 'counts/set':
      return { ...state, counts: { ...state.counts, ...action.patch } };
    case 'settings/merge':
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case 'cache/clear': {
      // A resync drops derived state and keeps what the human typed (spec §5.5).
      const sessions: Record<string, SessionState> = {};
      for (const [id, session] of Object.entries(state.sessions)) {
        sessions[id] = { ...session, messages: [], oldestSeq: null, hasEarlier: true, run: null, stream: null };
      }
      return { ...state, entities: emptyEntities(), sessions, cursors: { session: {}, workspace: 0n } };
    }
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// The event → action translation
// ---------------------------------------------------------------------------

/**
 * One server event becomes zero or more reducer actions. Keeping it a pure
 * function is what lets the reducer tests drive the store with real contract
 * events rather than hand-built actions.
 */
export function actionsFor(event: StreamEvent, state: AppState): Action[] {
  const id = BigInt(event.id);
  const sessionId = event.session_id;
  const out: Action[] = [];
  const advance: Action = sessionId
    ? { type: 'cursor/advance', stream: 'session', sessionId, id }
    : { type: 'cursor/advance', stream: 'workspace', id };

  switch (event.kind) {
    case 'run.started': {
      const p = event.payload;
      out.push({
        type: 'run/start',
        sessionId: p.session_id,
        run: {
          id: p.run_id,
          session_id: p.session_id,
          status: 'working',
          attempt: p.attempt,
          title: p.title,
          steps: p.steps.map((step) => ({ id: step.id, label: step.label, state: step.state })),
          queue: [],
          guidance: null,
        },
      });
      // A run is a trace the moment it starts, and the Traces tab's list is
      // loaded once when the shell mounts — on a fresh workspace, before any
      // run exists. Without this the tab keeps saying "No runs yet." while the
      // transcript beside it is streaming one. Same reasoning as
      // `request.created` above, and the same fix: invalidate rather than
      // guess at the row, because only `GET /w/:ws/traces` knows its subtitle,
      // its step count and whether it needs anybody.
      out.push({ type: 'list/invalidate', key: 'traces' });
      break;
    }
    case 'run.step': {
      const p = event.payload;
      if (sessionId) out.push({ type: 'run/step', sessionId, stepId: p.step_id, label: p.label, state: p.state });
      break;
    }
    case 'run.status': {
      const p = event.payload;
      if (sessionId)
        out.push({
          type: 'run/status',
          sessionId,
          status: p.status,
          patch: {
            waiting_for: p.waiting_for ?? null,
            waiting_label: p.waiting_label ?? null,
            active_ms: p.active_ms ?? null,
            error: p.error
              ? { class: p.error.class, retryable: p.error.retryable, reason: p.error.reason, message: p.error.message, step_id: p.error.step_id ?? null }
              : null,
          },
        });
      // The trace row's status, worked time and step count all move with this,
      // and none of them is in the payload in the shape the list renders.
      if (p.status !== 'working') out.push({ type: 'list/invalidate', key: 'traces' });
      break;
    }
    case 'run.focus': {
      const p = event.payload;
      out.push({ type: 'iris/focus', sessionId: p.session_id, object: p.ref });
      // The session socket can outrun the workspace socket: name the entity now,
      // so a miss shows a skeleton and a fetch rather than "Request not found".
      if (p.entity_type && p.entity_id && p.entity_type !== 'session' && p.entity_type !== 'agent') {
        const kind = p.entity_type === 'file' ? 'agent_file' : (p.entity_type as EntityKind);
        const unseen = !state.entities[kind]?.[p.entity_id];
        if (unseen) out.push({ type: 'entity/loading', kind, id: p.entity_id });
        // A focus on a request the client has never seen is also the *first*
        // it hears of that request: the engine writes the `requests` row and
        // publishes `run.focus`, but it does not publish `request.created`, so
        // the workspace stream carries nothing about it. (Server finding; see
        // the README.) Treating the focus as the creation keeps the Inbox and
        // its badge honest for the person whose session proposed it — and a
        // later `request.created`, if one is ever published, is a no-op
        // because the id is already in both lists.
        if (unseen && kind === 'request') {
          out.push({ type: 'list/prepend', key: 'inbox:needs-review', id: p.entity_id });
          out.push({ type: 'list/prepend', key: 'requests', id: p.entity_id });
          out.push({ type: 'counts/set', patch: { inbox: state.counts.inbox + 1 } });
        }
      }
      break;
    }
    case 'run.guidance.applied':
      if (sessionId) out.push({ type: 'run/guide-apply', sessionId });
      break;
    case 'run.queue.updated':
      if (sessionId) out.push({ type: 'run/queue', sessionId, items: event.payload.items });
      break;
    case 'message.appended': {
      const p = event.payload;
      out.push({
        type: 'message/add',
        sessionId: p.session_id,
        message: { id: p.message_id, session_id: p.session_id, seq: p.seq, role: p.role, kind: p.kind, text: p.text, blocks: p.blocks, status: p.status, run_id: p.run_id, at: event.at },
      });
      break;
    }
    case 'message.reset': {
      const p = event.payload;
      if (sessionId) out.push({ type: 'stream/reset', sessionId, runId: p.run_id, turn: p.turn, stepAttempt: p.step_attempt });
      break;
    }
    case 'message.delta': {
      const p = event.payload;
      if (sessionId) out.push({ type: 'stream/delta', sessionId, runId: p.run_id, turn: p.turn, stepAttempt: p.step_attempt, delta: p.delta });
      break;
    }
    case 'message.final': {
      const p = event.payload;
      out.push({
        type: 'stream/final',
        sessionId: p.session_id,
        message: {
          id: p.message_id,
          session_id: p.session_id,
          seq: Number.MAX_SAFE_INTEGER,
          role: 'iris',
          kind: null,
          text: p.text,
          blocks: p.blocks,
          status: p.incomplete ? 'incomplete' : 'complete',
          run_id: p.run_id,
          worked_ms: p.worked_ms ?? null,
          incomplete: p.incomplete ?? false,
          at: event.at,
        },
      });
      break;
    }
    case 'request.created': {
      const p = event.payload;
      // A `request.created` for an id already cached is a no-op: the fetch that
      // answered the cross-socket miss already has the authoritative row.
      if (!state.entities.request[p.request_id]) {
        out.push({ type: 'entity/loading', kind: 'request', id: p.request_id });
      }
      // Both lists the Inbox reads from. `inbox:needs-review` is the badge's
      // list; `requests` is the one the Inbox pane renders, and it is loaded
      // once when the shell mounts — which on a fresh workspace is *before*
      // the first request exists. Without this the pane keeps saying "No
      // reviews waiting" while the badge says 1.
      out.push({ type: 'list/prepend', key: 'inbox:needs-review', id: p.request_id });
      out.push({ type: 'list/prepend', key: 'requests', id: p.request_id });
      out.push({ type: 'counts/set', patch: { inbox: state.counts.inbox + 1 } });
      break;
    }
    case 'decision.recorded': {
      const p = event.payload;
      out.push({ type: 'entity/upsert', kind: 'decision', id: p.decision_id, version: 1, data: { id: p.decision_id, request_id: p.request_id, decision: p.decision, resulting_status: p.resulting_status, decided_by: p.decided_by, decided_by_name: '', decided_at: p.decided_at, note: null, effect_ids: p.effect_ids } });
      // The request row itself is refetched: `resulting_status` is all the event
      // carries, and the review pane needs the whole row.
      out.push({ type: 'entity/loading', kind: 'request', id: p.request_id });
      // A decision writes a `history` row too, and History is loaded once for
      // the same reason; the id is not known here, so the list is invalidated
      // and refetched the next time the screen asks for it.
      out.push({ type: 'list/invalidate', key: 'history' });
      out.push({ type: 'counts/set', patch: { inbox: Math.max(0, state.counts.inbox - 1), decisions: state.counts.decisions + 1 } });
      break;
    }
    case 'entity.updated': {
      const p = event.payload;
      const kind = (p.entity_type === 'workspace_settings' ? 'catalog' : p.entity_type) as EntityKind;
      if (p.entity_type === 'session') out.push({ type: 'entity/loading', kind: 'session', id: p.entity_id });
      else out.push({ type: 'entity/loading', kind, id: p.entity_id });
      break;
    }
    case 'resync':
      out.push({ type: 'cache/clear' });
      break;
  }
  out.push(advance);
  return out;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export type Listener = (state: AppState, action: Action) => void;
export interface Store {
  getState(): AppState;
  dispatch(action: Action): AppState;
  subscribe(listener: Listener): () => void;
}

export function createStore(initial: AppState = initialState()): Store {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next !== state) {
        state = next;
        for (const listener of listeners) listener(state, action);
      }
      return next;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** Client-generated ids. A turn id is a UUID v4, not the demo's counter (§2.4). */
export type ClientTurnId = string & { readonly __brand: 'ClientTurnId' };
export const newClientTurnId = (): ClientTurnId => uuid() as ClientTurnId;

export function uuid(): string {
  const c = globalThis.crypto;
  if (c && 'randomUUID' in c) return c.randomUUID();
  // Deterministic-enough fallback for the jsdom-free test environment.
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
