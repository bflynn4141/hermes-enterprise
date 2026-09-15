// The two push hubs.
//
// A hub holds sockets and nothing authoritative. It never opens a database
// connection. If a hub is evicted, restarted or deployed over, the only cost is
// a reconnect: the client replays from `stream_events` over HTTP and carries
// on. That is what makes "a connected client cannot miss a committed event" a
// property of the outbox rather than a property of a Durable Object staying
// alive.
//
// Authorisation happens in the Worker before the upgrade: it checks the sealed
// cookie, the Origin, and membership or share, then puts the result in the
// socket attachment. The hub only enforces the expiry it was handed.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';

/** What the Worker stamps on a socket at upgrade time (16 KB cap). */
export interface SocketAttachment {
  readonly userId: string;
  readonly workspaceId: string;
  readonly sessionId: string | null;
  /** Epoch milliseconds. The client re-tickets every 4 minutes. */
  readonly authorizedUntil: number;
}

export interface PublishResult {
  readonly delivered: number;
  readonly lastId: string | null;
}

abstract class Hub<T extends Env = Env> extends DurableObject<T> {
  constructor(ctx: DurableObjectState, env: T) {
    super(ctx, env);
    // Browsers cannot send protocol ping frames, and any data message wakes a
    // hibernating object and bills duration. The auto-response pair answers
    // "ping" with "pong" without waking anything.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  /** Accept an already-authorised socket. Called only by the Worker. */
  accept(server: WebSocket, attachment: SocketAttachment): void {
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
  }

  /**
   * Fan out committed events. The publisher is the request or Workflow step
   * that just committed them; it acknowledges by returning the last delivered
   * id, and a `publish` job re-runs this if the acknowledgement never arrived.
   */
  publish(events: readonly { id: string; session_id: string | null; kind: string }[]): PublishResult {
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
      socket.send(JSON.stringify({ type: 'events', events: visible }));
      delivered += visible.length;
    }
    return { delivered, lastId: events.at(-1)?.id ?? null };
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

  protected abstract maySee(attachment: SocketAttachment, event: { session_id: string | null }): boolean;

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
  protected override maySee(attachment: SocketAttachment, event: { session_id: string | null }): boolean {
    return attachment.sessionId !== null && attachment.sessionId === event.session_id;
  }
}

/**
 * One object per workspace. Carries `request.created`, `decision.recorded` and
 * `entity.updated` to every member.
 */
export class WorkspaceHub extends Hub {
  protected override maySee(): boolean {
    return true;
  }
}
