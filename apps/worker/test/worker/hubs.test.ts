// The hubs in the runtime they actually run in.
//
// The Node project can prove the fan-out rule against fake sockets; only
// workerd can prove that `acceptWebSocket` and the auto-response heartbeat are
// real, that an attachment survives the hop into a Durable Object, and that the
// upgrade answers 101 — which Node's own `Response` cannot even construct.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const ATTACHMENT_HEADER = 'x-hermes-attachment';

const attachment = (sessionId: string): string =>
  JSON.stringify({
    userId: '00000000-0000-4000-8000-00000000000a',
    workspaceId: '00000000-0000-4000-8000-00000000000b',
    sessionId,
    authorizedUntil: Date.now() + 600_000,
  });

const upgrade = (sessionId: string): Request =>
  new Request('https://hub.hermes.internal/socket', {
    headers: { upgrade: 'websocket', [ATTACHMENT_HEADER]: attachment(sessionId) },
  });

describe('a hub in workerd', () => {
  it('accepts an authorised upgrade and answers 101 with a socket', async () => {
    const stub = env.SESSION_HUB.get(env.SESSION_HUB.idFromName('session-1'));
    const response = await stub.fetch(upgrade('session-1'));

    expect(response.status).toBe(101);
    expect(response.webSocket).not.toBeNull();
    response.webSocket?.accept();
    response.webSocket?.close();
  });

  it('refuses an upgrade with no attachment, because the Worker owes it one', async () => {
    const stub = env.SESSION_HUB.get(env.SESSION_HUB.idFromName('session-2'));
    const response = await stub.fetch(
      new Request('https://hub.hermes.internal/socket', { headers: { upgrade: 'websocket' } }),
    );
    expect(response.status).toBe(400);
  });

  it('delivers a committed event to the socket that is allowed to see it', async () => {
    const stub = env.SESSION_HUB.get(env.SESSION_HUB.idFromName('session-3'));
    const opened = await stub.fetch(upgrade('session-3'));
    const socket = opened.webSocket;
    expect(socket).not.toBeNull();
    socket?.accept();

    const delivered = new Promise<string>((resolve) => {
      socket?.addEventListener('message', (message: MessageEvent) => resolve(String(message.data)));
    });
    const result = await stub.publish([{ id: '7', session_id: 'session-3', kind: 'message.delta' }]);

    expect(result.delivered).toBe(1);
    expect(JSON.parse(await delivered)).toMatchObject({ type: 'events' });
    socket?.close();
  });

  it('holds a stop for the engine to read back', async () => {
    const stub = env.SESSION_HUB.get(env.SESSION_HUB.idFromName('session-4'));
    await stub.requestStop('run-1');
    expect(await stub.stopRequested('run-1')).toBe(true);
    expect(await stub.stopRequested('run-2')).toBe(false);
  });
});
