// OpenRouter, over its OpenAI-compatible Chat Completions API.
//
// Docs this adapter is written against (fetched 2026-09-15, cited in
// docs/DECISIONS.md R2-R5):
//   https://openrouter.ai/docs/api-reference/streaming
//   https://openrouter.ai/docs/use-cases/reasoning-tokens
//   https://openrouter.ai/docs/api-reference/errors
//   https://openrouter.ai/docs/api-reference/overview   (models, key)
//
// Three things make this its own transport rather than a second DeepSeek:
//
//   1. The replay rule. OpenRouter returns `reasoning_details`, an *ordered
//      array* of typed blocks (`reasoning.text`, `reasoning.summary`,
//      `reasoning.encrypted`), and the docs are explicit that the entire
//      sequence of consecutive reasoning blocks must be sent back unchanged and
//      unreordered. DeepSeek's rule is a single string. Collapsing the two
//      would silently drop an encrypted block, which is the failure mode that
//      only shows up on the second turn of a tool-using run.
//   2. The knob. `reasoning: { effort }`, not `reasoning_effort`.
//   3. The error table. 402 means the *workspace's* OpenRouter account is out
//      of credits, which no other provider in this product can say, and which
//      is permanent until a human tops it up.
//
// The model id on the wire is the catalog id with the `openrouter:` prefix
// removed (decision R1). Nothing above this file knows that.
import { openRouterModelId, type Transport } from '@hermes/shared';
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
  type ReasoningDetail,
  type StopReason,
  type StreamRequest,
  type Usage,
  type VerificationResult,
} from './types.js';

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * Attribution headers. OpenRouter ranks apps by these and they are the only
 * thing that makes a workspace's own OpenRouter dashboard say where the spend
 * came from. Constants, not configuration: they identify this product, not this
 * deployment, and a header assembled from a variable is one more place a value
 * could arrive from a request.
 */
export const ATTRIBUTION_HEADERS: Readonly<Record<string, string>> = {
  'HTTP-Referer': 'https://hermes.enterprise',
  'X-Title': 'Hermes Enterprise',
};

/** OpenRouter's 402: the account is out of credits. Permanent, with copy. */
export class OpenRouterCreditsError extends ProviderError {
  constructor() {
    super(
      'Your OpenRouter account is out of credits. Add credit at openrouter.ai/credits, then run again.',
      'permanent',
      402,
      'openrouter',
    );
    this.name = 'OpenRouterCreditsError';
  }
}

/**
 * The status table, from the errors page.
 *
 *   401  invalid or disabled key      -> auth (the key is marked invalid)
 *   402  out of credits               -> permanent, with copy a human can act on
 *   403  moderation or permissions    -> auth, which is also what makes the
 *                                        scoped-key probe in keys/verify fire
 *   408  timed out                    -> transient
 *   429  rate limited                 -> transient (retryable), `Retry-After`
 *   502  upstream model down          -> transient
 *   503  no provider meets routing    -> transient
 *
 * Everything else falls through to the shared `classifyStatus`, so a 400 we
 * caused stays permanent.
 */
export async function openRouterError(response: Response): Promise<ProviderError> {
  if (response.status === 402) {
    // The body is not read: it is prose, and prose from a provider is the one
    // thing `http.ts` refuses to carry into an error string.
    try {
      await response.text();
    } catch {
      // Nothing to learn from a body that will not read.
    }
    return new OpenRouterCreditsError();
  }
  const error = await errorFromResponse(response, 'openrouter');
  if (response.status === 502 || response.status === 503) {
    return new ProviderError(error.message, 'transient', response.status, 'openrouter');
  }
  return error;
}

interface ChatDelta {
  content?: string | null;
  reasoning?: string | null;
  reasoning_details?: ReasoningDetail[] | null;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
}

interface ChatFrame {
  error?: { code?: number; message?: string } | null;
  choices?: { index?: number; delta?: ChatDelta; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
}

const STOP_REASONS: Readonly<Record<string, StopReason>> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  length: 'max_tokens',
  content_filter: 'error',
  error: 'error',
};

/**
 * Our messages, as OpenRouter's chat messages.
 *
 * The reasoning carry is written back as `reasoning_details` in the order it
 * arrived. Not re-typed, not merged, not filtered: an `reasoning.encrypted`
 * block is opaque by construction and a `reasoning.summary` block that we
 * helpfully dropped would break the "entire sequence must match" rule the docs
 * state, which fails as a 400 on the turn *after* the one you are debugging.
 */
export function toChatMessages(system: string, messages: readonly ProviderMessage[]): unknown[] {
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
      if (message.reasoning.kind !== 'openrouter_reasoning_details') {
        throw new ProviderError(
          `a ${message.reasoning.kind} reasoning carry cannot be replayed to OpenRouter`,
          'permanent',
          undefined,
          'openrouter',
        );
      }
      if (message.reasoning.details.length > 0) {
        assistant.reasoning_details = message.reasoning.details;
      }
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

/**
 * Merge streamed `reasoning_details` into one ordered list.
 *
 * Blocks arrive with an `index`; the same index across frames is one block
 * whose `text`/`summary` is being appended to. `data` (the encrypted payload)
 * is replaced rather than appended, because it arrives whole.
 */
export function mergeReasoningDetails(
  into: Map<number, ReasoningDetail>,
  details: readonly ReasoningDetail[],
): void {
  let fallbackIndex = into.size;
  for (const detail of details) {
    const index = typeof detail.index === 'number' ? detail.index : fallbackIndex++;
    const open = into.get(index);
    if (!open) {
      into.set(index, { ...detail, index });
      continue;
    }
    const merged: ReasoningDetail = { ...open, ...detail, index };
    if (typeof detail.text === 'string') merged.text = `${open.text ?? ''}${detail.text}`;
    if (typeof detail.summary === 'string') merged.summary = `${open.summary ?? ''}${detail.summary}`;
    into.set(index, merged);
  }
}

export class OpenRouterProvider implements ModelProvider {
  readonly provider = 'openrouter';
  readonly transport: Transport = 'openrouter_chat';

  constructor(private readonly options: AdapterOptions = {}) {}

  private url(path: string): string {
    const url = `${OPENROUTER_BASE}${path}`;
    return this.options.gateway ? this.options.gateway.rewrite(this.provider, url) : url;
  }

  private headers(credential: Credential): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${credential.apiKey}`,
      ...ATTRIBUTION_HEADERS,
      ...(this.options.gateway?.headers ?? {}),
    };
  }

  /**
   * `GET /api/v1/key`, not `/models`.
   *
   * `/models` on OpenRouter is public: it answers 200 to an invalid key, a
   * revoked key and no key at all, so verifying against it would mark every
   * string a person pasted as `verified`. `/api/v1/key` is the endpoint that
   * actually authenticates, and it answers 401 for a key that does not work —
   * which is the semantics `keys/verify.ts` already has a table for.
   *
   * The model list a workspace can reach is not this call's job: it comes from
   * the catalog sync, which runs after a successful verification and writes
   * rows rather than a text[] on the key (decision R7).
   */
  async listModels(credential: Credential): Promise<VerificationResult> {
    const doFetch = this.options.fetch ?? defaultFetch;
    let response: Response;
    try {
      response = await doFetch(this.url('/key'), { headers: this.headers(credential) });
    } catch (error) {
      throw networkError(error, this.provider);
    }
    if (!response.ok) throw await openRouterError(response);
    // The label is the only field read, and it is not returned upward: the body
    // also carries usage and limits, which are the account's business.
    await response.json().catch(() => null);
    return { ok: true, models: [] };
  }

  /** A 1-token completion, for the scoped-key path `keys/verify.ts` owns. */
  async probe(credential: Credential, model: string): Promise<boolean> {
    const doFetch = this.options.fetch ?? defaultFetch;
    let response: Response;
    try {
      response = await doFetch(this.url('/chat/completions'), {
        method: 'POST',
        headers: this.headers(credential),
        body: JSON.stringify({
          model: openRouterModelId(model) ?? model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
    } catch (error) {
      throw networkError(error, this.provider);
    }
    if (response.ok || response.status === 400) return true;
    if (response.status === 401) return false;
    throw await openRouterError(response);
  }

  /** The public model list. No credential: OpenRouter serves it to anyone. */
  async listCatalog(credential: Credential | null = null): Promise<unknown> {
    const doFetch = this.options.fetch ?? defaultFetch;
    let response: Response;
    try {
      response = await doFetch(this.url('/models'), {
        headers: credential
          ? this.headers(credential)
          : { 'content-type': 'application/json', ...ATTRIBUTION_HEADERS },
      });
    } catch (error) {
      throw networkError(error, this.provider);
    }
    if (!response.ok) throw await openRouterError(response);
    return response.json();
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    const doFetch = this.options.fetch ?? defaultFetch;
    const body: Record<string, unknown> = {
      model: openRouterModelId(request.model) ?? request.model,
      messages: toChatMessages(request.system, request.messages),
      stream: true,
      // Without this the final chunk carries no usage and every cost estimate
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
      // The object form, per the reasoning-tokens page. `exclude` is left unset:
      // we want the details back, because the next turn has to replay them.
      body.reasoning = { effort: mapped };
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
    if (!response.ok) throw await openRouterError(response);

    let usage: Usage = ZERO_USAGE;
    let stop: StopReason = 'end_turn';
    const reasoning = new Map<number, ReasoningDetail>();
    const calls = new Map<number, { id: string; name: string; args: string }>();

    try {
      for await (const frame of readSse(response, this.provider)) {
        const event = parseFrameJson<ChatFrame>(frame, this.provider);
        if (!event) continue;

        // OpenRouter can answer 200 and then put the failure in the stream —
        // a moderation block, or a chosen upstream going down mid-route. A
        // stream that ends with an error object and no `finish_reason` would
        // otherwise look like a short but successful answer.
        if (event.error) {
          const status = typeof event.error.code === 'number' ? event.error.code : 502;
          if (status === 402) throw new OpenRouterCreditsError();
          throw new ProviderError(
            `openrouter reported ${status} mid-stream`,
            status === 401 || status === 403 ? 'auth' : status === 429 ? 'rate_limit' : 'transient',
            status,
            this.provider,
          );
        }

        if (event.usage) {
          usage = {
            input_tokens: event.usage.prompt_tokens ?? 0,
            output_tokens: event.usage.completion_tokens ?? 0,
            cached_input_tokens: event.usage.prompt_tokens_details?.cached_tokens ?? 0,
            reasoning_tokens: event.usage.completion_tokens_details?.reasoning_tokens ?? 0,
          };
        }

        const choice = event.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta;
        if (delta?.reasoning) yield { type: 'reasoning_delta', text: delta.reasoning };
        if (delta?.reasoning_details && delta.reasoning_details.length > 0) {
          mergeReasoningDetails(reasoning, delta.reasoning_details);
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
      if (error instanceof ProviderError) throw error;
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

    if (reasoning.size > 0) {
      const details = [...reasoning.entries()].sort((a, b) => a[0] - b[0]).map(([, detail]) => detail);
      yield { type: 'reasoning', carry: { kind: 'openrouter_reasoning_details', details } };
    }
    yield { type: 'usage', usage };
    yield { type: 'stop', reason: stop };
  }
}
