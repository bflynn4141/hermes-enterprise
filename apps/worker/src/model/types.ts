// The model provider interface.
//
// Every model call in this product goes through `ModelProvider.stream`. That is
// not an abstraction for its own sake: it is what makes the engine testable
// without a network, and it is where the BYOK boundary sits. The credential is
// a parameter, never a module-level secret, so a provider adapter cannot read
// one workspace's key while serving another, and `ScriptedProvider` can satisfy
// the same interface with no credential at all.
//
// Three transports, three replay rules, one interface. The rules differ enough
// that hiding them behind a lowest common denominator would lose the thing that
// matters — a reasoning block replayed wrongly is a provider error on the
// second turn of every run — so reasoning is carried through as an opaque
// per-transport payload that the adapter that produced it knows how to replay.
import type { Transport } from '@hermes/shared';

/** A provider key, resolved for exactly one request. */
export interface Credential {
  readonly provider: string;
  /** The key material. Never logged, never stored, never returned upward. */
  readonly apiKey: string;
  /** Which row it came from. This is what `model_calls` and `events` record. */
  readonly keyId: string;
}

/**
 * Reasoning carried from one turn to the next, verbatim.
 *
 * Each provider requires its own thing back, and each rejects a paraphrase:
 * Anthropic verifies the signature on a thinking block, OpenAI decrypts
 * `encrypted_content`, DeepSeek expects `reasoning_content` unchanged. So the
 * union is the three shapes rather than one normalised one, and an adapter
 * refuses a carry it did not produce.
 */
/**
 * One element of OpenRouter's `reasoning_details` array.
 *
 * Deliberately open: `type` is a documented enum today (`reasoning.text`,
 * `reasoning.summary`, `reasoning.encrypted`) and will not stay one, and the
 * contract with the provider is that we send back what we were given. A shape
 * that could not carry an unknown field would quietly drop it.
 */
export interface ReasoningDetail {
  readonly type?: string;
  readonly id?: string;
  readonly format?: string;
  index?: number;
  text?: string;
  summary?: string;
  readonly data?: string;
  readonly [key: string]: unknown;
}

export type ReasoningCarry =
  | {
      readonly kind: 'anthropic_thinking';
      /** Signed thinking blocks, replayed byte for byte with their signatures. */
      readonly blocks: readonly {
        readonly type: 'thinking' | 'redacted_thinking';
        readonly thinking?: string;
        readonly data?: string;
        readonly signature?: string;
      }[];
    }
  | { readonly kind: 'deepseek_reasoning_content'; readonly content: string }
  | {
      /**
       * OpenRouter: the ordered `reasoning_details` array, replayed unchanged.
       * The docs are explicit that the whole consecutive sequence must match
       * what the model produced, so this is a list and not a string.
       */
      readonly kind: 'openrouter_reasoning_details';
      readonly details: readonly ReasoningDetail[];
    }
  | {
      readonly kind: 'openai_encrypted';
      readonly items: readonly { readonly id?: string; readonly encrypted_content: string }[];
    };

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  /** Raw JSON text as the model emitted it. Parsed by the caller, not here. */
  readonly arguments: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export interface ProviderMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  /** Set on a `tool` message: which call this is the result of. */
  readonly tool_call_id?: string;
  /** Set on an `assistant` message that asked for tools. */
  readonly tool_calls?: readonly ToolCall[];
  /** Set on an `assistant` message that reasoned. Replayed verbatim. */
  readonly reasoning?: ReasoningCarry;
}

export interface Usage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens: number;
  readonly reasoning_tokens: number;
}

export const ZERO_USAGE: Usage = {
  input_tokens: 0,
  output_tokens: 0,
  cached_input_tokens: 0,
  reasoning_tokens: 0,
};

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'stopped' | 'error';

/**
 * What a stream yields.
 *
 * `reasoning` arrives once, at the end of the reasoning, carrying the payload
 * the next turn has to replay; `reasoning_delta` is the human-visible text as
 * it arrives. They are separate events because only one of them is a contract
 * with the provider — the deltas are for the reader, the carry is for the
 * protocol, and a reducer that confused the two would replay prose.
 */
export type ProviderEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'reasoning_delta'; readonly text: string }
  | { readonly type: 'reasoning'; readonly carry: ReasoningCarry }
  | { readonly type: 'tool_call'; readonly call: ToolCall }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'stop'; readonly reason: StopReason };

export interface StreamRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ToolDefinition[];
  /**
   * Our effort name. The adapter maps it through the catalog row's
   * `effort_map`; a model whose `effort_map` is null ignores it.
   *
   * Held constant for the whole run. Anthropic rejects a replayed thinking
   * block when the thinking configuration changed mid-conversation, so effort
   * is a property of the run, not of the turn.
   */
  readonly effort: string | null;
  /** The catalog row's `effort_map`, or null when effort is fixed. */
  readonly effortMap: Readonly<Record<string, string>> | null;
  readonly maxTokens?: number;
  readonly credential: Credential;
  /** Stop and the step timeout both arrive here. */
  readonly signal?: AbortSignal;
}

/** How a failure should be handled, decided by the adapter that saw it. */
export type FailureClass =
  /** A provider 401. Permanent for this key; the key is marked invalid. */
  | 'auth'
  /** 429. Transient, and the banner names whose limit it is. */
  | 'rate_limit'
  /** 5xx, a timeout, a torn stream. Retried by the Workflow step. */
  | 'transient'
  /** A 400 we caused: a bad request body, an unsupported parameter. */
  | 'permanent'
  /** The model emitted tool arguments that are not JSON. */
  | 'malformed';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly failure: FailureClass,
    readonly status?: number,
    readonly provider?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Whether the Workflow step should throw a retryable error. */
  get retryable(): boolean {
    return this.failure === 'transient' || this.failure === 'rate_limit';
  }
}

/** What a verification probe learned. */
export interface VerificationResult {
  /** 200 from list-models. */
  readonly ok: boolean;
  readonly models: readonly string[];
}

export interface ModelProvider {
  readonly provider: string;
  readonly transport: Transport;
  stream(request: StreamRequest): AsyncIterable<ProviderEvent>;
  /** The free list-models endpoint. Used by verification, never by a run. */
  listModels(credential: Credential): Promise<VerificationResult>;
  /**
   * A 1-token completion, for a scoped key that list-models refuses. Resolving
   * true means the key works for inference even though it cannot enumerate.
   */
  probe(credential: Credential, model: string): Promise<boolean>;
}

/** Injected so unit tests mock it. Adapters never reach for a global `fetch`. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AdapterOptions {
  readonly fetch?: FetchLike;
  /** Non-null when MODEL_GATEWAY_MODE routes this provider through a gateway. */
  readonly gateway?: GatewayRouting | null;
}

export interface GatewayRouting {
  /** Rewrites a provider's base URL to the gateway's passthrough URL. */
  readonly rewrite: (provider: string, url: string) => string;
  /** Headers the gateway needs, including the logging-off header. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The default transport, which refuses to follow a redirect.
 *
 * Every adapter puts the workspace's provider key in a header (`x-api-key` for
 * Anthropic, `Authorization: Bearer` for the OpenAI-shaped ones). workerd's
 * `fetch` does not implement the browser's rule about stripping credentials on
 * a cross-origin redirect, so with the default `redirect: 'follow'` a 30x from
 * a provider host — an open redirect on it, or a hijacked resolution of it —
 * would replay a customer's key to wherever the `Location` pointed. There is no
 * legitimate 3xx on these endpoints, so `manual` turns the whole class into an
 * ordinary `ProviderError` from `errorFromResponse` instead.
 *
 * `security/fetch-url.ts` already validates every hop for the same reason; this
 * is the same rule on the path that carries a credential rather than a URL.
 */
export const defaultFetch: FetchLike = (input, init) => fetch(input, { ...init, redirect: 'manual' });
