// The only database surface the run engine has.
//
// Invariant 2 of docs/CONVENTIONS.md has three layers, and this file is the
// second one: "the `AgentDb` interface the Workflow receives, which will have
// no `decide`, `execute`, `invite`, `role` or `job` method". The grants
// (migration 0004) are the first layer and the block validator is the third;
// this one exists because a grant is invisible at the call site, and a method
// that does not exist cannot be called by accident in a refactor.
//
// `AgentWrites` is the surface a *tool* is handed. It is deliberately six
// methods long, and `test/unit/agent-writes.test.ts` asserts by type that it
// never grows a decide, execute, invite, role or job method. `AgentDb` adds the
// reads and the run's own bookkeeping — status, steps, the streaming message,
// the model-call meter — none of which a tool can reach.
//
// Everything here runs on the `agent` Hyperdrive config, which is a different
// database role with far fewer grants than the one the routes use. The role has
// no INSERT on `jobs` at all (0004: `REVOKE ALL ON jobs FROM agent`), which is
// why the engine publishes by handing committed rows to the hub itself rather
// than by enqueuing a `publish` job; see decision 40 in docs/DECISIONS.md.
import type { RequestKind } from '@hermes/shared';
import type { Credential, ProviderMessage, Usage } from '../model/types.js';

/** An outbox row, written in the same transaction as the change it describes. */
export interface EmitInput {
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  /** Null routes the event to the workspace hub. Agent events are session-scoped. */
  readonly sessionId?: string | null;
}

/** What `emit` returns: the committed ids, so the caller can publish them. */
export interface EmittedEvent {
  readonly id: string;
  readonly kind: string;
  readonly sessionId: string | null;
  readonly payload: Record<string, unknown>;
  readonly traceId: string | null;
  readonly at: string;
}

export interface ProposeRequestInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly kind: RequestKind;
  readonly subject: string;
  readonly subjectKey: string;
  readonly label: string;
  readonly payload: unknown;
}

export interface SaveReviewNoteInput {
  readonly runId: string;
  readonly toolCallId: string;
  readonly requestId: string;
  readonly body: string;
}

export interface SetContextFieldInput {
  readonly runId: string;
  readonly toolCallId: string;
  readonly agentId: string;
  readonly key: string;
  readonly value: string;
  readonly scope: string;
}

export interface ProposeInstructionInput {
  readonly runId: string;
  readonly toolCallId: string;
  readonly agentId: string;
  readonly body: string;
  readonly sources: readonly unknown[];
}

export interface AppendTurnInput {
  readonly runId: string;
  readonly turn: number;
  readonly seq: number;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly providerMessage: ProviderMessage;
  readonly toolCallId?: string | null;
  readonly subjectId?: string | null;
}

/**
 * The tool-facing write surface.
 *
 * Read the list and then read what is missing from it. There is no `decide`,
 * because a decision is the guarded route's to write. There is no `execute`,
 * because an effect is a human's to run. There is no `invite`, `role` or
 * `job`. A tool that wanted one of those would have to add it here, in a file
 * whose header says why it will not be added, with a type test that fails.
 */
export interface AgentWrites {
  /** Writes a `requests` row in `pending`. Nothing else may move it out. */
  proposeRequest(input: ProposeRequestInput): Promise<{ requestId: string; created: boolean }>;
  saveReviewNote(input: SaveReviewNoteInput): Promise<{ noteId: string; created: boolean }>;
  setContextField(input: SetContextFieldInput): Promise<{ fieldId: string }>;
  proposeInstruction(input: ProposeInstructionInput): Promise<{ versionId: string; created: boolean }>;
  appendTurn(input: AppendTurnInput): Promise<{ turnId: string; created: boolean }>;
  emit(events: readonly EmitInput[]): Promise<EmittedEvent[]>;
}

// ---------------------------------------------------------------------------
// Reads and run bookkeeping: the engine's half, never handed to a tool
// ---------------------------------------------------------------------------

export interface EngineRunRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly stopRequested: boolean;
  readonly attempt: number;
  readonly engineVersion: number;
  readonly maxTurns: number;
  readonly modelId: string;
  readonly effort: string | null;
  readonly traceId: string | null;
  readonly activeMs: number;
  readonly waitingFor: string | null;
  readonly mode: string;
  readonly agentId: string | null;
  readonly clientTurnId: string;
}

export interface HistoryTurn {
  readonly turn: number;
  readonly seq: number;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly providerMessage: ProviderMessage;
  readonly toolCallId: string | null;
}

export interface GuidanceRow {
  readonly id: string;
  readonly text: string;
  readonly status: string;
}

export interface QueueRow {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly position: number;
}

export interface StepProgress {
  readonly runId: string;
  readonly turn: number;
  readonly stepId: string;
  readonly label: string;
  readonly state: 'todo' | 'active' | 'done' | 'failed';
  readonly toolCallId?: string | null;
}

export interface AssistantMessageInput {
  readonly runId: string;
  readonly sessionId: string;
  readonly turn: number;
  readonly text: string;
  readonly blocks: readonly unknown[];
  readonly status: 'streaming' | 'complete' | 'incomplete';
  readonly workedMs: number | null;
}

export interface RunErrorInput {
  readonly class: string;
  readonly retryable: boolean;
  readonly reason: string;
  readonly message: string;
  /** Snake case because this object is the event payload's `error` verbatim. */
  readonly step_id?: string | null;
}

/**
 * Everything the engine may do. A tool receives only the `AgentWrites` half.
 */
export interface AgentDb extends AgentWrites {
  loadRun(runId: string): Promise<EngineRunRow | null>;
  /**
   * The turn a new attempt starts at: the first turn whose assistant message is
   * not complete, or the turn after the last complete one. A user Retry resumes
   * at the failed turn rather than replaying the whole conversation.
   */
  resumeTurn(runId: string): Promise<number>;
  /** Read straight from the row: every resume path reads Stop first. */
  stopRequested(runId: string): Promise<boolean>;
  loadHistory(runId: string, limit: number): Promise<{ recent: HistoryTurn[]; olderSummary: string | null }>;
  loadGuidance(runId: string): Promise<GuidanceRow[]>;
  markGuidanceApplied(runId: string, guidanceId: string, turn: number): Promise<void>;
  /**
   * Read-only: `run_queue` is SELECT for the `agent` role. Pausing on Stop and
   * draining after completion are `app`-role writes done by the Stop route and
   * the minute Cron respectively (decision 41).
   */
  loadQueue(runId: string): Promise<QueueRow[]>;
  /** The per-run tool allowlist: `agent_capabilities.tool_names`, filtered by mode. */
  loadToolNames(agentId: string | null): Promise<string[]>;
  loadSystemPrompt(runId: string): Promise<string>;
  loadWorkspaceContext(agentId: string | null): Promise<{ key: string; value: string | null; scope: string }[]>;
  /** `resolveKey` runs inside the step, so plaintext exists only for that step. */
  resolveCredential(provider: string): Promise<Credential>;
  /**
   * A 401 stops the other working runs on that provider (plan section 4).
   *
   * Marking the key row itself `invalid` is not here, and deliberately: the
   * `agent` role has no UPDATE on `workspace_provider_keys` and widening the
   * grant would break invariant 2. The run records `reason: 'key_invalid'` with
   * the key id, and the minute Cron — which runs as `app` — marks the row and
   * blocks creation. See decision 41 in docs/DECISIONS.md.
   */
  stopOtherRunsOnProvider(provider: string, exceptRunId: string): Promise<number>;
  loadModel(modelId: string): Promise<{
    model_id: string;
    provider: string;
    transport: string;
    effort_map: Record<string, string> | null;
  } | null>;

  /** Run bookkeeping. Not on `AgentWrites`: a tool cannot move its own run. */
  enterStep(input: StepProgress): Promise<{ stepAttempt: number }>;
  finishStep(input: StepProgress): Promise<void>;
  setRunStatus(
    runId: string,
    status: string,
    detail?: { waitingFor?: string | null; waitingLabel?: string | null; error?: RunErrorInput | null },
  ): Promise<void>;
  addActiveMs(runId: string, ms: number): Promise<number>;
  /** Keyed on (run_id, turn), so a retry replaces rather than duplicates. */
  upsertAssistantMessage(input: AssistantMessageInput): Promise<{ messageId: string; seq: number }>;
  recordModelCall(input: {
    runId: string;
    turn: number;
    modelId: string;
    provider: string;
    keyId: string | null;
    usage: Usage;
    latencyMs: number | null;
    status: 'ok' | 'error' | 'stopped';
  }): Promise<void>;

  /** Tool reads. Everything here is filtered by row-level security already. */
  listRequests(status: string | null, limit: number): Promise<unknown[]>;
  getRequest(requestId: string): Promise<unknown | null>;
  getDocumentText(documentId: string, offset: number, maxChars: number): Promise<{ text: string; next_offset: number | null; total_chars: number } | null>;
  getHistory(sessionId: string, limit: number): Promise<unknown[]>;
  listMembers(): Promise<unknown[]>;
  /** True when a run is blocked on a human answer for this context key. */
  isAwaitingContext(key: string): Promise<boolean>;
  readContextField(agentId: string | null, key: string): Promise<string | null>;
}
