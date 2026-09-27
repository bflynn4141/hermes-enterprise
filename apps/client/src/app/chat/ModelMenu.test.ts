// The model menu's pure parts: grouping, price and context copy.
//
// The component is not rendered here — the client's test setup has no DOM, and
// the rendering is covered by the live scenario. What is worth a unit test is
// the judgement the component makes about a list it did not choose the shape
// of: which vendor a row belongs to, in what order the groups appear, and how
// a per-million price and a context window read to a person.
import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from '@hermes/shared';
import { costLabel, groupByVendor, lengthLabel, modelRouteLabel, unavailableLabel } from './ModelMenu.js';
import { vendorName } from '../copy/names.js';

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

describe('the cost and length copy', () => {
  const priced = (input: number, output: number) => entry('x', { pricing_per_million: { input, output, input_off_peak: null, output_off_peak: null, cached_input: null } });

  it('says a cost tier rather than a per-million price', () => {
    expect(costLabel(priced(0.27, 0.85))).toBe('Low cost');
    expect(costLabel(priced(1.25, 10))).toBe('Standard cost');
    expect(costLabel(priced(3, 15))).toBe('Higher cost');
    expect(costLabel(priced(0, 0))).toBe('Free');
    expect(costLabel(priced(3, 15))).not.toMatch(/\$|\/M|est\./);
  });

  it('mentions length only when a model reads long documents', () => {
    expect(lengthLabel(1_000_000)).toBe('Reads very long documents');
    expect(lengthLabel(200_000)).toBe('Reads long documents');
    expect(lengthLabel(32_000)).toBeNull();
    expect(lengthLabel(null)).toBeNull();
  });

  it('says why a row is unavailable with the provider’s brand name', () => {
    expect(unavailableLabel({ provider: 'nous_portal', disabled_code: 'no_key', disabled_reason: 'Add your nous_portal key' })).toBe('Connect Nous Portal to use this model');
    expect(unavailableLabel({ provider: 'nous_portal', disabled_code: 'catalog', disabled_reason: 'This model has no tool calling, which every run needs.' })).toBe('Can’t use tools, which every task needs');
    expect(unavailableLabel({ provider: 'nous_portal', disabled_code: null, disabled_reason: 'raw server text' })).not.toContain('raw');
  });

  it('names vendor groups by brand', () => {
    expect(['anthropic', 'meta-llama', 'openai', 'x-ai', 'unknown-lab'].map(vendorName)).toEqual(['Anthropic', 'Meta', 'OpenAI', 'xAI', 'Unknown lab']);
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
