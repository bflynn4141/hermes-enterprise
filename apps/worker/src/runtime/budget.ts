// Hard admission controls for model calls made by an approved continuation.
//
// Ordinary runs keep the workspace-level usage controls. A run linked to an
// approval continuation additionally has to fit the exact reviewed model,
// call/output/token limits and the catalog-price estimate cap. Reservations
// happen before fetch. If a provider accepted a call but its usage cannot be
// recovered, the upper bound remains consumed rather than being released.

export interface RuntimeBudgetContext {
  readonly budgetId: string | null;
  readonly authorizationState: string;
  readonly state: string | null;
  readonly modelId: string | null;
  readonly maxOutputTokensPerCall: number | null;
  readonly contextLength: number | null;
  readonly pricingVerifiedOn: string | null;
  readonly pricing: {
    readonly input: number | null;
    readonly output: number | null;
    readonly cachedInput: number | null;
  } | null;
}

export interface RuntimeBudgetReservation {
  readonly reservationId: string;
  readonly budgetId: string;
}

export interface RuntimeUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}

export type RuntimeBudgetResolution = 'completed' | 'rejected' | 'unresolved' | 'cancelled';

export interface RuntimeBudgetDb {
  runtimeBudgetForRun?(runId: string): Promise<RuntimeBudgetContext | null>;
  reserveRuntimeBudget?(input: {
    runId: string;
    modelId: string;
    inputTokenBound: number;
    outputTokenBound: number;
    reservedCostUsd: number;
  }): Promise<RuntimeBudgetReservation>;
  reconcileRuntimeBudget?(input: {
    reservationId: string;
    resolution: RuntimeBudgetResolution;
    usage?: RuntimeUsage;
    actualCostUsd?: number;
  }): Promise<void>;
}

export class RuntimeBudgetError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'RuntimeBudgetError';
  }
}

const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const tokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function requiredPositiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Both OpenAI spellings are accepted by OpenRouter. Reserve the larger when a
 * caller supplies both, because different upstream adapters choose different
 * precedence and the smaller value would not be a safe bound.
 */
export function requestedOutputBound(value: Record<string, unknown>): number | null {
  const bounds = [requiredPositiveInt(value.max_tokens), requiredPositiveInt(value.max_completion_tokens)]
    .filter((entry): entry is number => entry !== null);
  return bounds.length === 0 ? null : Math.max(...bounds);
}

/**
 * A tokenizer-independent upper bound. Provider tokenizers are byte based, but
 * chat templates add tokens that are not present in the JSON. The fixed
 * per-message/tool allowance covers that template framing while remaining
 * deliberately conservative for budget admission.
 */
export function inputTokenUpperBound(value: Record<string, unknown>): number {
  const encoded = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const messages = Array.isArray(value.messages) ? value.messages.length : 0;
  const tools = Array.isArray(value.tools) ? value.tools.length : 0;
  return encoded + 128 * (messages + tools + 1);
}

function checkedPricing(context: RuntimeBudgetContext): {
  input: number;
  output: number;
  cachedInput: number;
} {
  if (!context.pricingVerifiedOn || !context.pricing) throw new RuntimeBudgetError('approval_budget_price_unknown');
  const { input, output, cachedInput } = context.pricing;
  if (!finiteNonNegative(input) || !finiteNonNegative(output)) {
    throw new RuntimeBudgetError('approval_budget_price_unknown');
  }
  return {
    input,
    output,
    cachedInput: finiteNonNegative(cachedInput) ? cachedInput : input,
  };
}

function roundCost(value: number): number {
  // The reservation column has eight decimals. Always round up so SQL never
  // admits a call because JavaScript rounded its upper bound down.
  return Math.ceil((value - Number.EPSILON) * 1e8) / 1e8;
}

export function maximumRuntimeCostUsd(
  context: RuntimeBudgetContext,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = checkedPricing(context);
  const inputRate = Math.max(pricing.input, pricing.cachedInput);
  return roundCost((inputTokens * inputRate + outputTokens * pricing.output) / 1_000_000);
}

export function actualRuntimeCostUsd(context: RuntimeBudgetContext, usage: RuntimeUsage): number {
  const pricing = checkedPricing(context);
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const fresh = usage.inputTokens - cached;
  return roundCost(
    (fresh * pricing.input + cached * pricing.cachedInput + usage.outputTokens * pricing.output) / 1_000_000,
  );
}

export interface PreparedRuntimeBudget {
  readonly context: RuntimeBudgetContext;
  readonly inputTokenBound: number;
  readonly outputTokenBound: number;
  readonly reservedCostUsd: number;
}

/** Null means this is an ordinary, non-continuation run. */
export async function prepareRuntimeBudget(
  db: RuntimeBudgetDb,
  runId: string,
  modelId: string,
  forwarded: Record<string, unknown>,
): Promise<PreparedRuntimeBudget | null> {
  const context = await db.runtimeBudgetForRun?.(runId);
  if (context === null || context === undefined) return null;
  if (context.authorizationState !== 'admitted') {
    throw new RuntimeBudgetError('approval_budget_authorization_stale');
  }
  if (!context.budgetId) throw new RuntimeBudgetError('approval_budget_missing');
  if (context.state !== 'active') throw new RuntimeBudgetError('approval_budget_exhausted');
  if (context.modelId !== modelId) throw new RuntimeBudgetError('approval_budget_model_mismatch');
  if (!db.reserveRuntimeBudget || !db.reconcileRuntimeBudget) {
    throw new RuntimeBudgetError('approval_budget_store_unavailable');
  }

  if (!context.maxOutputTokensPerCall) throw new RuntimeBudgetError('approval_budget_output_bound_required');
  if (forwarded.stream === true) {
    const existing = object(forwarded.stream_options) ? forwarded.stream_options : {};
    forwarded.stream_options = { ...existing, include_usage: true };
  }
  const requested = requestedOutputBound(forwarded);
  const outputTokenBound = requested ?? context.maxOutputTokensPerCall;
  // The official runtime does not promise to send an output limit on every
  // OpenAI-compatible request. Impose the reviewed limit at the proxy when it
  // omits one; an explicit larger request is refused rather than silently
  // changing a caller that believed it had more room.
  if (requested === null) forwarded.max_tokens = outputTokenBound;
  if (outputTokenBound > context.maxOutputTokensPerCall) {
    throw new RuntimeBudgetError('approval_budget_output_bound_exceeded');
  }
  const inputTokenBound = inputTokenUpperBound(forwarded);
  if (!context.contextLength || inputTokenBound + outputTokenBound > context.contextLength) {
    throw new RuntimeBudgetError('approval_budget_context_bound_unknown');
  }
  const reservedCostUsd = maximumRuntimeCostUsd(context, inputTokenBound, outputTokenBound);
  return { context, inputTokenBound, outputTokenBound, reservedCostUsd };
}

export interface ParsedProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
}

function usageFrom(value: unknown): ParsedProviderUsage | null {
  if (!object(value)) return null;
  const usage = object(value.usage) ? value.usage : value;
  const input = usage.prompt_tokens ?? usage.input_tokens;
  const output = usage.completion_tokens ?? usage.output_tokens;
  if (!tokenCount(input) || !tokenCount(output)) return null;
  const promptDetails = object(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const inputDetails = object(usage.input_tokens_details) ? usage.input_tokens_details : null;
  const cached = promptDetails?.cached_tokens ?? inputDetails?.cached_tokens ?? usage.cached_input_tokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: tokenCount(cached) ? cached : 0,
  };
}

export type ProviderStreamObservation = 'first_byte' | 'first_frame' | 'first_reasoning' | 'first_content';
export type ProviderStreamObserver = (observation: ProviderStreamObservation) => void;

const hasVisibleText = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

/** Parse OpenRouter's final streaming chunk or a non-stream JSON response. */
export class ProviderUsageParser {
  private readonly decoder = new TextDecoder();
  private lineBuffer = '';
  private jsonBuffer = '';
  private latest: ParsedProviderUsage | null = null;
  private readonly observed = new Set<ProviderStreamObservation>();

  constructor(private readonly observe?: ProviderStreamObserver) {}

  push(chunk: Uint8Array): void {
    if (chunk.byteLength > 0) this.notify('first_byte');
    const text = this.decoder.decode(chunk, { stream: true });
    // Non-stream replies are bounded by the approved output limit. The extra
    // cap prevents a malformed provider from turning accounting into a second
    // unbounded copy of its response.
    if (this.jsonBuffer.length < 1_048_576) this.jsonBuffer += text.slice(0, 1_048_576 - this.jsonBuffer.length);
    this.lineBuffer += text;
    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() ?? '';
    for (const line of lines) this.readLine(line);
  }

  finish(): ParsedProviderUsage | null {
    const tail = this.decoder.decode();
    if (tail) {
      this.lineBuffer += tail;
      if (this.jsonBuffer.length < 1_048_576) this.jsonBuffer += tail.slice(0, 1_048_576 - this.jsonBuffer.length);
    }
    if (this.lineBuffer) this.readLine(this.lineBuffer);
    if (this.latest) return this.latest;
    try {
      const value: unknown = JSON.parse(this.jsonBuffer);
      this.observeContent(value);
      return usageFrom(value);
    } catch {
      return null;
    }
  }

  private readLine(line: string): void {
    const match = /^data:\s*(.+)$/.exec(line.trim());
    if (!match || match[1] === '[DONE]') return;
    try {
      const value: unknown = JSON.parse(match[1] ?? '');
      if (object(value)) this.notify('first_frame');
      this.observeContent(value);
      const found = usageFrom(value);
      if (found) this.latest = found;
    } catch {
      // A partial/malformed data line is not trusted usage. The reservation is
      // retained as unresolved if no later authoritative usage arrives.
    }
  }

  private observeContent(value: unknown): void {
    if (!this.observe || (this.observed.has('first_reasoning') && this.observed.has('first_content'))) return;
    if (!object(value) || !Array.isArray(value.choices)) return;
    for (const choice of value.choices) {
      if (!object(choice)) continue;
      const delta = object(choice.delta) ? choice.delta : object(choice.message) ? choice.message : null;
      if (!delta) continue;
      // Role, usage, tool arguments, reasoning signatures and empty chunks are
      // not user-visible text. Inspect only text presence; never retain or emit it.
      if (hasVisibleText(delta.reasoning) || hasVisibleText(delta.reasoning_content) ||
          (Array.isArray(delta.reasoning_details) && delta.reasoning_details.some((part) =>
            object(part) && part.type === 'reasoning.text' && hasVisibleText(part.text)))) {
        this.notify('first_reasoning');
      }
      if (hasVisibleText(delta.content) ||
          (Array.isArray(delta.content) && delta.content.some((part) =>
            object(part) && part.type === 'text' && hasVisibleText(part.text)))) {
        this.notify('first_content');
      }
    }
  }

  private notify(observation: ProviderStreamObservation): void {
    if (!this.observe || this.observed.has(observation)) return;
    this.observed.add(observation);
    try { this.observe(observation); } catch { /* Telemetry cannot interrupt delivery or accounting. */ }
  }
}

/**
 * Preserve the provider byte stream while observing only usage metadata.
 * Settlement is exactly once across completion, read failure and cancellation.
 */
export function meterRuntimeResponse(
  response: Response,
  settle: (usage: ParsedProviderUsage | null) => Promise<void>,
  observe?: ProviderStreamObserver,
): Response {
  const body = response.body;
  if (!body) {
    void settle(null);
    return response;
  }
  const reader = body.getReader();
  const parser = new ProviderUsageParser(observe);
  let settled = false;
  const settleOnce = async (usage: ParsedProviderUsage | null): Promise<void> => {
    if (settled) return;
    settled = true;
    await settle(usage);
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          await settleOnce(parser.finish());
          controller.close();
          return;
        }
        parser.push(next.value);
        controller.enqueue(next.value);
      } catch (error) {
        await settleOnce(null);
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await settleOnce(null);
      }
    },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
