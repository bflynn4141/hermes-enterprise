// The run engine's Workflow: one instance per run attempt.
//
// The class is deliberately thin. Everything that decides anything lives in
// `src/engine/`, behind an `EngineStep` interface that the Node test harness
// can implement, because a tool loop that can only be exercised inside workerd
// is a tool loop whose failure taxonomy nobody tests. What is here is the
// wiring: the real `step`, an `AgentDb` on the `agent` Hyperdrive config, the
// provider adapter for the model's transport, and the SessionHub RPC that
// carries deltas out and Stop back.
//
// Two rules are fixed here because they are the ones that are painful to change
// later:
//
//   * the instance id is `${run_id}-a${attempt}`. Workflow ids must match
//     /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/ and be at most 100 characters, and they
//     cannot contain '/'. A uuid plus that suffix satisfies both, and the id is
//     derivable from the row, so a sweep can look an instance up.
//   * `create()` throws on a duplicate id, so the `runs` row is the idempotency
//     record, not the Workflow. The route inserts the row first under
//     UNIQUE(session_id, client_turn_id), then creates the instance and treats
//     a duplicate-id error as a no-op.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { Env } from '../env.js';
import { adapterOptions, providerForTransport, SCRIPTS, ScriptedProvider, type Script } from '../model/index.js';
import type { ModelProvider } from '../model/types.js';
import type { Transport } from '@hermes/shared';
import { PgAgentDb } from '../engine/pg-agent-db.js';
import { denyHostsFor, fetchUrl } from '../security/fetch-url.js';
import {
  PROVIDER_STEP_CONFIG,
  TOOL_STEP_CONFIG,
  runAttempt,
  stepNames as engineStepNames,
  type EngineStep,
  type StepConfig,
} from '../engine/engine.js';
import type { EmittedEvent } from '../engine/agent-db.js';

export interface RunAttemptParams {
  readonly runId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly engineVersion: number;
  readonly traceId: string;
  /**
   * Development only: which `ScriptedProvider` script this attempt answers
   * from. Set by `POST turns` when `MODEL_SCRIPTED=1`, ignored otherwise, and
   * honoured on the first attempt only — so "a 503, then a Retry that works"
   * is one flag rather than two. See decision F6.
   */
  readonly scriptedScript?: string;
}

/** Cloudflare's documented instance-id pattern. Asserted by a unit test. */
export const WORKFLOW_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9\-_]*$/;
export const WORKFLOW_ID_MAX_LENGTH = 100;

export function runAttemptInstanceId(runId: string, attempt: number): string {
  const id = `${runId}-a${attempt}`;
  if (!WORKFLOW_ID_PATTERN.test(id) || id.length > WORKFLOW_ID_MAX_LENGTH) {
    throw new Error(`run attempt id is not a valid Workflow instance id: ${id}`);
  }
  return id;
}

/** Step names are checkpoint keys, so they must be deterministic and stable. */
export const stepNames = {
  provider: engineStepNames.provider,
  tool: engineStepNames.tool,
} as const;

/**
 * Step options, fixed because the defaults are wrong for this workload: the
 * documented default is `timeout: '10 minutes'` per attempt, and a Max-effort
 * turn can stream for longer than that.
 */
export const STEP_OPTIONS = {
  provider: PROVIDER_STEP_CONFIG,
  tool: TOOL_STEP_CONFIG,
} as const;

/**
 * Which adapter serves a run.
 *
 * `MODEL_SCRIPTED=1` swaps in the deterministic provider. It exists for
 * `wrangler dev --local` on a machine with no provider key: the whole turn
 * route, the Workflow, the hub fan-out and the replay route can then be
 * exercised end to end offline. It is refused outside development, because a
 * staging environment that quietly answered from a script would be a staging
 * environment nobody could trust.
 */
export function providerFactory(env: Env, script?: readonly Script[]): (transport: string) => ModelProvider {
  if (env.MODEL_SCRIPTED === '1') {
    if (env.ENVIRONMENT !== 'development') {
      throw new Error('MODEL_SCRIPTED is a development-only switch');
    }
    // One provider per invocation, not one per call: a `ScriptedProvider`
    // advances through its scripts, and building a fresh one for every turn
    // would replay script zero forever — which looks exactly like an agent
    // stuck in a loop until the turn cap stops it.
    let scripted: ModelProvider | null = null;
    const scripts = script ?? DEV_SCRIPT;
    return (transport) => {
      scripted ??= new ScriptedProvider(scripts, transport as Transport);
      return scripted;
    };
  }
  const options = adapterOptions(env);
  return (transport) => providerForTransport(transport as Transport, options);
}

/**
 * What `wrangler dev --local` answers with: one turn that proposes a request a
 * human can actually review, then one that stops. The payload matches the
 * shared application schema, because a payload the viewer cannot render is a
 * request the reviewer cannot decide.
 */
const DEV_APPLICATION = {
  kind: 'application',
  applicant: { name: 'Ada Ling', email: 'ada.ling@example.com' },
  proposed_role: 'Research fellow',
  score: 72,
  score_max: 100,
  criteria: [
    { id: 'c1', label: 'Publications', points: 40, points_max: 50, evidence: 'Three peer-reviewed papers', source_ids: ['s1'] },
    { id: 'c2', label: 'References', points: 32, points_max: 50, evidence: 'Two of three reachable', source_ids: ['s1'] },
  ],
  sources: [{ id: 's1', name: 'Application', note: 'pasted into the session' }],
  missing: ['a third reference'],
};

const DEV_SCRIPT = [
  {
    events: [
      { type: 'text_delta', text: 'Reading the programme and the application. ' },
      { type: 'text_delta', text: 'Scoring against the published criteria. ' },
      {
        type: 'tool_call',
        call: { id: 'call_1', name: 'propose_request', arguments: JSON.stringify({ kind: 'application', payload: DEV_APPLICATION }) },
      },
      { type: 'usage', usage: { input_tokens: 1200, output_tokens: 180, cached_input_tokens: 0, reasoning_tokens: 0 } },
      { type: 'stop', reason: 'tool_use' },
    ],
  },
  {
    events: [
      { type: 'text_delta', text: 'Proposed. It is pending your decision in the Inbox; I cannot admit anyone myself.' },
      { type: 'usage', usage: { input_tokens: 1400, output_tokens: 40, cached_input_tokens: 0, reasoning_tokens: 0 } },
      { type: 'stop', reason: 'end_turn' },
    ],
  },
] as const satisfies readonly Script[];

/**
 * The scripted scenarios a development turn can ask for.
 *
 * `MODEL_SCRIPTED=1` used to be one fixed two-turn script with no failure
 * path, so the spec's P8 (a provider 5xx, then a Retry) and P9 (a stream that
 * tears at 40 percent) could not be driven from the client at all — the
 * scripts existed in `src/model/scripted.ts`, only the selection was missing.
 *
 * Each entry is the failure *followed by* the ordinary script, so a scenario
 * reads as "this goes wrong, then the run does what it always does". The names
 * are the ones the client-port spec uses, not the internal `SCRIPTS` keys,
 * because they are what a person types. See decision F6.
 */
export const DEV_SCRIPTS: Readonly<Record<string, readonly Script[]>> = {
  completed: DEV_SCRIPT,
  transient_5xx: [SCRIPTS.transient_5xx, ...DEV_SCRIPT],
  partial_stream: [SCRIPTS.partial_stream, ...DEV_SCRIPT],
  auth_401: [SCRIPTS.unauthorized, ...DEV_SCRIPT],
  malformed_tool: [SCRIPTS.malformed_tool_json, ...DEV_SCRIPT],
};

/**
 * Which scenario a turn asked for: the `x-scripted-script` header first, then
 * the turn's own text.
 *
 * The text is matched rather than parsed, because the point is to drive a
 * scenario from a composer a person is typing into: "Screen the applicant
 * (transient_5xx)" is a sentence *and* a selection. An unknown name is not an
 * error — it is ordinary prose that happens to contain an underscore — so it
 * falls back to `completed`.
 */
export function pickDevScript(header: string | undefined, text: string | undefined): string | undefined {
  const fromHeader = (header ?? '').trim().toLowerCase();
  if (fromHeader && fromHeader in DEV_SCRIPTS) return fromHeader;
  const body = (text ?? '').toLowerCase();
  for (const name of Object.keys(DEV_SCRIPTS)) {
    if (name !== 'completed' && body.includes(name)) return name;
  }
  return undefined;
}

/** The real `step`, narrowed to the three calls the engine makes. */
function engineStep(step: WorkflowStep): EngineStep {
  return {
    // The cast is the one place a cast is justified: `step.do` is typed to
    // return `Serializable<T>`, which is structurally the same JSON the engine
    // already restricts itself to (step returns are ids only, 1 MiB cap), but
    // the mapped type does not prove that to the compiler for a generic T.
    do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T> {
      // Called through the object, never through a detached reference: `step`
      // is an RPC stub and a pulled-off `do` loses its receiver, which fails at
      // run time with "the RPC receiver does not implement the method call".
      const loose = step as unknown as {
        do(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T>;
      };
      return loose.do(name, config, fn);
    },
    waitForEvent<T>(name: string, options: { timeout: string }): Promise<{ payload: T }> {
      const loose = step as unknown as {
        waitForEvent(name: string, options: { timeout: string }): Promise<{ payload: T }>;
      };
      return loose.waitForEvent(name, options);
    },
  };
}

export class RunAttempt extends WorkflowEntrypoint<Env, RunAttemptParams> {
  override async run(event: WorkflowEvent<RunAttemptParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    if (!params?.runId || !params.workspaceId) {
      throw new NonRetryableError('RunAttempt was created without a run id');
    }

    const db = new PgAgentDb(this.env, params.workspaceId, params.traceId);
    try {
      await runAttempt(
        {
          db,
          // The scenario, honoured on the first attempt only: a Retry is the
          // scenario's second half and has to be allowed to succeed.
          providerFor: providerFactory(
            this.env,
            params.attempt === 1 && params.scriptedScript
              ? DEV_SCRIPTS[params.scriptedScript]
              : undefined,
          ),
          forward: async (sessionId, runId, events: readonly EmittedEvent[]) => {
            const stub = this.env.SESSION_HUB.get(this.env.SESSION_HUB.idFromName(sessionId));
            // The reply carries Stop, so polling the flag costs no extra
            // subrequest (plan section 4, Subrequest budget).
            return stub.forward(
              runId,
              events.map((e) => ({
                id: e.id,
                workspace_id: params.workspaceId,
                session_id: e.sessionId,
                kind: e.kind,
                payload: e.payload,
                schema_version: 1,
                trace_id: e.traceId ?? params.traceId,
                at: e.at,
              })),
            );
          },
          // Workspace-scoped rows — `request.created` and the `entity.updated`
          // a note produces — go to the other hub, because they are read by
          // every member rather than by the session's owner (decision F3).
          forwardWorkspace: async (events: readonly EmittedEvent[]) => {
            const stub = this.env.WORKSPACE_HUB.get(this.env.WORKSPACE_HUB.idFromName(params.workspaceId));
            await stub.publish(
              events.map((e) => ({
                id: e.id,
                workspace_id: params.workspaceId,
                session_id: null,
                kind: e.kind,
                payload: e.payload,
                schema_version: 1,
                trace_id: e.traceId ?? params.traceId,
                at: e.at,
              })),
            );
          },
          now: () => new Date(),
          engineVersion: params.engineVersion,
          scripted: this.env.MODEL_SCRIPTED === '1',
          // This deployment's own hostnames are denied here rather than in the
          // module: `fetch-url.ts` knows about Neon, R2 and the provider APIs
          // because those are the same everywhere, and about *us* only because
          // the Workflow tells it, which is the only place that knows.
          fetchUrl: (url, method, allowlist) =>
            fetchUrl(url, method, { allowlist, denyHosts: denyHostsFor(this.env) }),
        },
        engineStep(step),
        { runId: params.runId, attempt: params.attempt, traceId: params.traceId },
      );
    } finally {
      await db.close();
    }
  }
}
