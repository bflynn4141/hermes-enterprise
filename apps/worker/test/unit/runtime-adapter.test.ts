// Native Hermes owns execution; these tests prove the enterprise projection
// survives retries, reconciles status, and keeps Stop honest.
import { assertRunLog } from '@hermes/shared';
import { describe, expect, it, vi } from 'vitest';
import type { EngineRunRow } from '../../src/engine/agent-db.js';
import type { ProviderMessage } from '../../src/model/types.js';
import { runHermesAttempt, type RuntimeDeps, type RuntimePersistence, type RuntimeTerminalFailure } from '../../src/runtime/adapter.js';
import { HermesClient, HermesCapabilitiesError, terminalHermesStatus, type HermesEvent, type HermesStatus } from '../../src/runtime/client.js';
import type { HermesEnterpriseReadiness } from '../../src/runtime/client.js';
import type { RuntimeSkillManifest } from '../../src/runtime/skills.js';
import { PARTNER_INVOICE_REVIEW_DEFINITION } from '../../src/enterprise-skills/registry.js';
import { ENTERPRISE_BRIDGE_VERSION, HERMES_NATIVE_REVISION } from '../../src/runtime/readiness.js';
import { RESPONSE_ONLY_RECOVERY_INPUT } from '../../src/runs/recovery-safety.js';
import { FakeAgentDb } from './engine/fake-db.js';
import { FakeStep } from './engine/fake-step.js';

const NATIVE_ID = 'run_native-123';
const MODEL = 'openrouter:anthropic/claude-sonnet-4';
const PROFILE = 'enterprise-agent-1';
const nativeCapabilities = {
  object: 'hermes.api_server.capabilities', platform: 'hermes-agent',
  auth: { type: 'bearer', required: true },
  runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
  features: {
    run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_steer: true,
    runs_idempotency: { supported: true, durable: true, retention_seconds: 86_400 },
  },
  endpoints: {
    runs: { method: 'POST', path: '/v1/runs' },
    run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
    run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
    run_steer: { method: 'POST', path: '/v1/runs/{run_id}/steer' },
    run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
  },
};

class FakeRuntimeDb extends FakeAgentDb implements RuntimePersistence {
  nativeBinding: { runtimeRunId: string | null; runtimeAttempt: number | null } | null = null;
  readonly bindings: { runId: string; attempt: number; remoteId: string; sessionId: string; profile: string }[] = [];
  readonly snapshots = new Map<number, Record<string, unknown>>();
  readonly carriedGuidance: string[] = [];
  finalizations = 0;
  finalizing = false;
  bootstrap: ProviderMessage[] = [];
  submissionSessionId: string | null = null;
  acceptBinding = true;
  resumeInput: string | null = null;
  priorAuthority: Record<string, unknown> | null = null;
  runtimeTransactions = 0;
  runtimeTransactionDepth = 0;
  automaticExecutionLocks = 0;
  onAutomaticExecutionLock: ((count: number) => void) | null = null;
  recoveryInput() { return Promise.resolve(this.resumeInput); }
  recoveryAuthority() { return Promise.resolve(this.priorAuthority); }
  runtimeRequest(_runId: string, attempt: number) { return Promise.resolve(this.snapshots.get(attempt) ?? null); }

  async withRuntimeTransaction<T>(work: () => Promise<T>): Promise<T> {
    this.runtimeTransactions += 1;
    this.runtimeTransactionDepth += 1;
    try { return await work(); }
    finally { this.runtimeTransactionDepth -= 1; }
  }

  constructor(overrides: Partial<EngineRunRow> = {}) {
    super({ modelId: MODEL, ...overrides });
  }

  override loadModel() {
    return Promise.resolve({ model_id: MODEL, provider: 'openrouter', transport: 'openrouter', effort_map: null });
  }

  binding() { return Promise.resolve(this.nativeBinding); }

  async lockAutomaticRecoveryExecution(_runId: string, attempt: number) {
    this.automaticExecutionLocks += 1;
    this.onAutomaticExecutionLock?.(this.automaticExecutionLocks);
    const run = (await this.loadRun())!;
    return run.attempt === attempt && run.automaticRecovery === true
      && run.status === 'working' && !run.stopRequested;
  }

  bindRun(runId: string, attempt: number, remoteId: string, sessionId: string, profile: string) {
    if (this.acceptBinding) {
      this.bindings.push({ runId, attempt, remoteId, sessionId, profile });
      this.nativeBinding = { runtimeRunId: remoteId, runtimeAttempt: attempt };
    }
    return Promise.resolve(this.acceptBinding);
  }

  snapshotRequest(_runId: string, attempt: number, body: Record<string, unknown>) {
    if (!this.snapshots.has(attempt)) this.snapshots.set(attempt, structuredClone(body));
    return Promise.resolve(structuredClone(this.snapshots.get(attempt)!));
  }

  loadBootstrapHistory() { return Promise.resolve(this.bootstrap); }

  resolveRuntimeSessionId(run: EngineRunRow) {
    return Promise.resolve(this.submissionSessionId ?? run.id);
  }

  nextRuntimeSequence() {
    return Promise.resolve(Math.max(-1, ...this.turns.filter((turn) => turn.turn === 0).map((turn) => turn.seq)) + 1);
  }

  async finalizeRuntime<T>(_runId: string, attempt: number, work: () => Promise<T>): Promise<T | null> {
    const run = (await this.loadRun())!;
    if (run.attempt !== attempt || ['completed', 'stopped', 'error'].includes(run.status)) return null;
    this.finalizations += 1;
    this.finalizing = true;
    try { return await work(); }
    finally { this.finalizing = false; }
  }

  carryGuidance(_runId: string, ids: string[]) {
    this.carriedGuidance.push(...this.guidance.filter((row) => row.status === 'queued' && ids.includes(row.id)).map((row) => row.id));
    return Promise.resolve();
  }
}

class FakeHermesClient extends HermesClient {
  readonly submissions: { body: Record<string, unknown>; key: string }[] = [];
  readonly stops: string[] = [];
  readonly steers: { id: string; text: string }[] = [];
  statusReads = 0;
  eventSubscriptions = 0;
  streamSignal: AbortSignal | null = null;
  current: HermesStatus = { run_id: NATIVE_ID, status: 'running' };
  final: HermesStatus = { run_id: NATIVE_ID, status: 'completed', output: 'The review is ready.' };
  deltas = ['Reading the application. ', 'Checking references.'];
  disconnect = false;
  acceptSteer = true;
  onSubmit: (() => void) | null = null;
  onStatus: (() => void) | null = null;
  onStop: (() => void) | null = null;
  streamFailure: Error | null = null;
  capabilityReads = 0;
  capabilityFailure: Error | null = null;

  constructor() { super('https://runtime.invalid', 'test-runtime-key'); }

  override capabilities() {
    this.capabilityReads += 1;
    return this.capabilityFailure
      ? Promise.reject(this.capabilityFailure)
      : Promise.resolve({ durableIdempotency: true as const, retentionSeconds: 86_400 });
  }

  override submit(body: Record<string, unknown>, key: string) {
    this.onSubmit?.();
    this.submissions.push({ body: structuredClone(body), key });
    return Promise.resolve(NATIVE_ID);
  }

  override status() {
    this.statusReads += 1;
    if (this.statusReads > 30) return Promise.reject(new Error('test runtime never reached terminal status'));
    this.onStatus?.();
    return Promise.resolve({ ...this.current });
  }

  override stop(id: string) {
    this.stops.push(id);
    if (this.onStop) this.onStop();
    else this.current = { run_id: NATIVE_ID, status: 'cancelled' };
    return Promise.resolve();
  }

  override steer(id: string, text: string) {
    this.steers.push({ id, text });
    return Promise.resolve(this.acceptSteer);
  }

  override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
    this.eventSubscriptions += 1;
    this.streamSignal = signal;
    for (const delta of this.deltas) yield { event: 'message.delta', run_id: NATIVE_ID, delta };
    this.current = this.final;
    if (this.disconnect) throw this.streamFailure ?? new Error('stream disconnected');
    yield { event: `run.${this.final.status}`, ...this.final };
  }
}

async function execute<TClient extends HermesClient = FakeHermesClient>(
  db = new FakeRuntimeDb(),
  client: TClient = new FakeHermesClient() as unknown as TClient,
  step = new FakeStep(),
  forward?: RuntimeDeps['forward'],
  timing: {
    pollMs?: number;
    batchMs?: number;
    preview?: RuntimeDeps['preview'];
    onTerminalFailure?: RuntimeDeps['onTerminalFailure'];
    onLatency?: RuntimeDeps['onLatency'];
    managedRuntimeIdentity?: RuntimeDeps['managedRuntimeIdentity'];
    skillSnapshot?: readonly RuntimeSkillManifest[];
  } = {},
) {
  const run = (await db.loadRun())!;
  await runHermesAttempt({
    db, client, profile: PROFILE, pollMs: timing.pollMs ?? 0, batchMs: timing.batchMs,
    forward: forward ?? (async () => ({ stop_requested: db.stopFlag })),
    ...(timing.preview ? { preview: timing.preview } : {}),
    ...(timing.onTerminalFailure ? { onTerminalFailure: timing.onTerminalFailure } : {}),
    ...(timing.onLatency ? { onLatency: timing.onLatency } : {}),
    ...(timing.managedRuntimeIdentity ? { managedRuntimeIdentity: timing.managedRuntimeIdentity } : {}),
    ...(timing.skillSnapshot ? { skillSnapshot: timing.skillSnapshot } : {}),
  }, step, { runId: run.id, attempt: run.attempt, traceId: run.traceId ?? 'runtime-test' });
  return { db, client, step };
}

describe('official Hermes enterprise projection', () => {
  it('does not contact the runtime when an automatic Workflow belongs to an older attempt', async () => {
    const db = new FakeRuntimeDb({ attempt: 3, automaticRecovery: true });
    const run = (await db.loadRun())!;
    const client = new FakeHermesClient();
    await expect(runHermesAttempt({
      db, client, profile: PROFILE,
      forward: async () => ({ stop_requested: false }),
    }, new FakeStep(), { runId: run.id, attempt: 2, traceId: 'stale-automatic-workflow' }))
      .rejects.toThrow('no current agent binding');
    expect(client.capabilityReads).toBe(0);
    expect(client.submissions).toHaveLength(0);
    expect(client.eventSubscriptions).toBe(0);
  });

  it('does not emit started or change state when an automatic attempt advances at the startup checkpoint', async () => {
    const db = new FakeRuntimeDb({ attempt: 2, automaticRecovery: true });
    db.resumeInput = RESPONSE_ONLY_RECOVERY_INPUT;
    const step = new FakeStep();
    step.beforeAttempt = (name) => {
      if (name === 'hermes-started') db.setRunForTest({ attempt: 3 });
    };
    const { client } = await execute(db, new FakeHermesClient(), step);
    expect(db.events.filter((event) => event.kind === 'run.started')).toHaveLength(0);
    expect(db.statusChanges).toHaveLength(0);
    expect(client.capabilityReads).toBe(0);
    expect(client.submissions).toHaveLength(0);
  });

  it('does not emit started or overwrite Stop when it arrives at the automatic startup checkpoint', async () => {
    const db = new FakeRuntimeDb({ attempt: 2, automaticRecovery: true });
    db.resumeInput = RESPONSE_ONLY_RECOVERY_INPUT;
    const step = new FakeStep();
    step.beforeAttempt = (name) => {
      if (name === 'hermes-started') db.setRunForTest({ status: 'stopping', stopRequested: true });
    };
    const { client } = await execute(db, new FakeHermesClient(), step);
    expect(db.events.filter((event) => event.kind === 'run.started')).toHaveLength(0);
    expect(db.statusChanges).toHaveLength(0);
    expect((await db.loadRun())?.status).toBe('stopping');
    expect(client.submissions).toHaveLength(0);
  });

  it.each([
    ['a successor attempt', { attempt: 3 }],
    ['Stop', { status: 'stopping', stopRequested: true }],
  ] as const)(
    'does not submit when %s wins immediately before the automatic dispatch fence',
    async (_label, transition) => {
      const db = new FakeRuntimeDb({ attempt: 2, automaticRecovery: true });
      db.resumeInput = RESPONSE_ONLY_RECOVERY_INPUT;
      db.onAutomaticExecutionLock = (count) => {
        if (count === 2) db.setRunForTest(transition);
      };
      const { client } = await execute(db);
      expect(db.snapshots.has(2)).toBe(true);
      expect(db.automaticExecutionLocks).toBe(2);
      expect(client.submissions).toHaveLength(0);
      expect(client.eventSubscriptions).toBe(0);
      expect(db.statusChanges).toHaveLength(0);
    },
  );

  it('holds the automatic execution fence through native acknowledgement and binding only', async () => {
    const db = new FakeRuntimeDb({ attempt: 2, automaticRecovery: true });
    db.resumeInput = RESPONSE_ONLY_RECOVERY_INPUT;
    const client = new FakeHermesClient();
    client.onSubmit = () => { expect(db.runtimeTransactionDepth).toBe(1); };
    const bind = db.bindRun.bind(db);
    vi.spyOn(db, 'bindRun').mockImplementation(async (...args) => {
      expect(db.runtimeTransactionDepth).toBe(1);
      return bind(...args);
    });
    await execute(db, client);
    expect(db.runtimeTransactionDepth).toBe(0);
    expect(client.eventSubscriptions).toBe(1);
  });

  it('carries trusted Bot Mode attribution from the durable user turn', async () => {
    const db = new FakeRuntimeDb();
    db.turns.splice(0, 1, {
      ...db.turns[0]!,
      providerMessage: {
        role: 'user',
        content: 'Message from 🤖 Iris (@agent-partnerships): Review this handoff.',
        enterprise_turn_author: { id: 'bot:agent-partnerships', name: 'Iris', is_bot: true },
      },
    });
    const { client } = await execute(db);
    expect(client.submissions[0]?.body._enterprise_turn_author).toEqual({
      id: 'bot:agent-partnerships', name: 'Iris', is_bot: true,
    });
  });

  it('submits exact governed creator calls for an explicit channel test', async () => {
    const db = new FakeRuntimeDb();
    db.turns.splice(0, 1, {
      ...db.turns[0]!,
      providerMessage: { role: 'user', content: 'Run a Hermes creator test for LinkedIn, YouTube, and X.' },
    });
    const { client } = await execute(db);
    const input = String(client.submissions[0]?.body.input ?? '');
    expect(input).toContain(db.turns[0]!.providerMessage.content);
    expect(input).toContain('https://stableenrich.dev/api/exa/search');
    expect(input).toContain('https://fetcher.sh/api/twitter/search?query=%22Hermes%20Agent%22&sort=Top');
    expect(input.match(/mcp__agentcash__fetch exactly once/g)).toHaveLength(2);
    expect(db.snapshots.get(1)?.input).toBe(input);
  });

  it('submits saved recovery instructions instead of replaying original discovery input', async () => {
    const db = new FakeRuntimeDb({ attempt: 2 });
    db.resumeInput = RESPONSE_ONLY_RECOVERY_INPUT;
    const { client } = await execute(db);
    expect(client.submissions).toHaveLength(1);
    expect(client.submissions[0]?.body.input).toBe(db.resumeInput);
    expect(client.submissions[0]?.key).toContain('-a2');
    expect(db.snapshots.get(2)?.input).toBe(db.resumeInput);
    expect(client.submissions[0]?.body._enterprise_tool_names).toEqual([]);
    expect(client.submissions[0]?.body._enterprise_skills).toEqual([]);
  });

  it('keeps response-only authority empty through the real Hermes transport contract', async () => {
    const db = new FakeRuntimeDb({ attempt: 2 });
    db.resumeInput = RESPONSE_ONLY_RECOVERY_INPUT;
    const nativeBodies: Record<string, unknown>[] = [];
    const send = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/capabilities')) return Response.json(nativeCapabilities);
      if (url.endsWith('/v1/runs') && init?.method === 'POST') {
        nativeBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return Response.json({ run_id: NATIVE_ID, status: 'started' }, { status: 202 });
      }
      if (url.endsWith(`/v1/runs/${NATIVE_ID}/events`)) {
        return new Response(`data: ${JSON.stringify({ event: 'run.completed', run_id: NATIVE_ID, output: 'Finished from stored results.' })}\n\n`, {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      throw new Error(`Unexpected native request: ${url}`);
    });
    await execute(db,new HermesClient('https://runtime.invalid','runtime-secret',send));
    expect(db.snapshots.get(2)).toMatchObject({
      input: RESPONSE_ONLY_RECOVERY_INPUT,_enterprise_tool_names: [],_enterprise_skills: [],
    });
    expect(nativeBodies).toHaveLength(1);
    expect(nativeBodies[0]).not.toHaveProperty('_enterprise_tool_names');
    expect(nativeBodies[0]).not.toHaveProperty('_enterprise_skills');
    expect(nativeBodies[0]?.input).toBe(RESPONSE_ONLY_RECOVERY_INPUT);
  });

  it('records the prior/current authority intersection for audit without treating it as native enforcement', async () => {
    class RestrictedRuntimeDb extends FakeRuntimeDb {
      override loadToolNames() { return Promise.resolve(['list_requests', 'propose_instruction']); }
    }
    const db = new RestrictedRuntimeDb({ attempt: 2 });
    db.resumeInput = 'Resume the bounded stored-evidence assessment.';
    db.priorAuthority = { _enterprise_tool_names: ['list_requests', 'get_request'], _enterprise_skills: [] };
    const newlyGrantedSkill = {
      name: 'new-skill', skill_key: 'new-skill', runtime_name: 'new-skill', version: '1',
      artifact_digest: `sha256:${'a'.repeat(64)}`, state: 'active', assignment_revision: 2,
      grant_revision: null, binding_source: 'enterprise_assignment', binding_state: null,
      grant_expires_at: null, capability_grants: ['read'], auto_load: true, config: {},
    } as RuntimeSkillManifest;
    const { client } = await execute(db, new FakeHermesClient(), new FakeStep(), undefined, {
      skillSnapshot: [newlyGrantedSkill],
    });
    expect(client.submissions[0]?.body._enterprise_tool_names).toEqual(['list_requests']);
    expect(client.submissions[0]?.body._enterprise_skills).toEqual([]);
  });

  it('starts fresh streaming without a second remote readiness round trip', async () => {
    const client = new FakeHermesClient();
    await execute(new FakeRuntimeDb(), client);
    expect(client.capabilityReads).toBe(1);
    expect(client.eventSubscriptions).toBe(1);
  });

  it('blocks token-digest execution before native submit when managed readiness is absent after restart', async () => {
    class UnmanagedClient extends FakeHermesClient {
      override enterpriseReadiness() {
        return Promise.reject(new HermesCapabilitiesError());
      }
    }
    const client = new UnmanagedClient();
    const { db } = await execute(new FakeRuntimeDb(), client, new FakeStep(), undefined, {
      managedRuntimeIdentity: {
        workspaceId: '11111111-1111-4111-8111-111111111111',
        agentId: '22222222-2222-4222-8222-222222222222',
        enterpriseUrl: 'https://enterprise.example.test',
        pluginRevision: 'a'.repeat(40),
        pluginArtifactDigest: `sha256:${'d'.repeat(64)}`,
      },
    });
    expect(client.capabilityReads).toBeGreaterThan(0);
    expect(client.submissions).toHaveLength(0);
    expect(client.eventSubscriptions).toBe(0);
    expect(db.statusChanges.at(-1)?.status).toBe('error');
  });

  it('runs a promoted digest binding after its explicit assignment changes to Finance', async () => {
    const skill: RuntimeSkillManifest = {
      name: PARTNER_INVOICE_REVIEW_DEFINITION.runtimeName,
      skill_key: PARTNER_INVOICE_REVIEW_DEFINITION.key,
      runtime_name: PARTNER_INVOICE_REVIEW_DEFINITION.runtimeName,
      version: PARTNER_INVOICE_REVIEW_DEFINITION.version,
      artifact_digest: PARTNER_INVOICE_REVIEW_DEFINITION.artifactDigest,
      state: 'active', assignment_revision: 2, grant_revision: null,
      binding_source: 'enterprise_assignment', binding_state: null, grant_expires_at: null,
      capability_grants: [...PARTNER_INVOICE_REVIEW_DEFINITION.defaultCapabilityGrants],
      auto_load: true,
      config: { invoice_review: { duplicate_window_days: 365, require_engagement_evidence: true } },
    };
    class FinanceClient extends FakeHermesClient {
      override enterpriseReadiness(): Promise<HermesEnterpriseReadiness> {
        return Promise.resolve({
          object: 'hermes.enterprise_bridge.readiness', version: ENTERPRISE_BRIDGE_VERSION,
          runtimeRevision: HERMES_NATIVE_REVISION,
          plugin: { name: 'enterprise_bridge', version: ENTERPRISE_BRIDGE_VERSION,
            revision: 'a'.repeat(40), artifactDigest: `sha256:${'d'.repeat(64)}` },
          workspaceId: '11111111-1111-4111-8111-111111111111',
          agentId: '22222222-2222-4222-8222-222222222222',
          enterpriseUrl: 'https://enterprise.example.test',
          skills: [{ name: skill.runtime_name, version: skill.version,
            artifactDigest: skill.artifact_digest, contentDigest: skill.artifact_digest }],
          toolNames: ['get_partner_handoff_result', 'list_requests', 'get_request', 'skill_view'],
          agentCashEnabled: false, agentCashWalletPresent: false, nativeCronDisabled: true,
        });
      }
    }
    const client = new FinanceClient();
    await execute(new FakeRuntimeDb(), client, new FakeStep(), undefined, {
      managedRuntimeIdentity: {
        workspaceId: '11111111-1111-4111-8111-111111111111',
        agentId: '22222222-2222-4222-8222-222222222222',
        enterpriseUrl: 'https://enterprise.example.test',
        pluginRevision: 'a'.repeat(40),
        pluginArtifactDigest: `sha256:${'d'.repeat(64)}`,
      },
      skillSnapshot: [skill],
    });
    expect(client.submissions).toHaveLength(1);
    expect(client.eventSubscriptions).toBe(1);
  });

  it('groups startup, submission, and execution setup into four serial runtime transactions', async () => {
    const db = new FakeRuntimeDb();
    let startupTransactions: number | undefined;
    class Client extends FakeHermesClient {
      override async *events(id: string, signal: AbortSignal) {
        startupTransactions = db.runtimeTransactions;
        yield* super.events(id, signal);
      }
    }
    await execute(db, new Client());
    expect(startupTransactions).toBe(4);
  });

  it('reads Stop and guidance in one serial transaction and releases it before native control calls', async () => {
    const db = new FakeRuntimeDb();
    db.guidance.push({ id: crypto.randomUUID(), text: 'Check the references.', status: 'queued' });
    let activeTransaction: number | null = null;
    let transaction = 0;
    const reads: Array<{ name: string; transaction: number | null }> = [];
    vi.spyOn(db, 'withRuntimeTransaction').mockImplementation(async (work) => {
      expect(activeTransaction).toBeNull();
      activeTransaction = ++transaction;
      try { return await work(); }
      finally { activeTransaction = null; }
    });
    const originalStop = db.stopRequested.bind(db);
    vi.spyOn(db, 'stopRequested').mockImplementation(async () => {
      reads.push({ name: 'stop', transaction: activeTransaction });
      return originalStop();
    });
    const originalGuidance = db.loadGuidance.bind(db);
    vi.spyOn(db, 'loadGuidance').mockImplementation(async () => {
      if (!db.finalizing) reads.push({ name: 'guidance', transaction: activeTransaction });
      return originalGuidance();
    });
    const client = new FakeHermesClient();
    client.onStatus = () => { expect(activeTransaction).toBeNull(); };
    const originalSteer = client.steer.bind(client);
    vi.spyOn(client, 'steer').mockImplementation(async (id, text) => {
      expect(activeTransaction).toBeNull();
      return originalSteer(id, text);
    });
    await execute(db, client);
    expect(reads).toEqual([
      { name: 'stop', transaction: 1 },
      { name: 'stop', transaction: 5 },
      { name: 'guidance', transaction: 5 },
    ]);
    expect(client.eventSubscriptions).toBe(1);
    expect(client.steers).toHaveLength(1);
    expect(db.finalizations).toBe(1);
  });

  it('rechecks readiness when a fresh submission takes longer than the reuse window', async () => {
    let now = 10_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const client = new FakeHermesClient();
      client.onSubmit = () => { now += 5_001; };
      await execute(new FakeRuntimeDb(), client);
      expect(client.capabilityReads).toBe(2);
      expect(client.eventSubscriptions).toBe(1);
    } finally { clock.mockRestore(); }
  });

  it('does not treat a persisted submit checkpoint as a fresh readiness check', async () => {
    const db = new FakeRuntimeDb();
    db.nativeBinding = { runtimeRunId: NATIVE_ID, runtimeAttempt: 1 };
    const client = new FakeHermesClient();
    client.capabilityFailure = new HermesCapabilitiesError();
    const step = new FakeStep();
    step.results.set('hermes-submit', { id: NATIVE_ID });
    await execute(db, client, step);
    expect(client.submissions).toHaveLength(0);
    expect(client.capabilityReads).toBe(1);
    expect(client.eventSubscriptions).toBe(0);
    expect(db.statusChanges.at(-1)?.status).toBe('error');
  });

  it('consumes a fresh check before an execution retry and refuses the changed runtime', async () => {
    const db = new FakeRuntimeDb();
    const client = new FakeHermesClient();
    vi.spyOn(db, 'enterStep').mockImplementationOnce(async () => {
      client.capabilityFailure = new HermesCapabilitiesError();
      throw new Error('transient persistence failure before subscribing');
    });
    class RetryingStep extends FakeStep {
      override do<T>(name: string, config: Parameters<FakeStep['do']>[1], fn: () => Promise<T>) {
        return super.do(name, name === 'hermes-execute' ? { ...config, retries: { ...config.retries, limit: 2 } } : config, fn);
      }
    }
    await execute(db, client, new RetryingStep());
    expect(client.submissions).toHaveLength(1);
    expect(client.capabilityReads).toBe(2);
    expect(client.eventSubscriptions).toBe(0);
    expect(db.statusChanges.at(-1)?.status).toBe('error');
  });

  it.each([5_001, -1])('refuses changed readiness after a %i ms clock difference', async (difference) => {
    let now = 10_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const client = new FakeHermesClient();
      client.onSubmit = () => {
        now += difference;
        client.capabilityFailure = new HermesCapabilitiesError();
      };
      const { db } = await execute(new FakeRuntimeDb(), client);
      expect(client.capabilityReads).toBe(2);
      expect(client.eventSubscriptions).toBe(0);
      expect(db.statusChanges.at(-1)?.status).toBe('error');
    } finally { clock.mockRestore(); }
  });

  it('reports first text from attempt entry including capability and submission time', async () => {
    let now = 10_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const measurements: Array<Parameters<NonNullable<RuntimeDeps['onLatency']>>[0]> = [];
    class TimedClient extends FakeHermesClient {
      override capabilities() {
        now += 600;
        return super.capabilities();
      }
    }
    try {
      const client = new TimedClient();
      client.onSubmit = () => { now += 800; };
      const { db } = await execute(new FakeRuntimeDb(), client, new FakeStep(), undefined, {
        onLatency: (measurement) => {
          measurements.push(measurement);
          // A broken telemetry sink must not interrupt the native stream.
          throw new Error('metric sink unavailable');
        },
      });
      expect(measurements).toContainEqual(expect.objectContaining({ phase: 'submit_capabilities', duration_ms: 600 }));
      expect(measurements).toContainEqual(expect.objectContaining({ phase: 'native_submit', duration_ms: 800 }));
      expect(measurements).toContainEqual(expect.objectContaining({ phase: 'first_delta', elapsed_ms: 1400 }));
      expect(JSON.stringify(measurements)).not.toContain(client.deltas[0]);
      expect(db.statusChanges.at(-1)?.status).toBe('completed');
    } finally { clock.mockRestore(); }
  });

  it('streams into a single assistant message and replaces interim prose with authoritative final output', async () => {
    const client = new FakeHermesClient();
    client.final.usage = { input_tokens: 37, output_tokens: 9 };
    const { db } = await execute(new FakeRuntimeDb(), client);
    expect(db.messages.size).toBe(1);
    expect(db.messages.get(0)).toMatchObject({ text: 'The review is ready.', status: 'complete' });
    const deltas = db.events.filter((event) => event.kind === 'message.delta');
    expect(deltas.map((event) => (event.payload as { delta: string }).delta).join('')).toBe(client.deltas.join(''));
    expect(db.events.filter((event) => event.kind === 'message.final')).toHaveLength(1);
    expect(db.statusChanges.at(-1)?.status).toBe('completed');
    // Provider calls are accounted at the model proxy with the key actually
    // used. The terminal native aggregate must not create a duplicate row.
    expect(db.modelCalls).toEqual([]);
    expect(client.streamSignal?.aborted).toBe(true);
    assertRunLog(db.streamEvents(), { requireFinalPerTurn: true });
  });

  it('does not duplicate governed bridge tools from name-only native lifecycle frames', async () => {
    class ToolActivityClient extends FakeHermesClient {
      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        yield { event: 'tool.started', run_id: NATIVE_ID, tool: 'list_partner_candidates' };
        yield { event: 'tool.completed', run_id: NATIVE_ID, tool: 'list_partner_candidates' };
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'I found one candidate.' };
        this.current = this.final;
        yield { event: `run.${this.final.status}`, ...this.final };
      }
    }

    const db = new FakeRuntimeDb();
    const enteredSteps = vi.spyOn(db, 'enterStep');
    await execute(db, new ToolActivityClient());
    const activity = db.events
      .filter((event) => event.kind === 'run.step' && Boolean((event.payload as { tool_call_id?: string | null }).tool_call_id))
      .map((event) => event.payload as { step_id: string; label: string; state: string; tool_call_id: string });

    expect(activity).toEqual([]);
    expect(enteredSteps).not.toHaveBeenCalledWith(expect.objectContaining({ label: 'list_partner_candidates' }));
    expect(db.steps.has('0:hermes-tool-1')).toBe(false);
  });

  it('preserves native lifecycle activity for local and MCP tools without a bridge record', async () => {
    class ToolActivityClient extends FakeHermesClient {
      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        yield { event: 'tool.started', run_id: NATIVE_ID, tool: 'skill_view' };
        yield { event: 'tool.completed', run_id: NATIVE_ID, tool: 'skill_view' };
        yield { event: 'tool.started', run_id: NATIVE_ID, tool: 'mcp__fixture__read' };
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'I found one candidate.' };
        yield { event: 'tool.completed', run_id: NATIVE_ID, tool: 'mcp__fixture__read', error: false };
        this.current = this.final;
        yield { event: `run.${this.final.status}`, ...this.final };
      }
    }

    const db = new FakeRuntimeDb();
    const enteredSteps = vi.spyOn(db, 'enterStep');
    await execute(db, new ToolActivityClient());
    const activity = db.events
      .filter((event) => event.kind === 'run.step' && Boolean((event.payload as { tool_call_id?: string | null }).tool_call_id))
      .map((event) => event.payload as { step_id: string; label: string; state: string; tool_call_id: string });

    expect(activity).toEqual([
      expect.objectContaining({ step_id: 'hermes-tool-1', label: 'skill_view', state: 'active', tool_call_id: 'hermes-tool-1' }),
      expect.objectContaining({ step_id: 'hermes-tool-1', label: 'skill_view', state: 'done', tool_call_id: 'hermes-tool-1' }),
      expect.objectContaining({ step_id: 'hermes-tool-2', label: 'mcp__fixture__read', state: 'active', tool_call_id: 'hermes-tool-2' }),
      expect.objectContaining({ step_id: 'hermes-tool-2', label: 'mcp__fixture__read', state: 'done', tool_call_id: 'hermes-tool-2' }),
    ]);
    expect(enteredSteps).toHaveBeenCalledWith(expect.objectContaining({ label: 'skill_view', toolCallId: 'hermes-tool-1' }));
    expect(enteredSteps).toHaveBeenCalledWith(expect.objectContaining({ label: 'mcp__fixture__read', toolCallId: 'hermes-tool-2' }));
    expect(db.steps.get('0:hermes-tool-1')?.state).toBe('done');
    expect(db.steps.get('0:hermes-tool-2')?.state).toBe('done');
  });

  it('records a reasoning phase boundary without exposing preview text', async () => {
    class ReasoningClient extends FakeHermesClient {
      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        yield { event: 'reasoning.available', run_id: NATIVE_ID, text: 'private intermediate reasoning' };
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'A user-facing answer.' };
        this.current = this.final;
        yield { event: `run.${this.final.status}`, ...this.final };
      }
    }

    const { db } = await execute(new FakeRuntimeDb(), new ReasoningClient());
    const reasoning = db.events
      .filter((event) => event.kind === 'run.step')
      .map((event) => event.payload as { step_id: string; label: string; state: string })
      .find((event) => event.step_id === 'hermes-reasoning');
    expect(reasoning).toEqual(expect.objectContaining({ label: 'Reasoning', state: 'done' }));
    expect(db.steps.get('0:hermes-reasoning')?.state).toBe('done');
    expect(JSON.stringify(db.events)).not.toContain('private intermediate reasoning');
  });

  it('flushes a trailing delta during a native pause instead of waiting for the status poll', async () => {
    class PausingClient extends FakeHermesClient {
      beforeTerminal: (() => void) | null = null;

      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'First. ' };
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'Second.' };
        await new Promise((resolve) => setTimeout(resolve, 30));
        this.beforeTerminal?.();
        this.current = this.final;
        yield { event: `run.${this.final.status}`, ...this.final };
      }
    }

    const client = new PausingClient();
    let forwardedDeltas = 0;
    client.beforeTerminal = () => expect(forwardedDeltas).toBe(2);
    await execute(
      new FakeRuntimeDb(),
      client,
      new FakeStep(),
      async (_session, _run, events) => {
        forwardedDeltas += events.filter((event) => event.kind === 'message.delta').length;
        return { stop_requested: false };
      },
      { pollMs: 100, batchMs: 5 },
    );
    expect(forwardedDeltas).toBe(2);
  });

  it('coalesces an already-buffered burst after a slow durable delta write', async () => {
    class SlowDeltaDb extends FakeRuntimeDb {
      override async emit(events: Parameters<FakeRuntimeDb['emit']>[0]) {
        const saved = await super.emit(events);
        if (events.some((event) => event.kind === 'message.delta')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return saved;
      }
    }

    const client = new FakeHermesClient();
    client.deltas = ['One. ', 'Two. ', 'Three.'];
    const { db } = await execute(
      new SlowDeltaDb(),
      client,
      new FakeStep(),
      undefined,
      { pollMs: 100, batchMs: 5 },
    );
    const deltas = db.events.filter((event) => event.kind === 'message.delta');
    expect(deltas).toHaveLength(2);
    expect(deltas.map((event) => (event.payload as { delta: string }).delta).join('')).toBe(client.deltas.join(''));
  });

  it('previews native text before a slow durable checkpoint completes', async () => {
    class SlowDeltaDb extends FakeRuntimeDb {
      durableDeltaFinished = false;
      override async emit(events: Parameters<FakeRuntimeDb['emit']>[0]) {
        const saved = await super.emit(events);
        if (events.some((event) => event.kind === 'message.delta')) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          this.durableDeltaFinished = true;
        }
        return saved;
      }
    }

    const db = new SlowDeltaDb();
    const client = new FakeHermesClient();
    client.deltas = ['Fast ', 'lane'];
    const previews: { offset: number; delta: string; beforeDurable: boolean }[] = [];
    await execute(db, client, new FakeStep(), undefined, {
      pollMs: 100,
      batchMs: 5,
      preview: async (frame) => {
        previews.push({ offset: frame.offset, delta: frame.delta, beforeDurable: !db.durableDeltaFinished });
      },
    });

    expect(previews.map(({ offset, delta }) => ({ offset, delta }))).toEqual([
      { offset: 0, delta: 'Fast ' },
      { offset: 5, delta: 'lane' },
    ]);
    expect(previews.every((frame) => frame.beforeDurable)).toBe(true);
    expect(db.events.filter((event) => event.kind === 'message.delta').map((event) => (event.payload as { delta: string }).delta).join('')).toBe('Fast lane');
  });

  it.each(['eof', 'error'] as const)('flushes a suppressed delta immediately when the native stream ends by %s', async (ending) => {
    class EndingClient extends FakeHermesClient {
      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'First. ' };
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'Last.' };
        this.current = this.final;
        if (ending === 'error') throw new Error('native stream disconnected');
      }
    }

    const client = new EndingClient();
    const started = Date.now();
    let secondDeltaAt = Number.POSITIVE_INFINITY;
    await execute(
      new FakeRuntimeDb(),
      client,
      new FakeStep(),
      async (_session, _run, events) => {
        if (events.some((event) => event.kind === 'message.delta' && (event.payload as { delta?: string }).delta === 'Last.')) {
          secondDeltaAt = Date.now() - started;
        }
        return { stop_requested: false };
      },
      { pollMs: 200, batchMs: 1000 },
    );
    expect(secondDeltaAt).toBeLessThan(150);
  });

  it('does not lose stream completion while a stale status read is in flight', async () => {
    vi.useFakeTimers();
    let statusStarted!: () => void;
    const statusPending = new Promise<void>((resolve) => { statusStarted = resolve; });
    let streamEnded!: () => void;
    const streamFinished = new Promise<void>((resolve) => { streamEnded = resolve; });
    let releaseStatus!: (value: HermesStatus) => void;
    class RacedTerminalClient extends FakeHermesClient {
      override status() {
        this.statusReads += 1;
        if (this.statusReads !== 1) return Promise.resolve({ ...this.current });
        statusStarted();
        return new Promise<HermesStatus>((resolve) => { releaseStatus = resolve; });
      }
      override async *events(): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        await statusPending;
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'Complete answer.' };
        this.current = this.final;
        streamEnded();
        yield { event: 'run.completed', ...this.final };
      }
    }
    const db = new FakeRuntimeDb();
    const client = new RacedTerminalClient();
    const task = execute(db, client, new FakeStep(), undefined, { pollMs: 1000 });
    try {
      await streamFinished;
      await vi.advanceTimersByTimeAsync(1);
      releaseStatus({ run_id: NATIVE_ID, status: 'running' });
      await vi.advanceTimersByTimeAsync(25);
      expect(db.statusChanges.at(-1)?.status).toBe('completed');
      expect(client.statusReads).toBe(2);
      expect(client.submissions).toHaveLength(1);
    } finally {
      await vi.runAllTimersAsync();
      await task;
      vi.useRealTimers();
    }
  });

  it('consumes an EOF wake only once and retains bounded polling after disconnect', async () => {
    vi.useFakeTimers();
    class DisconnectedRunningClient extends FakeHermesClient {
      override status() {
        this.statusReads += 1;
        return Promise.resolve(this.statusReads >= 3 ? this.final : this.current);
      }
      override async *events(): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'Partial answer.' };
        // EOF is not terminal status. One prompt status check is useful, but
        // repeatedly observing an ended stream must not produce a hot loop.
      }
    }
    const db = new FakeRuntimeDb();
    const client = new DisconnectedRunningClient();
    const task = execute(db, client, new FakeStep(), undefined, { pollMs: 1000 });
    try {
      await vi.advanceTimersByTimeAsync(25);
      expect(client.statusReads).toBe(2);
      expect(db.statusChanges.at(-1)?.status).toBe('working');
      await vi.advanceTimersByTimeAsync(1000);
      await task;
      expect(client.statusReads).toBe(3);
      expect(client.eventSubscriptions).toBe(1);
      expect(client.submissions).toHaveLength(1);
      expect(db.statusChanges.at(-1)?.status).toBe('completed');
    } finally {
      await vi.runAllTimersAsync();
      await task;
      vi.useRealTimers();
    }
  });

  it('forwards the last delta before a slow terminal status reconciliation', async () => {
    class SlowTerminalClient extends FakeHermesClient {
      terminalStatusResolved = false;

      override status() {
        this.statusReads += 1;
        if (!terminalHermesStatus(this.current.status)) return Promise.resolve({ ...this.current });
        return new Promise<HermesStatus>((resolve) => {
          setTimeout(() => {
            this.terminalStatusResolved = true;
            resolve({ ...this.current });
          }, 80);
        });
      }

      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'First. ' };
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'Last.' };
        this.current = this.final;
        yield { event: `run.${this.final.status}`, ...this.final };
      }
    }

    const client = new SlowTerminalClient();
    let lastDeltaBeforeStatus = false;
    await execute(
      new FakeRuntimeDb(),
      client,
      new FakeStep(),
      async (_session, _run, events) => {
        if (events.some((event) => event.kind === 'message.delta' && (event.payload as { delta?: string }).delta === 'Last.')) {
          lastDeltaBeforeStatus = !client.terminalStatusResolved;
        }
        return { stop_requested: false };
      },
      { pollMs: 200, batchMs: 75 },
    );
    expect(lastDeltaBeforeStatus).toBe(true);
    expect(client.terminalStatusResolved).toBe(true);
  });

  it('snapshots request metadata before submission and persists the binding before consuming native execution', async () => {
    const db = new FakeRuntimeDb({ effort: 'high' });
    db.bootstrap = [{ role: 'user', content: 'Earlier question.' }, { role: 'assistant', content: 'Earlier answer.' }];
    const client = new FakeHermesClient();
    client.onSubmit = () => expect(db.snapshots.has(1)).toBe(true);
    client.onStatus = () => expect(db.nativeBinding?.runtimeRunId).toBe(NATIVE_ID);
    await execute(db, client);
    const run = (await db.loadRun())!;
    expect(client.submissions).toHaveLength(1);
    expect(client.submissions[0]).toMatchObject({
      key: `enterprise-${run.id}-a1`,
      body: {
        input: 'Here is the programme and the application.', session_id: run.id,
        provider: 'custom', model: 'anthropic/claude-sonnet-4',
        model_options: { reasoning_effort: 'high' }, conversation_history: db.bootstrap,
      },
    });
    expect(client.submissions[0]?.body.instructions).toContain('Admit applicants who meet the published bar.');
    expect(db.bindings).toEqual([{ runId: run.id, attempt: 1, remoteId: NATIVE_ID, sessionId: run.id, profile: PROFILE }]);
    expect(JSON.stringify(client.submissions)).not.toContain('sk-test');
  });

  it('reuses the prior native conversation id for a later Enterprise turn', async () => {
    const db = new FakeRuntimeDb();
    db.submissionSessionId = 'native-session-root';
    const { client } = await execute(db);
    expect(client.submissions[0]?.body.session_id).toBe('native-session-root');
    expect(db.bindings[0]?.sessionId).toBe('native-session-root');
  });

  it.each([
    ['nous:stepfun/step-3.7-flash', 'stepfun/step-3.7-flash'],
    ['nous:stepfun/step-3.7-flash:free', 'stepfun/step-3.7-flash:free'],
  ])('submits the exact effective Portal route for %s', async (catalogId, wireId) => {
    class NousRuntimeDb extends FakeRuntimeDb {
      constructor() { super({ modelId: catalogId }); }
      override loadModel() {
        return Promise.resolve({ model_id: catalogId, provider: 'nous_portal', transport: 'nous_chat', effort_map: null });
      }
    }
    const client = new FakeHermesClient();
    await execute(new NousRuntimeDb(), client);
    expect(client.submissions[0]?.body.model).toBe(wireId);
    expect(client.submissions[0]?.body.provider).toBe('custom');
  });

  it('reuses a persisted native run when submission checkpoints are lost', async () => {
    const db = new FakeRuntimeDb();
    db.nativeBinding = { runtimeRunId: NATIVE_ID, runtimeAttempt: 1 };
    const client = new FakeHermesClient();
    client.current = client.final;
    await execute(db, client, new FakeStep());
    expect(client.submissions).toEqual([]);
    expect(client.eventSubscriptions).toBe(0);
    expect(client.capabilityReads).toBe(2);
    expect(db.messages.get(0)?.text).toBe(client.final.output);
    expect(db.statusChanges.at(-1)?.status).toBe('completed');
  });

  it('checks submission readiness and the persisted binding concurrently', async () => {
    let releaseReadiness: (() => void) | null = null;
    class ConcurrentSubmitClient extends FakeHermesClient {
      override capabilities() {
        this.capabilityReads += 1;
        if (this.capabilityReads !== 1) {
          return Promise.resolve({ durableIdempotency: true as const, retentionSeconds: 86_400 });
        }
        return new Promise<{ durableIdempotency: true; retentionSeconds: number }>((resolve) => {
          releaseReadiness = () => resolve({ durableIdempotency: true, retentionSeconds: 86_400 });
        });
      }
    }

    class ConcurrentBindingDb extends FakeRuntimeDb {
      override binding() {
        releaseReadiness?.();
        releaseReadiness = null;
        return super.binding();
      }
    }

    const client = new ConcurrentSubmitClient();
    await execute(new ConcurrentBindingDb(), client);
    expect(client.capabilityReads).toBe(1);
    expect(client.statusReads).toBeGreaterThan(0);
  });

  it('fails closed on replay when the restarted runtime loses durable idempotency', async () => {
    const db = new FakeRuntimeDb();
    db.nativeBinding = { runtimeRunId: NATIVE_ID, runtimeAttempt: 1 };
    const client = new FakeHermesClient();
    client.capabilityFailure = new Error('native durability unavailable');
    await execute(db, client);
    expect(client.capabilityReads).toBeGreaterThan(0);
    expect(client.submissions).toEqual([]);
    expect(client.statusReads).toBe(0);
    expect(db.statusChanges.at(-1)?.status).toBe('error');
  });

  it('uses the snapshotted request on a submit retry even if current context has changed', async () => {
    const db = new FakeRuntimeDb();
    const original = { input: 'Original question.', session_id: FakeAgentDb.SESSION_ID, instructions: 'Original instructions.', model: 'original/model', provider: 'custom' };
    db.snapshots.set(1, original);
    db.contextFields.set('new-context', 'Changed since admission.');
    const { client } = await execute(db);
    expect(client.submissions[0]?.body).toEqual(original);
  });

  it('recovers terminal output after the non-replayable native stream disconnects', async () => {
    const client = new FakeHermesClient();
    client.disconnect = true;
    client.final.usage = { input_tokens: 15, output_tokens: 5 };
    const { db } = await execute(new FakeRuntimeDb(), client);
    expect(client.submissions).toHaveLength(1);
    expect(client.eventSubscriptions).toBe(1);
    expect(client.stops).toEqual([]);
    expect(db.messages.get(0)?.text).toBe(client.final.output);
    expect(db.modelCalls).toEqual([]);
    expect(db.statusChanges.at(-1)?.status).toBe('completed');
  });

  it('sends Stop once and waits for the native cancelled status before reporting stopped', async () => {
    const db = new FakeRuntimeDb();
    let nativeStopped!: () => void;
    const stopReceived = new Promise<void>((resolve) => { nativeStopped = resolve; });
    class StoppableClient extends FakeHermesClient {
      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        for (const delta of this.deltas) yield { event: 'message.delta', run_id: NATIVE_ID, delta };
        // Keep native execution alive until Stop arrives; an already-complete
        // in-memory fixture is no longer held back by control polling.
        await stopReceived;
      }
    }
    const client = new StoppableClient();
    let readsAfterStop = 0;
    client.onStop = () => { client.current = { run_id: NATIVE_ID, status: 'stopping' }; nativeStopped(); };
    client.onStatus = () => {
      if (!client.stops.length) return;
      readsAfterStop += 1;
      expect(db.statusChanges.at(-1)?.status).toBe('working');
      if (readsAfterStop >= 2) client.current = { run_id: NATIVE_ID, status: 'cancelled' };
    };
    await execute(db, client, new FakeStep(), async (_session, _run, events) => {
      if (events.some((event) => event.kind === 'message.delta')) db.stopFlag = true;
      return { stop_requested: db.stopFlag };
    });
    expect(client.stops).toEqual([NATIVE_ID]);
    expect(readsAfterStop).toBeGreaterThanOrEqual(2);
    expect(db.statusChanges.at(-1)?.status).toBe('stopped');
    expect(db.messages.get(0)).toMatchObject({ status: 'incomplete', text: client.deltas.join('') });
    expect(db.modelCalls).toEqual([]);
  });

  it('stops a bound native run when Stop was requested before a Workflow replay begins', async () => {
    const db = new FakeRuntimeDb();
    db.nativeBinding = { runtimeRunId: NATIVE_ID, runtimeAttempt: 1 };
    db.stopFlag = true;
    const { client } = await execute(db);
    expect(client.stops).toEqual([NATIVE_ID]);
    expect(client.statusReads).toBeGreaterThan(0);
    expect(client.submissions).toEqual([]);
    expect(db.statusChanges.at(-1)?.status).toBe('stopped');
  });

  it('does not submit a new native run when stopped before admission', async () => {
    const db = new FakeRuntimeDb();
    db.stopFlag = true;
    const { client } = await execute(db);
    expect(client.submissions).toEqual([]);
    expect(client.stops).toEqual([]);
    expect(db.statusChanges.at(-1)?.status).toBe('stopped');
  });

  it.each([true, false])('marks queued guidance applied only when native steering accepts it (%s)', async (accepted) => {
    const db = new FakeRuntimeDb();
    const guidanceId = crypto.randomUUID();
    db.guidance.push({ id: guidanceId, text: 'Check the references first.', status: 'queued' });
    const client = new FakeHermesClient();
    client.acceptSteer = accepted;
    await execute(db, client);
    expect(client.steers.length).toBeGreaterThan(0);
    expect(client.steers.every((steer) => steer.id === NATIVE_ID && steer.text === 'Check the references first.')).toBe(true);
    expect(db.guidance[0]?.status).toBe(accepted ? 'applied' : 'queued');
    expect(db.events.filter((event) => event.kind === 'run.guidance.applied')).toHaveLength(accepted ? 1 : 0);
    expect(db.carriedGuidance).toEqual(accepted ? [] : [guidanceId]);
  });

  it('leaves accepted guidance queued when the terminal native status says it was never delivered', async () => {
    const db = new FakeRuntimeDb();
    const text = 'Check the references first.';
    db.guidance.push({ id: crypto.randomUUID(), text, status: 'queued' });
    const client = new FakeHermesClient();
    client.final.pending_steer = text;
    await execute(db, client);
    expect(client.steers).toEqual([{ id: NATIVE_ID, text }]);
    expect(db.guidance[0]?.status).toBe('queued');
    expect(db.events.filter((event) => event.kind === 'run.guidance.applied')).toEqual([]);
    expect(db.carriedGuidance).toEqual([db.guidance[0]!.id]);
  });

  it('does not claim guidance was applied when the native run failed', async () => {
    const db = new FakeRuntimeDb();
    db.guidance.push({ id: crypto.randomUUID(), text: 'Check the references first.', status: 'queued' });
    const client = new FakeHermesClient();
    client.final = { run_id: NATIVE_ID, status: 'failed' };
    await execute(db, client);
    expect(client.steers).toHaveLength(1);
    expect(db.guidance[0]?.status).toBe('queued');
    expect(db.events.filter((event) => event.kind === 'run.guidance.applied')).toEqual([]);
    expect(db.carriedGuidance).toEqual([db.guidance[0]!.id]);
  });

  it('classifies failed native execution, logs only safe fields and does not duplicate proxy accounting', async () => {
    const client = new FakeHermesClient();
    client.final = { run_id: NATIVE_ID, status: 'failed', error: 'HTTP 429: provider-key-and-private-request-must-not-leak' };
    const terminalFailures: RuntimeTerminalFailure[] = [];
    const { db } = await execute(new FakeRuntimeDb(), client, new FakeStep(), undefined, {
      onTerminalFailure: (failure) => terminalFailures.push(failure),
    });
    expect(db.statusChanges.at(-1)).toMatchObject({
      status: 'error',
      error: { class: 'transient', retryable: true, reason: 'hermes_provider_rate_limited', step_id: 'hermes' },
    });
    expect(terminalFailures).toEqual([expect.objectContaining({
      native_status: 'failed', failure_code: 'rate_limit', reason: 'hermes_provider_rate_limited',
      retryable: true, native_error_present: true,
    })]);
    expect(db.messages.get(0)?.status).toBe('incomplete');
    expect(db.modelCalls).toEqual([]);
    expect(JSON.stringify({ events: db.events, messages: [...db.messages], status: db.statusChanges, terminalFailures })).not.toContain(client.final.error);
  });

  it('reports stopped after native authority revocation beats the stop poll to a terminal failure', async () => {
    const db = new FakeRuntimeDb();
    const client = new FakeHermesClient();
    client.final = { run_id: NATIVE_ID, status: 'failed', error: 'HTTP 409: runtime_run_inactive' };
    client.onStatus = () => { if (client.current.status === 'failed') db.stopFlag = true; };
    await execute(db, client);
    expect(db.statusChanges.at(-1)?.status).toBe('stopped');
    expect(db.modelCalls).toEqual([]);
    expect(db.messages.get(0)?.status).toBe('incomplete');
  });

  it('closes activity and preserves partial output when runtime status becomes unreachable', async () => {
    const client = new FakeHermesClient();
    client.onStatus = () => { if (terminalHermesStatus(client.current.status)) throw new Error('private upstream failure'); };
    const { db } = await execute(new FakeRuntimeDb(), client);
    expect(db.statusChanges.at(-1)).toMatchObject({ status: 'error', error: { reason: 'hermes_unavailable' } });
    expect(db.messages.get(0)).toMatchObject({ status: 'incomplete' });
    expect(db.events.filter((event) => event.kind === 'run.step').at(-1)?.payload).toMatchObject({ state: 'failed' });
    expect(db.events.filter((event) => event.kind === 'message.final')).toHaveLength(1);
    expect(client.stops).toEqual([NATIVE_ID]);
    expect(JSON.stringify(db.events)).not.toContain('private upstream failure');
  });

  it('keeps an explicitly empty final output instead of promoting intermediate prose to the answer', async () => {
    const client = new FakeHermesClient();
    client.final.output = '';
    const { db } = await execute(new FakeRuntimeDb(), client);
    expect(db.messages.get(0)).toMatchObject({ text: '', status: 'complete' });
    expect(db.modelCalls).toEqual([]);
  });

  it('stops the native execution if its attempt was superseded before the binding could be saved', async () => {
    const db = new FakeRuntimeDb();
    db.acceptBinding = false;
    const { client } = await execute(db);
    expect(client.stops.length).toBeGreaterThan(0);
    expect(client.eventSubscriptions).toBe(0);
    expect(db.messages.size).toBe(0);
  });

  it('does not duplicate final assistant history when the execute checkpoint is replayed after persistence', async () => {
    const { db, client, step } = await execute();
    const firstMessageId = db.messages.get(0)?.id;
    // Simulate process loss after durable writes, before the step checkpoint.
    step.results.delete('hermes-execute');
    await execute(db, client, new FakeStep(step));
    expect(client.submissions).toHaveLength(1);
    expect(db.messages.size).toBe(1);
    expect(db.messages.get(0)?.id).toBe(firstMessageId);
    expect(db.turns.filter((turn) => turn.role === 'assistant' && !turn.providerMessage.tool_calls?.length)).toHaveLength(1);
  });

  it('does not meter or emit a completed native run again after losing the execute checkpoint', async () => {
    const { db, client, step } = await execute();
    const originalEvents = [...db.events];
    const originalActiveMs = (await db.loadRun())!.activeMs;
    step.results.delete('hermes-execute');
    await execute(db, client, new FakeStep(step));
    expect(db.modelCalls).toHaveLength(0);
    expect((await db.loadRun())!.activeMs).toBe(originalActiveMs);
    expect(db.events).toEqual(originalEvents);
    expect(db.finalizations).toBe(1);
    assertRunLog(db.streamEvents(), { requireFinalPerTurn: true });
  });

  it('publishes terminal events only after the finalization transaction has completed', async () => {
    const db = new FakeRuntimeDb();
    let finalPublished = false;
    await execute(db, new FakeHermesClient(), new FakeStep(), async (_session, _run, events) => {
      if (events.some((event) => event.kind === 'message.final')) {
        finalPublished = true;
        expect(db.finalizing).toBe(false);
        expect(db.messages.get(0)?.status).toBe('complete');
        expect(db.statusChanges.at(-1)?.status).toBe('completed');
        expect(db.modelCalls).toHaveLength(1);
      }
      return { stop_requested: false };
    });
    expect(finalPublished).toBe(true);
    expect(db.finalizations).toBe(1);
  });

  it('measures final persistence through commit before terminal delivery without recording content', async () => {
    let now = 10_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const measurements: Array<Parameters<NonNullable<RuntimeDeps['onLatency']>>[0]> = [];
    class TimedDb extends FakeRuntimeDb {
      override async finalizeRuntime<T>(id: string, attempt: number, work: () => Promise<T>) {
        const events = await super.finalizeRuntime(id, attempt, work);
        now += 450; // Includes transaction commit, not just its callback.
        return events;
      }
    }
    try {
      const db = new TimedDb();
      const client = new FakeHermesClient();
      await execute(db, client, new FakeStep(), async (_sessionId, _runId, events) => {
        if (events.some((event) => event.kind === 'message.final')) {
          expect(measurements).toContainEqual(expect.objectContaining({ phase: 'final_persistence', duration_ms: 450 }));
          expect(db.finalizing).toBe(false);
          now += 40;
        }
        return { stop_requested: false };
      }, { onLatency: (measurement) => { measurements.push(measurement); } });
      const phases = measurements.map((measurement) => measurement.phase);
      expect(phases).toContain('native_stream_terminal');
      expect(phases).toContain('native_status_terminal');
      expect(phases).toContain('final_stream_drain');
      expect(phases).toContain('final_checkpoint_drain');
      expect(measurements).toContainEqual(expect.objectContaining({ phase: 'final_delivery', duration_ms: 40 }));
      expect(JSON.stringify(measurements)).not.toContain(client.final.output);
      expect(db.statusChanges.at(-1)?.status).toBe('completed');
    } finally { clock.mockRestore(); }
  });

  it('preserves the completed run and durable final events when their live delivery fails', async () => {
    const db = new FakeRuntimeDb();
    await execute(db, new FakeHermesClient(), new FakeStep(), async (_session, _run, events) => {
      if (events.some((event) => event.kind === 'message.final')) throw new Error('hub disconnected with sensitive upstream detail');
      return { stop_requested: false };
    });
    expect(db.statusChanges.at(-1)?.status).toBe('completed');
    expect(db.messages.get(0)?.status).toBe('complete');
    expect(db.events.filter((event) => event.kind === 'message.final')).toHaveLength(1);
    expect(db.events.filter((event) => event.kind === 'run.status')).toHaveLength(1);
    expect(JSON.stringify(db.events)).not.toContain('sensitive upstream detail');
    assertRunLog(db.streamEvents(), { requireFinalPerTurn: true });
  });
});
