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
import { safeParseStreamEvent, type StreamEvent } from '@hermes/shared';
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
  onState(state: LinkState): void;
  onResync(): void;
  /** Replays `after` → head over HTTP. Resolves `resync` when the cursor is gone. */
  replay(after: bigint): Promise<{ events: StreamEvent[]; resync: boolean }>;
  onSignedOut(): void;
  onEvicted(): void;
  socketFactory?: SocketFactory;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  random?: () => number;
}

export const PING_MS = 20_000;
export const SILENCE_MS = 60_000;
const BACKOFF = [500, 1000, 2000, 5000, 10_000];

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
  let pingHandle: unknown = null;
  let silenceHandle: unknown = null;
  let reconnectHandle: unknown = null;
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

  function applyBuffered(): void {
    const pending = buffer;
    buffer = [];
    buffering = false;
    for (const item of pending) {
      if (item.id <= cursor) continue;
      cursor = item.id;
      options.onEvent(item.event, item.id);
    }
  }

  async function catchUp(): Promise<void> {
    setStatus('replaying');
    try {
      const page = await options.replay(cursor);
      if (page.resync) {
        buffer = [];
        buffering = false;
        options.onResync();
        setStatus('open');
        return;
      }
      for (const event of page.events) {
        const id = BigInt(event.id);
        if (id <= cursor) continue;
        cursor = id;
        options.onEvent(event, id);
      }
      applyBuffered();
      setStatus('open');
    } catch {
      dropAndReconnect();
    }
  }

  function connect(): void {
    if (closed) return;
    setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
    buffering = true;
    buffer = [];
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
      armPing();
      armSilence();
      void catchUp();
    };

    ws.onmessage = (event) => {
      state = { ...state, lastMessageAt: now() };
      armSilence();
      const data = typeof event.data === 'string' ? event.data : '';
      if (!data || data === 'pong') return;
      let json: unknown;
      try {
        json = JSON.parse(data);
      } catch {
        return;
      }
      const parsed = safeParseStreamEvent(json);
      if (!parsed.success) {
        // A frame that does not parse is a contract break, not a transcript
        // hole to paper over: ask for a resync rather than guess.
        options.onResync();
        return;
      }
      const streamEvent = parsed.data;
      const id = BigInt(streamEvent.id);
      if (buffering) {
        buffer.push({ event: streamEvent, id });
        return;
      }
      if (id <= cursor) return;
      cursor = id;
      options.onEvent(streamEvent, id);
    };

    ws.onclose = (event) => {
      stopTimers();
      socket = null;
      if (closed) return;
      if (event.code === 4401) {
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
        socket?.send(JSON.stringify({ type: 'ticket', value: next }));
      } catch {
        /* the hub closes the socket if the ticket never arrives */
      }
    },
    close() {
      closed = true;
      stopTimers();
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
