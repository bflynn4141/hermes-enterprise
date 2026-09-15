// Authenticated official Hermes callbacks. The runtime receives only scoped
// bridge credentials; enterprise tools retain the existing agent-role boundary.
import type { Context } from 'hono';
import { openRouterModelId } from '@hermes/shared';
import type { Env } from '../env.js';
import type { AgentDb, EmittedEvent, EngineRunRow, EmitInput } from '../engine/agent-db.js';
import { allowedTools, executeTool, FOCUS_TOOLS, TOOL_SOURCE, toolResultEnvelope, type FetchUrlRunner } from '../engine/tools.js';
import { denyHostsFor, fetchUrl } from '../security/fetch-url.js';
import { isProviderAllowed } from '../model/allowed.js';
import { ATTRIBUTION_HEADERS, OPENROUTER_BASE } from '../model/openrouter.js';
import type { ProviderMessage } from '../model/types.js';
import { pathUuid, RouteError } from '../routes/tenant.js';
import { requireBridgeAuth } from './config.js';
import { RuntimeDb, type RuntimeCallRecord } from './store.js';

export interface BridgeDb extends AgentDb {
  findRuntimeRun(remoteRunId: string, agentId: string): Promise<EngineRunRow | null>;
  mappingPending(agentId: string): Promise<boolean>;
  withCallLock<T>(agentId: string, fn: () => Promise<T>): Promise<T>;
  lockRun(runId: string): Promise<void>;
  runtimeCall(runId: string, callId: string): Promise<RuntimeCallRecord | null>;
  nextRuntimeSequence(runId: string): Promise<number>;
}
export interface RuntimeCall {
  readonly runtime_run_id: string;
  readonly tool_call_id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}
export type CallReply = { readonly ok: boolean; readonly content: string } | { readonly status: 'pending' };
export interface CallResult {
  readonly reply: CallReply;
  readonly events: readonly EmittedEvent[];
  readonly run: EngineRunRow;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export function parseRuntimeCall(value: unknown): RuntimeCall {
  if (!object(value) || typeof value.runtime_run_id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value.runtime_run_id) ||
      typeof value.tool_call_id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value.tool_call_id) ||
      typeof value.name !== 'string' || !/^[a-z_]{1,64}$/.test(value.name) || !object(value.arguments)) {
    throw new RouteError('Invalid runtime tool call.', 'bad_body', 400);
  }
  return { runtime_run_id: value.runtime_run_id, tool_call_id: value.tool_call_id, name: value.name, arguments: value.arguments };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function durableCallId(call: RuntimeCall): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${call.runtime_run_id}:${call.tool_call_id}`));
  return `hermes-${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
function requireActive(run: EngineRunRow | null, workspaceId: string, agentId: string): asserts run is EngineRunRow {
  if (!run || run.workspaceId !== workspaceId || run.agentId !== agentId || run.stopRequested || !['working', 'waiting'].includes(run.status)) {
    throw new RouteError('This runtime run is no longer active.', 'runtime_run_inactive', 409);
  }
}
export async function dispatchRuntimeCall(
  db: BridgeDb, workspaceId: string, agentId: string, call: RuntimeCall,
  options: { now?: () => Date; fetchUrl?: FetchUrlRunner } = {},
): Promise<CallResult> {
  const now = options.now ?? (() => new Date());
  return db.withCallLock(agentId, async () => {
    let run = await db.findRuntimeRun(call.runtime_run_id, agentId);
    if (!run && await db.mappingPending(agentId)) throw new RouteError('The runtime mapping is being committed.', 'mapping_pending', 409);
    requireActive(run, workspaceId, agentId);
    await db.lockRun(run.id);
    run = await db.findRuntimeRun(call.runtime_run_id, agentId);
    requireActive(run, workspaceId, agentId);
    const tool = allowedTools(run.mode, await db.loadToolNames(agentId)).find((entry) => entry.name === call.name);
    if (!tool) throw new RouteError('This tool is not available to this run.', 'runtime_tool_forbidden', 403);
    const callId = await durableCallId(call);
    const existing = await db.runtimeCall(run.id, callId);
    if (existing && (existing.call.name !== call.name || canonical(JSON.parse(existing.call.arguments)) !== canonical(call.arguments))) {
      throw new RouteError('The tool call id already names different arguments.', 'runtime_call_conflict', 409);
    }
    if (existing?.result !== null && existing?.result !== undefined) {
      const envelope = JSON.parse(existing.result) as { data?: { error?: unknown } };
      return { run, events: [], reply: { ok: existing.ok ?? !envelope.data?.error, content: existing.result } };
    }
    if (run.status === 'waiting' && !existing) throw new RouteError('The run is waiting for a human answer.', 'runtime_run_waiting', 409);
    const seq = existing?.seq ?? await db.nextRuntimeSequence(run.id);
    const turn = existing?.turn ?? 0;
    const stepId = `tool-${callId}`.slice(0, 64);
    const step = { runId: run.id, turn, stepId, label: call.name, toolCallId: callId };
    const events: EmittedEvent[] = [];
    const emit = async (inputs: EmitInput[]): Promise<void> => { events.push(...await db.emit(inputs.map((event) => ({ ...event, sessionId: run.sessionId })))); };
    if (!existing) {
      // Raw arguments and the native identifiers stay in the tenant trace,
      // never in Workflow checkpoints or event payloads.
      const providerMessage: ProviderMessage & { runtime_run_id: string; runtime_tool_call_id: string } = {
        role: 'assistant', content: '', tool_calls: [{ id: callId, name: call.name, arguments: JSON.stringify(call.arguments) }],
        runtime_run_id: call.runtime_run_id, runtime_tool_call_id: call.tool_call_id,
      };
      await db.appendTurn({ runId: run.id, turn, seq, role: 'assistant', providerMessage });
      await db.enterStep({ ...step, state: 'active' });
      await emit([{ kind: 'run.step', payload: { run_id: run.id, attempt: run.attempt, turn, step_id: stepId, label: call.name, state: 'active', tool_call_id: callId } }]);
    }
    const outcome = await executeTool(tool, call.arguments, { writes: db, reads: db, run, toolCallId: callId, now, mode: run.mode, fetchUrl: options.fetchUrl });
    let content: string;
    if (outcome.ok && outcome.waiting) {
      const { key, label } = outcome.waiting;
      await db.ensureContextField({ runId: run.id, toolCallId: callId, agentId, key });
      const answer = await db.readContextField(agentId, key);
      if (!answer?.trim()) {
        if (run.status !== 'waiting') {
          await db.setRunStatus(run.id, 'waiting', { waitingFor: key, waitingLabel: label });
          await emit([{ kind: 'run.status', payload: { run_id: run.id, attempt: run.attempt, status: 'waiting', waiting_for: key, waiting_label: label } }]);
        }
        return { run, events, reply: { status: 'pending' } };
      }
      content = toolResultEnvelope(call.name, 'workspace.agent_context_fields', { key, value: answer }, now());
      if (run.status === 'waiting') {
        await db.setRunStatus(run.id, 'working', { waitingFor: null, waitingLabel: null });
        await emit([{ kind: 'run.status', payload: { run_id: run.id, attempt: run.attempt, status: 'working' } }]);
      }
    } else {
      content = outcome.ok ? toolResultEnvelope(call.name, TOOL_SOURCE[call.name] ?? 'engine', outcome.data, now()) : toolResultEnvelope(call.name, 'engine', { error: outcome.error }, now());
    }
    // The result id is reserved by this transaction's lock. A disconnected
    // callback can replay the committed response without making a second row.
    const resultMessage: ProviderMessage & { runtime_ok: boolean } = { role: 'tool', tool_call_id: callId, content, runtime_ok: outcome.ok };
    await db.appendTurn({ runId: run.id, turn, seq: seq + 1, role: 'tool', toolCallId: callId, providerMessage: resultMessage });
    await db.finishStep({ ...step, state: outcome.ok ? 'done' : 'failed' });
    await emit([{ kind: 'run.step', payload: { run_id: run.id, attempt: run.attempt, turn, step_id: stepId, label: call.name, state: outcome.ok ? 'done' : 'failed', tool_call_id: callId } }]);
    if (outcome.ok && outcome.focus && FOCUS_TOOLS.has(call.name)) {
      await emit([{ kind: 'run.focus', payload: { run_id: run.id, session_id: run.sessionId, ref: outcome.focus.ref, entity_type: outcome.focus.entityType, entity_id: outcome.focus.entityId } }]);
    }
    if (outcome.ok && outcome.published) events.push(...outcome.published);
    return { run, events, reply: { ok: outcome.ok, content } };
  });
}
async function authenticate(c: Context<{ Bindings: Env }>): Promise<{ workspaceId: string; agentId: string }> {
  const workspaceId = pathUuid(c, 'ws');
  const agentId = pathUuid(c, 'agentId');
  await requireBridgeAuth(c.env, workspaceId, agentId, c.req.header('Authorization') ?? null);
  return { workspaceId, agentId };
}
async function body(c: Context<{ Bindings: Env }>): Promise<unknown> {
  if (Number(c.req.header('Content-Length') ?? 0) > 1_048_576) throw new RouteError('Runtime body too large.', 'bad_body', 400);
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > 1_048_576) throw new RouteError('Runtime body too large.', 'bad_body', 400);
  try { return JSON.parse(text); } catch { throw new RouteError('Invalid JSON body.', 'bad_body', 400); }
}
export async function listRuntimeTools(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { workspaceId, agentId } = await authenticate(c);
  const db = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
  try {
    const tools = allowedTools('work', await db.loadToolNames(agentId));
    return c.json({ tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.input_schema })) });
  } finally { await db.close(); }
}
async function publish(env: Env, workspaceId: string, result: CallResult): Promise<void> {
  const rows = result.events.map((event) => ({ id: event.id, workspace_id: workspaceId, session_id: event.sessionId, kind: event.kind, payload: event.payload, schema_version: 1, trace_id: event.traceId, at: event.at }));
  const session = rows.filter((event) => event.session_id !== null);
  const workspace = rows.filter((event) => event.session_id === null);
  // Delivery failure leaves a committed outbox for the existing replay route.
  try {
    if (session.length) await env.SESSION_HUB.get(env.SESSION_HUB.idFromName(result.run.sessionId)).forward(result.run.id, session);
    if (workspace.length) await env.WORKSPACE_HUB.get(env.WORKSPACE_HUB.idFromName(workspaceId)).publish(workspace);
  } catch { /* The outbox is authoritative. */ }
}
export async function callRuntimeTool(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { workspaceId, agentId } = await authenticate(c);
  const call = parseRuntimeCall(await body(c));
  const db = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
  try {
    const result = await dispatchRuntimeCall(db, workspaceId, agentId, call, {
      fetchUrl: (url, method, allowlist) => fetchUrl(url, method, { allowlist, denyHosts: denyHostsFor(c.env) }),
    });
    await publish(c.env, workspaceId, result);
    return c.json(result.reply, 'status' in result.reply ? 202 : 200);
  } finally { await db.close(); }
}
function modelError(reason: string, status: number): Response {
  return Response.json({ error: { message: reason, type: 'runtime_bridge_error', code: reason } }, { status });
}
export async function runtimeModels(c: Context<{ Bindings: Env }>): Promise<Response> {
  let db: RuntimeDb | undefined;
  try {
    const { workspaceId } = await authenticate(c);
    if (!isProviderAllowed(c.env, 'openrouter')) return modelError('provider_not_allowed', 403);
    db = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
    await db.resolveCredential('openrouter');
    return c.json({ object: 'list', data: (await db.allowedRuntimeModels()).map((model) => ({ id: openRouterModelId(model.model_id), object: 'model', created: 0, owned_by: 'openrouter' })) });
  } catch (error) {
    return modelError(error instanceof RouteError ? error.reason : 'runtime_model_unavailable', error instanceof RouteError ? error.status : 503);
  } finally { await db?.close(); }
}
export interface ModelBridgeDb {
  activeProfileRun(agentId: string): Promise<EngineRunRow | null>;
  allowedRuntimeModels(): Promise<{ model_id: string; provider: string }[]>;
  resolveCredential: AgentDb['resolveCredential'];
}
export async function proxyRuntimeModel(env: Env, db: ModelBridgeDb, workspaceId: string, agentId: string, value: unknown, fetchImpl: typeof fetch = fetch): Promise<Response> {
  if (!isProviderAllowed(env, 'openrouter')) return modelError('provider_not_allowed', 403);
  if (!object(value) || typeof value.model !== 'string' || !Array.isArray(value.messages)) return modelError('bad_body', 400);
  const run = await db.activeProfileRun(agentId);
  if (!run || run.workspaceId !== workspaceId || run.agentId !== agentId || run.stopRequested || run.status !== 'working') return modelError('runtime_run_inactive', 409);
  const allowed = await db.allowedRuntimeModels();
  const selected = allowed.find((model) => model.model_id === run.modelId && model.provider === 'openrouter');
  if (!selected || value.model !== openRouterModelId(selected.model_id)) return modelError('runtime_model_forbidden', 403);
  // Whitelist request fields: OpenRouter fallback models, provider credentials,
  // routing URLs, and other caller-controlled routing cannot bypass the catalog.
  const forwarded: Record<string, unknown> = { model: value.model, messages: value.messages };
  for (const key of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'response_format', 'stop', 'seed', 'frequency_penalty', 'presence_penalty']) {
    if (key in value) forwarded[key] = value[key];
  }
  if (!('reasoning' in forwarded) && typeof value.reasoning_effort === 'string') forwarded.reasoning = { effort: value.reasoning_effort };
  const credential = await db.resolveCredential('openrouter');
  const response = await fetchImpl(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential.apiKey}`, ...ATTRIBUTION_HEADERS },
    body: JSON.stringify(forwarded),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return modelError('runtime_provider_rejected', response.status >= 400 && response.status < 600 ? response.status : 502);
  }
  return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' } });
}
export async function runtimeChatCompletions(c: Context<{ Bindings: Env }>): Promise<Response> {
  let db: RuntimeDb | undefined;
  try {
    const { workspaceId, agentId } = await authenticate(c);
    db = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
    return await proxyRuntimeModel(c.env, db, workspaceId, agentId, await body(c));
  } catch (error) {
    return modelError(error instanceof RouteError ? error.reason : 'runtime_model_unavailable', error instanceof RouteError ? error.status : 503);
  } finally { await db?.close(); }
}
