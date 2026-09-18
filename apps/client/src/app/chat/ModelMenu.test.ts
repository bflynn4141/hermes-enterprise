// The model menu's pure parts: grouping, price and context copy.
//
// The component is not rendered here — the client's test setup has no DOM, and
// the rendering is covered by the live scenario. What is worth a unit test is
// the judgement the component makes about a list it did not choose the shape
// of: which vendor a row belongs to, in what order the groups appear, and how
// a per-million price and a context window read to a person.
import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@hermes/shared';
import { contextLabel, groupByVendor, modelRouteLabel, priceLabel } from './ModelMenu.js';

const entry = (model_id: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  model_id,
  provider: 'nous_portal',
  label: model_id,
  transport: 'nous_chat',
  effort_map: null,
  default_effort: null,
  pricing_per_million: { input: 1, output: 2, input_off_peak: null, output_off_peak: null, cached_input: null },
  pricing_verified_on: '2026-09-15',
  enabled: true,
  disabled_code: null,
  disabled_reason: null,
  source: 'provider_list',
  context_length: null,
  supports_tools: true,
  supports_reasoning: false,
  ...over,
});

describe('grouping the model list by vendor', () => {
  it('groups Nous Portal rows by the segment before the slash', () => {
    const groups = groupByVendor([
      entry('nous:openai/gpt-5.5'),
      entry('nous:anthropic/claude-sonnet-4.6'),
      entry('nous:anthropic/claude-haiku-4.5'),
      entry('nous:meta-llama/llama-4-70b-instruct'),
    ]);
    expect(groups.map((g) => g.vendor)).toEqual(['anthropic', 'meta-llama', 'openai']);
    expect(groups[0]!.rows.map((r) => r.model_id)).toEqual([
      'nous:anthropic/claude-sonnet-4.6',
      'nous:anthropic/claude-haiku-4.5',
    ]);
  });

  it('puts the directly-keyed models first, under one heading', () => {
    const groups = groupByVendor([
      entry('nous:zzz/model'),
      entry('deepseek-flash', { provider: 'deepseek', source: 'seed' }),
      entry('nous:aaa/model'),
    ]);
    expect(groups[0]!.vendor).toBe('Direct');
    expect(groups[0]!.rows.map((r) => r.model_id)).toEqual(['deepseek-flash']);
    expect(groups.slice(1).map((g) => g.vendor)).toEqual(['aaa', 'zzz']);
  });

  it('keeps the server’s ordering inside a group rather than re-sorting it', () => {
    const groups = groupByVendor([entry('nous:x/b'), entry('nous:x/a')]);
    expect(groups[0]!.rows.map((r) => r.model_id)).toEqual(['nous:x/b', 'nous:x/a']);
  });

  it('gives a bare Nous Portal id its own group rather than dropping it', () => {
    expect(groupByVendor([entry('nous:bare-id')])[0]!.vendor).toBe('other');
  });

  it('answers an empty list with no groups', () => {
    expect(groupByVendor([])).toEqual([]);
  });
});

describe('the price and context copy', () => {
  it('reads sub-dollar prices without a wall of zeroes', () => {
    expect(priceLabel(entry('x', { pricing_per_million: { input: 0.27, output: 0.85, input_off_peak: null, output_off_peak: null, cached_input: null } }))).toBe(
      '$0.27 in · $0.85 out /M est.',
    );
  });

  it('says free rather than $0.00, and keeps two decimals above a dollar', () => {
    expect(priceLabel(entry('x', { pricing_per_million: { input: 0, output: 15, input_off_peak: null, output_off_peak: null, cached_input: null } }))).toBe(
      'free in · $15.00 out /M est.',
    );
  });

  it('always says est., because the provider does the billing', () => {
    expect(priceLabel(entry('x'))).toContain('est.');
  });

  it('renders a context window as a person says it', () => {
    expect(contextLabel(200_000)).toBe('200K ctx');
    expect(contextLabel(1_000_000)).toBe('1M ctx');
    expect(contextLabel(131_072)).toBe('131K ctx');
    expect(contextLabel(512)).toBe('512 ctx');
    expect(contextLabel(null)).toBeNull();
  });
});

describe('the effective Nous Portal route', () => {
  it('keeps otherwise-identical paid and free StepFun routes distinguishable', () => {
    const paid = entry('nous:stepfun/step-3.7-flash');
    const free = entry('nous:stepfun/step-3.7-flash:free');
    expect(modelRouteLabel(paid)).toBe('Paid route');
    expect(modelRouteLabel(free)).toBe('Free route');
  });

  it('does not invent a paid/free route for a direct provider', () => {
    expect(modelRouteLabel(entry('deepseek-flash', { provider: 'deepseek' }))).toBeNull();
  });
});
