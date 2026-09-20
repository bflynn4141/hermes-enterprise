// What a hub delivers, and to whom.
//
// These run in Node against fake sockets rather than in workerd, because what
// is under test is the fan-out rule — which socket sees which event — and that
// is ordinary logic. The workerd project proves the class boots with the real
// Durable Object runtime; this proves it never hands one person's conversation
// to another.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { mintHubTicket, verifyHubTicket } from '../../src/auth/tickets.js';

// The Durable Object constructor asks for these two globals; Node has neither.
class FakePair {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
}
(globalThis as { WebSocketRequestResponsePair?: unknown }).WebSocketRequestResponsePair = FakePair;

const env = { ENVIRONMENT: 'test', AUTH_MODE: 'fake', HUB_TICKET_SECRET: 'unit-test-secret' } as unknown as Env;

interface FakeSocket {
  attachment: unknown;
  sent: string[];
  closed: { code: number; reason: string } | null;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
  send(message: string): void;
  close(code: number, reason: string): void;
}

function socket(attachment: unknown): FakeSocket {
  return {
    attachment,
    sent: [],
    closed: null,
    serializeAttachment(value) {
      this.attachment = value;
    },
    deserializeAttachment() {
      return this.attachment;
    },
    send(message) {
      this.sent.push(message);
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
  };
}

function hubContext(sockets: FakeSocket[]): DurableObjectState {
  const storage = new Map<string, unknown>();
  return {
    getWebSockets: () => sockets,
    acceptWebSocket: () => undefined,
    setWebSocketAutoResponse: () => undefined,
    storage: {
      put: (key: string, value: unknown) => {
        storage.set(key, value);
        return Promise.resolve();
      },
      get: (key: string) => Promise.resolve(storage.get(key)),
    },
  } as unknown as DurableObjectState;
}

const attachment = (userId: string, sessionId: string | null, minutes = 10): unknown => ({
  userId,
  workspaceId: 'ws-1',
  sessionId,
  authorizedUntil: Date.now() + minutes * 60_000,
});

const event = (id: string, sessionId: string | null): { id: string; session_id: string | null; kind: string } => ({
  id,
  session_id: sessionId,
  kind: 'message.delta',
});

let SessionHub: typeof import('../../src/hubs.js').SessionHub;
let WorkspaceHub: typeof import('../../src/hubs.js').WorkspaceHub;

beforeAll(async () => {
  ({ SessionHub, WorkspaceHub } = await import('../../src/hubs.js'));
});

describe('the session hub', () => {
  it('never delivers one session’s delta to another session’s socket', () => {
    const mine = socket(attachment('user-a', 'session-a'));
    const theirs = socket(attachment('user-b', 'session-b'));
    const hub = new SessionHub(hubContext([mine, theirs]), env);

    const result = hub.publish([event('11', 'session-a')]);

    expect(result.delivered).toBe(1);
    expect(mine.sent).toHaveLength(1);
    expect(theirs.sent).toHaveLength(0);
  });

  it('keeps a transient preview inside its session and outside the replay stream', () => {
    const mine = socket(attachment('user-a', 'session-a'));
    const theirs = socket(attachment('user-b', 'session-b'));
    const hub = new SessionHub(hubContext([mine, theirs]), env);

    const result = hub.preview({
      type: 'message.preview',
      session_id: 'session-a',
      run_id: 'run-a',
      turn: 0,
      attempt: 1,
      step_attempt: 1,
      offset: 0,
      delta: 'Visible now',
    });

    expect(result).toEqual({ delivered: 1, lastId: null });
    expect(JSON.parse(mine.sent[0]!)).toMatchObject({ type: 'message.preview', offset: 0, delta: 'Visible now' });
    expect(theirs.sent).toHaveLength(0);
  });

  it('closes a socket whose authorization window has passed instead of delivering to it', () => {
    const stale = socket(attachment('user-a', 'session-a', -1));
    const hub = new SessionHub(hubContext([stale]), env);

    hub.publish([event('12', 'session-a')]);

    expect(stale.sent).toHaveLength(0);
    expect(stale.closed?.code).toBe(4401);
  });

  it('evicts one user’s sockets and leaves everyone else connected', () => {
    const removed = socket(attachment('user-a', 'session-a'));
    const other = socket(attachment('user-b', 'session-a'));
    const hub = new SessionHub(hubContext([removed, other]), env);

    expect(hub.evict('user-a')).toBe(1);
    expect(removed.closed?.code).toBe(4403);
    expect(other.closed).toBeNull();
  });

  it('extends a window against a valid ticket and closes the socket against a forged one', async () => {
    const live = socket(attachment('user-a', 'session-a', 1));
    const hub = new SessionHub(hubContext([live]), env);
    const { ticket, expiresAt } = await mintHubTicket(env, {
      userId: 'user-a',
      workspaceId: 'ws-1',
      sessionId: 'session-a',
    });

    await hub.webSocketMessage(live as unknown as WebSocket, JSON.stringify({ type: 'ticket', ticket }));
    expect((live.attachment as { authorizedUntil: number }).authorizedUntil).toBe(
      Math.floor(expiresAt.getTime() / 1000) * 1000,
    );
    expect(live.closed).toBeNull();

    await hub.webSocketMessage(
      live as unknown as WebSocket,
      JSON.stringify({ type: 'ticket', ticket: `${ticket}tampered` }),
    );
    expect(live.closed?.code).toBe(4401);
  });

  it('records a stop for the engine to read without touching Postgres', async () => {
    const hub = new SessionHub(hubContext([]), env);
    expect(await hub.stopRequested('run-1')).toBe(false);
    await hub.requestStop('run-1');
    expect(await hub.stopRequested('run-1')).toBe(true);
  });
});

describe('the workspace hub', () => {
  it('delivers a workspace event to every authorised socket', () => {
    const one = socket(attachment('user-a', null));
    const two = socket(attachment('user-b', null));
    const hub = new WorkspaceHub(hubContext([one, two]), env);

    expect(hub.publish([event('20', null)]).delivered).toBe(2);
  });

  it('delivers an audience-scoped workspace event only to the named human and removes delivery metadata', () => {
    const finance = socket(attachment('user-finance', null));
    const admin = socket(attachment('user-admin', null));
    const hub = new WorkspaceHub(hubContext([finance, admin]), env);
    const scoped = { ...event('21', null), audience_user_ids: ['user-finance'] };

    expect(hub.publish([scoped]).delivered).toBe(1);
    expect(admin.sent).toHaveLength(0);
    const delivered = JSON.parse(finance.sent[0]!) as { events: Record<string, unknown>[] };
    expect(delivered.events[0]).not.toHaveProperty('audience_user_ids');
  });

  it('delivers an explicitly scoped event with no active audience to nobody', () => {
    const formerFinance = socket(attachment('user-finance', null));
    const admin = socket(attachment('user-admin', null));
    const hub = new WorkspaceHub(hubContext([formerFinance, admin]), env);
    const scoped = { ...event('22', null), audience_user_ids: [] };

    expect(hub.publish([scoped]).delivered).toBe(0);
    expect(formerFinance.sent).toHaveLength(0);
    expect(admin.sent).toHaveLength(0);
  });
});

describe('hub tickets', () => {
  it('round-trips the claims it was minted with', async () => {
    const { ticket } = await mintHubTicket(env, { userId: 'user-a', workspaceId: 'ws-1' });
    const claims = await verifyHubTicket(env, ticket);
    expect(claims).toMatchObject({ user_id: 'user-a', workspace_id: 'ws-1', session_id: null });
  });

  it('refuses a ticket signed with a different secret', async () => {
    const { ticket } = await mintHubTicket({ ...env, HUB_TICKET_SECRET: 'other' } as Env, {
      userId: 'user-a',
      workspaceId: 'ws-1',
    });
    expect(await verifyHubTicket(env, ticket)).toBeNull();
  });

  it('refuses an expired ticket', async () => {
    const { ticket } = await mintHubTicket(env, { userId: 'user-a', workspaceId: 'ws-1' }, -1);
    expect(await verifyHubTicket(env, ticket)).toBeNull();
  });
});
