// Runtime callbacks must retain tenant, attempt, mode, replay and BYOK gates.
import { describe, expect, it, vi } from 'vitest';
import { bridgeToken, requireBridgeAuth, runtimeBinding } from '../../src/runtime/config.js';
import { dispatchRuntimeCall, parseRuntimeCall, proxyRuntimeModel, type RuntimeCall } from '../../src/runtime/bridge.js';
import type { RuntimeCallRecord } from '../../src/runtime/store.js';
import type { Env } from '../../src/env.js';
import { FakeAgentDb } from './engine/fake-db.js';

const workspaceId = FakeAgentDb.WORKSPACE_ID;
const agentId = '33333333-3333-4333-8333-333333333333';
const remoteId = 'runtime-1';
const env = {
  ENVIRONMENT: 'development', AGENT_RUNTIME: 'hermes', HERMES_BRIDGE_SECRET: 'test-only-bridge-secret-that-is-at-least-32-characters',
  HERMES_RUNTIME_AGENTS: JSON.stringify({ [agentId]: { workspace_id: workspaceId, base_url: 'http://localhost:8642', api_key: 'test-runtime-token' } }),
} as unknown as Env;
class FakeBridgeDb extends FakeAgentDb {
  mapped = true;
  pending = false;
  capabilities: string[] | null = null;
  inCallLock = false;
  approvalRanInsideCallLock: boolean | null = null;
  async findRuntimeRun(id: string, agent: string) { return this.mapped && id === remoteId && agent === agentId ? this.loadRun() : null; }
  async mappingPending() { return this.pending; }
  async withCallLock<T>(_agent: string, fn: () => Promise<T>): Promise<T> {
    this.inCallLock = true;
    try { return await fn(); }
    finally { this.inCallLock = false; }
  }
  async lockRun() {}
  async startRuntimeWait() {}
  async endRuntimeWait() {}
  async nextRuntimeSequence() { return Math.max(...this.turns.map((turn) => turn.seq)) + 1; }
  async runtimeCall(_run: string, id: string): Promise<RuntimeCallRecord | null> {
    const row = this.turns.find((turn) => turn.role === 'assistant' && turn.providerMessage.tool_calls?.some((call) => call.id === id));
    const call = row?.providerMessage.tool_calls?.find((item) => item.id === id);
    return row && call ? { turn: row.turn, seq: row.seq, call, ok: null, result: this.turns.find((turn) => turn.toolCallId === id)?.providerMessage.content ?? null } : null;
  }
  override loadToolNames() { return this.capabilities ? Promise.resolve(this.capabilities) : super.loadToolNames(); }
  override proposeApproval(_input: Parameters<FakeAgentDb['proposeApproval']>[0]) {
    this.approvalRanInsideCallLock = this.inCallLock;
    return Promise.reject(new Error('fixture policy rejected the proposal'));
  }
}
const call = (name = 'list_requests', args: Record<string, unknown> = {}): RuntimeCall => ({ runtime_run_id: remoteId, tool_call_id: 'native-call-1', name, arguments: args });
const db = (overrides = {}) => new FakeBridgeDb({ workspaceId, agentId, ...overrides });

describe('official runtime configuration and authentication', () => {
  it('derives a deterministic agent profile and accepts only the scoped HMAC', async () => {
    expect(runtimeBinding(env, workspaceId, agentId)).toMatchObject({
      profile: `agent-${agentId}`,
      transport: 'native',
    });
    const token = await bridgeToken(env, workspaceId, agentId);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    await expect(requireBridgeAuth(env, workspaceId, agentId, `Bearer ${token}`)).resolves.toMatchObject({ workspaceId, agentId });
    await expect(requireBridgeAuth(env, workspaceId, agentId, `Bearer ${'0'.repeat(64)}`)).rejects.toMatchObject({ reason: 'runtime_unauthorized' });
    await expect(requireBridgeAuth(env, workspaceId, agentId, null)).rejects.toMatchObject({ reason: 'runtime_unauthorized' });
  });
  it('refuses cross-workspace paths even with the original valid token', async () => {
    const token = await bridgeToken(env, workspaceId, agentId);
    await expect(requireBridgeAuth(env, crypto.randomUUID(), agentId, `Bearer ${token}`)).rejects.toMatchObject({ reason: 'runtime_binding_mismatch' });
  });
  it('fails closed for absent allowlists, weak secrets, legacy and production HTTP', () => {
    for (const change of [{ HERMES_RUNTIME_AGENTS: '{}' }, { HERMES_BRIDGE_SECRET: 'short' }, { AGENT_RUNTIME: 'legacy' }, { AGENT_RUNTIME: undefined }, { ENVIRONMENT: 'production' }]) {
      expect(() => runtimeBinding({ ...env, ...change }, workspaceId, agentId)).toThrow();
    }
  });
  it('does not allow remote HTTP or embedded URL credentials in development', () => {
    for (const base_url of ['http://runtime.example', 'https://token@runtime.example', 'https://runtime.example?key=token']) {
      const changed = { ...env, HERMES_RUNTIME_AGENTS: JSON.stringify({ [agentId]: { workspace_id: workspaceId, base_url, api_key: 'runtime-key' } }) };
      expect(() => runtimeBinding(changed, workspaceId, agentId)).toThrow();
    }
  });
  it('accepts only the explicit Cloud dashboard connector transport', () => {
    const connector = {
      ...env,
      ENVIRONMENT: 'production',
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [agentId]: {
          workspace_id: workspaceId,
          base_url: 'https://iris.example/api/plugins/enterprise_bridge/control',
          api_key: 'runtime-key',
          transport: 'dashboard_connector',
        },
      }),
    };
    expect(runtimeBinding(connector, workspaceId, agentId).transport).toBe('dashboard_connector');
    const invalid = {
      ...connector,
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [agentId]: {
          workspace_id: workspaceId,
          base_url: 'https://iris.example/api/plugins/enterprise_bridge/control',
          api_key: 'runtime-key',
          transport: 'arbitrary_proxy',
        },
      }),
    };
    expect(() => runtimeBinding(invalid, workspaceId, agentId)).toThrow();
  });
  it('requires trusted runtime and call identifiers separately from model arguments', () => {
    expect(() => parseRuntimeCall({ name: 'list_requests', arguments: { runtime_run_id: remoteId, tool_call_id: 'call' } })).toThrow();
    expect(() => parseRuntimeCall({ ...call(), arguments: [] })).toThrow();
  });
});

describe('enterprise runtime tool boundary', () => {
  it('executes the app-role approval domain outside the agent run-row lock', async () => {
    const store = db();
    store.capabilities = ['propose_approval'];
    const result = await dispatchRuntimeCall(store, workspaceId, agentId, call('propose_approval', {
      label: 'Reviewed plan',
      policy_key: 'run-plan-standard',
      proposal: {
        kind: 'approval', approval_type: 'run_plan', summary: 'Prepare the reviewed report.',
        consequence: 'One bounded run may start after human approval.', evidence: [], illustrative: true,
        details: {
          goal: 'Prepare the report.',
          steps: [{ id: 'report', label: 'Prepare report', agent_id: agentId, output: 'Report' }],
          participating_agents: [{ agent_id: agentId, role: 'Researcher' }],
          deliverables: ['Report'], schedule: 'Once after approval.',
          budget: {
            currency: 'USD', estimated_min_minor: 0, estimated_max_minor: 0, cap_minor: 0,
            total_token_cap: 1000, call_cap: 1, max_output_tokens_per_call: 100,
            max_parallel_calls: 1, model_ids: ['openrouter:model-a'], metered_tools: [],
            retries_included: 0, illustrative: true,
          },
        },
      },
      continuation: {},
    }));
    expect(store.approvalRanInsideCallLock).toBe(false);
    expect(result.reply).toMatchObject({ ok: false });
    expect('content' in result.reply ? result.reply.content : '').toContain('fixture policy rejected');
  });

  it('refuses stopped and terminal runs before any tool writes', async () => {
    for (const status of ['stopped', 'stopping', 'completed', 'error']) {
      const store = db({ status });
      await expect(dispatchRuntimeCall(store, workspaceId, agentId, call())).rejects.toMatchObject({ reason: 'runtime_run_inactive' });
      expect(store.turns).toHaveLength(1);
    }
    const store = db(); store.stopFlag = true;
    await expect(dispatchRuntimeCall(store, workspaceId, agentId, call())).rejects.toMatchObject({ reason: 'runtime_run_inactive' });
  });
  it('rejects a stale attempt mapping and distinguishes the submission race', async () => {
    const store = db(); store.mapped = false;
    await expect(dispatchRuntimeCall(store, workspaceId, agentId, call())).rejects.toMatchObject({ reason: 'runtime_run_inactive' });
    store.pending = true;
    await expect(dispatchRuntimeCall(store, workspaceId, agentId, call())).rejects.toMatchObject({ reason: 'mapping_pending' });
  });
  it('refuses capabilities outside the current run mode, including human-only actions', async () => {
    const store = db({ mode: 'ask' });
    await expect(dispatchRuntimeCall(store, workspaceId, agentId, call('propose_instruction', { body: 'Read this' }))).rejects.toMatchObject({ reason: 'runtime_tool_forbidden' });
    await expect(dispatchRuntimeCall(store, workspaceId, agentId, call('decide'))).rejects.toMatchObject({ reason: 'runtime_tool_forbidden' });
    store.capabilities = [];
    await expect(dispatchRuntimeCall(store, workspaceId, agentId, call())).rejects.toMatchObject({ reason: 'runtime_tool_forbidden' });
  });
  it('replays identical results without another proposal or event and rejects argument changes', async () => {
    const store = db();
    const input = call('propose_instruction', { body: 'Always cite sources.', sources: [] });
    const first = await dispatchRuntimeCall(store, workspaceId, agentId, input);
    const replay = await dispatchRuntimeCall(store, workspaceId, agentId, input);
    expect(replay.reply).toEqual(first.reply);
    expect(replay.events).toEqual([]);
    expect(store.instructions).toHaveLength(1);
    expect(store.turns).toHaveLength(3);
    expect(store.turns[1]?.turn).toBe(store.turns[2]?.turn);
    await expect(dispatchRuntimeCall(store, workspaceId, agentId, { ...input, arguments: { body: 'Different instructions.' } })).rejects.toMatchObject({ reason: 'runtime_call_conflict' });
    expect(store.instructions).toHaveLength(1);
  });
  it('rechecks capabilities before even returning a previously allowed result', async () => {
    const store = db();
    await dispatchRuntimeCall(store, workspaceId, agentId, call());
    store.capabilities = [];
    await expect(dispatchRuntimeCall(store, workspaceId, agentId, call())).rejects.toMatchObject({ reason: 'runtime_tool_forbidden' });
  });
  it('keeps Plan actions prepared without writing the instruction', async () => {
    const store = db({ mode: 'plan' });
    const result = await dispatchRuntimeCall(store, workspaceId, agentId, call('propose_instruction', { body: 'Always cite sources.' }));
    expect(result.reply).toMatchObject({ ok: true });
    if ('content' in result.reply) expect(JSON.parse(result.reply.content).data).toMatchObject({ written: false, prepared: { tool: 'propose_instruction' } });
    expect(store.instructions).toHaveLength(0);
  });
  it('persists a visible question, polls it, and returns only a human answer', async () => {
    const store = db();
    const input = call('ask_for_context', { key: 'budget', question: 'What is the budget?' });
    expect((await dispatchRuntimeCall(store, workspaceId, agentId, input)).reply).toEqual({ status: 'pending' });
    expect(store.contextFields.get('budget')).toBe('');
    expect((await store.loadRun())?.status).toBe('waiting');
    expect((await dispatchRuntimeCall(store, workspaceId, agentId, input)).reply).toEqual({ status: 'pending' });
    expect(store.turns).toHaveLength(2);
    store.contextFields.set('budget', '500');
    const answered = await dispatchRuntimeCall(store, workspaceId, agentId, input);
    expect(answered.reply).toMatchObject({ ok: true });
    if ('content' in answered.reply) expect(JSON.parse(answered.reply.content).data).toEqual({ key: 'budget', value: '500' });
    expect((await store.loadRun())?.status).toBe('working');
    expect(store.turns).toHaveLength(3);
  });
});

describe('workspace model credential proxy', () => {
  const selected = 'nous:nousresearch/hermes-4';
  const makeModelDb = () => ({
    activeProfileRun: async () => (await db({ modelId: selected }).loadRun()),
    allowedRuntimeModels: async () => [{ model_id: selected, provider: 'nous_portal' }],
    resolveCredential: vi.fn(async () => ({ provider: 'nous_portal', apiKey: 'workspace-provider-secret', keyId: 'key-1' })),
    recordModelCall: vi.fn(async () => undefined),
  });
  it('forwards only the selected raw catalog model to fixed Nous Portal with fresh workspace credentials', async () => {
    const store = makeModelDb();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 2 } },
    }));
    const value = { model: 'nousresearch/hermes-4', messages: [], models: ['evil/model'], provider: { api_key: 'attacker' }, base_url: 'https://attacker.example', reasoning_effort: 'high' };
    const response = await proxyRuntimeModel(env, store, workspaceId, agentId, value, fetcher);
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://inference-api.nousresearch.com/v1/chat/completions');
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer workspace-provider-secret');
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'nousresearch/hermes-4', messages: [], reasoning: { effort: 'high' } });
    expect(await response.text()).not.toContain('workspace-provider-secret');
    expect(store.recordModelCall).toHaveBeenCalledWith(expect.objectContaining({
      runId: expect.any(String), turn: null, modelId: selected, provider: 'nous_portal', keyId: 'key-1',
      usage: { input_tokens: 7, output_tokens: 3, cached_input_tokens: 2, reasoning_tokens: 0 }, status: 'ok',
    }));
  });
  it('refuses another model or workspace before decrypting a key or making a request', async () => {
    const store = makeModelDb(); const fetcher = vi.fn<typeof fetch>();
    expect((await proxyRuntimeModel(env, store, workspaceId, agentId, { model: 'another/model', messages: [] }, fetcher)).status).toBe(403);
    expect((await proxyRuntimeModel(env, store, crypto.randomUUID(), agentId, { model: 'nousresearch/hermes-4', messages: [] }, fetcher)).status).toBe(409);
    expect(store.resolveCredential).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses provider redirects without forwarding their body or secret to another origin', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('workspace-provider-secret', { status: 307, headers: { Location: 'https://attacker.example' } }));
    const response = await proxyRuntimeModel(env, makeModelDb(), workspaceId, agentId, { model: 'nousresearch/hermes-4', messages: [] }, fetcher);
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('workspace-provider-secret');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    [401, 'runtime_provider_auth'],
    [402, 'runtime_provider_quota'],
    [404, 'runtime_model_unavailable'],
    [429, 'runtime_provider_rate_limited'],
    [503, 'runtime_provider_unavailable'],
    [422, 'runtime_provider_rejected'],
  ])('classifies an upstream %i without forwarding provider-controlled diagnostics', async (status, code) => {
    const store = makeModelDb();
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      'provider diagnostic containing workspace-provider-secret',
      { status },
    ));
    const response = await proxyRuntimeModel(
      env, store, workspaceId, agentId,
      { model: 'nousresearch/hermes-4', messages: [] },
      fetcher,
    );
    expect(response.status).toBe(status);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: { message: code, type: 'runtime_bridge_error', code },
    });
    expect(store.recordModelCall).toHaveBeenCalledWith(expect.objectContaining({
      modelId: selected, provider: 'nous_portal', keyId: 'key-1', status: 'error',
    }));
  });
  it('reserves an approved plan before fetch and reconciles final streamed usage', async () => {
    const store = {
      ...makeModelDb(),
      runtimeBudgetForRun: vi.fn(async () => ({
        budgetId: 'budget-1', authorizationState: 'admitted', state: 'active', modelId: selected,
        maxOutputTokensPerCall: 100, contextLength: 32_000, pricingVerifiedOn: '2026-09-15',
        pricing: { input: 1, output: 2, cachedInput: 0.25 },
      })),
      reserveRuntimeBudget: vi.fn(async () => ({ reservationId: 'reservation-1', budgetId: 'budget-1' })),
      reconcileRuntimeBudget: vi.fn(async () => undefined),
    };
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      'data: {"usage":{"prompt_tokens":20,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":4}}}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    const response = await proxyRuntimeModel(
      env, store, workspaceId, agentId,
      { model: 'nousresearch/hermes-4', messages: [{ role: 'user', content: 'bounded' }], max_tokens: 50, stream: true },
      fetcher,
    );
    expect(store.reserveRuntimeBudget).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    await response.text();
    expect(store.reconcileRuntimeBudget).toHaveBeenCalledWith({
      reservationId: 'reservation-1',
      resolution: 'completed',
      usage: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 4 },
      actualCostUsd: 0.000027,
    });
    expect(store.recordModelCall).toHaveBeenCalledWith(expect.objectContaining({
      keyId: 'key-1', status: 'ok',
      usage: { input_tokens: 20, output_tokens: 5, cached_input_tokens: 4, reasoning_tokens: 0 },
    }));
  });
  it('fails a budgeted call closed when catalog pricing or output bounds are unavailable', async () => {
    const store = {
      ...makeModelDb(),
      runtimeBudgetForRun: vi.fn(async () => ({
        budgetId: 'budget-1', authorizationState: 'admitted', state: 'active', modelId: selected,
        maxOutputTokensPerCall: 100, contextLength: 32_000, pricingVerifiedOn: null,
        pricing: null,
      })),
      reserveRuntimeBudget: vi.fn(),
      reconcileRuntimeBudget: vi.fn(),
    };
    const fetcher = vi.fn<typeof fetch>();
    const response = await proxyRuntimeModel(
      env, store, workspaceId, agentId,
      { model: 'nousresearch/hermes-4', messages: [], max_tokens: 10 },
      fetcher,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'approval_budget_price_unknown' } });
    expect(store.resolveCredential).not.toHaveBeenCalled();
    expect(store.reserveRuntimeBudget).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
