// The real transport is exercised against the pinned native Runs API wire
// format. Response bodies and transport errors must not expose credentials.
import { describe, expect, it, vi } from 'vitest';
import { HermesApiError, HermesCapabilitiesError, HermesClient, terminalHermesStatus } from '../../src/runtime/client.js';

const RUN_ID = 'run_native-123';
const SECRET = 'runtime-secret-that-must-stay-server-side';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const capabilities = (durable = true) => ({
  object: 'hermes.api_server.capabilities',
  platform: 'hermes-agent',
  auth: { type: 'bearer', required: true },
  runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
  features: {
    run_submission: true,
    run_status: true,
    run_events_sse: true,
    run_stop: true,
    run_steer: true,
    runs_idempotency: { supported: true, durable, retention_seconds: 86_400 },
  },
  endpoints: {
    runs: { method: 'POST', path: '/v1/runs' },
    run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
    run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
    run_steer: { method: 'POST', path: '/v1/runs/{run_id}/steer' },
    run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
  },
});

function transport(response: () => Response) {
  const send = vi.fn<typeof fetch>(async () => response());
  return { send, client: new HermesClient('https://runtime.example/', SECRET, send) };
}

function connectorTransport(response: () => Response) {
  const send = vi.fn<typeof fetch>(async () => response());
  return {
    send,
    client: new HermesClient(
      'https://iris.example/api/plugins/enterprise_bridge/control',
      SECRET,
      send,
      'dashboard_connector',
    ),
  };
}

describe('official Hermes Runs transport', () => {
  it('reads the Enterprise and AgentCash readiness attestation through the fixed connector', async () => {
    const { client } = connectorTransport(() => json({
      object: 'hermes.enterprise_bridge.readiness', version: '1.4.0',
      workspace_id: '11111111-1111-4111-8111-111111111111',
      agent_id: '22222222-2222-4222-8222-222222222222',
      enterprise_url: 'https://staging.example', agentcash_enabled: true,
      agentcash_wallet_present: true, native_cron_disabled: true,
    }));
    await expect(client.enterpriseReadiness()).resolves.toMatchObject({
      version: '1.4.0', agentCashEnabled: true, agentCashWalletPresent: true, nativeCronDisabled: true,
    });
  });

  it('uses one fixed service-authenticated route for a Hermes Cloud connector', async () => {
    const { client, send } = connectorTransport(() => json(capabilities()));
    await expect(client.capabilities()).resolves.toEqual({ durableIdempotency: true, retentionSeconds: 86_400 });
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://iris.example/api/plugins/enterprise_bridge/control');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(JSON.parse(String(init?.body))).toEqual({ operation: 'capabilities' });
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${SECRET}`);
  });

  it('uses the authenticated POST operation that the dashboard edge streams without compression', async () => {
    const event = { event: 'message.delta', run_id: RUN_ID, delta: 'First' };
    const { client, send } = connectorTransport(() => new Response(`: enterprise-bridge-connected\n\ndata: ${JSON.stringify(event)}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
    const controller = new AbortController();
    const received = [];
    for await (const item of client.events(RUN_ID, controller.signal)) received.push(item);
    expect(received).toEqual([event]);
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://iris.example/api/plugins/enterprise_bridge/control');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ operation: 'events', run_id: RUN_ID });
    expect(init?.signal).toBe(controller.signal);
    expect(new Headers(init?.headers).get('Accept')).toBe('text/event-stream');
    expect(new Headers(init?.headers).get('Accept-Encoding')).toBe('identity');
    expect(new Headers(init?.headers).get('Cache-Control')).toBe('no-cache');
  });

  it('wraps Cloud submit and control operations without exposing a generic proxy', async () => {
    const responses = [
      json({ run_id: RUN_ID, status: 'started' }, 202),
      json({ run_id: RUN_ID, status: 'completed', output: 'Reviewed.' }),
      json({ run_id: RUN_ID, status: 'stopping' }),
    ];
    const { client, send } = connectorTransport(() => responses.shift()!);
    await expect(client.submit({ input: 'Review.', _enterprise_tool_names: ['list_requests'] }, 'stable-key')).resolves.toBe(RUN_ID);
    await expect(client.status(RUN_ID)).resolves.toMatchObject({ status: 'completed' });
    await expect(client.stop(RUN_ID)).resolves.toBeUndefined();
    expect(send.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { operation: 'submit', idempotency_key: 'stable-key', body: { input: 'Review.' } },
      { operation: 'status', run_id: RUN_ID },
      { operation: 'stop', run_id: RUN_ID },
    ]);
    expect(send.mock.calls.every(([url]) => url === 'https://iris.example/api/plugins/enterprise_bridge/control')).toBe(true);
  });

  it('requires the authenticated server-agent Runs contract and durable reservations', async () => {
    const { client, send } = transport(() => json(capabilities()));
    await expect(client.capabilities()).resolves.toEqual({ durableIdempotency: true, retentionSeconds: 86_400 });
    expect(send.mock.calls[0]?.[0]).toBe('https://runtime.example/v1/capabilities');
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(`Bearer ${SECRET}`);
  });

  it.each([
    ['non-durable reservations', (() => capabilities(false))()],
    ['missing run status endpoint', (() => { const value = capabilities(); delete (value.endpoints as Record<string, unknown>).run_status; return value; })()],
    ['split client execution', (() => { const value = capabilities(); value.runtime.split_runtime = true; return value; })()],
  ])('rejects %s before native admission', async (_label, body) => {
    const { client } = transport(() => json(body));
    await expect(client.capabilities()).rejects.toEqual(new HermesCapabilitiesError());
  });

  it('submits one authenticated request with the durable idempotency key and no redirect forwarding', async () => {
    const { client, send } = transport(() => json({ run_id: RUN_ID, status: 'started' }, 202));
    const body = {
      input: 'Review this application.', session_id: 'session-1', provider: 'custom',
      _enterprise_tool_names: ['propose_request'],
      _enterprise_skills: [{ name: 'enterprise_bridge:partner-program-screening', version: '1.1.0' }],
      _enterprise_turn_author: { id: 'bot:agent-partnerships', name: 'Iris', is_bot: true },
    };
    expect(await client.submit(body, 'enterprise-local-a1')).toBe(RUN_ID);
    expect(send).toHaveBeenCalledOnce();
    const [url, init] = send.mock.calls[0]!;
    expect(url).toBe('https://runtime.example/v1/runs');
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${SECRET}`);
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('enterprise-local-a1');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      input: 'Review this application.', session_id: 'session-1', provider: 'custom',
      turn_author: { id: 'bot:agent-partnerships', name: 'Iris', is_bot: true },
    });
    expect(String(init?.body)).not.toContain(SECRET);
  });

  it('rejects malformed internal bot attribution before contacting Hermes', async () => {
    const { client, send } = transport(() => json({ run_id: RUN_ID, status: 'started' }, 202));
    await expect(client.submit({
      input: 'Review.',
      _enterprise_turn_author: { id: 'human:someone', name: 'Iris', is_bot: true },
    }, 'stable-key')).rejects.toThrow('invalid enterprise turn author');
    expect(send).not.toHaveBeenCalled();
  });

  it.each([{}, { run_id: '' }, { run_id: 42 }, { run_id: '../another/run' }])(
    'rejects a malformed native run id: %j', async (body) => {
      const { client } = transport(() => json(body));
      await expect(client.submit({}, 'stable-key')).rejects.toThrow('invalid run id');
    },
  );

  it('reads authoritative terminal output and usage without a stream subscription', async () => {
    const status = { run_id: RUN_ID, status: 'completed', output: 'Reviewed.', usage: { input_tokens: 30, output_tokens: 4 } };
    const { client, send } = transport(() => json(status));
    expect(await client.status(RUN_ID)).toEqual(status);
    expect(send.mock.calls[0]?.[0]).toBe(`https://runtime.example/v1/runs/${RUN_ID}`);
  });

  it.each([{ run_id: 'run_other', status: 'completed' }, { run_id: RUN_ID, status: null }])(
    'rejects a status response that does not belong to this run: %j', async (body) => {
      const { client } = transport(() => json(body));
      await expect(client.status(RUN_ID)).rejects.toThrow('invalid run status');
    },
  );

  it('parses native data.event across byte chunks and ignores SSE keepalives', async () => {
    const events = [
      { event: 'message.delta', run_id: RUN_ID, delta: 'Résumé ' },
      { event: 'message.delta', run_id: RUN_ID, delta: 'reviewed.' },
      { event: 'run.completed', run_id: RUN_ID, output: 'Résumé reviewed.' },
    ];
    const wire = `: heartbeat\r\n\r\n${events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('')}data: [DONE]\n\n`;
    const bytes = new TextEncoder().encode(wire);
    const { client, send } = transport(() => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } }));
    const controller = new AbortController();
    const received = [];
    for await (const event of client.events(RUN_ID, controller.signal)) received.push(event);
    expect(received).toEqual(events);
    expect(send.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(new Headers(send.mock.calls[0]?.[1]?.headers).has('Last-Event-ID')).toBe(false);
  });

  it('refuses an event for another run before exposing its contents', async () => {
    const { client } = transport(() => new Response(`data: ${JSON.stringify({ event: 'message.delta', run_id: 'run_other', delta: SECRET })}\n\n`));
    const next = client.events(RUN_ID, new AbortController().signal).next();
    await expect(next).rejects.toThrow('unrelated run event');
    await expect(next).rejects.not.toThrow(SECRET);
  });

  it('treats a native steer conflict as queued guidance, while surfacing other failures safely', async () => {
    const conflict = transport(() => json({ error: SECRET }, 409));
    expect(await conflict.client.steer(RUN_ID, 'Focus on references.')).toBe(false);
    expect(JSON.parse(String(conflict.send.mock.calls[0]?.[1]?.body))).toEqual({ input: 'Focus on references.' });
    const forbidden = transport(() => json({ error: SECRET }, 403));
    await expect(forbidden.client.steer(RUN_ID, 'Focus on references.')).rejects.toEqual(new HermesApiError(403, 'steer'));
  });

  it('posts Stop without treating the request acknowledgment as the final native status', async () => {
    const { client, send } = transport(() => json({ run_id: RUN_ID, status: 'stopping' }));
    await expect(client.stop(RUN_ID)).resolves.toBeUndefined();
    expect(send.mock.calls[0]?.[0]).toBe(`https://runtime.example/v1/runs/${RUN_ID}/stop`);
    expect(send.mock.calls[0]?.[1]?.method).toBe('POST');
    expect(terminalHermesStatus('stopping')).toBe(false);
    expect(terminalHermesStatus('cancelled')).toBe(true);
  });

  it('discards an upstream error body instead of including it in an exception', async () => {
    const { client } = transport(() => json({ error: `Authorization: Bearer ${SECRET}` }, 503));
    const failure = client.status(RUN_ID);
    await expect(failure).rejects.toEqual(new HermesApiError(503, 'request'));
    await expect(failure).rejects.not.toThrow(SECRET);
  });

  it.each([301, 302, 307, 308])('rejects a %s redirect without forwarding the bearer token', async (status) => {
    const { client, send } = transport(() => new Response('upstream redirect', {
      status, headers: { Location: 'https://another-host.example/capture' },
    }));
    await expect(client.status(RUN_ID)).rejects.toEqual(new HermesApiError(status, 'request'));
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0]).toBe(`https://runtime.example/v1/runs/${RUN_ID}`);
    expect(send.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it.each(['completed', 'failed', 'cancelled', 'interrupted'])('recognizes %s as terminal', (status) => {
    expect(terminalHermesStatus(status)).toBe(true);
  });
});
