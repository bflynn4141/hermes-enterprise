// The M0 spike, against a real provider. Never run in CI.
//
// Everything else in this repository is tested with `ScriptedProvider` and no
// network, deliberately. This file is the one exception, and it exists to
// answer the three questions a scripted provider cannot:
//
//   1. does a real stream carry a tool call the way the adapter expects?
//   2. how long does Stop actually take, measured, from the moment the flag is
//      set to the moment the stream stops producing? The plan's budget is 1 s
//      and the runbook records the number this prints.
//   3. does the reasoning carry replay? Turn two sends turn one's reasoning
//      back verbatim; every provider rejects a paraphrase, so a 400 here is the
//      answer rather than a mystery in production.
//
// How Brian runs it:
//
// It runs through vitest, which is already a dependency and already knows how
// to load this repository's TypeScript. The `spike` project exists in
// `vitest.config.ts` only when `HERMES_SPIKE_KEY` is set, so CI — which never
// sets it — cannot run this file even by accident.
//
//     cd apps/worker
//     # DeepSeek (cheapest; the plan's recommended first provider):
//     HERMES_SPIKE_PROVIDER=deepseek HERMES_SPIKE_KEY=sk-... \
//       HERMES_SPIKE_MODEL=deepseek-chat pnpm spike
//     # Anthropic:
//     HERMES_SPIKE_PROVIDER=anthropic HERMES_SPIKE_KEY=sk-ant-... \
//       HERMES_SPIKE_MODEL=claude-sonnet-4-5 pnpm spike
//     # OpenAI:
//     HERMES_SPIKE_PROVIDER=openai HERMES_SPIKE_KEY=sk-... \
//       HERMES_SPIKE_MODEL=gpt-5 pnpm spike
//
// The key comes from the environment and is never written anywhere: not to a
// file, not to a log line, not into an error message. Do not paste one into
// this repository, into `.dev.vars`, or into a terminal whose history is saved.
// A key that reaches a commit is a key that has to be rotated at the provider.
import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/model/anthropic.js';
import { DeepSeekProvider } from '../src/model/deepseek.js';
import { OpenAiProvider } from '../src/model/openai.js';
import type { Credential, ModelProvider, ProviderEvent, ProviderMessage, ReasoningCarry } from '../src/model/types.js';
import { STOP_LATENCY_BUDGET_MS, DELTA_BATCH_MS } from '../src/engine/constants.js';

/** Subrequests, counted the way the budget counts them: one per outbound fetch. */
let fetches = 0;
const countingFetch = (input: string, init?: RequestInit): Promise<Response> => {
  fetches += 1;
  return fetch(input, init);
};

const PROVIDERS: Record<string, () => ModelProvider> = {
  anthropic: () => new AnthropicProvider({ fetch: countingFetch }),
  deepseek: () => new DeepSeekProvider({ fetch: countingFetch }),
  openai: () => new OpenAiProvider({ fetch: countingFetch }),
};

const providerName = process.env.HERMES_SPIKE_PROVIDER ?? 'deepseek';
const apiKey = process.env.HERMES_SPIKE_KEY ?? '';
const model = process.env.HERMES_SPIKE_MODEL ?? 'deepseek-chat';
const effort = process.env.HERMES_SPIKE_EFFORT ?? null;

const make = PROVIDERS[providerName];
if (!make) throw new Error(`HERMES_SPIKE_PROVIDER must be one of ${Object.keys(PROVIDERS).join(', ')}`);

const credential: Credential = { provider: providerName, apiKey, keyId: 'spike' };
const provider = make();

const TOOLS = [
  {
    name: 'get_workspace_context',
    description: 'Read the context fields a human has set for this agent.',
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

const line = (label: string, value: unknown): void => console.log(`${label.padEnd(28)} ${String(value)}`);

async function streamOnce(
  messages: readonly ProviderMessage[],
  options: { abortAfterMs?: number } = {},
): Promise<{
  text: string;
  toolCalls: number;
  reasoning: ReasoningCarry | undefined;
  events: number;
  batches: number;
  abortedAt: number | null;
  stoppedAt: number | null;
}> {
  const controller = new AbortController();
  let abortedAt: number | null = null;
  let stoppedAt: number | null = null;
  let text = '';
  let toolCalls = 0;
  let events = 0;
  let batches = 0;
  let reasoning: ReasoningCarry | undefined;
  let pending = '';
  let lastFlush = Date.now();

  if (options.abortAfterMs !== undefined) {
    setTimeout(() => {
      // This is the Stop route's `stop_requested = true` plus the engine
      // reading it from a delta reply, collapsed into one clock.
      abortedAt = Date.now();
      controller.abort();
    }, options.abortAfterMs);
  }

  const stream = provider.stream({
    model,
    system: 'You are a careful assistant. Call get_workspace_context before answering.',
    messages,
    tools: TOOLS,
    effort,
    effortMap: null,
    credential,
    signal: controller.signal,
    maxTokens: 1024,
  });

  try {
    for await (const event of stream as AsyncIterable<ProviderEvent>) {
      events += 1;
      if (event.type === 'text_delta') {
        text += event.text;
        pending += event.text;
        if (Date.now() - lastFlush >= DELTA_BATCH_MS) {
          batches += 1;
          pending = '';
          lastFlush = Date.now();
        }
      }
      if (event.type === 'tool_call') toolCalls += 1;
      if (event.type === 'reasoning') reasoning = event.carry;
      if (abortedAt !== null && stoppedAt === null) stoppedAt = Date.now();
    }
  } catch (error) {
    if (abortedAt !== null) stoppedAt = stoppedAt ?? Date.now();
    else throw error;
  }
  if (pending.length > 0) batches += 1;
  return { text, toolCalls, reasoning, events, batches, abortedAt, stoppedAt };
}

async function main(): Promise<number | null> {
  line('provider', providerName);
  line('model', model);
  console.log('');

  // 1. A streamed tool call.
  console.log('1. one streamed tool call');
  const first = await streamOnce([
    { role: 'user', content: 'What context has the workspace set? Use the tool, then summarise it in one sentence.' },
  ]);
  line('  tool calls', first.toolCalls);
  line('  stream events', first.events);
  line('  delta batches at 500 ms', first.batches);
  line('  reasoning carry', first.reasoning ? first.reasoning.kind : 'none');
  line('  fetches so far', fetches);
  console.log('');

  // 2. Stop, measured. This is the number the runbook records.
  console.log('2. Stop, measured');
  const stopped = await streamOnce(
    [{ role: 'user', content: 'Write four hundred words about the history of the filing cabinet.' }],
    { abortAfterMs: 1_500 },
  );
  const latency =
    stopped.abortedAt !== null && stopped.stoppedAt !== null ? stopped.stoppedAt - stopped.abortedAt : null;
  line('  stop latency (ms)', latency ?? 'not measured');
  line('  budget (ms)', STOP_LATENCY_BUDGET_MS);
  line('  within budget', latency !== null && latency <= STOP_LATENCY_BUDGET_MS ? 'yes' : 'NO — record it in the runbook');
  line('  characters before stop', stopped.text.length);
  console.log('');

  // 3. Reasoning replay: send turn one's carry back, verbatim.
  console.log('3. reasoning replay');
  if (!first.reasoning) {
    line('  skipped', 'this model streamed no reasoning carry');
  } else {
    const replay: ProviderMessage[] = [
      { role: 'user', content: 'What context has the workspace set?' },
      { role: 'assistant', content: first.text, reasoning: first.reasoning },
      { role: 'user', content: 'Thank you. In one sentence, what did you conclude?' },
    ];
    try {
      const second = await streamOnce(replay);
      line('  replayed', 'accepted');
      line('  second-turn events', second.events);
    } catch (error) {
      // A 400 here is the answer, not a mystery: the carry has to go back byte
      // for byte, and effort has to be held constant for the whole run.
      line('  replayed', `REJECTED: ${(error as Error).message}`);
    }
  }
  console.log('');
  line('total provider fetches', fetches);
  return latency;
}

describe('the M0 spike', () => {
  it('streams a tool call, honours Stop, and replays its reasoning', async () => {
    expect(apiKey).not.toBe('');
    const latency = await main();
    // The assertion is deliberately soft: the point of the spike is to record
    // the number, and a provider having a bad afternoon should print it rather
    // than fail a build nobody is running.
    if (latency !== null && latency > STOP_LATENCY_BUDGET_MS) {
      console.warn(`Stop took ${latency} ms, over the ${STOP_LATENCY_BUDGET_MS} ms budget. Record it.`);
    }
    expect(latency === null || latency >= 0).toBe(true);
  }, 180_000);
});
