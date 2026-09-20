// The two push hubs.
//
// A hub holds sockets and nothing authoritative. It never opens a database
// connection. If a hub is evicted, restarted or deployed over, the only cost is
// a reconnect: the client replays from `stream_events` over HTTP and carries
// on. That is what makes "a connected client cannot miss a committed event" a
// property of the outbox rather than a property of a Durable Object staying
// alive.
//
// Authorisation happens in the Worker before the upgrade: it checks the session
// cookie, the Origin, and membership or share, then puts the result in the
// socket attachment. The hub only enforces the expiry it was handed, and it
// extends that expiry only against a ticket it can verify itself — which is an
// HMAC check, not a query.
import { DurableObject } from 'cloudflare:workers';
import type { MessagePreviewFrame } from '@hermes/shared';
import type { Env } from './env.js';
import { verifyHubTicket } from './auth/tickets.js';

/** What the Worker stamps on a socket at upgrade time (16 KB cap). */
export interface SocketAttachment {
  readonly userId: string;
  readonly workspaceId: string;
  readonly sessionId: string | null;
  /** Epoch milliseconds. The client re-tickets every 4 minutes. */
  readonly authorizedUntil: number;
}

/** The header the Worker hands the attachment across on the upgrade request. */
export const ATTACHMENT_HEADER = 'x-hermes-attachment';

export interface PublishResult {
  readonly delivered: number;
  readonly lastId: string | null;
}

export interface HubEvent {
  readonly id: string;
  readonly session_id: string | null;
  readonly kind: string;
  /** Delivery-only request audience. Removed before the browser sees it. */
  readonly audience_user_ids?: readonly string[];
  readonly [extra: string]: unknown;
}

function clientEvent(event: HubEvent): Omit<HubEvent, 'audience_user_ids'> {
  const { audience_user_ids: _audience, ...visible } = event;
  return visible;
}

abstract class Hub<T extends Env = Env> extends DurableObject<T> {
  constructor(ctx: DurableObjectState, env: T) {
    super(ctx, env);
    // Browsers cannot send protocol ping frames, and any data message wakes a
    // hibernating object and bills duration. The auto-response pair answers
    // "ping" with "pong" without waking anything.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /**
   * The upgrade itself. The Worker has already decided that this person may
   * listen here; the attachment is that decision, and the hub's only job is to
   * hold it and honour its expiry.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a websocket upgrade', { status: 426 });
    }
    const raw = request.headers.get(ATTACHMENT_HEADER);
    if (!raw) return new Response('no attachment', { status: 400 });

    let attachment: SocketAttachment;
    try {
      attachment = JSON.parse(raw) as SocketAttachment;
    } catch {
      return new Response('bad attachment', { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Fan out committed events. The publisher is the request or Workflow step
   * that just committed them; it acknowledges by returning the last delivered
   * id, and a `publish` job re-runs this if the acknowledgement never arrived.
   */
  publish(events: readonly HubEvent[]): PublishResult {
    const now = Date.now();
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) continue;
      if (attachment.authorizedUntil <= now) {
        socket.close(4401, 'authorization expired');
        continue;
      }
      const visible = events.filter((e) => this.maySee(attachment, e));
      if (visible.length === 0) continue;
      socket.send(JSON.stringify({ type: 'events', events: visible.map(clientEvent) }));
      delivered += visible.length;
    }
    return { delivered, lastId: events.at(-1)?.id ?? null };
  }

  /** Fan out a non-durable frame through the same authorization boundary. */
  protected publishTransient(sessionId: string, frame: MessagePreviewFrame): PublishResult {
    const now = Date.now();
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) continue;
      if (attachment.authorizedUntil <= now) {
        socket.close(4401, 'authorization expired');
        continue;
      }
      if (!this.maySee(attachment, { id: 'transient', kind: 'message.preview', session_id: sessionId })) continue;
      socket.send(JSON.stringify(frame));
      delivered += 1;
    }
    return { delivered, lastId: null };
  }

  /** Close every socket belonging to a user whose access was removed. */
  evict(userId: string): number {
    let closed = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.userId !== userId) continue;
      socket.close(4403, 'access revoked');
      closed += 1;
    }
    return closed;
  }

  /** Extend a socket's window after the client presents a fresh ticket. */
  extend(userId: string, authorizedUntil: number): number {
    let extended = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment || attachment.userId !== userId) continue;
      socket.serializeAttachment({ ...attachment, authorizedUntil });
      extended += 1;
    }
    return extended;
  }

  /** Used by `/health`: a round trip that proves the namespace is reachable. */
  ping(): { ok: true; sockets: number } {
    return { ok: true, sockets: this.ctx.getWebSockets().length };
  }

  /**
   * A client's own message. There is exactly one it may send — a ticket — and
   * anything else closes the socket.
   *
   * The reason a hub accepts a ticket at all is that it cannot ask a database
   * whether the person is still a member, and a socket that lived as long as
   * the browser tab would outlive a removal by hours. So authorisation is a
   * window the Worker keeps renewing, and silence closes it.
   */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let parsed: { type?: string; ticket?: string };
    try {
      parsed = JSON.parse(message) as { type?: string; ticket?: string };
    } catch {
      return;
    }
    if (parsed.type !== 'ticket' || !parsed.ticket) return;

    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) {
      ws.close(4401, 'no attachment');
      return;
    }
    const ticket = await verifyHubTicket(this.env, parsed.ticket);
    const matches =
      ticket !== null &&
      ticket.user_id === attachment.userId &&
      ticket.workspace_id === attachment.workspaceId &&
      (attachment.sessionId === null || ticket.session_id === null || ticket.session_id === attachment.sessionId);
    if (!matches) {
      ws.close(4401, 'ticket rejected');
      return;
    }
    const authorizedUntil = ticket.exp * 1000;
    ws.serializeAttachment({ ...attachment, authorizedUntil });
    ws.send(JSON.stringify({ type: 'ticket.accepted', authorized_until: authorizedUntil }));
  }

  protected abstract maySee(attachment: SocketAttachment, event: HubEvent): boolean;

  override webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    void code;
    void reason;
    void wasClean;
    ws.close();
  }
}

/**
 * One object per session. Carries `message.*` and `run.*` to the session's
 * owner and to holders of a share on it.
 */
export class SessionHub extends Hub {
  protected override maySee(attachment: SocketAttachment, event: HubEvent): boolean {
    return attachment.sessionId !== null && attachment.sessionId === event.session_id;
  }

  /**
   * Stop, recorded where the engine will look for it.
   *
   * The run engine (M3) polls this between steps: the request that asked for a
   * Stop has already written `runs.stop_requested`, and this is the copy the
   * Workflow can read without a database round trip inside a step. The hub is
   * still not truth — the row is — this is a cache with one reader.
   */
  async requestStop(runId: string): Promise<void> {
    await this.ctx.storage.put(`stop:${runId}`, Date.now());
  }

  async stopRequested(runId: string): Promise<boolean> {
    return (await this.ctx.storage.get<number>(`stop:${runId}`)) !== undefined;
  }

  /**
   * Paint assistant text before its durable checkpoint finishes.
   *
   * This frame is intentionally absent from replay and has no stream id. A
   * reconnect falls back to committed `message.delta` rows, while the client
   * uses `offset` to reconcile an overlapping preview without duplicating it.
   */
  preview(frame: MessagePreviewFrame): PublishResult {
    return this.publishTransient(frame.session_id, frame);
  }

  /**
   * Fan out a delta batch and answer with Stop in the same round trip.
   *
   * The engine calls this once per durable batch. Riding Stop on the reply is
   * what keeps the subrequest budget in range: a separate poll would double the
   * per-batch cost.
   */
  async forward(runId: string, events: readonly HubEvent[]): Promise<PublishResult & { stop_requested: boolean }> {
    const result = this.publish(events);
    return { ...result, stop_requested: await this.stopRequested(runId) };
  }
}

/**
 * One object per workspace. Carries `request.created`, `decision.recorded` and
 * `entity.updated` to every member.
 */
export class WorkspaceHub extends Hub {
  protected override maySee(attachment: SocketAttachment, event: HubEvent): boolean {
    return event.audience_user_ids === undefined || event.audience_user_ids.includes(attachment.userId);
  }
}
