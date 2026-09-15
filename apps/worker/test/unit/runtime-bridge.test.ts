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
  async findRuntimeRun(id: string, agent: string) { return this.mapped && id === remoteId && agent === agentId ? this.loadRun() : null; }
  async mappingPending() { return this.pending; }
  async withCallLock<T>(_agent: string, fn: () => Promise<T>): Promise<T> { return fn(); }
  async lockRun() {}
  async nextRuntimeSequence() { return Math.max(...this.turns.map((turn) => turn.seq)) + 1; }
  async runtimeCall(_run: string, id: string): Promise<RuntimeCallRecord | null> {
    const row = this.turns.find((turn) => turn.role === 'assistant' && turn.providerMessage.tool_calls?.some((call) => call.id === id));
    const call = row?.providerMessage.tool_calls?.find((item) => item.id === id);
    return row && call ? { turn: row.turn, seq: row.seq, call, ok: null, result: this.turns.find((turn) => turn.toolCallId === id)?.providerMessage.content ?? null } : null;
  }
  override loadToolNames() { return this.capabilities ? Promise.resolve(this.capabilities) : super.loadToolNames(); }
}
const call = (name = 'list_requests', args: Record<string, unknown> = {}): RuntimeCall => ({ runtime_run_id: remoteId, tool_call_id: 'native-call-1', name, arguments: args });
const db = (overrides = {}) => new FakeBridgeDb({ workspaceId, agentId, ...overrides });

describe('official runtime configuration and authentication', () => {
  it('derives a deterministic agent profile and accepts only the scoped HMAC', async () => {
    expect(runtimeBinding(env, workspaceId, agentId).profile).toBe(`agent-${agentId}`);
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
  it('requires trusted runtime and call identifiers separately from model arguments', () => {
    expect(() => parseRuntimeCall({ name: 'list_requests', arguments: { runtime_run_id: remoteId, tool_call_id: 'call' } })).toThrow();
    expect(() => parseRuntimeCall({ ...call(), arguments: [] })).toThrow();
  });
});

describe('enterprise runtime tool boundary', () => {
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
  const selected = 'openrouter:nousresearch/hermes-4';
  const makeModelDb = () => ({
    activeProfileRun: async () => (await db({ modelId: selected }).loadRun()),
    allowedRuntimeModels: async () => [{ model_id: selected, provider: 'openrouter' }],
    resolveCredential: vi.fn(async () => ({ provider: 'openrouter', apiKey: 'workspace-provider-secret', keyId: 'key-1' })),
  });
  it('forwards only the selected raw catalog model to fixed OpenRouter with fresh workspace credentials', async () => {
    const store = makeModelDb();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ choices: [] }));
    const value = { model: 'nousresearch/hermes-4', messages: [], models: ['evil/model'], provider: { api_key: 'attacker' }, base_url: 'https://attacker.example', reasoning_effort: 'high' };
    const response = await proxyRuntimeModel(env, store, workspaceId, agentId, value, fetcher);
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('manual');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer workspace-provider-secret');
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'nousresearch/hermes-4', messages: [], reasoning: { effort: 'high' } });
    expect(await response.text()).not.toContain('workspace-provider-secret');
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
});
