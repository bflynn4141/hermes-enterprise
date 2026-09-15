// Anthropic Messages API, streaming.
//
// The replay rule this adapter exists to keep: a thinking block comes back with
// a `signature`, and the next turn must send that block back byte for byte,
// signature included, with the thinking configuration unchanged. So `effort` is
// a property of the run rather than of the turn — the engine holds it constant
// for every turn of a run — and a redacted thinking block is replayed as
// `redacted_thinking` with its opaque `data`, not dropped. Dropping it is the
// failure that looks like it works: the first turn is fine and the second is a
// 400 the user cannot act on.
//
// Effort maps to a thinking token budget. The catalog row's `effort_map` names
// which effort levels the model offers; the budget table below turns the mapped
// name into the number the API wants, in one place, so a model that gains a
// level needs a catalog row change and not a code change.
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
  type ReasoningCarry,
  type StopReason,
  type StreamRequest,
  type Usage,
  type VerificationResult,
} from './types.js';

const BASE = 'https://api.anthropic.com';
const VERSION = '2023-06-01';

/** Thinking budget in tokens, per mapped effort name. */
const THINKING_BUDGET: Readonly<Record<string, number>> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  max: 32_768,
};

const DEFAULT_MAX_TOKENS = 8_192;

interface AnthropicBlock {
  type: string;
  text?: string;
  thinking?: string;
  data?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  partial_json?: string;
}

interface AnthropicFrame {
  type: string;
  index?: number;
  delta?: AnthropicBlock & { stop_reason?: string; text?: string; thinking?: string; partial_json?: string };
  content_block?: AnthropicBlock;
  message?: { usage?: Record<string, number>; stop_reason?: string };
  usage?: Record<string, number>;
  error?: { type?: string };
}

const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  stop_sequence: 'end_turn',
  refusal: 'end_turn',
};

/** Our neutral messages, rendered as Anthropic content blocks. */
function toAnthropicMessages(messages: readonly ProviderMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      // A tool result is a user-role message in this API, which is why the
      // neutral shape carries `tool_call_id` rather than assuming a role.
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }],
      });
      continue;
    }
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content });
      continue;
    }

    const content: unknown[] = [];
    // Thinking blocks go first and unchanged. Order matters to the API, and the
    // signature covers the block as it was emitted.
    if (message.reasoning) {
      if (message.reasoning.kind !== 'anthropic_thinking') {
        throw new ProviderError(
          `a ${message.reasoning.kind} reasoning carry cannot be replayed to Anthropic`,
          'permanent',
          undefined,
          'anthropic',
        );
      }
      for (const block of message.reasoning.blocks) {
        content.push(
          block.type === 'redacted_thinking'
            ? { type: 'redacted_thinking', data: block.data }
            : { type: 'thinking', thinking: block.thinking, signature: block.signature },
        );
      }
    }
    if (message.content !== '') content.push({ type: 'text', text: message.content });
    for (const call of message.tool_calls ?? []) {
      content.push({ type: 'tool_use', id: call.id, name: call.name, input: safeJson(call.arguments, call.name) });
    }
    out.push({ role: 'assistant', content });
  }
  return out;
}

function safeJson(text: string, toolName: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError(`tool arguments for ${toolName} are not JSON`, 'malformed', undefined, 'anthropic');
  }
}

function thinkingConfig(request: StreamRequest): Record<string, unknown> | undefined {
  if (request.effort === null || request.effortMap === null) return undefined;
  const mapped = request.effortMap[request.effort];
  if (mapped === undefined) {
    throw new ProviderError(
      `effort "${request.effort}" is not in this model's effort map`,
      'permanent',
      undefined,
      'anthropic',
    );
  }
  const budget = THINKING_BUDGET[mapped];
  if (budget === undefined) return undefined;
  return { type: 'enabled', budget_tokens: budget };
}

function usageFrom(raw: Record<string, number> | undefined, previous: Usage): Usage {
  if (!raw) return previous;
  return {
    input_tokens: raw.input_tokens ?? previous.input_tokens,
    output_tokens: raw.output_tokens ?? previous.output_tokens,
    cached_input_tokens: (raw.cache_read_input_tokens ?? 0) || previous.cached_input_tokens,
    // The Messages API bills thinking as output tokens and does not break them
    // out, so this stays 0 rather than being invented: a number we cannot get
    // is worse than a number we admit we do not have.
    reasoning_tokens: previous.reasoning_tokens,
  };
}

export class AnthropicProvider implements ModelProvider {
  readonly provider = 'anthropic';
  readonly transport: Transport = 'anthropic_messages';

  constructor(private readonly options: AdapterOptions = {}) {}

  private url(path: string): string {
    const url = `${BASE}${path}`;
    return this.options.gateway ? this.options.gateway.rewrite(this.provider, url) : url;
  }

  private headers(credential: Credential): Record<string, string> {
    return {
      'content-type': 'application/json',
      'anthropic-version': VERSION,
      'x-api-key': credential.apiKey,
      ...(this.options.gateway?.headers ?? {}),
    };
  }

  async listModels(credential: Credential): Promise<VerificationResult> {
    const doFetch = this.options.fetch ?? defaultFetch;
    let response: Response;
    try {
      response = await doFetch(this.url('/v1/models?limit=100'), { headers: this.headers(credential) });
    } catch (error) {
      throw networkError(error, this.provider);
    }
    if (!response.ok) throw await errorFromResponse(response, this.provider);
    const body = (await response.json()) as { data?: { id?: string }[] };
    return { ok: true, models: (body.data ?? []).map((m) => m.id ?? '').filter(Boolean) };
  }

  /**
   * The scoped-key probe: one token, no tools, no thinking. A key that can
   * infer but not enumerate answers 200 here and 403 on /v1/models, which is
   * exactly the case the plan calls "verified (scoped)".
   */
  async probe(credential: Credential, model: string): Promise<boolean> {
    const doFetch = this.options.fetch ?? defaultFetch;
    let response: Response;
    try {
      response = await doFetch(this.url('/v1/messages'), {
        method: 'POST',
        headers: this.headers(credential),
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      });
    } catch (error) {
      throw networkError(error, this.provider);
    }
    if (response.ok) return true;
    // A 400 here means the request was wrong, not the key: `max_tokens: 1` can
    // trip a model minimum. The key is still good, so say so.
    if (response.status === 400) return true;
    if (response.status === 401) return false;
    throw await errorFromResponse(response, this.provider);
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const doFetch = this.options.fetch ?? defaultFetch;
    const thinking = thinkingConfig(request);
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
      system: request.system,
      messages: toAnthropicMessages(request.messages),
      stream: true,
    };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));
    }
    if (thinking) body.thinking = thinking;

    let response: Response;
    try {
      response = await doFetch(this.url('/v1/messages'), {
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
    const thinkingBlocks: { type: 'thinking' | 'redacted_thinking'; thinking?: string; data?: string; signature?: string }[] =
      [];
    const partial = new Map<number, { id: string; name: string; json: string }>();
    let current: { index: number; kind: 'thinking'; text: string } | null = null;

    try {
      for await (const frame of readSse(response, this.provider)) {
        const event = parseFrameJson<AnthropicFrame>(frame, this.provider);
        if (!event) continue;

        switch (event.type) {
          case 'message_start':
            usage = usageFrom(event.message?.usage, usage);
            break;

          case 'content_block_start': {
            const block = event.content_block;
            if (!block) break;
            if (block.type === 'tool_use') {
              partial.set(event.index ?? 0, { id: block.id ?? '', name: block.name ?? '', json: '' });
            } else if (block.type === 'thinking') {
              current = { index: event.index ?? 0, kind: 'thinking', text: '' };
            } else if (block.type === 'redacted_thinking') {
              // Opaque by design: carried, never rendered.
              thinkingBlocks.push({ type: 'redacted_thinking', data: block.data });
            }
            break;
          }

          case 'content_block_delta': {
            const delta = event.delta;
            if (!delta) break;
            if (delta.type === 'text_delta' && delta.text) {
              yield { type: 'text_delta', text: delta.text };
            } else if (delta.type === 'thinking_delta' && delta.thinking) {
              if (current) current.text += delta.thinking;
              yield { type: 'reasoning_delta', text: delta.thinking };
            } else if (delta.type === 'signature_delta' && delta.signature) {
              // The signature arrives after the thinking text; both belong to
              // the same block, and replaying one without the other is a 400.
              thinkingBlocks.push({ type: 'thinking', thinking: current?.text ?? '', signature: delta.signature });
              current = null;
            } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
              const open = partial.get(event.index ?? 0);
              if (open) open.json += delta.partial_json;
            }
            break;
          }

          case 'content_block_stop': {
            const open = partial.get(event.index ?? 0);
            if (open) {
              partial.delete(event.index ?? 0);
              // Validated here so a malformed call fails as `malformed` rather
              // than as an exception inside the tool step.
              try {
                JSON.parse(open.json === '' ? '{}' : open.json);
              } catch {
                throw new ProviderError(
                  `tool arguments for ${open.name} are not JSON`,
                  'malformed',
                  undefined,
                  this.provider,
                );
              }
              yield { type: 'tool_call', call: { id: open.id, name: open.name, arguments: open.json || '{}' } };
            }
            break;
          }

          case 'message_delta':
            usage = usageFrom(event.usage, usage);
            if (event.delta?.stop_reason) stop = STOP_REASONS[event.delta.stop_reason] ?? 'end_turn';
            break;

          case 'error':
            throw new ProviderError(
              `anthropic sent an error frame (${event.error?.type ?? 'unknown'})`,
              'transient',
              undefined,
              this.provider,
            );

          default:
            break;
        }
      }
    } catch (error) {
      if (isAbort(error)) {
        yield { type: 'stop', reason: 'stopped' };
        return;
      }
      throw networkError(error, this.provider);
    }

    if (thinkingBlocks.length > 0) {
      const carry: ReasoningCarry = { kind: 'anthropic_thinking', blocks: thinkingBlocks };
      yield { type: 'reasoning', carry };
    }
    yield { type: 'usage', usage };
    yield { type: 'stop', reason: stop };
  }
}
