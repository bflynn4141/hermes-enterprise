// OpenAI, over the Responses API.
//
// Three things make this transport different, and all three are why the plan
// names it separately rather than reusing the Chat Completions adapter:
//
//   `store: false`       we do not let the provider retain the conversation.
//                        That is the whole point of the erasure inventory: a
//                        store we cannot delete from is a store we cannot
//                        answer a DSAR about.
//   `include` encrypted  because nothing is stored, reasoning has to come back
//     reasoning          to us as `reasoning.encrypted_content` and be replayed
//                        on the next turn. With `store: false` and no replay,
//                        the model starts every turn from nothing.
//   `reasoning.effort`   the effort knob, mapped through the catalog row.
//
// The encrypted content is opaque and is carried verbatim, like Anthropic's
// signature: it is a contract with the provider, not text.
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

const BASE = 'https://api.openai.com';

interface ResponsesFrame {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    encrypted_content?: string;
  };
  response?: {
    status?: string;
    incomplete_details?: { reason?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
  };
  error?: { type?: string };
}

function toResponsesInput(messages: readonly ProviderMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
      continue;
    }
    if (message.role === 'user') {
      input.push({ role: 'user', content: [{ type: 'input_text', text: message.content }] });
      continue;
    }

    // Reasoning items are replayed before the message they belong to, in the
    // order the provider produced them.
    if (message.reasoning) {
      if (message.reasoning.kind !== 'openai_encrypted') {
        throw new ProviderError(
          `a ${message.reasoning.kind} reasoning carry cannot be replayed to OpenAI`,
          'permanent',
          undefined,
          'openai',
        );
      }
      for (const item of message.reasoning.items) {
        input.push({
          type: 'reasoning',
          ...(item.id === undefined ? {} : { id: item.id }),
          summary: [],
          encrypted_content: item.encrypted_content,
        });
      }
    }
    if (message.content !== '') {
      input.push({ role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
    }
    for (const call of message.tool_calls ?? []) {
      input.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
    }
  }
  return input;
}

export class OpenAiProvider implements ModelProvider {
  readonly provider = 'openai';
  readonly transport: Transport = 'openai_responses';

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
      response = await doFetch(this.url('/v1/models'), { headers: this.headers(credential) });
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
      response = await doFetch(this.url('/v1/responses'), {
        method: 'POST',
        headers: this.headers(credential),
        body: JSON.stringify({ model, max_output_tokens: 16, store: false, input: 'hi' }),
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
      instructions: request.system,
      input: toResponsesInput(request.messages),
      stream: true,
      // Never stored by the provider, so never something we cannot erase.
      store: false,
      include: ['reasoning.encrypted_content'],
    };
    if (request.maxTokens !== undefined) body.max_output_tokens = request.maxTokens;
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
      body.reasoning = { effort: mapped };
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }));
    }

    let response: Response;
    try {
      response = await doFetch(this.url('/v1/responses'), {
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
    let sawToolCall = false;
    const reasoningItems: { id?: string; encrypted_content: string }[] = [];

    try {
      for await (const frame of readSse(response, this.provider)) {
        const event = parseFrameJson<ResponsesFrame>(frame, this.provider);
        if (!event) continue;

        switch (event.type) {
          case 'response.output_text.delta':
            if (event.delta) yield { type: 'text_delta', text: event.delta };
            break;

          case 'response.reasoning_summary_text.delta':
            if (event.delta) yield { type: 'reasoning_delta', text: event.delta };
            break;

          case 'response.output_item.done': {
            const item = event.item;
            if (!item) break;
            if (item.type === 'reasoning' && item.encrypted_content) {
              reasoningItems.push({
                ...(item.id === undefined ? {} : { id: item.id }),
                encrypted_content: item.encrypted_content,
              });
            } else if (item.type === 'function_call') {
              const args = item.arguments && item.arguments !== '' ? item.arguments : '{}';
              try {
                JSON.parse(args);
              } catch {
                throw new ProviderError(
                  `tool arguments for ${item.name ?? 'a tool'} are not JSON`,
                  'malformed',
                  undefined,
                  this.provider,
                );
              }
              sawToolCall = true;
              yield {
                type: 'tool_call',
                call: { id: item.call_id ?? item.id ?? '', name: item.name ?? '', arguments: args },
              };
            }
            break;
          }

          case 'response.completed':
          case 'response.incomplete': {
            const u = event.response?.usage;
            if (u) {
              usage = {
                input_tokens: u.input_tokens ?? 0,
                output_tokens: u.output_tokens ?? 0,
                cached_input_tokens: u.input_tokens_details?.cached_tokens ?? 0,
                reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0,
              };
            }
            if (event.response?.incomplete_details?.reason === 'max_output_tokens') stop = 'max_tokens';
            break;
          }

          case 'response.failed':
          case 'error':
            throw new ProviderError(
              `openai sent an error frame (${event.error?.type ?? 'unknown'})`,
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

    if (sawToolCall && stop === 'end_turn') stop = 'tool_use';
    if (reasoningItems.length > 0) {
      yield { type: 'reasoning', carry: { kind: 'openai_encrypted', items: reasoningItems } };
    }
    yield { type: 'usage', usage };
    yield { type: 'stop', reason: stop };
  }
}
