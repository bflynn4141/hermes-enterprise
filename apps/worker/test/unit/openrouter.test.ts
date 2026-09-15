// The OpenRouter adapter and its catalog sync, against recorded fixtures.
//
// Never the network, for the reasons `providers.test.ts` gives, plus one more
// that is specific to this provider: OpenRouter's model list is several hundred
// rows that change weekly, so a test that fetched it would assert on a moving
// target and fail on a Tuesday for a reason nobody caused.
//
// The frames are the shapes the documentation describes:
//   https://openrouter.ai/docs/api-reference/streaming
//   https://openrouter.ai/docs/use-cases/reasoning-tokens
//   https://openrouter.ai/docs/api-reference/errors
import { describe, expect, it } from 'vitest';
import { openRouterCatalogId, openRouterModelId, vendorPrefix } from '@hermes/shared';
import {
  ATTRIBUTION_HEADERS,
  OpenRouterCreditsError,
  OpenRouterProvider,
  mergeReasoningDetails,
  openRouterError,
  toChatMessages,
} from '../../src/model/openrouter.js';
import { normaliseModels, perMillion } from '../../src/model/openrouter-catalog.js';
import { OPENROUTER_FIXTURE_MODELS, openRouterFixtureEnabled, openRouterFixtureFetch } from '../../src/model/openrouter-dev.js';
import { ProviderError, type Credential, type ProviderEvent, type ReasoningDetail, type StreamRequest } from '../../src/model/types.js';

const credential: Credential = {
  provider: 'openrouter',
  apiKey: ['sk', 'or', 'v1', 'NOTAREALKEY000000000000'].join('-'),
  keyId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
};

/** SSE split at a fixed stride, so the frame buffering is exercised. */
function sseResponse(frames: readonly string[], chunkSize = 9, status = 200): Response {
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

const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}`;

function recorder(response: () => Response) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  return {
    calls,
    fetch: (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(response());
    },
  };
}

const baseRequest = (overrides: Partial<StreamRequest> = {}): StreamRequest => ({
  model: 'openrouter:anthropic/claude-sonnet-4.6',
  system: 'be useful',
  messages: [{ role: 'user', content: 'hello' }],
  tools: [],
  effort: null,
  effortMap: null,
  credential,
  ...overrides,
});

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of stream) out.push(event);
  return out;
}

// ---------------------------------------------------------------------------
// The id convention (decision R1)
// ---------------------------------------------------------------------------

describe('the openrouter: model id convention', () => {
  it('round-trips a vendor-prefixed id', () => {
    const catalogId = openRouterCatalogId('anthropic/claude-sonnet-4.6');
    expect(catalogId).toBe('openrouter:anthropic/claude-sonnet-4.6');
    expect(openRouterModelId(catalogId)).toBe('anthropic/claude-sonnet-4.6');
  });

  it('leaves a native catalog id alone', () => {
    expect(openRouterModelId('deepseek-flash')).toBeNull();
    expect(vendorPrefix('deepseek-flash')).toBe('native');
  });

  it('groups by the segment before the first slash', () => {
    expect(vendorPrefix('openrouter:meta-llama/llama-4-70b-instruct')).toBe('meta-llama');
    expect(vendorPrefix('openrouter:some-bare-id')).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe('the OpenRouter adapter, streaming', () => {
  it('sends the prefix-stripped model id and the attribution headers, and never follows a redirect', async () => {
    const rec = recorder(() => sseResponse([frame({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }), 'data: [DONE]']));
    const provider = new OpenRouterProvider({ fetch: rec.fetch });
    await collect(provider.stream(baseRequest()));

    const call = rec.calls[0]!;
    expect(call.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['HTTP-Referer']).toBe(ATTRIBUTION_HEADERS['HTTP-Referer']);
    expect(headers['X-Title']).toBe(ATTRIBUTION_HEADERS['X-Title']);
    const body = JSON.parse(String(call.init?.body)) as { model: string; stream_options: unknown };
    // The wire never sees our prefix.
    expect(body.model).toBe('anthropic/claude-sonnet-4.6');
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('ignores the OPENROUTER PROCESSING keepalive comments', async () => {
    const rec = recorder(() =>
      sseResponse([
        ': OPENROUTER PROCESSING',
        frame({ choices: [{ delta: { content: 'one ' } }] }),
        ': OPENROUTER PROCESSING',
        frame({ choices: [{ delta: { content: 'two' }, finish_reason: 'stop' }] }),
        'data: [DONE]',
      ]),
    );
    const events = await collect(new OpenRouterProvider({ fetch: rec.fetch }).stream(baseRequest()));
    const text = events.filter((e) => e.type === 'text_delta').map((e) => (e as { text: string }).text).join('');
    expect(text).toBe('one two');
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'end_turn' });
  });

  it('reads usage from the final chunk, including cached and reasoning tokens', async () => {
    const rec = recorder(() =>
      sseResponse([
        frame({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] }),
        frame({
          choices: [{ delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            prompt_tokens_details: { cached_tokens: 100 },
            completion_tokens_details: { reasoning_tokens: 12 },
          },
        }),
        'data: [DONE]',
      ]),
    );
    const events = await collect(new OpenRouterProvider({ fetch: rec.fetch }).stream(baseRequest()));
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: { input_tokens: 120, output_tokens: 30, cached_input_tokens: 100, reasoning_tokens: 12 },
    });
  });

  it('reassembles a tool call whose name and arguments are split across frames', async () => {
    const rec = recorder(() =>
      sseResponse([
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'propose_' } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'request', arguments: '{"kind":' } }] } }] }),
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"invoice"}' } }] }, finish_reason: 'tool_calls' }] }),
        'data: [DONE]',
      ]),
    );
    const events = await collect(new OpenRouterProvider({ fetch: rec.fetch }).stream(baseRequest()));
    expect(events.find((e) => e.type === 'tool_call')).toEqual({
      type: 'tool_call',
      call: { id: 'call_1', name: 'propose_request', arguments: '{"kind":"invoice"}' },
    });
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('refuses tool arguments that are not JSON, as malformed rather than transient', async () => {
    const rec = recorder(() =>
      sseResponse([
        frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'n', arguments: '{oops' } }] }, finish_reason: 'tool_calls' }] }),
        'data: [DONE]',
      ]),
    );
    await expect(collect(new OpenRouterProvider({ fetch: rec.fetch }).stream(baseRequest()))).rejects.toMatchObject({
      failure: 'malformed',
    });
  });

  it('sends reasoning as an object with an effort, mapped through the catalog row', async () => {
    const rec = recorder(() => sseResponse([frame({ choices: [{ delta: { content: '.' }, finish_reason: 'stop' }] }), 'data: [DONE]']));
    await collect(
      new OpenRouterProvider({ fetch: rec.fetch }).stream(
        baseRequest({ effort: 'high', effortMap: { low: 'low', medium: 'medium', high: 'high' } }),
      ),
    );
    const body = JSON.parse(String(rec.calls[0]!.init?.body)) as { reasoning?: unknown };
    expect(body.reasoning).toEqual({ effort: 'high' });
  });

  it('refuses an effort the model does not map, as permanent', async () => {
    const rec = recorder(() => sseResponse(['data: [DONE]']));
    await expect(
      collect(new OpenRouterProvider({ fetch: rec.fetch }).stream(baseRequest({ effort: 'max', effortMap: { low: 'low' } }))),
    ).rejects.toMatchObject({ failure: 'permanent' });
  });
});

// ---------------------------------------------------------------------------
// Reasoning replay (decision R3)
// ---------------------------------------------------------------------------

describe('reasoning_details', () => {
  it('accumulates text by index and emits the blocks in order', async () => {
    const rec = recorder(() =>
      sseResponse([
        frame({ choices: [{ delta: { reasoning: 'Let me ', reasoning_details: [{ type: 'reasoning.text', index: 0, format: 'anthropic', text: 'Let me ' }] } }] }),
        frame({ choices: [{ delta: { reasoning: 'think.', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'think.' }] } }] }),
        frame({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.encrypted', index: 1, data: 'OPAQUE' }] }, finish_reason: 'stop' }] }),
        'data: [DONE]',
      ]),
    );
    const events = await collect(new OpenRouterProvider({ fetch: rec.fetch }).stream(baseRequest()));

    // The human-visible half arrives as deltas...
    expect(events.filter((e) => e.type === 'reasoning_delta').map((e) => (e as { text: string }).text).join('')).toBe('Let me think.');
    // ...and the protocol half arrives once, ordered, with the encrypted block kept.
    const carry = events.find((e) => e.type === 'reasoning');
    expect(carry).toEqual({
      type: 'reasoning',
      carry: {
        kind: 'openrouter_reasoning_details',
        details: [
          { type: 'reasoning.text', index: 0, format: 'anthropic', text: 'Let me think.' },
          { type: 'reasoning.encrypted', index: 1, data: 'OPAQUE' },
        ],
      },
    });
  });

  it('replays the carry verbatim on the next turn, in order', () => {
    const details: ReasoningDetail[] = [
      { type: 'reasoning.text', index: 0, text: 'first' },
      { type: 'reasoning.encrypted', index: 1, data: 'OPAQUE' },
    ];
    const messages = toChatMessages('sys', [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        reasoning: { kind: 'openrouter_reasoning_details', details },
        tool_calls: [{ id: 'c1', name: 'n', arguments: '{}' }],
      },
      { role: 'tool', content: 'ok', tool_call_id: 'c1' },
    ]) as Record<string, unknown>[];

    expect(messages[2]!.reasoning_details).toEqual(details);
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'ok' });
  });

  it('refuses another transport’s carry rather than coercing it', () => {
    expect(() =>
      toChatMessages('sys', [{ role: 'assistant', content: '', reasoning: { kind: 'deepseek_reasoning_content', content: 'x' } }]),
    ).toThrow(ProviderError);
  });

  it('merges a block that arrives with no index', () => {
    const into = new Map<number, ReasoningDetail>();
    mergeReasoningDetails(into, [{ type: 'reasoning.text', text: 'a' }]);
    mergeReasoningDetails(into, [{ type: 'reasoning.text', text: 'b' }]);
    expect([...into.values()]).toEqual([{ type: 'reasoning.text', index: 0, text: 'a' }, { type: 'reasoning.text', index: 1, text: 'b' }]);
  });
});

// ---------------------------------------------------------------------------
// The error table (decision R4)
// ---------------------------------------------------------------------------

describe('the OpenRouter error table', () => {
  const body = (code: number) => new Response(JSON.stringify({ error: { code, message: 'prose we do not repeat' } }), { status: code });

  it('maps 401 to auth, so the key is marked invalid', async () => {
    expect(await openRouterError(body(401))).toMatchObject({ failure: 'auth', status: 401 });
  });

  it('maps 402 to permanent, with copy naming credits and no provider prose', async () => {
    const error = await openRouterError(body(402));
    expect(error).toBeInstanceOf(OpenRouterCreditsError);
    expect(error.failure).toBe('permanent');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('out of credits');
    expect(error.message).not.toContain('prose we do not repeat');
  });

  it('maps 429 to rate_limit, which the Workflow step retries', async () => {
    const error = await openRouterError(body(429));
    expect(error.failure).toBe('rate_limit');
    expect(error.retryable).toBe(true);
  });

  it('maps 502 and 503 to transient rather than to permanent', async () => {
    expect((await openRouterError(body(502))).failure).toBe('transient');
    expect((await openRouterError(body(503))).failure).toBe('transient');
  });

  it('maps 400 to permanent', async () => {
    expect((await openRouterError(body(400))).failure).toBe('permanent');
  });

  it('turns a mid-stream error object into a ProviderError rather than a short answer', async () => {
    const rec = recorder(() => sseResponse([frame({ choices: [{ delta: { content: 'par' } }] }), frame({ error: { code: 502, message: 'model down' } })]));
    await expect(collect(new OpenRouterProvider({ fetch: rec.fetch }).stream(baseRequest()))).rejects.toMatchObject({
      failure: 'transient',
      status: 502,
    });
  });

  it('turns a mid-stream 402 into the credits error', async () => {
    const rec = recorder(() => sseResponse([frame({ error: { code: 402 } })]));
    await expect(collect(new OpenRouterProvider({ fetch: rec.fetch }).stream(baseRequest()))).rejects.toBeInstanceOf(
      OpenRouterCreditsError,
    );
  });
});

// ---------------------------------------------------------------------------
// Verification probe (decision R6)
// ---------------------------------------------------------------------------

describe('the OpenRouter verification probe', () => {
  it('authenticates against /key, not the public /models list', async () => {
    const rec = recorder(() => new Response(JSON.stringify({ data: { label: 'pilot', usage: 3, limit: null } }), { status: 200 }));
    const result = await new OpenRouterProvider({ fetch: rec.fetch }).listModels(credential);
    expect(rec.calls[0]!.url).toBe('https://openrouter.ai/api/v1/key');
    // The list is not stored on the key row; the catalog sync writes rows.
    expect(result).toEqual({ ok: true, models: [] });
  });

  it('reports a 401 as auth, which keys/verify turns into `invalid`', async () => {
    const rec = recorder(() => new Response(JSON.stringify({ error: { code: 401 } }), { status: 401 }));
    await expect(new OpenRouterProvider({ fetch: rec.fetch }).listModels(credential)).rejects.toMatchObject({
      failure: 'auth',
      status: 401,
    });
  });
});

// ---------------------------------------------------------------------------
// The catalog sync's judgement (decision R6)
// ---------------------------------------------------------------------------

describe('normalising OpenRouter’s model list', () => {
  const rows = normaliseModels(OPENROUTER_FIXTURE_MODELS);

  it('converts per-token decimal strings to USD per million', () => {
    expect(perMillion('0.000003')).toBe(3);
    expect(perMillion('0.00000125')).toBe(1.25);
    expect(perMillion('0')).toBe(0);
  });

  it('refuses a price it cannot parse rather than defaulting it to free', () => {
    expect(perMillion(undefined)).toBeNull();
    expect(perMillion('not a number')).toBeNull();
    expect(perMillion('-1')).toBeNull();
    expect(rows.some((r) => r.model_id === 'openrouter:broken/no-price')).toBe(false);
  });

  it('skips an endpoint that cannot answer with text', () => {
    expect(rows.some((r) => r.model_id.includes('flux'))).toBe(false);
  });

  it('prefixes every id and computes the price per million', () => {
    const sonnet = rows.find((r) => r.model_id === 'openrouter:anthropic/claude-sonnet-4.6')!;
    expect(sonnet.pricing_per_million).toEqual({
      input: 3,
      output: 15,
      input_off_peak: null,
      output_off_peak: null,
      cached_input: 0.3,
    });
    expect(sonnet.context_length).toBe(200_000);
  });

  it('carries an effort map only for a model that supports reasoning', () => {
    expect(rows.find((r) => r.model_id === 'openrouter:anthropic/claude-sonnet-4.6')!.effort_map).toEqual({
      low: 'low',
      medium: 'medium',
      high: 'high',
    });
    const gemini = rows.find((r) => r.model_id === 'openrouter:google/gemini-3-flash')!;
    expect(gemini.supports_reasoning).toBe(false);
    expect(gemini.effort_map).toBeNull();
    expect(gemini.default_effort).toBeNull();
  });

  it('keeps a model with no tool calling, and says so, rather than hiding it', () => {
    const llama = rows.find((r) => r.model_id === 'openrouter:meta-llama/llama-4-70b-instruct')!;
    expect(llama.supports_tools).toBe(false);
  });

  it('is deterministic: the same list normalises to the same rows, in the same order', () => {
    expect(normaliseModels(OPENROUTER_FIXTURE_MODELS)).toEqual(rows);
    expect(rows.map((r) => r.model_id)).toEqual([...rows.map((r) => r.model_id)].sort());
  });

  it('answers empty for a body that is not the models shape', () => {
    expect(normaliseModels(null)).toEqual([]);
    expect(normaliseModels({ data: 'nope' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The development seam
// ---------------------------------------------------------------------------

describe('the development fixture seam', () => {
  it('is refused outside development, and outside the opt-in var', () => {
    expect(openRouterFixtureEnabled({ ENVIRONMENT: 'production', OPENROUTER_FIXTURE: '1' })).toBe(false);
    expect(openRouterFixtureEnabled({ ENVIRONMENT: 'staging', OPENROUTER_FIXTURE: '1' })).toBe(false);
    expect(openRouterFixtureEnabled({ ENVIRONMENT: 'development' })).toBe(false);
    expect(openRouterFixtureEnabled({ ENVIRONMENT: 'development', OPENROUTER_FIXTURE: '1' })).toBe(true);
  });

  it('answers only the two endpoints verification touches', async () => {
    expect((await openRouterFixtureFetch('https://openrouter.ai/api/v1/key')).status).toBe(200);
    expect((await openRouterFixtureFetch('https://openrouter.ai/api/v1/models')).status).toBe(200);
    expect((await openRouterFixtureFetch('https://openrouter.ai/api/v1/chat/completions')).status).toBe(501);
  });
});
