// The provider the tests use.
//
// Every test in this repository that exercises the engine, a route or a failure
// path uses this and never the network. That is a rule, not a convenience: a
// test that reaches api.anthropic.com is a test that fails when someone else's
// service has an incident, needs a real key to run, and cannot express "the
// stream tore at 40 percent" at all.
//
// A script is a plain array of events plus an optional failure, so a scenario
// reads as the thing it is testing: `SCRIPTS.transient_then_success` is two
// attempts, the first a 503, and the assertion is that the run completes.
import type { Transport } from '@hermes/shared';
import {
  ProviderError,
  ZERO_USAGE,
  type Credential,
  type ModelProvider,
  type ProviderEvent,
  type StreamRequest,
  type VerificationResult,
} from './types.js';

export interface Script {
  /** Yielded in order. */
  readonly events: readonly ProviderEvent[];
  /** Thrown after `events` have been yielded. A partial stream, then a tear. */
  readonly throwAfter?: ProviderError;
  /** What `listModels` does. Verification tests drive this. */
  readonly listModels?: { readonly status: number; readonly models?: readonly string[] };
  /** What `probe` returns. Used for the scoped-key path. */
  readonly probe?: boolean;
}

const usage = (input: number, output: number): ProviderEvent => ({
  type: 'usage',
  usage: { ...ZERO_USAGE, input_tokens: input, output_tokens: output },
});

/**
 * The five scenarios the plan names as engine tests, written once so that the
 * engine, route and client tests all assert against the same fixtures.
 */
export const SCRIPTS = {
  /** A completed run with one tool call: the ordinary path. */
  completed_with_tool_call: {
    events: [
      { type: 'text_delta', text: 'Checking the application. ' },
      { type: 'tool_call', call: { id: 'call_1', name: 'propose_request', arguments: '{"kind":"application"}' } },
      usage(1200, 64),
      { type: 'stop', reason: 'tool_use' },
    ],
    listModels: { status: 200, models: ['deepseek-flash'] },
  },

  /** A transient 5xx. The Workflow step retries and the second attempt runs. */
  transient_5xx: {
    events: [],
    throwAfter: new ProviderError('scripted 503', 'transient', 503, 'scripted'),
  },

  /** A provider 401. Permanent: the key is marked invalid and runs stop. */
  unauthorized: {
    events: [],
    throwAfter: new ProviderError('scripted 401', 'auth', 401, 'scripted'),
    listModels: { status: 401 },
  },

  /** Tool arguments that are not JSON. The turn fails as `malformed`. */
  malformed_tool_json: {
    events: [{ type: 'text_delta', text: 'Calling a tool. ' }],
    throwAfter: new ProviderError('tool arguments for propose_request are not JSON', 'malformed', undefined, 'scripted'),
  },

  /** Deltas, then the stream tears. Nothing after `text_delta` is emitted. */
  partial_stream: {
    events: [
      { type: 'text_delta', text: 'The applicant lists three ' },
      { type: 'text_delta', text: 'references, of which ' },
    ],
    throwAfter: new ProviderError('scripted: the stream ended mid-frame', 'transient', undefined, 'scripted'),
  },

  /** A scoped key: list-models is forbidden, a 1-token probe succeeds. */
  scoped_key: {
    events: [usage(10, 1), { type: 'stop', reason: 'end_turn' }],
    listModels: { status: 403 },
    probe: true,
  },
} as const satisfies Record<string, Script>;

export type ScriptName = keyof typeof SCRIPTS;

/**
 * A deterministic provider.
 *
 * `attempts` is how the retry scenarios work: pass a list of scripts and each
 * call to `stream` takes the next one, so "transient then success" is
 * `new ScriptedProvider([SCRIPTS.transient_5xx, SCRIPTS.completed_with_tool_call])`
 * and the last script repeats once the list runs out.
 */
export class ScriptedProvider implements ModelProvider {
  readonly provider = 'scripted';
  readonly transport: Transport;
  /** Every request this provider was handed. Assertions read it. */
  readonly calls: StreamRequest[] = [];
  private index = 0;

  constructor(
    private readonly scripts: readonly Script[],
    transport: Transport = 'deepseek_chat',
  ) {
    if (scripts.length === 0) throw new Error('a ScriptedProvider needs at least one script');
    this.transport = transport;
  }

  /** The script the next `stream`, `listModels` or `probe` will use. */
  private next(): Script {
    const script = this.scripts[Math.min(this.index, this.scripts.length - 1)] as Script;
    this.index += 1;
    return script;
  }

  private peek(): Script {
    return this.scripts[Math.min(this.index, this.scripts.length - 1)] as Script;
  }

  async *stream(request: StreamRequest): AsyncGenerator<ProviderEvent> {
    this.calls.push(request);
    const script = this.next();
    for (const event of script.events) {
      // Stop is honoured between events, which is exactly where the real
      // adapters honour it: at a delta boundary.
      if (request.signal?.aborted) {
        yield { type: 'stop', reason: 'stopped' };
        return;
      }
      yield event;
      await Promise.resolve();
    }
    if (script.throwAfter) throw script.throwAfter;
  }

  listModels(_credential: Credential): Promise<VerificationResult> {
    const script = this.next();
    const result = script.listModels ?? { status: 200, models: [] };
    if (result.status === 200) return Promise.resolve({ ok: true, models: result.models ?? [] });
    return Promise.reject(
      new ProviderError(
        `scripted ${result.status}`,
        result.status === 401 || result.status === 403
          ? 'auth'
          : result.status === 429
            ? 'rate_limit'
            : result.status >= 500
              ? 'transient'
              : 'permanent',
        result.status,
        this.provider,
      ),
    );
  }

  probe(_credential: Credential, _model: string): Promise<boolean> {
    return Promise.resolve(this.peek().probe ?? true);
  }
}
