// The ScriptedProvider, the gateway config rule, and the cost estimate.
//
// These are the pieces the engine leans on in M3, so they are pinned now: a
// scripted scenario that stopped producing the events its name claims would
// make every engine test pass for the wrong reason.
import { describe, expect, it } from 'vitest';
import { SCRIPTS, ScriptedProvider } from '../../src/model/scripted.js';
import { COLLECT_LOG_PAYLOAD_HEADER, gatewayConfigCheck, gatewayRouting } from '../../src/model/gateway.js';
import { estimateCostUsd } from '../../src/model/catalog.js';
import { providerForTransport } from '../../src/model/index.js';
import { AnthropicProvider } from '../../src/model/anthropic.js';
import { DeepSeekProvider } from '../../src/model/deepseek.js';
import { OpenAiProvider } from '../../src/model/openai.js';
import type { Credential, ProviderEvent, StreamRequest } from '../../src/model/types.js';

const credential: Credential = { provider: 'scripted', apiKey: 'unused', keyId: 'k' };
const request: StreamRequest = {
  model: 'deepseek-flash',
  system: '',
  messages: [],
  tools: [],
  effort: null,
  effortMap: null,
  credential,
};

async function drain(provider: ScriptedProvider, req: StreamRequest = request): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of provider.stream(req)) events.push(event);
  return events;
}

describe('the scripted scenarios', () => {
  it('completes a run with one tool call', async () => {
    const events = await drain(new ScriptedProvider([SCRIPTS.completed_with_tool_call]));
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('fails transiently and then succeeds, which is what a step retry looks like', async () => {
    const provider = new ScriptedProvider([SCRIPTS.transient_5xx, SCRIPTS.completed_with_tool_call]);
    await expect(drain(provider)).rejects.toMatchObject({ failure: 'transient', status: 503 });
    const second = await drain(provider);
    expect(second.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('fails permanently on a 401', async () => {
    await expect(drain(new ScriptedProvider([SCRIPTS.unauthorized]))).rejects.toMatchObject({
      failure: 'auth',
      status: 401,
    });
    await expect(new ScriptedProvider([SCRIPTS.unauthorized]).listModels(credential)).rejects.toMatchObject({
      failure: 'auth',
    });
  });

  it('reports malformed tool JSON after the deltas it already emitted', async () => {
    const provider = new ScriptedProvider([SCRIPTS.malformed_tool_json]);
    // The deltas before the failure are real: the reducer has to survive a turn
    // that produced visible text and then failed.
    await expect(drain(provider)).rejects.toMatchObject({ failure: 'malformed' });
  });

  it('tears mid-stream, leaving a partial answer', async () => {
    const provider = new ScriptedProvider([SCRIPTS.partial_stream]);
    const seen: ProviderEvent[] = [];
    await expect(
      (async () => {
        for await (const event of provider.stream(request)) seen.push(event);
      })(),
    ).rejects.toMatchObject({ failure: 'transient' });
    expect(seen.map((e) => (e.type === 'text_delta' ? e.text : '')).join('')).toBe(
      'The applicant lists three references, of which ',
    );
  });

  it('answers 403 to list-models and true to a probe, which is a scoped key', async () => {
    const provider = new ScriptedProvider([SCRIPTS.scoped_key]);
    await expect(provider.listModels(credential)).rejects.toMatchObject({ status: 403 });
    expect(await provider.probe(credential, 'claude-sonnet-4-6')).toBe(true);
  });

  it('honours an abort between events, where the real adapters honour it', async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await drain(new ScriptedProvider([SCRIPTS.completed_with_tool_call]), {
      ...request,
      signal: controller.signal,
    });
    expect(events).toEqual([{ type: 'stop', reason: 'stopped' }]);
  });

  it('records the requests it was handed, so a test can assert on them', async () => {
    const provider = new ScriptedProvider([SCRIPTS.completed_with_tool_call]);
    await drain(provider, { ...request, effort: 'high' });
    expect(provider.calls[0]?.effort).toBe('high');
  });
});

describe('the AI Gateway', () => {
  it('is off by default, and off means no routing at all', () => {
    expect(gatewayRouting({ MODEL_GATEWAY_MODE: 'off' }, { accountId: 'a', gatewayId: 'g' })).toBeNull();
    // Null rather than an identity rewriter: `gateway === null` is how a reader
    // answers "does this request leave our account?".
    expect(gatewayRouting({ MODEL_GATEWAY_MODE: 'passthrough' }, null)).toBeNull();
  });

  it('turns payload logging off on every request when it is on', () => {
    const routing = gatewayRouting({ MODEL_GATEWAY_MODE: 'passthrough' }, { accountId: 'acct', gatewayId: 'gw' });
    expect(routing?.headers[COLLECT_LOG_PAYLOAD_HEADER]).toBe('false');
  });

  it('has no configuration in which payload logging is on', () => {
    for (const mode of ['off', 'passthrough']) {
      for (const config of [null, { accountId: 'acct', gatewayId: 'gw' }, { accountId: 'a', gatewayId: 'g', token: 't' }]) {
        expect(gatewayConfigCheck({ MODEL_GATEWAY_MODE: mode }, config).payloadLoggingOff).toBe(true);
      }
    }
  });

  it('rewrites a provider URL onto the gateway, keeping the path', () => {
    const routing = gatewayRouting({ MODEL_GATEWAY_MODE: 'passthrough' }, { accountId: 'acct', gatewayId: 'gw' });
    expect(routing?.rewrite('anthropic', 'https://api.anthropic.com/v1/messages')).toBe(
      'https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages',
    );
  });

  it('carries the gateway token in a header the redactor knows by name', () => {
    const routing = gatewayRouting({ MODEL_GATEWAY_MODE: 'passthrough' }, { accountId: 'a', gatewayId: 'g', token: 'tok' });
    expect(routing?.headers['cf-aig-authorization']).toBe('Bearer tok');
  });
});

describe('the registry', () => {
  it('maps each transport to its adapter', () => {
    expect(providerForTransport('anthropic_messages')).toBeInstanceOf(AnthropicProvider);
    expect(providerForTransport('deepseek_chat')).toBeInstanceOf(DeepSeekProvider);
    expect(providerForTransport('openai_responses')).toBeInstanceOf(OpenAiProvider);
  });
});

describe('the cost estimate', () => {
  const sonnet = { input: 3, output: 15, input_off_peak: null, output_off_peak: null, cached_input: 0.3 };

  it('prices input and output per million tokens', () => {
    expect(estimateCostUsd(sonnet, { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 0 })).toBe(3);
    expect(estimateCostUsd(sonnet, { input_tokens: 0, output_tokens: 100_000, cached_input_tokens: 0 })).toBe(1.5);
  });

  it('bills a cache hit once, at the cached rate', () => {
    // 1M input of which 500k cached: 500k at $3 plus 500k at $0.30.
    expect(
      estimateCostUsd(sonnet, { input_tokens: 1_000_000, output_tokens: 0, cached_input_tokens: 500_000 }),
    ).toBeCloseTo(1.65, 6);
  });

  it('never reports more cached tokens than input tokens', () => {
    // A provider that reported a cache hit larger than the prompt would
    // otherwise produce a negative charge.
    expect(estimateCostUsd(sonnet, { input_tokens: 100, output_tokens: 0, cached_input_tokens: 1_000 })).toBeGreaterThan(0);
  });

  it('rounds to the six decimals the column stores', () => {
    const cost = estimateCostUsd(sonnet, { input_tokens: 7, output_tokens: 3, cached_input_tokens: 0 });
    expect(cost).toBe(Math.round(cost * 1e6) / 1e6);
  });
});
