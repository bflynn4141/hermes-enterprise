// An in-memory `AgentDb`.
//
// It keeps the properties the engine relies on and nothing else: ids are
// monotonic so the run-log validator's first rule can be checked, every write a
// tool makes is idempotent on `(run_id, tool_call_id)` so the crash-mid-tool
// case means something, and `stopRequested` reads a flag a test can flip
// mid-stream the way the Stop route does.
//
// The forbidden half matters as much as the present half: there is no method
// here that writes a `decisions`, `effects`, `members` or `jobs` row, because
// `AgentDb` has none to implement. A red-team test asserts on that by counting
// what the fake holds.
import { DEFAULT_TOOL_NAMES } from '../../../src/engine/pg-agent-db.js';
import type {
  AgentDb,
  AppendTurnInput,
  AssistantMessageInput,
  EmitInput,
  EmittedEvent,
  EngineRunRow,
  GuidanceRow,
  HistoryTurn,
  ProposeInstructionInput,
  ProposeApprovalFromAgentInput,
  ProposeRequestInput,
  QueueRow,
  RunErrorInput,
  SaveReviewNoteInput,
  SetContextFieldInput,
  StepProgress,
} from '../../../src/engine/agent-db.js';
import type { ApprovalView } from '@hermes/shared';
import type { Credential, ProviderMessage, Usage } from '../../../src/model/types.js';
import { KeyStoreError } from '../../../src/keys/store.js';

export interface FakeRequestRow {
  id: string;
  kind: string;
  status: string;
  label: string;
  subjectKey: string;
  payload: unknown;
  runId: string;
  toolCallId: string;
}

export class FakeAgentDb implements AgentDb {
  readonly events: EmittedEvent[] = [];
  readonly requests: FakeRequestRow[] = [];
  readonly partnerCandidates: Record<string, unknown>[] = [];
  readonly notes: { id: string; runId: string; toolCallId: string; body: string }[] = [];
  readonly instructions: { id: string; runId: string; toolCallId: string; body: string }[] = [];
  readonly contextFields = new Map<string, string>();
  /** Which context keys a *run* wrote, so the prompt can label them (O4). */
  readonly contextRunIds = new Map<string, string | null>();
  readonly turns: HistoryTurn[] = [];
  readonly messages = new Map<number, { id: string; text: string; status: string; blocks: unknown[]; workedMs: number | null }>();
  readonly steps = new Map<string, { stepAttempt: number; state: string }>();
  readonly modelCalls: { turn: number | null; status: string; keyId: string | null; usage: Usage }[] = [];
  readonly guidance: GuidanceRow[] = [];
  readonly queue: QueueRow[] = [];
  readonly statusChanges: { status: string; error: RunErrorInput | null }[] = [];
  stopFlag = false;
  /** Keys some run in this workspace is parked on, as the route would see them. */
  readonly awaitingKeys = new Set<string>();
  otherRunsStopped = 0;
  /** What `resolveCredential` does. Tests swap it for the no-key path. */
  credential: Credential | Error = { provider: 'scripted', apiKey: 'sk-test', keyId: 'key-1' };
  private nextId = 1;
  private run: EngineRunRow;

  static readonly WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
  static readonly SESSION_ID = '22222222-2222-4222-8222-222222222222';

  constructor(overrides: Partial<EngineRunRow> = {}) {
    this.run = {
      // Real uuids: every payload in the event contract is validated by the
      // run-log validator, which this fake's stream is fed to.
      id: crypto.randomUUID(),
      workspaceId: FakeAgentDb.WORKSPACE_ID,
      sessionId: FakeAgentDb.SESSION_ID,
      status: 'working',
      stopRequested: false,
      attempt: 1,
      engineVersion: 1,
      maxTurns: 12,
      modelId: 'deepseek-flash',
      effort: null,
      traceId: 'trace-0000',
      activeMs: 0,
      waitingFor: null,
      mode: 'work',
      agentId: 'agent-1',
      clientTurnId: 'turn-1',
      ...overrides,
    };
    this.turns.push({
      turn: 0,
      seq: 0,
      role: 'user',
      providerMessage: { role: 'user', content: 'Here is the programme and the application.' },
      toolCallId: null,
    });
  }

  /** Every id the event contract validates is a uuid, so they all are. */
  private uuid(): string {
    this.nextId += 1;
    return crypto.randomUUID();
  }

  // -- reads ----------------------------------------------------------------

  loadRun(): Promise<EngineRunRow | null> {
    return Promise.resolve({ ...this.run, stopRequested: this.stopFlag });
  }
  stopRequested(): Promise<boolean> {
    return Promise.resolve(this.stopFlag);
  }
  resumeTurn(): Promise<number> {
    let incomplete: number | null = null;
    let complete = -1;
    for (const [turn, message] of this.messages) {
      if (message.status !== 'complete') incomplete = incomplete === null ? turn : Math.min(incomplete, turn);
      else complete = Math.max(complete, turn);
    }
    return Promise.resolve(incomplete ?? complete + 1);
  }
  loadHistory(_runId: string, limit: number): Promise<{ recent: HistoryTurn[]; olderSummary: string | null }> {
    const all = [...this.turns].sort((a, b) => a.turn - b.turn || a.seq - b.seq);
    if (all.length <= limit) return Promise.resolve({ recent: all, olderSummary: null });
    return Promise.resolve({
      recent: all.slice(all.length - limit),
      olderSummary: `${all.length - limit} earlier turn(s).`,
    });
  }
  loadGuidance(): Promise<GuidanceRow[]> {
    return Promise.resolve([...this.guidance]);
  }
  markGuidanceApplied(_runId: string, guidanceId: string): Promise<void> {
    const row = this.guidance.find((g) => g.id === guidanceId);
    if (row) this.guidance[this.guidance.indexOf(row)] = { ...row, status: 'applied' };
    return Promise.resolve();
  }
  loadQueue(): Promise<QueueRow[]> {
    return Promise.resolve([...this.queue]);
  }
  loadToolNames(): Promise<string[]> {
    return Promise.resolve([...DEFAULT_TOOL_NAMES]);
  }
  loadSystemPrompt(): Promise<string> {
    return Promise.resolve('Admit applicants who meet the published bar.');
  }
  loadWorkspaceContext(): Promise<{ key: string; value: string | null; scope: string; run_id: string | null }[]> {
    return Promise.resolve(
      [...this.contextFields].map(([key, value]) => ({
        key,
        value,
        scope: 'reply',
        run_id: this.contextRunIds.get(key) ?? null,
      })),
    );
  }
  resolveCredential(): Promise<Credential> {
    if (this.credential instanceof Error) return Promise.reject(this.credential);
    return Promise.resolve(this.credential);
  }
  stopOtherRunsOnProvider(): Promise<number> {
    this.otherRunsStopped += 1;
    return Promise.resolve(this.otherRunsStopped);
  }
  loadModel(): Promise<{ model_id: string; provider: string; transport: string; effort_map: Record<string, string> | null } | null> {
    return Promise.resolve({
      model_id: this.run.modelId,
      provider: 'deepseek',
      transport: 'deepseek_chat',
      effort_map: null,
    });
  }

  // -- bookkeeping ----------------------------------------------------------

  enterStep(input: StepProgress): Promise<{ stepAttempt: number }> {
    const key = `${input.turn}:${input.stepId}`;
    const previous = this.steps.get(key);
    const stepAttempt = previous ? previous.stepAttempt + 1 : 1;
    this.steps.set(key, { stepAttempt, state: input.state });
    return Promise.resolve({ stepAttempt });
  }
  finishStep(input: StepProgress): Promise<void> {
    const key = `${input.turn}:${input.stepId}`;
    const previous = this.steps.get(key);
    this.steps.set(key, { stepAttempt: previous?.stepAttempt ?? 1, state: input.state });
    return Promise.resolve();
  }
  setRunStatus(
    _runId: string,
    status: string,
    detail: { waitingFor?: string | null; error?: RunErrorInput | null } = {},
  ): Promise<void> {
    this.run = { ...this.run, status, waitingFor: detail.waitingFor ?? this.run.waitingFor };
    this.statusChanges.push({ status, error: detail.error ?? null });
    return Promise.resolve();
  }
  addActiveMs(_runId: string, ms: number): Promise<number> {
    this.run = { ...this.run, activeMs: this.run.activeMs + Math.max(0, ms) };
    return Promise.resolve(this.run.activeMs);
  }
  upsertAssistantMessage(input: AssistantMessageInput): Promise<{ messageId: string; seq: number }> {
    const existing = this.messages.get(input.turn);
    const id = existing?.id ?? this.uuid();
    // Keyed on (run_id, turn): a retry replaces, it never appends a second one.
    this.messages.set(input.turn, {
      id,
      text: input.text,
      status: input.status,
      blocks: [...input.blocks],
      workedMs: input.workedMs,
    });
    return Promise.resolve({ messageId: id, seq: input.turn });
  }
  recordModelCall(input: Parameters<AgentDb['recordModelCall']>[0]): Promise<void> {
    this.modelCalls.push({ turn: input.turn, status: input.status, keyId: input.keyId, usage: input.usage });
    return Promise.resolve();
  }

  // -- writes ---------------------------------------------------------------

  proposeRequest(input: ProposeRequestInput): Promise<{ requestId: string; created: boolean }> {
    const existing = this.requests.find((r) =>
      r.runId === input.runId && r.toolCallId === input.toolCallId
      || input.subjectKey.startsWith('partner-candidate:') && r.subjectKey === input.subjectKey,
    );
    if (existing) return Promise.resolve({ requestId: existing.id, created: false });
    const row: FakeRequestRow = {
      id: this.uuid(),
      kind: input.kind,
      status: 'pending',
      label: input.label,
      subjectKey: input.subjectKey,
      payload: input.payload,
      runId: input.runId,
      toolCallId: input.toolCallId,
    };
    this.requests.push(row);
    return Promise.resolve({ requestId: row.id, created: true });
  }
  proposeApproval(_input: ProposeApprovalFromAgentInput): Promise<{ approval: ApprovalView; continuationId: string | null }> {
    return Promise.reject(new Error('approval fixture not configured'));
  }
  saveReviewNote(input: SaveReviewNoteInput): Promise<{ noteId: string; created: boolean }> {
    const existing = this.notes.find((n) => n.runId === input.runId && n.toolCallId === input.toolCallId);
    if (existing) return Promise.resolve({ noteId: existing.id, created: false });
    const row = { id: this.uuid(), runId: input.runId, toolCallId: input.toolCallId, body: input.body };
    this.notes.push(row);
    return Promise.resolve({ noteId: row.id, created: true });
  }
  setContextField(input: SetContextFieldInput): Promise<{ fieldId: string }> {
    this.contextFields.set(input.key, input.value);
    this.contextRunIds.set(input.key, input.runId);
    return Promise.resolve({ fieldId: `field-${input.key}` });
  }
  ensureContextField(input: { runId: string; toolCallId: string; agentId: string; key: string }): Promise<void> {
    if (!this.contextFields.has(input.key)) {
      this.contextFields.set(input.key, '');
      this.contextRunIds.set(input.key, input.runId);
    }
    return Promise.resolve();
  }
  proposeInstruction(input: ProposeInstructionInput): Promise<{ versionId: string; created: boolean }> {
    const existing = this.instructions.find((i) => i.runId === input.runId && i.toolCallId === input.toolCallId);
    if (existing) return Promise.resolve({ versionId: existing.id, created: false });
    const row = { id: this.uuid(), runId: input.runId, toolCallId: input.toolCallId, body: input.body };
    this.instructions.push(row);
    return Promise.resolve({ versionId: row.id, created: true });
  }
  appendTurn(input: AppendTurnInput): Promise<{ turnId: string; created: boolean }> {
    const clash = this.turns.find(
      (t) =>
        (input.toolCallId != null && t.toolCallId === input.toolCallId) ||
        (t.turn === input.turn && t.seq === input.seq),
    );
    if (clash) return Promise.resolve({ turnId: 'existing', created: false });
    this.turns.push({
      turn: input.turn,
      seq: input.seq,
      role: input.role,
      providerMessage: input.providerMessage as ProviderMessage,
      toolCallId: input.toolCallId ?? null,
    });
    return Promise.resolve({ turnId: this.uuid(), created: true });
  }
  emit(events: readonly EmitInput[]): Promise<EmittedEvent[]> {
    // `stream_events.id` is a bigserial, so ids are strictly increasing across
    // a batch as well as between batches. Computing them from the array length
    // inside `map` would give every event in one batch the same id, which the
    // validator's first rule would then (correctly) reject.
    let next = this.events.length;
    const written = events.map((event) => ({
      id: String(++next),
      kind: event.kind,
      sessionId: event.sessionId ?? this.run.sessionId,
      payload: event.payload,
      traceId: this.run.traceId,
      at: new Date(1_800_000_000_000 + next * 1000).toISOString(),
    }));
    this.events.push(...written);
    return Promise.resolve(written);
  }

  // -- tool reads -----------------------------------------------------------

  listRequests(): Promise<unknown[]> {
    return Promise.resolve(this.requests.map((r) => ({ id: r.id, kind: r.kind, status: r.status, label: r.label })));
  }
  getRequest(requestId: string): Promise<unknown | null> {
    return Promise.resolve(this.requests.find((r) => r.id === requestId) ?? null);
  }
  getApprovalStatus(_requestId: string): Promise<ApprovalView> {
    return Promise.reject(new Error('approval fixture not configured'));
  }
  getDocumentText(): Promise<{ text: string; next_offset: number | null; total_chars: number } | null> {
    return Promise.resolve({ text: 'extracted text', next_offset: null, total_chars: 14 });
  }
  getHistory(): Promise<unknown[]> {
    return Promise.resolve([]);
  }
  listMembers(): Promise<unknown[]> {
    return Promise.resolve([{ user_id: 'user-1', role: 'admin' }]);
  }
  listPartnerCandidates(_agentId: string | null, minimumPriority: number, limit: number): Promise<unknown[]> {
    return Promise.resolve(this.partnerCandidates
      .filter((candidate) => Number(candidate.deterministic_priority ?? 0) >= minimumPriority)
      .slice(0, limit));
  }
  getPartnerCandidate(_agentId: string | null, candidateId: string): Promise<unknown | null> {
    return Promise.resolve(this.partnerCandidates.find((candidate) => candidate.id === candidateId) ?? null);
  }
  /** What an Admin put in `workspace_settings.flags.fetch_url_allowlist`. */
  fetchAllowlist: string[] = [];
  loadFetchAllowlist(): Promise<string[]> {
    return Promise.resolve([...this.fetchAllowlist]);
  }
  isAwaitingContext(key: string): Promise<boolean> {
    if (this.awaitingKeys.has(key)) return Promise.resolve(true);
    return Promise.resolve(this.run.status === 'waiting' && this.run.waitingFor === key);
  }
  readContextField(_agentId: string | null, key: string): Promise<string | null> {
    return Promise.resolve(this.contextFields.get(key) ?? null);
  }

  /** The stream the run-log validator is run over. */
  streamEvents(): unknown[] {
    return this.events.map((event) => ({
      id: event.id,
      workspace_id: FakeAgentDb.WORKSPACE_ID,
      session_id: FakeAgentDb.SESSION_ID,
      schema_version: 1,
      trace_id: event.traceId ?? 'trace',
      at: event.at,
      kind: event.kind,
      payload: event.payload,
    }));
  }
}

export { KeyStoreError };
