// The three real adapters, against recorded frames and a mocked fetch.
//
// Never the network. A test that reached api.anthropic.com would need a real
// key, would fail during someone else's incident, and could not express "the
// stream tore at 40 percent" at all — which is the case that matters most.
//
// The frames below are the shapes the vendor documentation describes for each
// transport. What is being tested is our half: that a signed thinking block is
// carried and replayed byte for byte, that `reasoning_content` goes back
// verbatim, that `store: false` and encrypted reasoning are actually sent, that
// a tool call split across frames is reassembled, and that a status maps to the
// failure class the plan's table says it does.
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../../src/model/anthropic.js';
import { DeepSeekProvider } from '../../src/model/deepseek.js';
import { OpenAiProvider } from '../../src/model/openai.js';
import { classifyStatus } from '../../src/model/http.js';
import { defaultFetch, ProviderError, type Credential, type ProviderEvent, type StreamRequest } from '../../src/model/types.js';

const credential: Credential = {
  provider: 'test',
  apiKey: ['sk', 'test', 'NOTAREALKEY0000000000'].join('-'),
  keyId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
};

/**
 * An SSE response whose frames are split across chunk boundaries at a fixed
 * stride, so the parser's buffering is exercised rather than assumed.
 */
function sseResponse(frames: readonly string[], chunkSize = 7, status = 200): Response {
  const text = frames.map((f) => `${f}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

const dataFrame = (event: string, payload: unknown): string =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}`;

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function recorder(response: () => Response): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(response());
    },
  };
}

const body = (call: Captured): Record<string, unknown> =>
  JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const baseRequest = (overrides: Partial<StreamRequest> = {}): StreamRequest => ({
  model: 'test-model',
  system: 'You are Iris.',
  messages: [{ role: 'user', content: 'Screen this application.' }],
  tools: [],
  effort: null,
  effortMap: null,
  credential,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

const ANTHROPIC_THINKING_STREAM = [
  dataFrame('message_start', { type: 'message_start', message: { usage: { input_tokens: 1200 } } }),
  dataFrame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
  dataFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'Three references, ' },
  }),
  dataFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'signature_delta', signature: 'SIGNATURE-FROM-THE-PROVIDER' },
  }),
  dataFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  dataFrame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
  dataFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'text_delta', text: 'Proposing an admission.' },
  }),
  dataFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
  dataFrame('content_block_start', {
    type: 'content_block_start',
    index: 2,
    content_block: { type: 'tool_use', id: 'toolu_1', name: 'propose_request' },
  }),
  dataFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '{"kind":' },
  }),
  dataFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 2,
    delta: { type: 'input_json_delta', partial_json: '"application"}' },
  }),
  dataFrame('content_block_stop', { type: 'content_block_stop', index: 2 }),
  dataFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 240, input_tokens: 1200, cache_read_input_tokens: 800 },
  }),
];

describe('the Anthropic adapter', () => {
  it('streams text, reassembles a split tool call, and reports usage', async () => {
    const mock = recorder(() => sseResponse(ANTHROPIC_THINKING_STREAM));
    const events = await collect(new AnthropicProvider({ fetch: mock.fetch }).stream(baseRequest()));

    const text = events.filter((e) => e.type === 'text_delta').map((e) => e.text).join('');
    expect(text).toBe('Proposing an admission.');

    const call = events.find((e) => e.type === 'tool_call');
    expect(call).toEqual({
      type: 'tool_call',
      call: { id: 'toolu_1', name: 'propose_request', arguments: '{"kind":"application"}' },
    });

    expect(events.at(-2)).toEqual({
      type: 'usage',
      usage: { input_tokens: 1200, output_tokens: 240, cached_input_tokens: 800, reasoning_tokens: 0 },
    });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('carries the signed thinking block and replays it byte for byte', async () => {
    const mock = recorder(() => sseResponse(ANTHROPIC_THINKING_STREAM));
    const events = await collect(new AnthropicProvider({ fetch: mock.fetch }).stream(baseRequest()));

    const reasoning = events.find((e) => e.type === 'reasoning');
    expect(reasoning?.carry).toEqual({
      kind: 'anthropic_thinking',
      blocks: [{ type: 'thinking', thinking: 'Three references, ', signature: 'SIGNATURE-FROM-THE-PROVIDER' }],
    });

    // Second turn: the carry goes back unchanged, signature included. This is
    // the assertion that catches a "tidy up the transcript" refactor.
    const replay = recorder(() => sseResponse([dataFrame('message_delta', { type: 'message_delta', delta: {} })]));
    await collect(
      new AnthropicProvider({ fetch: replay.fetch }).stream(
        baseRequest({
          messages: [
            { role: 'user', content: 'Screen this application.' },
            { role: 'assistant', content: 'Proposing an admission.', reasoning: reasoning?.carry },
            { role: 'user', content: 'And the second one?' },
          ],
        }),
      ),
    );

    const sent = body(replay.calls[0] as Captured);
    const assistant = (sent.messages as { role: string; content: unknown[] }[])[1];
    expect(assistant?.content?.[0]).toEqual({
      type: 'thinking',
      thinking: 'Three references, ',
      signature: 'SIGNATURE-FROM-THE-PROVIDER',
    });
  });

  it('maps effort to a thinking budget through the catalog effort map', async () => {
    const mock = recorder(() => sseResponse([dataFrame('message_delta', { type: 'message_delta', delta: {} })]));
    await collect(
      new AnthropicProvider({ fetch: mock.fetch }).stream(
        baseRequest({ effort: 'high', effortMap: { low: 'low', high: 'high' } }),
      ),
    );
    expect(body(mock.calls[0] as Captured).thinking).toEqual({ type: 'enabled', budget_tokens: 16_384 });
  });

  it('refuses an effort the model does not offer rather than guessing one', async () => {
    const mock = recorder(() => sseResponse([]));
    const stream = new AnthropicProvider({ fetch: mock.fetch }).stream(
      baseRequest({ effort: 'max', effortMap: { low: 'low' } }),
    );
    await expect(collect(stream)).rejects.toThrow(/effort "max"/);
  });

  it('refuses to replay a carry another transport produced', async () => {
    const mock = recorder(() => sseResponse([]));
    const stream = new AnthropicProvider({ fetch: mock.fetch }).stream(
      baseRequest({
        messages: [
          { role: 'assistant', content: 'x', reasoning: { kind: 'deepseek_reasoning_content', content: 'y' } },
        ],
      }),
    );
    await expect(collect(stream)).rejects.toThrow(/cannot be replayed to Anthropic/);
  });

  it('reports a malformed tool argument as `malformed`, not as a crash', async () => {
    const mock = recorder(() =>
      sseResponse([
        dataFrame('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'propose_request' },
        }),
        dataFrame('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"kind": ' },
        }),
        dataFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
      ]),
    );
    const stream = new AnthropicProvider({ fetch: mock.fetch }).stream(baseRequest());
    await expect(collect(stream)).rejects.toMatchObject({ failure: 'malformed' });
  });

  it('sends the key as x-api-key and reads the model list on verification', async () => {
    const mock = recorder(() => new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6' }] }), { status: 200 }));
    const result = await new AnthropicProvider({ fetch: mock.fetch }).listModels(credential);

    expect(result).toEqual({ ok: true, models: ['claude-sonnet-4-6'] });
    const headers = (mock.calls[0] as Captured).init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(credential.apiKey);
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('treats a 403 on list-models as auth, which is what triggers the scoped probe', async () => {
    const mock = recorder(() => new Response('{}', { status: 403 }));
    await expect(new AnthropicProvider({ fetch: mock.fetch }).listModels(credential)).rejects.toMatchObject({
      failure: 'auth',
      status: 403,
    });
  });

  it('probes with a single token and calls a 400 a working key', async () => {
    const ok = recorder(() => new Response('{}', { status: 200 }));
    expect(await new AnthropicProvider({ fetch: ok.fetch }).probe(credential, 'claude-sonnet-4-6')).toBe(true);
    expect(body(ok.calls[0] as Captured).max_tokens).toBe(1);

    const rejected = recorder(() => new Response('{}', { status: 401 }));
    expect(await new AnthropicProvider({ fetch: rejected.fetch }).probe(credential, 'claude-sonnet-4-6')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DeepSeek
// ---------------------------------------------------------------------------

describe('the DeepSeek adapter', () => {
  const stream = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Checking ' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'the dates.' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Admitting.' } }] })}`,
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'propose_', arguments: '{"a":' } }] } }],
    })}`,
    `data: ${JSON.stringify({
      choices: [
        { delta: { tool_calls: [{ index: 0, function: { name: 'request', arguments: '1}' } }] }, finish_reason: 'tool_calls' },
      ],
    })}`,
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 900, completion_tokens: 120, prompt_cache_hit_tokens: 640, completion_tokens_details: { reasoning_tokens: 64 } },
    })}`,
    'data: [DONE]',
  ];

  it('streams reasoning and text, and reassembles a tool name split across frames', async () => {
    const mock = recorder(() => sseResponse(stream));
    const events = await collect(new DeepSeekProvider({ fetch: mock.fetch }).stream(baseRequest()));

    expect(events.filter((e) => e.type === 'reasoning_delta').map((e) => e.text).join('')).toBe('Checking the dates.');
    expect(events.find((e) => e.type === 'tool_call')?.call).toEqual({
      id: 'c1',
      name: 'propose_request',
      arguments: '{"a":1}',
    });
    expect(events.at(-2)).toEqual({
      type: 'usage',
      usage: { input_tokens: 900, output_tokens: 120, cached_input_tokens: 640, reasoning_tokens: 64 },
    });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('replays `reasoning_content` verbatim on the next turn', async () => {
    const mock = recorder(() => sseResponse(stream));
    const first = await collect(new DeepSeekProvider({ fetch: mock.fetch }).stream(baseRequest()));
    const carry = first.find((e) => e.type === 'reasoning')?.carry;
    expect(carry).toEqual({ kind: 'deepseek_reasoning_content', content: 'Checking the dates.' });

    const replay = recorder(() => sseResponse(['data: [DONE]']));
    await collect(
      new DeepSeekProvider({ fetch: replay.fetch }).stream(
        baseRequest({ messages: [{ role: 'assistant', content: 'Admitting.', reasoning: carry }] }),
      ),
    );
    const sent = body(replay.calls[0] as Captured);
    const assistant = (sent.messages as Record<string, unknown>[])[1];
    expect(assistant?.reasoning_content).toBe('Checking the dates.');
  });

  it('sends reasoning_effort and asks for usage in the stream', async () => {
    const mock = recorder(() => sseResponse(['data: [DONE]']));
    await collect(
      new DeepSeekProvider({ fetch: mock.fetch }).stream(
        baseRequest({ effort: 'high', effortMap: { low: 'low', high: 'high', max: 'max' } }),
      ),
    );
    const sent = body(mock.calls[0] as Captured);
    expect(sent.reasoning_effort).toBe('high');
    // Without this the final frame carries no usage and every cost estimate in
    // the workspace silently becomes zero.
    expect(sent.stream_options).toEqual({ include_usage: true });
  });

  it('sends the key as a bearer token', async () => {
    const mock = recorder(() => new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] }), { status: 200 }));
    await new DeepSeekProvider({ fetch: mock.fetch }).listModels(credential);
    const headers = (mock.calls[0] as Captured).init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${credential.apiKey}`);
  });
});

// ---------------------------------------------------------------------------
// OpenAI Responses
// ---------------------------------------------------------------------------

describe('the OpenAI Responses adapter', () => {
  const stream = [
    dataFrame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'Admitting. ' }),
    dataFrame('response.output_item.done', {
      type: 'response.output_item.done',
      item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENCRYPTED-BLOB' },
    }),
    dataFrame('response.output_item.done', {
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'fc_1', name: 'propose_request', arguments: '{"kind":"application"}' },
    }),
    dataFrame('response.completed', {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          input_tokens_details: { cached_tokens: 128 },
          output_tokens_details: { reasoning_tokens: 90 },
        },
      },
    }),
  ];

  it('never stores the conversation and always asks for encrypted reasoning', async () => {
    const mock = recorder(() => sseResponse(stream));
    await collect(
      new OpenAiProvider({ fetch: mock.fetch }).stream(baseRequest({ effort: 'high', effortMap: { high: 'high' } })),
    );

    const sent = body(mock.calls[0] as Captured);
    // The erasure inventory in section 6 depends on both of these being true.
    expect(sent.store).toBe(false);
    expect(sent.include).toEqual(['reasoning.encrypted_content']);
    expect(sent.reasoning).toEqual({ effort: 'high' });
  });

  it('carries encrypted reasoning and replays it as a reasoning item', async () => {
    const mock = recorder(() => sseResponse(stream));
    const events = await collect(new OpenAiProvider({ fetch: mock.fetch }).stream(baseRequest()));

    const carry = events.find((e) => e.type === 'reasoning')?.carry;
    expect(carry).toEqual({ kind: 'openai_encrypted', items: [{ id: 'rs_1', encrypted_content: 'ENCRYPTED-BLOB' }] });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });

    const replay = recorder(() => sseResponse([]));
    await collect(
      new OpenAiProvider({ fetch: replay.fetch }).stream(
        baseRequest({ messages: [{ role: 'assistant', content: 'Admitting.', reasoning: carry }] }),
      ),
    );
    const input = body(replay.calls[0] as Captured).input as Record<string, unknown>[];
    expect(input[0]).toEqual({ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'ENCRYPTED-BLOB' });
  });

  it('reports usage including reasoning tokens', async () => {
    const mock = recorder(() => sseResponse(stream));
    const events = await collect(new OpenAiProvider({ fetch: mock.fetch }).stream(baseRequest()));
    expect(events.at(-2)).toEqual({
      type: 'usage',
      usage: { input_tokens: 1000, output_tokens: 200, cached_input_tokens: 128, reasoning_tokens: 90 },
    });
  });

  it('renders a tool result as a function_call_output, not as a user message', async () => {
    const mock = recorder(() => sseResponse([]));
    await collect(
      new OpenAiProvider({ fetch: mock.fetch }).stream(
        baseRequest({ messages: [{ role: 'tool', tool_call_id: 'fc_1', content: '{"ok":true}' }] }),
      ),
    );
    const input = body(mock.calls[0] as Captured).input as Record<string, unknown>[];
    expect(input[0]).toEqual({ type: 'function_call_output', call_id: 'fc_1', output: '{"ok":true}' });
  });
});

// ---------------------------------------------------------------------------
// The status table from section 4
// ---------------------------------------------------------------------------

describe('failure classes', () => {
  it('follow the plan table', () => {
    expect(classifyStatus(401)).toBe('auth');
    expect(classifyStatus(403)).toBe('auth');
    expect(classifyStatus(429)).toBe('rate_limit');
    expect(classifyStatus(500)).toBe('transient');
    expect(classifyStatus(503)).toBe('transient');
    expect(classifyStatus(400)).toBe('permanent');
  });

  it('decide what the Workflow step retries', () => {
    expect(new ProviderError('x', 'transient').retryable).toBe(true);
    expect(new ProviderError('x', 'rate_limit').retryable).toBe(true);
    expect(new ProviderError('x', 'auth').retryable).toBe(false);
    expect(new ProviderError('x', 'malformed').retryable).toBe(false);
  });
});

describe('an aborted stream', () => {
  it('ends as `stopped` rather than as a failure', async () => {
    const controller = new AbortController();
    const mock = {
      fetch: (_url: string, _init?: RequestInit) => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      },
    };
    controller.abort();
    const events = await collect(
      new DeepSeekProvider({ fetch: mock.fetch }).stream(baseRequest({ signal: controller.signal })),
    );
    // Stop is a user action, not an incident: it must not look like an error to
    // the run log or to Sentry.
    expect(events).toEqual([{ type: 'stop', reason: 'stopped' }]);
  });
});


// ---------------------------------------------------------------------------
// The transport never follows a redirect
// ---------------------------------------------------------------------------

describe('defaultFetch', () => {
  it('asks for a manual redirect, so a 30x cannot replay the key elsewhere', async () => {
    // Every adapter puts the workspace's provider key in a header. workerd's
    // `fetch` does not implement the browser's rule about stripping
    // credentials on a cross-origin redirect, so with the default
    // `redirect: 'follow'` a 30x from a provider host — an open redirect on
    // it, or a hijacked resolution of it — replays a customer's key to
    // whatever the Location named. `security/fetch-url.ts` already uses
    // 'manual' for the same reason on the path that carries a URL; this is the
    // path that carries a credential.
    const seen: RequestInit[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: string, init?: RequestInit) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    try {
      await defaultFetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': 'never-sent-twice' },
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe('manual');
    // The caller's own init survives alongside it.
    expect(seen[0]?.method).toBe('POST');
  });
});
