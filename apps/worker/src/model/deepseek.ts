// DeepSeek, over the OpenAI-compatible Chat Completions API.
//
// The replay rule here is the opposite of Anthropic's and easy to get wrong in
// the same way: `reasoning_content` comes back on the assistant message and has
// to be sent back *verbatim* on later turns, but it is not signed, so a
// paraphrase does not fail loudly — it degrades the model's continuity in a way
// nobody can see in a diff. So the carry is stored as it arrived and this
// adapter refuses a carry produced by another transport rather than coercing
// one.
//
// `reasoning_effort` is the knob, mapped through the catalog row's effort_map.
import type { Transport } from '@hermes/shared';
import { errorFromResponse, isAbort, networkError } from './http.js';
import { parseFrameJson, readSse } from './sse.js';
import {
  ProviderError,
  ZERO_USAGE,
  defaultFetch,
  type AdapterOptions,
  type Credential,
  type ModelProvider,
  type ProviderEvent,
  type ProviderMessage,
  type StopReason,
  type StreamRequest,
  type Usage,
  type VerificationResult,
} from './types.js';

const BASE = 'https://api.deepseek.com';

interface ChatDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

interface ChatFrame {
  choices?: { index?: number; delta?: ChatDelta; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  insufficient_system_resource: 'error',
};

function toChatMessages(system: string, messages: readonly ProviderMessage[]): unknown[] {
  const out: unknown[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: message.tool_call_id, content: message.content });
      continue;
    }
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }

    const assistant: Record<string, unknown> = { role: 'assistant', content: message.content };
    if (message.reasoning) {
      if (message.reasoning.kind !== 'deepseek_reasoning_content') {
        throw new ProviderError(
          `a ${message.reasoning.kind} reasoning carry cannot be replayed to DeepSeek`,
          'permanent',
          undefined,
          'deepseek',
        );
      }
      // Verbatim. Not re-wrapped, not trimmed, not re-encoded.
      assistant.reasoning_content = message.reasoning.content;
    }
    if (message.tool_calls && message.tool_calls.length > 0) {
      assistant.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
    }
    out.push(assistant);
  }
  return out;
}

export class DeepSeekProvider implements ModelProvider {
  readonly provider = 'deepseek';
  readonly transport: Transport = 'deepseek_chat';

  constructor(private readonly options: AdapterOptions = {}) {}

  private url(path: string): string {
    const url = `${BASE}${path}`;
    return this.options.gateway ? this.options.gateway.rewrite(this.provider, url) : url;
  }

  private headers(credential: Credential): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${credential.apiKey}`,
      ...(this.options.gateway?.headers ?? {}),
    };
  }

  async listModels(credential: Credential): Promise<VerificationResult> {
    const doFetch = this.options.fetch ?? defaultFetch;
    let response: Response;
    try {
      response = await doFetch(this.url('/models'), { headers: this.headers(credential) });
    } catch (error) {
      throw networkError(error, this.provider);
    }
    if (!response.ok) throw await errorFromResponse(response, this.provider);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return { ok: true, models: (body.data ?? []).map((m) => m.id ?? '').filter(Boolean) };
  }

  async probe(credential: Credential, model: string): Promise<boolean> {
    const doFetch = this.options.fetch ?? defaultFetch;
    let response: Response;
    try {
      response = await doFetch(this.url('/chat/completions'), {
        method: 'POST',
        headers: this.headers(credential),
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
    } catch (error) {
      throw networkError(error, this.provider);
    }
    if (response.ok || response.status === 400) return true;
    if (response.status === 401) return false;
    throw await errorFromResponse(response, this.provider);
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const doFetch = this.options.fetch ?? defaultFetch;
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toChatMessages(request.system, request.messages),
      stream: true,
      // Without this the final frame carries no usage and every cost estimate
      // in the workspace silently becomes zero.
      stream_options: { include_usage: true },
    };
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.effort !== null && request.effortMap !== null) {
      const mapped = request.effortMap[request.effort];
      if (mapped === undefined) {
        throw new ProviderError(
          `effort "${request.effort}" is not in this model's effort map`,
          'permanent',
          undefined,
          this.provider,
        );
      }
      body.reasoning_effort = mapped;
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }

    let response: Response;
    try {
      response = await doFetch(this.url('/chat/completions'), {
        method: 'POST',
        headers: this.headers(request.credential),
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (error) {
      if (isAbort(error)) {
        yield { type: 'stop', reason: 'stopped' };
        return;
      }
      throw networkError(error, this.provider);
    }
    if (!response.ok) throw await errorFromResponse(response, this.provider);

    let usage: Usage = ZERO_USAGE;
    let stop: StopReason = 'end_turn';
    let reasoning = '';
    // Tool calls arrive as deltas keyed by index, and the name can be split
    // across frames as readily as the arguments, so both accumulate.
    const calls = new Map<number, { id: string; name: string; args: string }>();

    try {
      for await (const frame of readSse(response, this.provider)) {
        const event = parseFrameJson<ChatFrame>(frame, this.provider);
        if (!event) continue;

        if (event.usage) {
          usage = {
            input_tokens: event.usage.prompt_tokens ?? 0,
            output_tokens: event.usage.completion_tokens ?? 0,
            cached_input_tokens: event.usage.prompt_cache_hit_tokens ?? 0,
            reasoning_tokens: event.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          };
        }

        const choice = event.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.reasoning_content) {
          reasoning += delta.reasoning_content;
          yield { type: 'reasoning_delta', text: delta.reasoning_content };
        }
        if (delta?.content) yield { type: 'text_delta', text: delta.content };
        for (const call of delta?.tool_calls ?? []) {
          const index = call.index ?? 0;
          const open = calls.get(index) ?? { id: '', name: '', args: '' };
          if (call.id) open.id = call.id;
          if (call.function?.name) open.name += call.function.name;
          if (call.function?.arguments) open.args += call.function.arguments;
          calls.set(index, open);
        }
        if (choice.finish_reason) stop = STOP_REASONS[choice.finish_reason] ?? 'end_turn';
      }
    } catch (error) {
      if (isAbort(error)) {
        yield { type: 'stop', reason: 'stopped' };
        return;
      }
      throw networkError(error, this.provider);
    }

    for (const [, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      const args = call.args === '' ? '{}' : call.args;
      try {
        JSON.parse(args);
      } catch {
        throw new ProviderError(`tool arguments for ${call.name} are not JSON`, 'malformed', undefined, this.provider);
      }
      yield { type: 'tool_call', call: { id: call.id, name: call.name, arguments: args } };
    }

    if (reasoning !== '') {
      yield { type: 'reasoning', carry: { kind: 'deepseek_reasoning_content', content: reasoning } };
    }
    yield { type: 'usage', usage };
    yield { type: 'stop', reason: stop };
  }
}
