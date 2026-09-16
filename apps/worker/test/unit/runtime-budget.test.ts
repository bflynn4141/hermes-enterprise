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
