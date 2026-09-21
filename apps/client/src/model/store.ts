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
  INBOX,
  sameRef,
  type Block,
  type Ref,
  type Session,
  type Message,
  type Run,
  type RunQueueItem,
  type MemberRoleTemplate,
  type StreamEvent,
  type SessionSnapshot,
} from '@hermes/shared';

const PERSONAL_SETTINGS_VIEWS = new Set(['Notifications', 'Slack account', 'Data and privacy']);
const LEGACY_ADMIN_SETTINGS_VIEWS = new Set([
  'Organization', 'Inbox rules', 'Agents', 'Slack', 'Email', 'Provider keys', 'Runtime capacity', 'Usage',
]);

/**
 * Enforce the navigation boundary before a view can mount and start effects.
 * This also migrates old Settings deep links for Admins while making the same
 * forged link a personal Settings fallback for Members.
 */
export function authorisedRef(role: 'admin' | 'member', object: Ref, agentId?: string | null): Ref {
  if (agentId === null && object.section === 'agents') return INBOX;
  if (object.section === 'admin') {
    return role === 'admin' ? object : { section: 'settings', view: 'Notifications' };
  }
  if (object.section !== 'settings') return object;
  const view = object.view ?? 'Notifications';
  if (LEGACY_ADMIN_SETTINGS_VIEWS.has(view)) {
    return role === 'admin'
      ? { section: 'admin', view }
      : { section: 'settings', view: 'Notifications' };
  }
  return PERSONAL_SETTINGS_VIEWS.has(view)
    ? { ...object, view }
    : { section: 'settings', view: 'Notifications' };
}

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
  /** Prefix reconstructed from committed `message.delta` events. */
  durableText: string;
  /** Last contiguous committed delta; previews never advance this sequence. */
  seq?: number;
  blocks: Block[];
  status: 'streaming' | 'complete' | 'incomplete';
}

export interface DraftState {
  text: string;
  attachments: { id: string; label: string; icon?: string; kind?: 'source'; sha256?: string; source_kind?: 'agent_file' | 'library_source' }[];
}

/**
 * A turn the person has sent but the server has not projected back yet.
 *
 * Keeping it beside the authoritative message list makes the composer feel
 * immediate without pretending the server accepted work it may still refuse.
 * `clientTurnId` is the idempotency key that reconciles `run.started`; `runId`
 * is filled as soon as either the POST response or that event arrives.
 */
export interface PendingTurn {
  clientTurnId: string;
  runId: string | null;
  message: Message;
  previousStatus: string;
  previousRun?: Run | null;
}

const MAX_STREAM_FENCES = 64;
function addStreamFence(fences: Record<string, number> | undefined, runId: string, turn: number): Record<string, number> {
  const next = { ...(fences ?? {}) };
  const value = Math.max(next[runId] ?? -1, turn);
  delete next[runId];
  next[runId] = value;
  const entries = Object.entries(next);
  return entries.length <= MAX_STREAM_FENCES ? next : Object.fromEntries(entries.slice(-MAX_STREAM_FENCES));
}

/** Local sequence numbers are layout hints, never proof of turn identity. */
function confirmsPendingTurn(pending: PendingTurn | null, message: Message, clientTurnId?: string | null): boolean {
  if (!pending || message.role !== 'user') return false;
  if (clientTurnId) return clientTurnId === pending.clientTurnId;
  // Snapshots do not carry client_turn_id. Wait for admission/run.started to
  // establish the run instead of matching an older repeated prompt by text.
  return pending.runId !== null && message.run_id === pending.runId &&
    message.kind === null && message.text === pending.message.text;
}

function admitPendingTurn(session: SessionState, runId: string): PendingTurn | null {
  if (!session.pendingTurn) return null;
  const pending = { ...session.pendingTurn, runId, message: { ...session.pendingTurn.message, run_id: runId } };
  // A snapshot can contain the user row before the POST/run.started arrives.
  return session.messages.some((message) => confirmsPendingTurn(pending, message)) ? null : pending;
}

export interface SessionState {
  id: string;
  agentId: string | null;
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
  pendingTurn: PendingTurn | null;
  run: Run | null;
  stream: StreamAccumulator | null;
  /** Highest authoritative final turn per run; late transport frames cannot reopen it. */
  streamFences?: Record<string, number>;
  focus: Ref | null;
  /** The run that set `focus`, so the reply can offer it as a link. */
  focusRunId?: string | null;
  context: { label: string; ref: Ref | null } | null;
  scrollTop: number | null;
  share: { id: string; url: string | null; audience: string } | null;
  unread: boolean;
  pending: boolean;
  lastActivity: number;
  carried: { from: string; context: string } | null;
  /**
   * Whether this title is the client's guess or the person's word (C34).
   *
   * A session starts `auto`: the first turn names it, and the run that follows
   * may rename it again once it knows what it was about. A manual rename moves
   * it to `manual` and nothing ever overwrites it again — a title somebody
   * typed is a decision, and a product that quietly undoes it is a product
   * people stop trusting with names.
   */
  titleSource: 'auto' | 'manual';
  settingsPending?: boolean;
  settingsError?: string | null;
  hydrationError?: string | null;
  recovery?: SessionSnapshot['recovery'];
}

const terminalRun = (status: Run['status']): boolean => ['completed', 'stopped', 'error'].includes(status);

/** The waiting clock may move earlier, but never later within one attempt. */
function mergeRun(current: Run | null, incoming: Run, sameTurn = false): Run {
  if (!current || (!sameTurn && current.id !== incoming.id) || current.attempt < incoming.attempt) return incoming;
  if (current.attempt > incoming.attempt) return current;
  const started = [current.started_at, incoming.started_at].filter((value): value is string => Boolean(value));
  return {
    ...incoming,
    ...(started.length ? { started_at: started.sort((a, b) => Date.parse(a) - Date.parse(b))[0]! } : {}),
    ...(terminalRun(current.status) && !terminalRun(incoming.status) ? { status: current.status, error: current.error, active_ms: current.active_ms } : {}),
  };
}

export type LinkStatus = 'idle' | 'connecting' | 'open' | 'replaying' | 'reconnecting' | 'signed-out' | 'evicted';
export interface LinkState {
  status: LinkStatus;
  lastMessageAt: number;
  sinceMs: number;
}

/**
 * The Iris panel has three states, not two (decision C33).
 *
 * `open` is the chat pane at `irisWidth`; `rail` is the 56 px strip that keeps
 * the mark, its live run state and the unread count on screen; `hidden` gives
 * the app the whole work area and leaves only the app header's "Open Iris".
 * Nothing about a run depends on any of them — collapsing is a layout change.
 */
export type IrisPanel = 'open' | 'rail' | 'hidden';

export interface UiState {
  irisPanel: IrisPanel;
  /**
   * The remembered chat width in px, or `null` for "nobody has dragged it" —
   * which is not the same as 800. A null width follows the demo's rule (800 at
   * ≥1840, an equal split of the work area below it); a number overrides it and
   * is persisted per workspace and user.
   */
  irisWidth: number | null;
  /** Iris messages and decision receipts that arrived while not `open`. */
  irisUnread: number;
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
   * True when an older Worker answers `reauth_required` while reading masked
   * provider status. Current Workers allow this Admin-only read without
   * step-up, but the client keeps the distinction during rolling deploys so a
   * protected list can never be mistaken for "no connection".
   */
  providerKeysLocked: boolean;
}

export interface AppState {
  workspace: { id: string; name: string; role: 'admin' | 'member'; jurisdiction: string | null };
  user: { id: string; name: string; email: string; role: 'admin' | 'member' };
  agent: {
    id: string | null; name: string; email: string | null; summary: string; setupStep: string | null;
    provisioningStatus: 'getting_ready' | 'ready' | 'retrying' | null;
  };
  capabilities: {
    emailIngress: boolean;
    turnAttachments: boolean;
    automatedTriggers: boolean;
    memberInvitationMode: 'legacy_delivery' | 'setup_only';
    memberRoleTemplates: MemberRoleTemplate[];
    /** How Execute on a legacy effect answers. Older Workers are read as `unavailable`. */
    effectExecutor: 'unavailable' | 'simulated';
  };
  entities: EntityCache;
  sessions: Record<string, SessionState>;
  sessionOrder: string[];
  activeSessionId: string | null;
  counts: {
    /** Legacy total, retained for older Workers and History copy. */
    inbox: number;
    /** Server-projected request counts. Each counts requests, never votes. */
    pendingForMe?: number;
    pendingForOthers?: number;
    pendingGrants: number;
    createdDocuments: number;
    decisions: number;
  };
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

// ---------------------------------------------------------------------------
// Panel geometry
//
// One place, because four callers need the same numbers and a resize handle
// that clamps differently from the reducer is a handle that can be dragged into
// a state the reducer then silently corrects.
// ---------------------------------------------------------------------------

/** The demo's 1840 layout: 240 nav + 800 Iris + 800 app. */
export const IRIS_DEFAULT_WIDTH = 800;
export const IRIS_MIN_WIDTH = 420;
export const IRIS_RAIL_WIDTH = 56;
export const WIDE_BREAKPOINT = 1840;
export const PANE_SWITCH_BREAKPOINT = 1000;

/** The two widths rendered by SidebarNav. The grid must use the same state. */
export const NAV_WIDTH = 240;
export const NAV_RAIL_WIDTH = 52;

export const navWidthFor = (_windowWidth?: number, collapsed = false): number => (collapsed ? NAV_RAIL_WIDTH : NAV_WIDTH);

/** The work area is everything the navigation does not take. */
export const workAreaFor = (windowWidth: number, navCollapsed = false): number => Math.max(0, windowWidth - navWidthFor(windowWidth, navCollapsed));

/** 60 percent of the work area, but never below the minimum: a 700 px window has no valid range otherwise. */
export const irisMaxWidth = (workArea: number): number => Math.max(IRIS_MIN_WIDTH, Math.round(workArea * 0.6));

export const clampIrisWidth = (width: number, workArea: number): number => Math.min(Math.max(Math.round(width), IRIS_MIN_WIDTH), irisMaxWidth(workArea));

/**
 * The width with nothing remembered: 800 at 1840 and wider, an equal split of
 * the work area below it — the demo's rule, and the reason `irisWidth` is
 * nullable rather than seeded with 800.
 */
export const defaultIrisWidth = (windowWidth: number): number =>
  clampIrisWidth(windowWidth >= WIDE_BREAKPOINT ? IRIS_DEFAULT_WIDTH : Math.round(workAreaFor(windowWidth) / 2), workAreaFor(windowWidth));

/** What the chat pane is actually given, remembered or not. */
export const resolveIrisWidth = (width: number | null, windowWidth: number): number =>
  width === null ? defaultIrisWidth(windowWidth) : clampIrisWidth(width, workAreaFor(windowWidth));

export function initialState(): AppState {
  return {
    workspace: { id: '', name: '', role: 'member', jurisdiction: null },
    user: { id: '', name: '', email: '', role: 'member' },
    agent: { id: null, name: 'Iris', email: null, summary: '', setupStep: null, provisioningStatus: null },
    capabilities: {
      emailIngress: false,
      turnAttachments: false,
      automatedTriggers: false,
      memberInvitationMode: 'legacy_delivery',
      memberRoleTemplates: [],
      effectExecutor: 'unavailable',
    },
    entities: emptyEntities(),
    sessions: {},
    sessionOrder: [],
    activeSessionId: null,
    counts: { inbox: 0, pendingForMe: 0, pendingForOthers: 0, pendingGrants: 0, createdDocuments: 0, decisions: 0 },
    settings: {},
    cursors: { session: {}, workspace: 0n },
    connection: { session: emptyLink(), workspace: emptyLink(), authRefreshedAt: 0 },
    ui: {
      irisPanel: 'open',
      irisWidth: null,
      irisUnread: 0,
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
    agentId: row.agent_id,
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
    pendingTurn: null,
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
    titleSource: titleSourceOf(row),
  };
}

// ---------------------------------------------------------------------------
// Session titles (decision C34)
// ---------------------------------------------------------------------------

/** What `POST /w/:ws/sessions` names a session with nothing to go on. */
import { DEFAULT_SESSION_TITLE, autoTitleFrom } from '@hermes/shared';
export { DEFAULT_SESSION_TITLE, autoTitleFrom };

/**
 * Who named the session, as far as the client is concerned. The server records
 * the provenance; a row without it (mock data, an older Worker) falls back to
 * the old heuristic, where anything that is not the placeholder is somebody's.
 */
export function titleSourceOf(row: { title: string; title_source?: string }): 'auto' | 'manual' {
  if (row.title_source) return row.title_source === 'manual' ? 'manual' : 'auto';
  return row.title === DEFAULT_SESSION_TITLE ? 'auto' : 'manual';
}

/**
 * A session nobody has used: no messages, no run, and still the placeholder
 * title. These are not listed — one blank session is the one you are in, and
 * three of them are a bug that looks like a list of identical rows.
 */
export const isBlankSession = (s: SessionState): boolean =>
  s.messages.length === 0 && s.pendingTurn === null && s.run === null && (s.title === DEFAULT_SESSION_TITLE || s.title.trim() === '');

/**
 * The word a session row shows beside its title.
 *
 * `v_session_status` is the *run's* status — `COALESCE(r.status, 'idle')` — so
 * what reaches the client is `idle`/`working`/`waiting`/`stopped`/`completed`,
 * not the demo's vocabulary. These are the demo's words for the same five
 * facts. Anything else the server sends is passed through: a server that writes
 * a better sentence than this table should win, and a screen renders the
 * server's sentence rather than its own.
 *
 * A session nobody has used gets no word at all — "Ready" on a blank session is
 * a status about nothing.
 */
const RUN_WORDS: Record<string, string> = {
  idle: 'Ready',
  completed: 'Ready',
  working: 'Working',
  waiting: 'Waiting',
  stopping: 'Stopping',
  stopped: 'Stopped',
  error: 'Stopped',
  Empty: '',
};

/**
 * What a *list* calls a session that has no name yet.
 *
 * Not "New session": that is the name of the control that creates one, and two
 * buttons a keystroke apart with the same accessible name is a sidebar where
 * "New session" means two different things — which is how the three identical
 * rows read in the first place (decision C34). The stored title is untouched;
 * this is what the row says until the first turn names it.
 */
export const UNTITLED_SESSION = 'Untitled session';

export const sessionRowTitle = (session: SessionState): string => (isBlankSession(session) ? UNTITLED_SESSION : session.title);

export function sessionStatusLabel(session: SessionState): string {
  if (isBlankSession(session)) return '';
  const status = session.status?.trim() ?? '';
  if (!status) return '';
  return RUN_WORDS[status] ?? status;
}

/** The first six words of the first turn, which is what the session was about. */

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type Action =
  | { type: 'bootstrap/apply'; patch: Partial<AppState> }
  | { type: 'nav/app'; object: Ref; manual?: boolean }
  | { type: 'nav/tab'; key: keyof UiState; value: string }
  | { type: 'iris/focus'; sessionId: string; object: Ref; runId?: string | null }
  | { type: 'iris/toggle'; open?: boolean }
  | { type: 'iris/panel'; panel: IrisPanel }
  | { type: 'iris/width'; width: number | null; workArea?: number }
  | { type: 'iris/unread'; delta?: number; clear?: boolean }
  | { type: 'ui/set'; patch: Partial<UiState> }
  | { type: 'session/create'; id: string; title?: string; mode?: string; runtime?: 'cloud' | 'local'; context?: { label: string; ref: Ref | null }; carried?: { from: string; context: string }; model?: string; effort?: string | null; pending?: boolean }
  | { type: 'session/reconcile'; localId: string; serverId: string }
  | { type: 'session/rollback'; id: string }
  | { type: 'session/upsert'; session: Session }
  | { type: 'session/select'; id: string }
  | { type: 'session/snapshot'; snapshot: SessionSnapshot }
  | { type: 'session/rename'; id: string; title: string }
  | { type: 'session/auto-title'; id: string; title: string }
  | { type: 'session/pin'; id: string; pinned?: boolean }
  | { type: 'session/archive'; id: string; archived?: boolean }
  | { type: 'session/share'; id: string; share: { id: string; url: string | null; audience: string } | null }
  | { type: 'session/unshare'; id: string }
  | { type: 'session/draft'; id: string; text: string }
  | { type: 'session/draft-clear'; id: string }
  | { type: 'session/drafts-restore'; drafts: Record<string, DraftState> }
  | { type: 'session/attach'; id: string; attachment: DraftState['attachments'][number] }
  | { type: 'session/detach'; id: string; attachmentId: string }
  | { type: 'session/set'; id: string; patch: Partial<SessionState> }
  | { type: 'session/scroll'; id: string; scrollTop: number }
  | { type: 'turn/optimistic'; sessionId: string; clientTurnId: string; message: Message; run: Run }
  | { type: 'turn/accepted'; sessionId: string; clientTurnId: string; runId: string; status: Run['status']; attempt: number }
  | { type: 'turn/rejected'; sessionId: string; clientTurnId: string }
  | { type: 'message/add'; sessionId: string; message: Message }
  | { type: 'message/confirm-turn'; sessionId: string; message: Message; clientTurnId?: string | null }
  | { type: 'message/update'; sessionId: string; id: string; patch: Partial<Message> }
  | { type: 'message/prepend'; sessionId: string; messages: Message[]; hasEarlier: boolean }
  | { type: 'run/start'; sessionId: string; run: Run; clientTurnId?: string }
  | { type: 'run/step'; sessionId: string; stepId: string; label: string; state: Run['steps'][number]['state']; stepAttempt?: number; toolCallId?: string | null }
  | { type: 'run/status'; sessionId: string; runId: string; status: Run['status']; patch?: Partial<Run> }
  | { type: 'run/guide'; sessionId: string; text: string; id: string }
  | { type: 'run/guide-apply'; sessionId: string; runId: string; guidanceId: string }
  | { type: 'run/guide-remove'; sessionId: string }
  | { type: 'run/queue'; sessionId: string; items: RunQueueItem[] }
  | { type: 'run/queue-edit'; sessionId: string; id: string; text: string }
  | { type: 'run/queue-remove'; sessionId: string; id: string }
  | { type: 'run/queue-status'; sessionId: string; status: RunQueueItem['status'] }
  | { type: 'run/clear'; sessionId: string }
  | { type: 'stream/reset'; sessionId: string; runId: string; turn: number; stepAttempt: number }
  | { type: 'stream/delta'; sessionId: string; runId: string; turn: number; stepAttempt: number; delta: string; seq?: number }
  | { type: 'stream/preview'; sessionId: string; runId: string; turn: number; stepAttempt: number; offset: number; delta: string }
  | { type: 'stream/final'; sessionId: string; message: Message; turn?: number }
  | { type: 'stream/reveal-complete'; sessionId: string; runId: string }
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
  | { type: 'auth/evicted' }
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
    // The one blank session that is listed is the one you are looking at.
    .filter((row) => !isBlankSession(row.session) || row.session.id === s.activeSessionId)
    .sort((a, b) => Number(b.session.pinned) - Number(a.session.pinned) || a.order - b.order)
    .map((row) => row.session);

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * The rail's badge counts what a person would have read had the panel been open
 * (decision C33): Iris's own messages, in the session they are looking at, while
 * they could not see them. `before` is the state the decision is made against,
 * so a replay or a re-delivery — which the caller has already detected — never
 * counts twice.
 */
function countUnread(before: AppState, next: AppState, sessionId: string, role: string): AppState {
  if (before.ui.irisPanel === 'open' || role !== 'iris' || sessionId !== before.activeSessionId) return next;
  return { ...next, ui: { ...next.ui, irisUnread: next.ui.irisUnread + 1 } };
}

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

/**
 * The ref is the complete view, including list filters. Keep the older tab
 * fields in sync for existing callers, but never let yesterday's tab override
 * a new ref.
 */
function uiForRef(ui: UiState, app: Ref): UiState {
  const historyView = app.view ?? 'decisions';
  return {
    ...ui,
    app,
    ...(app.section === 'inbox' && app.view !== 'request'
      ? { inboxTab: app.view === 'rules' ? 'rules' : app.filters?.status === 'resolved' ? 'resolved' : 'needs-review' }
      : {}),
    ...(app.section === 'history' && ['all', 'decisions', 'blocked'].includes(historyView) ? { historyTab: historyView } : {}),
    ...(app.section === 'library' ? { libraryTab: app.view ?? 'skills' } : {}),
    ...(app.section === 'settings' ? { settingsTab: app.view ?? 'Notifications' } : {}),
  };
}

export function reduce(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'bootstrap/apply': {
      const next = { ...state, ...action.patch };
      const app = authorisedRef(next.user.role, next.ui.app, next.agent.id);
      const ui = uiForRef(next.ui, app);
      return next.agent.id === null
        ? { ...next, activeSessionId: null, ui: { ...ui, irisPanel: 'hidden', pane: 'app' } }
        : { ...next, ui };
    }

    // --- navigation ---
    // The app pane moves only when a person moves it. Iris records where it is
    // working on the session (`iris/focus`) and the reply offers that as a link;
    // nothing Iris does replaces the view somebody is looking at.
    case 'nav/app': {
      const object = authorisedRef(state.user.role, action.object, state.agent.id);
      return {
        ...state,
        ui: {
          ...uiForRef(state.ui, object),
          pane: action.manual ? 'app' : state.ui.pane,
        },
      };
    }
    case 'nav/tab': {
      // Existing tabs are manual navigation too: pin the entire view, not
      // just the page, so an incoming focus cannot replace a person's filter.
      if (action.key === 'inboxTab') {
        const filters = state.ui.app.section === 'inbox' ? state.ui.app.filters : undefined;
        const object: Ref = action.value === 'rules'
          ? { section: 'inbox', view: 'rules' }
          : { section: 'inbox', view: 'list', filters: { ...filters, status: action.value === 'resolved' ? 'resolved' : 'pending' } };
        return reduce(state, { type: 'nav/app', object, manual: true });
      }
      if (action.key === 'historyTab' || action.key === 'libraryTab' || action.key === 'settingsTab') {
        const section = action.key === 'historyTab' ? 'history' : action.key === 'libraryTab' ? 'library' : 'settings';
        return reduce(state, { type: 'nav/app', object: { section, view: action.value }, manual: true });
      }
      return { ...state, ui: { ...state.ui, [action.key]: action.value } };
    }
    case 'iris/focus':
      return withSession(state, action.sessionId, (session) => ({
        ...session,
        focus: action.object,
        focusRunId: action.runId === undefined ? session.focusRunId ?? null : action.runId,
      }));
    // `iris/toggle` predates the three states and every existing caller still
    // dispatches it, so it keeps its meaning: `open: true` opens, `open: false`
    // is the *rail* rather than nothing (the affordance to come back is the
    // point), and no argument is open↔rail. From `hidden` it can only open —
    // hiding completely is a deliberate choice and a toggle does not undo it
    // halfway.
    case 'iris/toggle': {
      const next: IrisPanel = action.open === true ? 'open' : action.open === false ? 'rail' : state.ui.irisPanel === 'open' ? 'rail' : 'open';
      return { ...state, ui: { ...state.ui, irisPanel: next, irisUnread: next === 'open' ? 0 : state.ui.irisUnread } };
    }
    case 'iris/panel':
      return { ...state, ui: { ...state.ui, irisPanel: action.panel, irisUnread: action.panel === 'open' ? 0 : state.ui.irisUnread } };
    case 'iris/width':
      return {
        ...state,
        ui: { ...state.ui, irisWidth: action.width === null ? null : clampIrisWidth(action.width, action.workArea ?? workAreaFor(WIDE_BREAKPOINT)) },
      };
    case 'iris/unread':
      return { ...state, ui: { ...state.ui, irisUnread: action.clear ? 0 : state.ui.irisUnread + (action.delta ?? 1) } };
    case 'ui/set':
      return { ...state, ui: { ...state.ui, ...action.patch } };

    // --- sessions ---
    case 'session/snapshot': {
      const { snapshot } = action;
      const id = snapshot.session.id;
      const current = state.sessions[id];
      const watermark = BigInt(snapshot.watermark);
      if (snapshot.workspace_id !== state.workspace.id || !current || watermark < (state.cursors.session[id] ?? 0n)) return state;
      if (current.run?.id === snapshot.run?.id && current.run && snapshot.run && current.run.attempt > snapshot.run.attempt) return state;
      let next = reduce(state, { type: 'session/upsert', session: snapshot.session });
      next = withSession(next, id, (session) => {
        // An admission in flight may postdate the snapshot transaction. Keep
        // its projection until admission or its own run appears in a snapshot.
        const pendingNewer = Boolean(session.pendingTurn && session.pendingTurn.runId !== snapshot.run?.id);
        let run = pendingNewer ? session.run : snapshot.run ? mergeRun(session.run, snapshot.run) : session.run;
        const messages = new Map(session.messages.map((message) => [message.id, message]));
        for (const message of snapshot.messages.items) {
          const previous = messages.get(message.id);
          if (previous?.status === 'complete' && (message.status !== 'complete' || previous.text.length > message.text.length)) continue;
          // Only the assistant placeholder belongs to the accumulator. User
          // guidance uses streaming to mean durably queued, not partial text.
          if (message.role === 'iris' && message.status === 'streaming') continue;
          messages.set(message.id, message.status === 'incomplete' ? { ...message, incomplete: true } : message);
        }
        if (!pendingNewer && run && snapshot.run) {
          let guidance = snapshot.run.guidance;
          if (guidance === undefined) {
            // Legacy responses lack the explicit projection. Never attribute
            // unassigned guidance to a run merely because it is in its page.
            const latest = [...messages.values()].filter((message) => message.role === 'user' && message.kind === 'guidance' && message.run_id === run!.id)
              .sort((a, b) => b.seq - a.seq)[0];
            guidance = latest ? { id: latest.id, text: latest.text, status: latest.status === 'complete' ? 'applied' : 'pending' } : null;
          }
          const current = session.run?.id === run.id && session.run.attempt === run.attempt ? session.run.guidance : null;
          // A snapshot taken before the guidance POST must not erase local
          // intent; explicit null otherwise clears the durable projection.
          if (guidance === null && current?.id.startsWith('pending-')) guidance = current;
          if (guidance && (messages.get(guidance.id)?.status === 'complete' || (current?.id === guidance.id && current.status === 'applied'))) {
            guidance = { ...guidance, status: 'applied' };
          }
          if (guidance?.status === 'applied') {
            const message = messages.get(guidance.id);
            if (message?.role === 'user' && message.kind === 'guidance') messages.set(message.id, { ...message, status: 'complete', run_id: run.id });
          }
          run = { ...run, guidance };
        }
        let stream = session.stream;
        const incoming = snapshot.stream;
        if (!pendingNewer && run?.id === snapshot.run?.id) {
          const sameAttempt = session.run?.id === run?.id && session.run?.attempt === run?.attempt;
          if (!sameAttempt) stream = null;
          if (incoming && incoming.status === 'streaming' && !terminalRun(run!.status)) {
            const sameStream = sameAttempt && stream?.runId === incoming.run_id && stream.turn === incoming.turn && stream.stepAttempt === incoming.step_attempt;
            const newerPreview = sameAttempt && stream?.runId === incoming.run_id && (stream.turn > incoming.turn || (stream.turn === incoming.turn && stream.stepAttempt > incoming.step_attempt));
            if (!newerPreview) stream = { runId: incoming.run_id, turn: incoming.turn, stepAttempt: incoming.step_attempt,
              text: sameStream && stream!.text.startsWith(incoming.text) ? stream!.text : incoming.text,
              durableText: sameStream && stream!.durableText.startsWith(incoming.text) ? stream!.durableText : incoming.text,
              seq: sameStream ? Math.max(stream!.seq ?? -1, incoming.seq) : incoming.seq,
              blocks: [], status: 'streaming' };
          } else if (incoming?.status === 'final') {
            const message = incoming.message_id ? messages.get(incoming.message_id) : null;
            const text = message?.status === 'complete' ? message.text : incoming.text;
            const olderTurn = sameAttempt && stream?.runId === incoming.run_id && (stream.turn > incoming.turn || (stream.turn === incoming.turn && stream.stepAttempt > incoming.step_attempt));
            if (!olderTurn && stream?.runId === incoming.run_id) stream = { ...stream, text, durableText: text,
              blocks: message?.blocks ?? [], status: message?.status === 'incomplete' ? 'incomplete' : 'complete' };
          } else if (terminalRun(run?.status ?? 'completed')) stream = null;
        }
        const ordered = [...messages.values()];
        const order = (message: Message): number => message.seq < Number.MAX_SAFE_INTEGER ? message.seq
          : (ordered.find((item) => item.role === 'user' && item.run_id === message.run_id)?.seq ?? Number.MAX_SAFE_INTEGER - 1) + 0.5;
        ordered.sort((a, b) => order(a) - order(b));
        const pendingTurn = session.pendingTurn && ordered.some((message) => confirmsPendingTurn(session.pendingTurn, message)) ? null : session.pendingTurn;
        return { ...session, messages: ordered, oldestSeq: ordered[0]?.seq ?? null, hasEarlier: snapshot.messages.cursor !== null,
          run, stream, pendingTurn, status: run?.status ?? session.status, recovery: snapshot.recovery, hydrationError: null };
      });
      return { ...next, cursors: { ...next.cursors, session: { ...next.cursors.session, [id]: watermark } } };
    }
    case 'session/create': {
      const session: SessionState = {
        id: action.id,
        agentId: state.agent.id,
        title: action.title ?? DEFAULT_SESSION_TITLE,
        subtitle: null,
        mode: action.mode ?? 'ask',
        model: action.model ?? String(state.settings.default_model_id ?? ''),
        effort: action.effort ?? (state.settings.default_effort as string | null) ?? null,
        runtime: action.runtime ?? ((state.settings.default_runtime as 'cloud' | 'local') ?? 'cloud'),
        pinned: false,
        titleSource: 'auto',
        archived: false,
        status: 'Empty',
        messages: [],
        oldestSeq: null,
        hasEarlier: false,
        draft: { text: '', attachments: [] },
        pendingTurn: null,
        run: null,
        stream: null,
        focus: null,
        focusRunId: null,
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
        ui: { ...state.ui, pane: 'chat' },
      };
    }
    case 'session/reconcile': {
      const local = state.sessions[action.localId];
      if (!local) return state;
      const sessions = { ...state.sessions };
      delete sessions[action.localId];
      sessions[action.serverId] = {
        ...local,
        id: action.serverId,
        pending: false,
        pendingTurn: local.pendingTurn
          ? { ...local.pendingTurn, message: { ...local.pendingTurn.message, session_id: action.serverId } }
          : null,
        run: local.run ? { ...local.run, session_id: action.serverId } : null,
      };
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
        ? {
            ...existing,
            ...fresh,
            messages: existing.messages,
            oldestSeq: existing.oldestSeq,
            hasEarlier: existing.hasEarlier,
            draft: existing.draft,
            pendingTurn: existing.pendingTurn,
            run: existing.run,
            stream: existing.stream,
            scrollTop: existing.scrollTop,
            unread: existing.unread,
            ...(existing.settingsPending || existing.settingsError ? { model: existing.model, effort: existing.effort } : {}),
            // Two title races, both lost without this (decision C34). A manual
            // rename is sticky: the row that re-delivers the old title must not
            // undo it. And a local auto-title beats the server's placeholder,
            // because the PATCH that carries it may not have landed yet.
            titleSource: existing.titleSource === 'manual' ? 'manual' : fresh.titleSource,
            title: existing.titleSource === 'manual' || fresh.title === DEFAULT_SESSION_TITLE ? existing.title : fresh.title,
            // A run's focus lives on the socket, not the row: nothing persists
            // `focus_ref` for it, so a snapshot without one must not erase the
            // link the reply is offering.
            focus: fresh.focus ?? existing.focus,
            focusRunId: fresh.focus ? null : existing.focusRunId ?? null,
          }
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
      const object = authorisedRef(state.user.role, session.focus ?? state.ui.app, state.agent.id);
      return {
        ...state,
        activeSessionId: action.id,
        sessions: { ...state.sessions, [action.id]: { ...session, unread: false } },
        ui: { ...uiForRef(state.ui, object), pane: 'chat', ...(state.agent.id ? {} : { irisPanel: 'open' as const }) },
      };
    }
    case 'session/rename':
      return withSession(state, action.id, (s) => ({ ...s, title: action.title.trim() || s.title, titleSource: 'manual' }));
    // A rename is a person's word: it lands, and it turns auto-titling off.
    case 'session/auto-title':
      return withSession(state, action.id, (s) => (s.titleSource === 'manual' ? s : { ...s, title: action.title }));
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

    // --- turn admission ---
    // The first painted frame after Send is local: the person's own message
    // and Iris's working state. Server events remain authoritative and replace
    // this projection as soon as they arrive.
    case 'turn/optimistic':
      return withSession(state, action.sessionId, (s) => ({
        ...s,
        pendingTurn: { clientTurnId: action.clientTurnId, runId: null, message: action.message, previousStatus: s.status, previousRun: s.run },
        run: action.run,
        status: 'Working',
        lastActivity: Date.now(),
      }));
    case 'turn/accepted':
      return withSession(state, action.sessionId, (s) => {
        if (s.pendingTurn?.clientTurnId !== action.clientTurnId) return s;
        const run = s.run && s.run.id === action.clientTurnId
          ? { ...s.run, id: action.runId, status: action.status, attempt: action.attempt }
          : s.run;
        return {
          ...s,
          pendingTurn: admitPendingTurn(s, action.runId),
          run,
        };
      });
    case 'turn/rejected':
      return withSession(state, action.sessionId, (s) => {
        if (s.pendingTurn?.clientTurnId !== action.clientTurnId) return s;
        const optimisticRun = s.run && (s.run.id === action.clientTurnId || s.run.id === s.pendingTurn.runId);
        return {
          ...s,
          pendingTurn: null,
          run: optimisticRun ? s.pendingTurn.previousRun ?? null : s.run,
          status: optimisticRun ? s.pendingTurn.previousStatus : s.status,
        };
      });

    // --- messages ---
    case 'message/add': {
      const duplicate = state.sessions[action.sessionId]?.messages.some((m) => m.id === action.message.id) ?? false;
      const next = withSession(state, action.sessionId, (s) =>
        duplicate
          ? s
          : {
              ...s,
              lastActivity: Date.now(),
              unread: action.sessionId === state.activeSessionId ? s.unread : true,
              oldestSeq: s.oldestSeq ?? action.message.seq,
              messages: [...s.messages, action.message],
            },
      );
      return duplicate ? next : countUnread(state, next, action.sessionId, action.message.role);
    }
    case 'message/confirm-turn': {
      const session = state.sessions[action.sessionId];
      if (!session) return state;
      const duplicate = session.messages.some((message) => message.id === action.message.id);
      const pending = session.pendingTurn;
      const confirmsPending = confirmsPendingTurn(pending, action.message, action.clientTurnId);
      if (duplicate && !confirmsPending) return state;
      const next = withSession(state, action.sessionId, (s) => {
        let run = s.run;
        if (confirmsPending && pending && run?.id === pending.clientTurnId && action.message.run_id) {
          run = { ...run, id: action.message.run_id };
        }
        return {
          ...s,
          pendingTurn: confirmsPending ? null : s.pendingTurn,
          run,
          lastActivity: duplicate ? s.lastActivity : Date.now(),
          unread: duplicate || action.sessionId === state.activeSessionId ? s.unread : true,
          oldestSeq: duplicate ? s.oldestSeq : s.oldestSeq ?? action.message.seq,
          messages: duplicate ? s.messages : [...s.messages, { ...action.message, ...(confirmsPending && pending?.message.attachments && !action.message.attachments ? { attachments: pending.message.attachments } : {}) }],
        };
      });
      return duplicate ? next : countUnread(state, next, action.sessionId, action.message.role);
    }
    case 'message/update':
      return withSession(state, action.sessionId, (s) => ({ ...s, messages: s.messages.map((m) => (m.id === action.id ? { ...m, ...action.patch } : m)) }));
    case 'message/prepend':
      return withSession(state, action.sessionId, (s) => ({
        ...s,
        messages: [...action.messages.filter((message) => !s.messages.some((current) => current.id === message.id)), ...s.messages].sort((a, b) => a.seq - b.seq),
        oldestSeq: action.messages[0]?.seq ?? s.oldestSeq,
        hasEarlier: action.hasEarlier,
      }));

    // --- runs ---
    case 'run/start':
      return withSession(state, action.sessionId, (s) => {
        const sameTurn = Boolean(action.clientTurnId && s.pendingTurn?.clientTurnId === action.clientTurnId);
        const run = mergeRun(s.run, action.run, sameTurn);
        const changedAttempt = s.run?.id !== run.id || s.run.attempt !== run.attempt;
        return { ...s, pendingTurn: sameTurn ? admitPendingTurn(s, run.id) : s.pendingTurn,
          run, status: run.status, stream: changedAttempt ? null : s.stream };
      });
    case 'run/step':
      return withRun(state, action.sessionId, (run) => {
        const found = run.steps.some((step) => step.id === action.stepId);
        const steps = found
          ? run.steps.map((step) =>
              step.id === action.stepId
                ? {
                    ...step,
                    state: action.state,
                    label: action.label,
                    ...(action.stepAttempt ? { step_attempt: action.stepAttempt } : {}),
                    ...(action.toolCallId ? { tool_call_id: action.toolCallId } : {}),
                  }
                : step,
            )
          : [
              ...run.steps,
              {
                id: action.stepId,
                label: action.label,
                state: action.state,
                ...(action.stepAttempt ? { step_attempt: action.stepAttempt } : {}),
                ...(action.toolCallId ? { tool_call_id: action.toolCallId } : {}),
              },
            ];
        return { ...run, steps };
      });
    case 'run/status':
      // A prior run can finish while the next turn's optimistic state is
      // already painted. Status belongs to the run named by the event; letting
      // a late completion mutate whichever run is current removes Thinking
      // from the new turn and leaves only its user bubble on screen.
      return withSession(state, action.sessionId, (s) => {
        if (s.run?.id !== action.runId) return s;
        const newer = (action.patch?.attempt ?? s.run.attempt) > s.run.attempt;
        const incoming = { ...s.run, ...(newer ? { steps: [], queue: [], error: null, started_at: undefined } : {}), status: action.status, ...action.patch };
        const run = mergeRun(s.run, incoming);
        return { ...s, status: run.status, run, stream: newer ? null : s.stream };
      });
    case 'run/guide':
      return withRun(state, action.sessionId, (run) => ({ ...run, guidance: { id: action.id, text: action.text, status: 'pending' } }));
    case 'run/guide-apply':
      return withSession(state, action.sessionId, (session) => ({
        ...session,
        messages: session.messages.map((message) => message.id === action.guidanceId && message.role === 'user' && message.kind === 'guidance'
          ? { ...message, status: 'complete', run_id: action.runId } : message),
        run: session.run?.id === action.runId && session.run.guidance?.id === action.guidanceId
          ? { ...session.run, guidance: { ...session.run.guidance, status: 'applied' } } : session.run,
      }));
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
      return withSession(state, action.sessionId, (s) => {
        if ((s.streamFences?.[action.runId] ?? -1) >= action.turn) return s;
        if (s.run && (s.run.id !== action.runId || terminalRun(s.run.status))) return s;
        if (s.stream?.runId === action.runId && (s.stream.turn > action.turn || (s.stream.turn === action.turn && s.stream.stepAttempt >= action.stepAttempt))) return s;
        return { ...s, stream: { runId: action.runId, turn: action.turn, stepAttempt: action.stepAttempt, text: '', durableText: '', seq: -1, blocks: [], status: 'streaming' } };
      });
    case 'stream/delta':
      return withSession(state, action.sessionId, (s) => {
        if ((s.streamFences?.[action.runId] ?? -1) >= action.turn) return s;
        const current = s.stream;
        if (s.run && (s.run.id !== action.runId || terminalRun(s.run.status))) return s;
        if (current?.runId === action.runId && current.turn > action.turn) return s;
        // A delta from a superseded attempt is discarded; a delta from a *higher*
        // attempt is an implicit reset, in case the reset was lost across a hub
        // restart.
        if (!current || current.runId !== action.runId || current.turn !== action.turn || action.stepAttempt > current.stepAttempt) {
          if (action.seq !== undefined && action.seq !== 0) return s;
          return { ...s, stream: { runId: action.runId, turn: action.turn, stepAttempt: action.stepAttempt, text: action.delta, durableText: action.delta, seq: action.seq, blocks: [], status: 'streaming' } };
        }
        if (action.stepAttempt < current.stepAttempt) return s;
        if (current.status !== 'streaming') return s;
        // A gap cannot be appended safely. Keep the visible preview and let
        // the next cumulative snapshot repair the missing committed prefix.
        if (action.seq !== undefined && action.seq !== (current.seq ?? -1) + 1) return s;
        const durableText = current.durableText + action.delta;
        const text = current.text.startsWith(durableText) ? current.text : durableText;
        return { ...s, stream: { ...current, text, durableText, seq: action.seq ?? current.seq } };
      });
    case 'stream/preview':
      return withSession(state, action.sessionId, (s) => {
        if ((s.streamFences?.[action.runId] ?? -1) >= action.turn) return s;
        const current = s.stream;
        // Best-effort RPCs may finish after the final's reveal was cleared or
        // after a new run started. They must not resurrect an old accumulator.
        if (s.run && s.run.id !== action.runId) return s;
        const terminalRun = s.run?.id === action.runId && ['completed', 'stopped', 'error'].includes(s.run.status);
        const savedFinal = s.messages.some((m) => m.run_id === action.runId && m.role === 'iris' && m.status !== 'streaming');
        const matchingLiveStream = current?.runId === action.runId && current.turn === action.turn && current.status === 'streaming';
        if (terminalRun || (savedFinal && !matchingLiveStream)) return s;
        if (current?.runId === action.runId && current.turn > action.turn) return s;
        if (!current || current.runId !== action.runId || current.turn !== action.turn || action.stepAttempt > current.stepAttempt) {
          if (action.offset !== 0) return s;
          return { ...s, stream: { runId: action.runId, turn: action.turn, stepAttempt: action.stepAttempt, text: action.delta, durableText: '', seq: -1, blocks: [], status: 'streaming' } };
        }
        if (action.stepAttempt < current.stepAttempt || action.offset > current.text.length) return s;
        if (current.status !== 'streaming') return s;
        const overlap = Math.min(action.delta.length, current.text.length - action.offset);
        if (current.text.slice(action.offset, action.offset + overlap) !== action.delta.slice(0, overlap)) return s;
        if (overlap === action.delta.length) return s;
        return { ...s, stream: { ...current, text: current.text + action.delta.slice(overlap) } };
      });
    // A streamed reply ends here rather than at `message/add`, and this is the
    // path almost every Iris message actually takes — so the rail's badge has to
    // count it, or a collapsed panel would sit at zero through a whole run.
    case 'stream/final': {
      if (action.message.status === 'streaming') return state;
      const seen = state.sessions[action.sessionId]?.messages.some((m) => m.id === action.message.id) ?? false;
      const next = withSession(state, action.sessionId, (s) => ({
        ...s,
        // A durable final for the previous run may race the next optimistic
        // turn. Keep that final in history, but do not replace the newer run's
        // transient preview accumulator. A matching accumulator stays until
        // the renderer has fluidly consumed the authoritative final text.
        stream: s.stream?.runId === action.message.run_id
          ? {
              ...s.stream,
              text: action.message.text,
              durableText: action.message.text,
              blocks: action.message.blocks,
              status: action.message.status === 'incomplete' || action.message.incomplete ? 'incomplete' : 'complete',
            }
          : s.stream,
        streamFences: action.message.run_id
          ? addStreamFence(
              s.streamFences,
              action.message.run_id,
              action.turn ?? (s.stream?.runId === action.message.run_id ? s.stream.turn : 0),
            )
          : s.streamFences,
        lastActivity: Date.now(),
        messages: seen ? s.messages.map((m) => (m.id === action.message.id ? action.message : m)) : [...s.messages, action.message],
      }));
      return seen ? next : countUnread(state, next, action.sessionId, action.message.role);
    }
    case 'stream/reveal-complete':
      return withSession(state, action.sessionId, (s) =>
        s.stream?.runId === action.runId && s.stream.status !== 'streaming'
          ? { ...s, stream: null }
          : s,
      );

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
    case 'auth/evicted': {
      const settings = state.settings as Record<string, unknown>;
      const personalSettings = Object.fromEntries(
        ['default_model_id', 'default_effort', 'default_runtime'].flatMap((key) => key in settings ? [[key, settings[key]]] : []),
      );
      return {
        ...state,
        workspace: { ...state.workspace, role: 'member' },
        user: { ...state.user, role: 'member' },
        entities: emptyEntities(),
        settings: personalSettings,
        ui: {
          ...state.ui,
          app: { section: 'settings', view: 'Notifications' },
          settingsTab: 'Notifications',
          pane: 'app',
          banner: 'evicted',
          providerKeysLocked: true,
        },
      };
    }
    case 'counts/set':
      return { ...state, counts: { ...state.counts, ...action.patch } };
    case 'settings/merge':
      return { ...state, settings: { ...state.settings, ...action.patch } };
    case 'cache/clear': {
      // A resync drops derived state and keeps what the human typed (spec §5.5).
      const sessions: Record<string, SessionState> = {};
      for (const [id, session] of Object.entries(state.sessions)) {
        sessions[id] = {
          ...session,
          messages: [],
          oldestSeq: null,
          hasEarlier: true,
          run: session.pendingTurn ? session.run : null,
          stream: null,
        };
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

  if (id <= (sessionId ? state.cursors.session[sessionId] ?? 0n : state.cursors.workspace)) return [];
  if (sessionId && event.kind === 'run.step' && state.sessions[sessionId]?.run?.id !== event.payload.run_id) return [advance];
  // Run attempts are independent of provider step attempts. Never let a late
  // frame from the previous retry reintroduce its text, steps, or failure.
  if (sessionId && 'run_id' in event.payload && 'attempt' in event.payload) {
    const current = state.sessions[sessionId]?.run;
    const payload = event.payload;
    if (current?.id === payload.run_id && typeof payload.attempt === 'number') {
      if (payload.attempt < current.attempt) return [advance];
      if (payload.attempt > current.attempt && event.kind !== 'run.started' && event.kind !== 'run.status') {
        out.push({ type: 'run/start', sessionId, run: { ...current, attempt: payload.attempt, status: 'working', steps: [], queue: [], error: null, started_at: event.at } });
      }
    }
  }

  switch (event.kind) {
    case 'run.started': {
      const p = event.payload;
      const agentId = state.sessions[p.session_id]?.agentId ?? state.agent.id;
      // Bootstrap and the session row establish the identity before a run can
      // arrive. If an out-of-order event breaks that contract, keep the cursor
      // moving and wait for resync instead of attributing work to a guess.
      if (!agentId) break;
      out.push({
        type: 'run/start',
        sessionId: p.session_id,
        clientTurnId: p.client_turn_id,
        run: {
          id: p.run_id,
          session_id: p.session_id,
          agent_id: agentId,
          status: 'working',
          attempt: p.attempt,
          title: p.title,
          steps: p.steps.map((step) => ({ id: step.id, label: step.label, state: step.state })),
          queue: [],
          guidance: null,
          started_at: event.at,
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
      // `tool_call_id` and `attempt` were being read off the wire and then
      // dropped here, which is why `ToolChips` never rendered a single chip and
      // why steps from a superseded attempt were never separated: both live on
      // the step entity and neither was reaching it (decision C44).
      if (sessionId)
        out.push({
          type: 'run/step',
          sessionId,
          stepId: p.step_id,
          label: p.label,
          state: p.state,
          stepAttempt: p.attempt,
          toolCallId: p.tool_call_id ?? null,
        });
      break;
    }
    case 'run.status': {
      const p = event.payload;
      if (sessionId)
        out.push({
          type: 'run/status',
          sessionId,
          runId: p.run_id,
          status: p.status,
          patch: {
            attempt: p.attempt,
            ...(state.sessions[sessionId]?.run?.attempt !== p.attempt ? { started_at: event.at } : {}),
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
      out.push({ type: 'iris/focus', sessionId: p.session_id, object: p.ref, runId: p.run_id });
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
      if (sessionId) out.push({ type: 'run/guide-apply', sessionId, runId: event.payload.run_id, guidanceId: event.payload.guidance_id });
      break;
    case 'run.queue.updated':
      if (sessionId) out.push({ type: 'run/queue', sessionId, items: event.payload.items });
      break;
    case 'message.appended': {
      const p = event.payload;
      out.push({
        type: p.role === 'user' ? 'message/confirm-turn' : 'message/add',
        sessionId: p.session_id,
        ...(p.role === 'user' ? { clientTurnId: p.client_turn_id } : {}),
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
      if (sessionId) out.push({ type: 'stream/delta', sessionId, runId: p.run_id, turn: p.turn, stepAttempt: p.step_attempt, delta: p.delta, seq: p.seq });
      break;
    }
    case 'message.final': {
      const p = event.payload;
      out.push({
        type: 'stream/final',
        sessionId: p.session_id,
        turn: p.turn,
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
      const alreadyKnown = Boolean(state.entities.request[p.request_id])
        || Boolean(state.entities.lists['inbox:needs-review']?.ids.includes(p.request_id))
        || Boolean(state.entities.lists.requests?.ids.includes(p.request_id));
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
      // The proposing session also emits `run.focus`. If that stream arrived
      // first, it already inserted the request and incremented the badge.
      // Count the request once across the two streams.
      if (!alreadyKnown) out.push({ type: 'counts/set', patch: { inbox: state.counts.inbox + 1 } });
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
      out.push({
        type: 'counts/set',
        patch: {
          inbox: Math.max(0, state.counts.inbox - 1),
          pendingForMe: Math.max(0, (state.counts.pendingForMe ?? state.counts.inbox) - 1),
          decisions: state.counts.decisions + 1,
        },
      });
      // A receipt is the one thing in this product a person is asked to check,
      // so it counts on the rail like a message does (decision C33).
      if (state.ui.irisPanel !== 'open') out.push({ type: 'iris/unread', delta: 1 });
      break;
    }
    case 'entity.updated': {
      const p = event.payload;
      const kind = (p.entity_type === 'workspace_settings' ? 'catalog' : p.entity_type) as EntityKind;
      if (p.entity_type === 'session') out.push({ type: 'entity/loading', kind: 'session', id: p.entity_id });
      else out.push({ type: 'entity/loading', kind, id: p.entity_id });
      break;
    }
    case 'member.agent_joined':
      // The dedicated join event carries durable source ids, while the member
      // and invitation endpoints remain authoritative for their rendered rows.
      out.push({ type: 'list/invalidate', key: 'members' });
      out.push({ type: 'list/invalidate', key: 'invitations' });
      break;
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
