import { describe, expect, it } from 'vitest';
import { nousCatalogId, nousModelId, vendorPrefix } from '@hermes/shared';
import { NousPortalProvider, mergeNousReasoningDetails, toNousChatMessages } from '../../src/model/nous.js';
import { normaliseNousModels } from '../../src/model/nous-catalog.js';
import { NOUS_PORTAL_FIXTURE_MODELS, nousPortalFixtureEnabled, nousPortalFixtureFetch } from '../../src/model/nous-dev.js';
import { ProviderError, type Credential, type ProviderEvent, type ReasoningDetail, type StreamRequest } from '../../src/model/types.js';

const credential: Credential = { provider: 'nous_portal', apiKey: 'nous-fixture-key-that-is-not-real', keyId: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' };
const frame = (payload: unknown): string => `data: ${JSON.stringify(payload)}`;
function sseResponse(frames: readonly string[]): Response {
  const bytes = new TextEncoder().encode(frames.map((value) => `${value}\n\n`).join(''));
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
function recorder(response: () => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  return { calls, fetch: (url: string, init?: RequestInit) => { calls.push({ url, init }); return Promise.resolve(response()); } };
}
const request = (overrides: Partial<StreamRequest> = {}): StreamRequest => ({
  model: 'nous:anthropic/claude-sonnet-5', system: 'be useful', messages: [{ role: 'user', content: 'hello' }],
  tools: [], effort: 'high', effortMap: { low: 'low', medium: 'medium', high: 'high' }, credential, ...overrides,
});
async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> { const out: ProviderEvent[] = []; for await (const event of stream) out.push(event); return out; }

describe('the nous: model id convention', () => {
  it('round-trips provider model ids and groups vendors', () => {
    const id = nousCatalogId('anthropic/claude-sonnet-5');
    expect(id).toBe('nous:anthropic/claude-sonnet-5');
    expect(nousModelId(id)).toBe('anthropic/claude-sonnet-5');
    expect(vendorPrefix('nous:meta-llama/model')).toBe('meta-llama');
  });
});

describe('the Nous Portal adapter', () => {
  it('strips the durable prefix, fixes the endpoint, and maps effort', async () => {
    const rec = recorder(() => sseResponse([frame({ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }), 'data: [DONE]']));
    await collect(new NousPortalProvider({ fetch: rec.fetch }).stream(request()));
    expect(rec.calls[0]?.url).toBe('https://inference-api.nousresearch.com/v1/chat/completions');
    const body = JSON.parse(String(rec.calls[0]?.init?.body));
    expect(body).toMatchObject({ model: 'anthropic/claude-sonnet-5', reasoning: { effort: 'high' }, stream_options: { include_usage: true } });
    expect(new Headers(rec.calls[0]?.init?.headers).get('authorization')).toBe(`Bearer ${credential.apiKey}`);
  });

  it('preserves ordered reasoning details for the next turn', async () => {
    const rec = recorder(() => sseResponse([
      frame({ choices: [{ delta: { reasoning: 'Think ', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'Think ' }] } }] }),
      frame({ choices: [{ delta: { reasoning: 'once.', reasoning_details: [{ type: 'reasoning.text', index: 0, text: 'once.' }, { type: 'reasoning.encrypted', index: 1, data: 'OPAQUE' }] }, finish_reason: 'stop' }] }),
      'data: [DONE]',
    ]));
    const events = await collect(new NousPortalProvider({ fetch: rec.fetch }).stream(request()));
    const carry = events.find((event) => event.type === 'reasoning');
    expect(carry).toEqual({ type: 'reasoning', carry: { kind: 'nous_reasoning_details', details: [
      { type: 'reasoning.text', index: 0, text: 'Think once.' }, { type: 'reasoning.encrypted', index: 1, data: 'OPAQUE' },
    ] } });
    const details = (carry as Extract<ProviderEvent, { type: 'reasoning' }>).carry;
    const messages = toNousChatMessages('sys', [{ role: 'assistant', content: '', reasoning: details }]) as Record<string, unknown>[];
    expect(messages[1]?.reasoning_details).toEqual(details.kind === 'nous_reasoning_details' ? details.details : []);
  });

  it('refuses another transport carry and merges unindexed blocks without loss', () => {
    expect(() => toNousChatMessages('sys', [{ role: 'assistant', content: '', reasoning: { kind: 'deepseek_reasoning_content', content: 'x' } }])).toThrow(ProviderError);
    const blocks = new Map<number, ReasoningDetail>();
    mergeNousReasoningDetails(blocks, [{ type: 'reasoning.text', text: 'a' }, { type: 'reasoning.encrypted', data: 'x' }]);
    expect([...blocks.values()]).toHaveLength(2);
  });

  it('verifies with a one-token completion because the model list is public', async () => {
    const rec = recorder(() => Response.json({ choices: [{ message: { content: 'OK' } }] }));
    expect(await new NousPortalProvider({ fetch: rec.fetch }).listModels(credential)).toEqual({ ok: true, models: [] });
    expect(rec.calls[0]?.url).toBe('https://inference-api.nousresearch.com/v1/chat/completions');
    expect(JSON.parse(String(rec.calls[0]?.init?.body))).toMatchObject({ max_tokens: 1, model: 'anthropic/claude-sonnet-5' });
  });
});

describe('the Nous Portal catalog and local seam', () => {
  it('normalizes prices, capabilities, and the nous prefix', () => {
    const rows = normaliseNousModels(NOUS_PORTAL_FIXTURE_MODELS);
    const sonnet = rows.find((row) => row.model_id === 'nous:anthropic/claude-sonnet-5');
    expect(sonnet).toMatchObject({ supports_tools: true, supports_reasoning: true, pricing_per_million: { input: 3, output: 15, cached_input: 0.3 } });
    expect(rows.some((row) => row.model_id === 'nous:broken/no-price')).toBe(false);
  });
  it('keeps the fixture development-only and covers both verification endpoints', async () => {
    expect(nousPortalFixtureEnabled({ ENVIRONMENT: 'development', NOUS_PORTAL_FIXTURE: '1' })).toBe(true);
    expect(nousPortalFixtureEnabled({ ENVIRONMENT: 'production', NOUS_PORTAL_FIXTURE: '1' })).toBe(false);
    expect((await nousPortalFixtureFetch('https://inference-api.nousresearch.com/v1/chat/completions')).status).toBe(200);
    expect((await nousPortalFixtureFetch('https://inference-api.nousresearch.com/v1/models')).status).toBe(200);
  });
});
