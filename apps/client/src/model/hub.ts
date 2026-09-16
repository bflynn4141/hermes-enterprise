// The two hub sockets. One implementation, two instances (session, workspace),
// because the behaviour is identical and the sequences are not (client-port
// spec §5.2).
//
// The rules that matter, and why:
//   * keepalive is the literal string `ping` every 20 s. The Durable Object
//     answers `pong` through `setWebSocketAutoResponse` without waking, so no
//     application code runs. Browsers cannot send protocol ping frames, which
//     is why this is an application message at all.
//   * 60 s with no inbound frame — `pong` included — counts as disconnected.
//     A socket that is open but silent is the failure mode a heartbeat exists
//     to catch, so silence closes it rather than waiting for the TCP stack.
//   * reconnect is replay-then-buffer, in that order: open, buffer live events
//     without applying them, GET the replay from the cursor, apply the replay,
//     then apply the buffer minus anything at or below the cursor. Applying the
//     live buffer first would leave a hole no reader could notice.
//   * a frame carries a *batch*: the hubs fan one committed transaction out as
//     `{"type":"events","events":[…]}`, because sending N frames for N events
//     in one commit costs N wakeups of a hibernating Durable Object. The
//     reducer still sees one event at a time, in id order.
//   * when the socket cannot be opened at all, the hub falls back to polling
//     the same replay endpoint. That is not a nicety: in `AUTH_MODE=fake` the
//     Worker authenticates from an `x-dev-user` header and a browser cannot
//     set a header on a WebSocket handshake, so a socket is refused with 401
//     before it exists. Polling goes through `onEvent` with the same cursor and
//     the same ordering, so the only thing that changes is latency.
import { hubFrameSchema, safeParseStreamEvent, type MessagePreviewFrame, type StreamEvent } from '@hermes/shared';
import type { LinkState, LinkStatus } from './store.js';

export type HubKind = 'session' | 'workspace';

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface HubOptions {
  kind: HubKind;
  url: string;
  ticket: string;
  after: bigint;
  onEvent(event: StreamEvent, id: bigint): void;
  /** A best-effort live fragment. It never advances the durable replay cursor. */
  onPreview?(frame: MessagePreviewFrame): void;
  onState(state: LinkState): void;
  onResync(): void;
  /**
   * Replays `after` → head over HTTP. Resolves `resync` when the cursor is
   * gone. `head` is the stream's newest id at the time of the call: the
   * replay route answers at most 500 rows, so a client far behind needs more
   * than one page and `head` is how it knows.
   */
  replay(after: bigint): Promise<{ events: StreamEvent[]; resync: boolean; head?: string }>;
  onSignedOut(): void;
  onEvicted(): void;
  socketFactory?: SocketFactory;
  /**
   * Which of the replayed events this hub should apply.
   *
   * `GET /w/:ws/events?stream=session` takes no session id — it answers with
   * every session the caller may see — so a session hub advances its cursor
   * past the other sessions' rows and applies only its own. Without this a
   * second session's replay would re-apply the first session's transcript.
   */
  accept?(event: StreamEvent): boolean;
  /**
   * Poll interval once the socket has been given up on. A function, because
   * the right interval depends on whether a run is streaming: ~700 ms while
   * the transcript is moving, several seconds when nothing is happening. A
   * fixed fast interval would make an idle tab as expensive as a working one.
   */
  pollMs?: number | (() => number);
  /** How many refused handshakes before polling takes over. 0 disables it. */
  pollAfterFailures?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
}

export const PING_MS = 20_000;
export const SILENCE_MS = 60_000;
const BACKOFF = [500, 1000, 2000, 5000, 10_000];
export const POLL_MS = 700;
/** Two refused handshakes is a policy, not a blip. */
const POLL_AFTER_FAILURES = 2;

export interface Hub {
  close(): void;
  extend(ticket: string): void;
  readonly state: LinkState;
  /** Test seam: advance the internal clock-driven work without real timers. */
  readonly kind: HubKind;
}

export function createHub(options: HubOptions): Hub {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const random = options.random ?? Math.random;
  const makeSocket = options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);

  let socket: SocketLike | null = null;
  let ticket = options.ticket;
  let cursor = options.after;
  let attempts = 0;
  let closed = false;
  let buffering = false;
  let buffer: { event: StreamEvent; id: bigint }[] = [];
  let previewBuffer: MessagePreviewFrame[] = [];
  let pingHandle: unknown = null;
  let silenceHandle: unknown = null;
  let reconnectHandle: unknown = null;
  let pollHandle: unknown = null;
  let polling = false;
  let handshakeFailures = 0;
  let everOpened = false;
  let state: LinkState = { status: 'connecting', lastMessageAt: 0, sinceMs: 0 };

  function setStatus(status: LinkStatus): void {
    state = { status, lastMessageAt: state.lastMessageAt, sinceMs: now() - (state.lastMessageAt || now()) };
    options.onState(state);
  }

  function stopTimers(): void {
    if (pingHandle) clearTimer(pingHandle);
    if (silenceHandle) clearTimer(silenceHandle);
    pingHandle = null;
    silenceHandle = null;
  }

  function armSilence(): void {
    if (silenceHandle) clearTimer(silenceHandle);
    silenceHandle = setTimer(() => {
      // Open but silent for a minute: treat as disconnected and start again.
      silenceHandle = null;
      dropAndReconnect();
    }, SILENCE_MS);
  }

  function armPing(): void {
    if (pingHandle) clearTimer(pingHandle);
    pingHandle = setTimer(() => {
      pingHandle = null;
      try {
        socket?.send('ping');
      } catch {
        /* a send on a dead socket is caught by the silence timer */
      }
      armPing();
    }, PING_MS);
  }

  function dropAndReconnect(): void {
    if (closed) return;
    stopTimers();
    try {
      socket?.close(4000, 'client_silence');
    } catch {
      /* ignore */
    }
    socket = null;
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (closed) return;
    setStatus('reconnecting');
    const base = BACKOFF[Math.min(attempts, BACKOFF.length - 1)] ?? 10_000;
    const jitter = base * 0.2 * (random() * 2 - 1);
    attempts += 1;
    if (reconnectHandle) clearTimer(reconnectHandle);
    reconnectHandle = setTimer(() => {
      reconnectHandle = null;
      connect();
    }, Math.max(0, Math.round(base + jitter)));
  }

  /** One event, wherever it came from: a live frame, a replay page, a poll. */
  function intake(streamEvent: StreamEvent): void {
    const id = BigInt(streamEvent.id);
    if (buffering) {
      buffer.push({ event: streamEvent, id });
      return;
    }
    if (id <= cursor) return;
    cursor = id;
    if (options.accept && !options.accept(streamEvent)) return;
    options.onEvent(streamEvent, id);
  }

  function intakePreview(frame: MessagePreviewFrame): void {
    if (buffering) {
      previewBuffer.push(frame);
      return;
    }
    options.onPreview?.(frame);
  }

  function applyBuffered(): void {
    const pending = buffer;
    const pendingPreviews = previewBuffer;
    buffer = [];
    previewBuffer = [];
    buffering = false;
    for (const item of pending) intake(item.event);
    // Durable replay and live committed events establish the prefix first.
    // Offset reconciliation then makes an overlapping preview a no-op.
    for (const frame of pendingPreviews) intakePreview(frame);
  }

  /** At most this many pages per catch-up, so a very stale cursor cannot spin. */
  const MAX_REPLAY_PAGES = 20;

  async function catchUp(): Promise<void> {
    setStatus('replaying');
    try {
      // Keep paging while the stream's head is ahead of the cursor. One page
      // is 500 rows; a client that was away for a long run needs several, and
      // stopping after the first would leave a hole that looks like a dropped
      // message rather than an unfinished replay.
      for (let pageCount = 0; pageCount < MAX_REPLAY_PAGES; pageCount += 1) {
        const page = await options.replay(cursor);
        if (page.resync) {
          buffer = [];
          previewBuffer = [];
          buffering = false;
          options.onResync();
          setStatus('open');
          return;
        }
        // The replay is applied with `buffering` still true for the *buffer*,
        // but these are not buffered: `intake` is called with buffering off for
        // the duration, so replay lands first and the buffer second.
        buffering = false;
        for (const event of page.events) intake(event);
        buffering = true;
        // Stop unless the page itself says there is more. A replay with no
        // `head` is one page by definition: guessing "there might be more"
        // would mean an extra round trip after every ordinary catch-up.
        if (page.events.length === 0) break;
        if (page.head === undefined || BigInt(page.head) <= cursor) break;
      }
      applyBuffered();
      setStatus('open');
    } catch {
      dropAndReconnect();
    }
  }

  /**
   * The fallback. Same cursor, same `onEvent`, same drop-anything-at-or-below
   * rule; only the transport differs, so replay ordering is still the only
   * ordering there is.
   */
  function poll(): void {
    if (closed || !polling) return;
    void options
      .replay(cursor)
      .then((page) => {
        if (closed) return;
        if (page.resync) {
          options.onResync();
          return;
        }
        state = { ...state, lastMessageAt: now() };
        for (const streamEvent of page.events) intake(streamEvent);
        if (state.status !== 'open') setStatus('open');
      })
      .catch(() => {
        if (!closed) setStatus('reconnecting');
      })
      .finally(() => {
        if (closed || !polling) return;
        const interval = typeof options.pollMs === 'function' ? options.pollMs() : (options.pollMs ?? POLL_MS);
        pollHandle = setTimer(poll, interval);
      });
  }

  function startPolling(): void {
    if (polling || closed) return;
    polling = true;
    buffering = false;
    buffer = [];
    previewBuffer = [];
    stopTimers();
    if (reconnectHandle) clearTimer(reconnectHandle);
    reconnectHandle = null;
    setStatus('replaying');
    poll();
  }

  function connect(): void {
    if (closed || polling) return;
    setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
    buffering = true;
    buffer = [];
    previewBuffer = [];
    const url = `${options.url}${options.url.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}&after=${cursor.toString()}`;
    let ws: SocketLike;
    try {
      ws = makeSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      attempts = 0;
      everOpened = true;
      handshakeFailures = 0;
      armPing();
      armSilence();
      void catchUp();
    };

    ws.onmessage = (event) => {
      state = { ...state, lastMessageAt: now() };
      armSilence();
      const data = typeof event.data === 'string' ? event.data : '';
      // `pong` is the Durable Object's auto-response and never reaches
      // application code there; here it only has to reset the silence timer,
      // which the lines above already did.
      if (!data || data === 'pong') return;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const frame = hubFrameSchema.safeParse(json);
      if (frame.success) {
        if (frame.data.type === 'ticket.accepted') return;
        if (frame.data.type === 'message.preview') {
          intakePreview(frame.data);
          return;
        }
        for (const streamEvent of frame.data.events) intake(streamEvent);
        return;
      }
      // Older shape, and the one the mock backend sends: a bare event.
      const parsed = safeParseStreamEvent(json);
      if (!parsed.success) {
        // A frame that does not parse is a contract break, not a transcript
        // hole to paper over: ask for a resync rather than guess.
        options.onResync();
        return;
      }
      intake(parsed.data);
    };

    ws.onclose = (event) => {
      stopTimers();
      socket = null;
      if (closed) return;
      // A handshake that never became an open socket is a refusal, not a drop.
      // Retrying it forever would be a tight loop against a policy that is not
      // going to change; after a couple of tries the hub polls instead.
      if (!everOpened) {
        handshakeFailures += 1;
        const threshold = options.pollAfterFailures ?? POLL_AFTER_FAILURES;
        if (threshold > 0 && handshakeFailures >= threshold) {
          startPolling();
          return;
        }
      }
      if (event.code === 4401 && everOpened) {
        setStatus('signed-out');
        options.onSignedOut();
        return;
      }
      if (event.code === 4403) {
        setStatus('evicted');
        options.onEvicted();
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      /* the close handler owns recovery; an error alone is not actionable */
    };
  }

  connect();

  return {
    kind: options.kind,
    get state() {
      return state;
    },
    extend(next) {
      ticket = next;
      try {
        socket?.send(JSON.stringify({ type: 'ticket', ticket: next }));
      } catch {
        /* the hub closes the socket if the ticket never arrives */
      }
    },
    close() {
      closed = true;
      polling = false;
      stopTimers();
      if (pollHandle) clearTimer(pollHandle);
      if (reconnectHandle) clearTimer(reconnectHandle);
      try {
        socket?.close(1000, 'client_close');
      } catch {
        /* ignore */
      }
      socket = null;
    },
  };
}
