import { describe, expect, it, vi } from 'vitest';
import {
  ProviderUsageParser,
  RuntimeBudgetError,
  actualRuntimeCostUsd,
  inputTokenUpperBound,
  maximumRuntimeCostUsd,
  meterRuntimeResponse,
  prepareRuntimeBudget,
  requestedOutputBound,
  type RuntimeBudgetContext,
  type RuntimeBudgetDb,
} from '../../src/runtime/budget.js';

const context = (overrides: Partial<RuntimeBudgetContext> = {}): RuntimeBudgetContext => ({
  budgetId: 'budget-1',
  authorizationState: 'admitted',
  state: 'active',
  modelId: 'openrouter:model-a',
  maxOutputTokensPerCall: 500,
  contextLength: 32_000,
  pricingVerifiedOn: '2026-09-15',
  pricing: { input: 1, output: 2, cachedInput: 0.25 },
  ...overrides,
});

describe('approved runtime budget bounds', () => {
  it('requires an explicit output bound and uses the larger supported spelling', () => {
    expect(requestedOutputBound({})).toBeNull();
    expect(requestedOutputBound({ max_tokens: 100 })).toBe(100);
    expect(requestedOutputBound({ max_tokens: 100, max_completion_tokens: 120 })).toBe(120);
    expect(requestedOutputBound({ max_tokens: 0 })).toBeNull();
  });

  it('uses a conservative tokenizer-independent input bound and rounds cost reservations up', () => {
    const request = { messages: [{ role: 'user', content: 'hello' }], tools: [{ name: 'read' }] };
    expect(inputTokenUpperBound(request)).toBeGreaterThan(new TextEncoder().encode(JSON.stringify(request)).byteLength);
    expect(maximumRuntimeCostUsd(context(), 1000, 100)).toBe(0.0012);
    expect(actualRuntimeCostUsd(context(), { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400 })).toBe(0.0009);
  });

  it('imposes the reviewed output bound when the native caller omits one', async () => {
    const db: RuntimeBudgetDb = {
      runtimeBudgetForRun: vi.fn(async () => context()),
      reserveRuntimeBudget: vi.fn(),
      reconcileRuntimeBudget: vi.fn(),
    };
    const request: Record<string, unknown> = { messages: [] };
    await expect(prepareRuntimeBudget(db, 'run-1', 'openrouter:model-a', request))
      .resolves.toMatchObject({ outputTokenBound: 500 });
    expect(request.max_tokens).toBe(500);
  });

  it('fails closed for stale authorization, missing approved bounds and unknown prices', async () => {
    const db: RuntimeBudgetDb = {
      runtimeBudgetForRun: vi.fn(async () => context({ maxOutputTokensPerCall: null })),
      reserveRuntimeBudget: vi.fn(),
      reconcileRuntimeBudget: vi.fn(),
    };
    await expect(prepareRuntimeBudget(db, 'run-1', 'openrouter:model-a', { messages: [] }))
      .rejects.toEqual(expect.objectContaining({ reason: 'approval_budget_output_bound_required' }));
    db.runtimeBudgetForRun = vi.fn(async () => context({ authorizationState: 'expired' }));
    await expect(prepareRuntimeBudget(db, 'run-1', 'openrouter:model-a', { messages: [], max_tokens: 10 }))
      .rejects.toEqual(expect.objectContaining({ reason: 'approval_budget_authorization_stale' }));
    db.runtimeBudgetForRun = vi.fn(async () => context({ pricing: { input: null, output: 2, cachedInput: null } }));
    await expect(prepareRuntimeBudget(db, 'run-1', 'openrouter:model-a', { messages: [], max_tokens: 10 }))
      .rejects.toEqual(expect.objectContaining({ reason: 'approval_budget_price_unknown' }));
  });

  it('returns null for an ordinary run and never invents a budget', async () => {
    await expect(prepareRuntimeBudget({ runtimeBudgetForRun: async () => null }, 'run-1', 'model', { messages: [] }))
      .resolves.toBeNull();
  });
});

describe('provider usage reconciliation', () => {
  it('distinguishes first bytes, frames, reasoning and visible content across split UTF-8 frames', () => {
    const observations: string[] = [];
    const parser = new ProviderUsageParser((kind) => observations.push(kind));
    const encoder = new TextEncoder();
    parser.push(new Uint8Array());
    expect(observations).toEqual([]);
    parser.push(encoder.encode(': keepalive\n\n'));
    expect(observations).toEqual(['first_byte']);
    parser.push(encoder.encode('data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\r\n\r\n'));
    parser.push(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":4}}\n\n'));
    expect(observations).toEqual(['first_byte', 'first_frame']);
    parser.push(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"private reasoning"}}]}\n\n'));
    parser.push(encoder.encode('data: {"choices":[{"delta":{"content":" "}}]}\n\n'));
    expect(observations).toEqual(['first_byte', 'first_frame', 'first_reasoning']);
    const content = encoder.encode('data: {"choices":[{"delta":{"content":"🌿 private response"}}]}\n\n');
    const split = content.indexOf(0xf0) + 2;
    parser.push(content.slice(0, split));
    expect(observations).not.toContain('first_content');
    parser.push(content.slice(split));
    parser.push(content);
    expect(observations).toEqual(['first_byte', 'first_frame', 'first_reasoning', 'first_content']);
    expect(parser.finish()).toEqual({ inputTokens: 12, outputTokens: 4, cachedInputTokens: 0 });
  });

  it('streams a gated upstream incrementally before usage settlement and tolerates an observation sink failure', async () => {
    const encoder = new TextEncoder();
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; }, cancel: cancelled });
    const settle = vi.fn(async () => undefined);
    const observe = vi.fn(() => { throw new Error('telemetry unavailable'); });
    const metered = meterRuntimeResponse(new Response(body), settle, observe);
    const reader = metered.body!.getReader();
    const first = encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    upstream.enqueue(first);
    expect(await reader.read()).toEqual({ done: false, value: first });
    expect(settle).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith('first_content');
    const usage = encoder.encode('data: {"usage":{"prompt_tokens":9,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":7}}}\n\n');
    upstream.enqueue(usage);
    expect(await reader.read()).toEqual({ done: false, value: usage });
    expect(settle).not.toHaveBeenCalled();
    upstream.close();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(settle).toHaveBeenCalledExactlyOnceWith({ inputTokens: 9, outputTokens: 3, cachedInputTokens: 7 });
    expect(cancelled).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'failure'] as const)('preserves exactly-once unresolved accounting on downstream %s', async (ending) => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { upstream = controller; }, cancel: cancelled });
    const settle = vi.fn(async () => undefined);
    const observe = vi.fn();
    const reader = meterRuntimeResponse(new Response(body), settle, observe).body!.getReader();
    upstream.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
    await reader.read();
    expect(observe).toHaveBeenCalledWith('first_content');
    if (ending === 'cancel') {
      await reader.cancel('consumer stopped');
      expect(cancelled).toHaveBeenCalledExactlyOnceWith('consumer stopped');
    } else {
      upstream.error(new Error('provider connection lost'));
      await expect(reader.read()).rejects.toThrow('provider connection lost');
      expect(cancelled).not.toHaveBeenCalled();
    }
    expect(settle).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('ignores tool arguments and reasoning signatures while recognizing text parts', () => {
    const observations: string[] = [];
    const parser = new ProviderUsageParser((kind) => observations.push(kind));
    const push = (delta: unknown) => parser.push(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
    push({ tool_calls: [{ function: { arguments: 'hello' } }], reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }] });
    expect(observations).toEqual(['first_byte', 'first_frame']);
    push({ reasoning_details: [{ type: 'reasoning.text', text: 'thinking' }] });
    push({ content: [{ type: 'image_url', image_url: 'image' }, { type: 'text', text: 'hello' }] });
    expect(observations).toEqual(['first_byte', 'first_frame', 'first_reasoning', 'first_content']);
  });

  it('reads the final OpenRouter usage from arbitrarily split SSE chunks', () => {
    const parser = new ProviderUsageParser();
    const encoder = new TextEncoder();
    parser.push(encoder.encode('data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":12,'));
    parser.push(encoder.encode('"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":3}}}\n\ndata: [DONE]\n'));
    expect(parser.finish()).toEqual({ inputTokens: 12, outputTokens: 4, cachedInputTokens: 3 });
  });

  it('reads a non-stream JSON response', () => {
    const parser = new ProviderUsageParser();
    parser.push(new TextEncoder().encode(JSON.stringify({ usage: { input_tokens: 8, output_tokens: 2 } })));
    expect(parser.finish()).toEqual({ inputTokens: 8, outputTokens: 2, cachedInputTokens: 0 });
  });

  it('does not trust fractional provider token counts', () => {
    const parser = new ProviderUsageParser();
    parser.push(new TextEncoder().encode(JSON.stringify({ usage: { input_tokens: 8.5, output_tokens: 2 } })));
    expect(parser.finish()).toBeNull();
  });

  it('settles once with actual usage while preserving response bytes', async () => {
    const payload = 'data: {"usage":{"prompt_tokens":9,"completion_tokens":3}}\n\ndata: [DONE]\n\n';
    const settle = vi.fn(async () => undefined);
    const metered = meterRuntimeResponse(new Response(payload, { headers: { 'content-type': 'text/event-stream' } }), settle);
    expect(await metered.text()).toBe(payload);
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith({ inputTokens: 9, outputTokens: 3, cachedInputTokens: 0 });
  });

  it('keeps the upper bound unresolved when no authoritative usage arrives', async () => {
    const settle = vi.fn(async () => undefined);
    const metered = meterRuntimeResponse(new Response('data: [DONE]\n\n'), settle);
    await metered.text();
    expect(settle).toHaveBeenCalledWith(null);
  });

  it('exposes stable budget reason codes', () => {
    expect(new RuntimeBudgetError('approval_budget_call_limit')).toMatchObject({
      name: 'RuntimeBudgetError',
      reason: 'approval_budget_call_limit',
    });
  });
});
