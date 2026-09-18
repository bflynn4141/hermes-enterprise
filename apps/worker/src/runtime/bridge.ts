// Authenticated official Hermes callbacks. The runtime receives only scoped
// bridge credentials; enterprise tools retain the existing agent-role boundary.
import type { Context } from 'hono';
import { nousModelId, openRouterModelId } from '@hermes/shared';
import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { parseProviderRetryAfter, type ProviderRetryAfter } from './retry-after.js';
import type { AgentDb, EmittedEvent, EngineRunRow, EmitInput } from '../engine/agent-db.js';
import { allowedTools, executeTool, FOCUS_TOOLS, TOOL_SOURCE, toolResultEnvelope, type FetchUrlRunner } from '../engine/tools.js';
import { denyHostsFor, fetchUrl } from '../security/fetch-url.js';
import { isProviderAllowed } from '../model/allowed.js';
import { ATTRIBUTION_HEADERS, OPENROUTER_BASE } from '../model/openrouter.js';
import { NOUS_PORTAL_BASE, NOUS_PORTAL_HEADERS } from '../model/nous.js';
import type { ProviderMessage } from '../model/types.js';
import { pathUuid, RouteError } from '../routes/tenant.js';
import {
  actualRuntimeCostUsd,
  meterRuntimeResponse,
  prepareRuntimeBudget,
  RuntimeBudgetError,
  type RuntimeBudgetDb,
  type RuntimeBudgetReservation,
  type ProviderStreamObservation,
} from './budget.js';
import { logEvent } from '../keys/redact.js';
import { requireResolvedBridgeAuth, type RuntimeBinding } from './config.js';
import { RuntimeDb, type RuntimeCallRecord } from './store.js';
import { PARTNER_PROGRAM_TOOLS, runtimeSkillManifests } from './skills.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { agentCashPeopleSearchArguments, parseAgentCashPeopleSearch } from '../partner-screening/agentcash-people.js';
import {
  AGENTCASH_CREATOR_SEARCH_ARGUMENTS,
  parseAgentCashCreatorSearch,
} from '../partner-screening/agentcash-creators.js';
import {
  AGENTCASH_CONTACT_ENRICH_URL,
  AGENTCASH_EMAIL_VERIFY_URL,
  agentCashContactEnrichmentArguments,
  agentCashEmailVerificationArguments,
  agentCashEmailVerificationPollArguments,
  parseAgentCashContactEnrichment,
  parseAgentCashEmailVerification,
  type ContactCallKind,
} from '../partner-screening/agentcash-contact.js';
import { partnerAgentConfigSchema } from '../partner-screening/config.js';
import { completePartnerScreening } from '../partner-screening/service.js';

export interface BridgeDb extends AgentDb {
  findRuntimeRun(remoteRunId: string, agentId: string): Promise<EngineRunRow | null>;
  mappingPending(agentId: string): Promise<boolean>;
  withCallLock<T>(agentId: string, fn: () => Promise<T>): Promise<T>;
  lockRun(runId: string): Promise<void>;
  runtimeCall(runId: string, callId: string): Promise<RuntimeCallRecord | null>;
  nextRuntimeSequence(runId: string): Promise<number>;
  startRuntimeWait(runId: string, attempt: number): Promise<void>;
  endRuntimeWait(runId: string, attempt: number): Promise<void>;
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

interface AgentCashPeopleImport {
  readonly runtime_run_id: string;
  readonly tool_call_id: string;
  readonly arguments: Record<string, unknown>;
  readonly result: unknown;
}

type AgentCashPeopleAuthorization = Omit<AgentCashPeopleImport, 'result'>;

function parseAgentCashPeopleAuthorization(value: unknown): AgentCashPeopleAuthorization {
  if (!object(value) || typeof value.runtime_run_id !== 'string' || !/^run_[0-9a-f]{32}$/.test(value.runtime_run_id) ||
      typeof value.tool_call_id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value.tool_call_id) ||
      !object(value.arguments)) {
    throw new RouteError('Invalid AgentCash People Search authorization.', 'bad_body', 400);
  }
  return {
    runtime_run_id: value.runtime_run_id,
    tool_call_id: value.tool_call_id,
    arguments: value.arguments,
  };
}

function parseAgentCashPeopleImport(value: unknown): AgentCashPeopleImport {
  if (!object(value) || typeof value.runtime_run_id !== 'string' || !/^run_[0-9a-f]{32}$/.test(value.runtime_run_id) ||
      typeof value.tool_call_id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value.tool_call_id) ||
      !object(value.arguments) || !('result' in value)) {
    throw new RouteError('Invalid AgentCash People Search import.', 'bad_body', 400);
  }
  return {
    runtime_run_id: value.runtime_run_id,
    tool_call_id: value.tool_call_id,
    arguments: value.arguments,
    result: value.result,
  };
}
const parseAgentCashContactAuthorization = parseAgentCashPeopleAuthorization;
const parseAgentCashContactImport = parseAgentCashPeopleImport;
const parseAgentCashCreatorAuthorization = parseAgentCashPeopleAuthorization;
const parseAgentCashCreatorImport = parseAgentCashPeopleImport;
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

interface RuntimeCallOptions {
  readonly now?: () => Date;
  readonly fetchUrl?: FetchUrlRunner;
}

/**
 * Approval proposal is the one tool whose implementation enters the app-role
 * server domain. It must not run while the agent-role transaction holds
 * `runs FOR UPDATE`: inserting the proposal's source-run foreign key needs a
 * key-share lock and would wait on our own outer transaction forever.
 *
 * Reserve the replay trace under the agent lock, commit it, execute the exact
 * idempotent proposal operation, then close the trace under the lock again.
 * A crash between phases replays the proposal with its derived idempotency key.
 */
async function dispatchRuntimeApprovalCall(
  db: BridgeDb,
  workspaceId: string,
  agentId: string,
  call: RuntimeCall,
  options: RuntimeCallOptions,
): Promise<CallResult> {
  const now = options.now ?? (() => new Date());
  const prepared = await db.withCallLock(agentId, async () => {
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
      return {
        complete: { run, events: [], reply: { ok: existing.ok ?? !envelope.data?.error, content: existing.result } } as CallResult,
      };
    }
    if (run.status === 'waiting' && !existing) throw new RouteError('The run is waiting for a human answer.', 'runtime_run_waiting', 409);
    const seq = existing?.seq ?? await db.nextRuntimeSequence(run.id);
    const turn = existing?.turn ?? 0;
    const stepId = `tool-${callId}`.slice(0, 64);
    const events: EmittedEvent[] = [];
    if (!existing) {
      await db.appendTurn({
        runId: run.id,
        turn,
        seq,
        role: 'assistant',
        providerMessage: {
          role: 'assistant', content: '',
          tool_calls: [{ id: callId, name: call.name, arguments: JSON.stringify(call.arguments) }],
          runtime_run_id: call.runtime_run_id,
          runtime_tool_call_id: call.tool_call_id,
        } as ProviderMessage & { runtime_run_id: string; runtime_tool_call_id: string },
      });
      await db.enterStep({ runId: run.id, turn, stepId, label: call.name, state: 'active', toolCallId: callId });
      events.push(...await db.emit([{
        kind: 'run.step', sessionId: run.sessionId,
        payload: { run_id: run.id, attempt: run.attempt, turn, step_id: stepId, label: call.name, state: 'active', tool_call_id: callId },
      }]));
    }
    return { run, tool, callId, seq, turn, stepId, events };
  });
  if ('complete' in prepared && prepared.complete) return prepared.complete;

  // Deliberately outside `withCallLock`; see the lock-order note above.
  const outcome = await executeTool(prepared.tool, call.arguments, {
    writes: db,
    reads: db,
    run: prepared.run,
    toolCallId: prepared.callId,
    now,
    mode: prepared.run.mode,
    fetchUrl: options.fetchUrl,
  });

  return db.withCallLock(agentId, async () => {
    await db.lockRun(prepared.run.id);
    const run = await db.findRuntimeRun(call.runtime_run_id, agentId);
    if (!run || run.workspaceId !== workspaceId || run.agentId !== agentId) {
      throw new RouteError('This runtime run is no longer available.', 'runtime_run_inactive', 409);
    }
    const replay = await db.runtimeCall(run.id, prepared.callId);
    if (replay?.result !== null && replay?.result !== undefined) {
      return { run, events: prepared.events, reply: { ok: replay.ok ?? true, content: replay.result } };
    }
    const content = outcome.ok
      ? toolResultEnvelope(call.name, TOOL_SOURCE[call.name] ?? 'engine', outcome.data, now())
      : toolResultEnvelope(call.name, 'engine', { error: outcome.error }, now());
    await db.appendTurn({
      runId: run.id, turn: prepared.turn, seq: prepared.seq + 1, role: 'tool', toolCallId: prepared.callId,
      providerMessage: { role: 'tool', tool_call_id: prepared.callId, content, runtime_ok: outcome.ok } as ProviderMessage & { runtime_ok: boolean },
    });
    await db.finishStep({
      runId: run.id, turn: prepared.turn, stepId: prepared.stepId, label: call.name,
      state: outcome.ok ? 'done' : 'failed', toolCallId: prepared.callId,
    });
    const events = [...prepared.events, ...await db.emit([{
      kind: 'run.step', sessionId: run.sessionId,
      payload: {
        run_id: run.id, attempt: run.attempt, turn: prepared.turn, step_id: prepared.stepId,
        label: call.name, state: outcome.ok ? 'done' : 'failed', tool_call_id: prepared.callId,
      },
    }])];
    if (outcome.ok && outcome.focus && FOCUS_TOOLS.has(call.name)) {
      events.push(...await db.emit([{
        kind: 'run.focus', sessionId: run.sessionId,
        payload: { run_id: run.id, session_id: run.sessionId, ref: outcome.focus.ref, entity_type: outcome.focus.entityType, entity_id: outcome.focus.entityId },
      }]));
    }
    if (outcome.ok && outcome.published) events.push(...outcome.published);
    return { run, events, reply: { ok: outcome.ok, content } };
  });
}

export async function dispatchRuntimeCall(
  db: BridgeDb, workspaceId: string, agentId: string, call: RuntimeCall,
  options: RuntimeCallOptions = {},
): Promise<CallResult> {
  if (call.name === 'propose_approval') {
    return dispatchRuntimeApprovalCall(db, workspaceId, agentId, call, options);
  }
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
        await db.startRuntimeWait(run.id, run.attempt);
        if (run.status !== 'waiting') {
          await db.setRunStatus(run.id, 'waiting', { waitingFor: key, waitingLabel: label });
          await emit([{ kind: 'run.status', payload: { run_id: run.id, attempt: run.attempt, status: 'waiting', waiting_for: key, waiting_label: label } }]);
        }
        return { run, events, reply: { status: 'pending' } };
      }
      await db.endRuntimeWait(run.id, run.attempt);
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
async function authenticate(c: Context<{ Bindings: Env }>): Promise<{
  workspaceId: string;
  agentId: string;
  binding: RuntimeBinding;
}> {
  const workspaceId = pathUuid(c, 'ws');
  const agentId = pathUuid(c, 'agentId');
  const binding = await withWorkspaceTransaction(c.env, workspaceId, (tx) =>
    requireResolvedBridgeAuth(c.env, tx, workspaceId, agentId, c.req.header('Authorization') ?? null));
  return { workspaceId, agentId, binding };
}
async function body(c: Context<{ Bindings: Env }>): Promise<unknown> {
  if (Number(c.req.header('Content-Length') ?? 0) > 1_048_576) throw new RouteError('Runtime body too large.', 'bad_body', 400);
  const text = await c.req.text();
  if (new TextEncoder().encode(text).length > 1_048_576) throw new RouteError('Runtime body too large.', 'bad_body', 400);
  try { return JSON.parse(text); } catch { throw new RouteError('Invalid JSON body.', 'bad_body', 400); }
}
export async function listRuntimeTools(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { workspaceId, agentId, binding } = await authenticate(c);
  const db = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
  try {
    const configured = await db.loadToolNames(agentId);
    // A warm profile must discover the exact schemas before its future owner
    // exists. Calls still fail closed because no run or agent capability row
    // exists until the reserved invitation is accepted.
    const names = configured.length === 0 && binding.assignment === 'invitee_pool'
      ? [...PARTNER_PROGRAM_TOOLS]
      : configured;
    const tools = allowedTools('work', names);
    return c.json({ tools: tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.input_schema })) });
  } finally { await db.close(); }
}
export async function listRuntimeSkills(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { agentId } = await authenticate(c);
  return c.json({ skills: runtimeSkillManifests(c.env, agentId) });
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

/** A retry and a paid-call lease serialize on the same task row. */
async function requireCurrentPaidRun(tx: Tx, workspaceId: string, agentId: string, runId: string, runtimeRunId: string): Promise<void> {
  const { rows } = await tx.query(
    `SELECT id FROM runs WHERE workspace_id=$1 AND agent_id=$2 AND id=$3
       AND runtime_run_id=$4 AND runtime_attempt=attempt AND status='working'
       AND NOT stop_requested FOR UPDATE`, [workspaceId,agentId,runId,runtimeRunId]);
  if (!rows.length) throw new RouteError('The task attempt is no longer active.', 'runtime_run_inactive', 409);
}

/** Atomically reserve the one paid call before the AgentCash MCP executes it. */
export async function authorizeAgentCashPeopleSearch(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { workspaceId, agentId } = await authenticate(c);
  const input = parseAgentCashPeopleAuthorization(await body(c));
  const runtime = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
  let run: EngineRunRow | null = null;
  try {
    run = await runtime.findRuntimeRun(input.runtime_run_id, agentId);
    requireActive(run, workspaceId, agentId);
  } finally {
    await runtime.close();
  }
  const match = /^partner-screening:([0-9a-f-]{36})$/i.exec(run.clientTurnId);
  if (!match) throw new RouteError('This native run is not a partner screening run.', 'runtime_run_inactive', 409);
  const screeningRunId = match[1]!;
  let created = false;
  await withWorkspaceTransaction(c.env, workspaceId, async (tx) => {
    await requireCurrentPaidRun(tx, workspaceId, agentId, run.id, input.runtime_run_id);
    const screening = await tx.query<{
      status: 'running' | 'completed' | 'failed';
      source: string;
      config_snapshot: Record<string, unknown>;
      api_requests_used: number;
      agentcash_tool_call_id: string | null;
    }>(
      `SELECT status, source, config_snapshot, api_requests_used, agentcash_tool_call_id
         FROM partner_screening_runs
        WHERE workspace_id=$1 AND id=$2 AND agent_id=$3
        FOR UPDATE`,
      [workspaceId, screeningRunId, agentId],
    );
    const row = screening.rows[0];
    if (!row || row.source !== 'agentcash_people' || row.status !== 'running') {
      throw new RouteError('No active AgentCash screening run matches this native run.', 'partner_screening_conflict', 409);
    }
    const config = partnerAgentConfigSchema.parse(row.config_snapshot);
    if (canonical(input.arguments) !== canonical(agentCashPeopleSearchArguments(config))) {
      throw new RouteError('The AgentCash call does not match the stored screening policy.', 'partner_source_policy_mismatch', 422);
    }
    if (row.api_requests_used === 1 && row.agentcash_tool_call_id === input.tool_call_id) return;
    if (row.api_requests_used !== 0 || row.agentcash_tool_call_id) {
      throw new RouteError('The AgentCash payment allowance for this screening run is already reserved.', 'partner_source_budget_exhausted', 409);
    }
    await tx.query(
      `UPDATE partner_screening_runs
          SET api_requests_used = 1, agentcash_tool_call_id = $4
        WHERE workspace_id = $1 AND id = $2 AND agent_id = $3`,
      [workspaceId, screeningRunId, agentId, input.tool_call_id],
    );
    created = true;
  });
  return c.json({ ok: true, screening_run_id: screeningRunId, reserved_requests: 1 }, created ? 201 : 200);
}

/**
 * Return the one paid response that still needs importing for this agent.
 *
 * The native profile uses this only during startup recovery. It receives no
 * new payment authority: the row must already hold the exact one-call lease.
 */
export async function pendingAgentCashPeopleSearch(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { workspaceId, agentId } = await authenticate(c);
  const pending = await withWorkspaceTransaction(c.env, workspaceId, async (tx) => tx.query<{
    runtime_run_id: string;
    agentcash_tool_call_id: string;
    config_snapshot: Record<string, unknown>;
  }>(
    `SELECT r.runtime_run_id, s.agentcash_tool_call_id, s.config_snapshot
       FROM partner_screening_runs s
       JOIN runs r
         ON r.workspace_id=s.workspace_id
        AND r.agent_id=s.agent_id
        AND r.client_turn_id='partner-screening:' || s.id::text
      WHERE s.workspace_id=$1 AND s.agent_id=$2
        AND s.source='agentcash_people' AND s.status='running'
        AND s.api_requests_used=1 AND s.agentcash_tool_call_id IS NOT NULL
        AND r.runtime_kind='hermes' AND r.runtime_run_id IS NOT NULL
      ORDER BY r.created_at DESC
      LIMIT 2`,
    [workspaceId, agentId],
  ));
  if (pending.rows.length === 0) return new Response(null, { status: 204 });
  if (pending.rows.length > 1) {
    throw new RouteError('More than one AgentCash import is pending for this agent.', 'partner_screening_conflict', 409);
  }
  const row = pending.rows[0]!;
  if (!/^run_[0-9a-f]{32}$/.test(row.runtime_run_id) || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(row.agentcash_tool_call_id)) {
    throw new RouteError('The pending AgentCash import has invalid runtime identity.', 'partner_screening_conflict', 409);
  }
  const config = partnerAgentConfigSchema.parse(row.config_snapshot);
  return c.json({
    runtime_run_id: row.runtime_run_id,
    tool_call_id: row.agentcash_tool_call_id,
    arguments: agentCashPeopleSearchArguments(config),
  });
}

/** Import the exact paid response associated with one trusted native run. */
export async function importAgentCashPeopleSearch(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { workspaceId, agentId } = await authenticate(c);
  const input = parseAgentCashPeopleImport(await body(c));
  const runtime = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
  let run: EngineRunRow | null = null;
  try {
    run = await runtime.findRuntimeRun(input.runtime_run_id, agentId);
    // A paid MCP response is written to durable spill storage before the
    // model continues. Import may legitimately be retried after the native
    // run reaches a terminal state (for example after an observer timeout).
    // The transaction below still requires the exact pre-paid tool-call lease
    // and exact stored arguments, so this grants no second payment or source
    // request and remains idempotent after completion.
    if (!run || run.workspaceId !== workspaceId || run.agentId !== agentId) {
      throw new RouteError('This runtime run is no longer available.', 'runtime_run_inactive', 409);
    }
  } finally {
    await runtime.close();
  }
  const match = /^partner-screening:([0-9a-f-]{36})$/i.exec(run.clientTurnId);
  if (!match) throw new RouteError('This native run is not a partner screening run.', 'runtime_run_inactive', 409);
  const screeningRunId = match[1]!;
  let importedCandidates = 0;
  let created = false;
  await withWorkspaceTransaction(c.env, workspaceId, async (tx) => {
    const screening = await tx.query<{
      created_by: string;
      status: 'running' | 'completed' | 'failed';
      source: string;
      config_snapshot: Record<string, unknown>;
      candidates_discovered: number;
      api_requests_used: number;
      agentcash_tool_call_id: string | null;
    }>(
      `SELECT created_by, status, source, config_snapshot, candidates_discovered,
              api_requests_used, agentcash_tool_call_id
         FROM partner_screening_runs
        WHERE workspace_id=$1 AND id=$2 AND agent_id=$3
        FOR UPDATE`,
      [workspaceId, screeningRunId, agentId],
    );
    const row = screening.rows[0];
    if (!row || row.source !== 'agentcash_people' || row.status === 'failed') {
      throw new RouteError('No active AgentCash screening run matches this native run.', 'partner_screening_conflict', 409);
    }
    if (row.api_requests_used !== 1 || row.agentcash_tool_call_id !== input.tool_call_id) {
      throw new RouteError('This AgentCash result does not have the matching payment lease.', 'partner_source_payment_not_authorized', 409);
    }
    const config = partnerAgentConfigSchema.parse(row.config_snapshot);
    if (canonical(input.arguments) !== canonical(agentCashPeopleSearchArguments(config))) {
      throw new RouteError('The AgentCash call does not match the stored screening policy.', 'partner_source_policy_mismatch', 422);
    }
    if (row.status === 'completed') {
      importedCandidates = row.candidates_discovered;
      return;
    }
    let result;
    try {
      result = parseAgentCashPeopleSearch(input.result, config);
    } catch {
      throw new RouteError(
        'AgentCash People Search returned an unsupported response shape.',
        'partner_source_invalid_response',
        422,
      );
    }
    importedCandidates = result.candidates.length;
    created = true;
    await completePartnerScreening(
      { tx, workspaceId, userId: row.created_by, role: 'admin', requireAdmin: () => undefined },
      { runId: screeningRunId, agentId, result },
    );
  });
  return c.json({ ok: true, screening_run_id: screeningRunId, imported_candidates: importedCandidates }, created ? 201 : 200);
}

function creatorPromptAuthorized(prompt: string | null): boolean {
  const normalized = (prompt ?? '').toLowerCase();
  return normalized.includes('hermes')
    && (normalized.includes('youtube') || normalized.includes('linkedin'))
    && (normalized.includes('consult') || normalized.includes('influenc') || normalized.includes('creator'));
}

function creatorRunKey(runtimeRunId: string): string {
  return `creator:${runtimeRunId}`;
}

/** Reserve one fixed $0.01 public creator search only from an explicitly matching user turn. */
export async function authorizeAgentCashCreatorSearch(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { workspaceId, agentId } = await authenticate(c);
  const input = parseAgentCashCreatorAuthorization(await body(c));
  if (canonical(input.arguments) !== canonical(AGENTCASH_CREATOR_SEARCH_ARGUMENTS)) {
    throw new RouteError('The creator search does not match the fixed policy.', 'partner_source_policy_mismatch', 422);
  }
  const runtime = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
  let run: EngineRunRow | null = null;
  try {
    run = await runtime.findRuntimeRun(input.runtime_run_id, agentId);
    requireActive(run, workspaceId, agentId);
  } finally { await runtime.close(); }

  let screeningRunId = '';
  let created = false;
  await withWorkspaceTransaction(c.env, workspaceId, async (tx) => {
    await requireCurrentPaidRun(tx, workspaceId, agentId, run.id, input.runtime_run_id);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`partner-creators:${run.id}`]);
    const context = await tx.query<{ owner_id: string; prompt: string | null }>(
      `SELECT s.owner_id, user_turn.provider_message::text AS prompt
         FROM runs r
         JOIN sessions s ON s.workspace_id=r.workspace_id AND s.id=r.session_id
         LEFT JOIN LATERAL (
           SELECT provider_message FROM run_turns
            WHERE run_id=r.id AND role='user'
            ORDER BY turn DESC, seq DESC LIMIT 1
         ) user_turn ON true
        WHERE r.workspace_id=$1 AND r.id=$2 AND r.agent_id=$3`,
      [workspaceId, run.id, agentId],
    );
    const authorized = context.rows[0];
    if (!authorized || !creatorPromptAuthorized(authorized.prompt)) {
      throw new RouteError('This run does not contain an explicit Hermes creator-search request.', 'partner_creator_search_not_authorized', 403);
    }
    const key = creatorRunKey(input.runtime_run_id);
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO partner_screening_runs
         (workspace_id, agent_id, created_by, idempotency_key, source, authentication,
          config_snapshot, api_requests_max, api_requests_used, agentcash_tool_call_id)
       VALUES ($1,$2,$3,$4,'agentcash_creators','wallet',$5::jsonb,1,1,$6)
       ON CONFLICT (workspace_id, agent_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [workspaceId, agentId, authorized.owner_id, key, JSON.stringify({
        runtime_run_id: input.runtime_run_id,
        query_kind: 'hermes_creator_consultants',
        minimum_priority: 0,
        ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
        max_candidates: 5,
        max_api_requests: 1,
        max_spend_usd: 0.01,
      }), input.tool_call_id],
    );
    if (inserted.rows[0]) {
      screeningRunId = inserted.rows[0].id;
      created = true;
      return;
    }
    const existing = await tx.query<{ id: string; status: string; api_requests_used: number; agentcash_tool_call_id: string | null }>(
      `SELECT id, status, api_requests_used, agentcash_tool_call_id
         FROM partner_screening_runs
        WHERE workspace_id=$1 AND agent_id=$2 AND idempotency_key=$3
        FOR UPDATE`,
      [workspaceId, agentId, key],
    );
    const row = existing.rows[0];
    if (!row || row.status !== 'running' || row.api_requests_used !== 1 || row.agentcash_tool_call_id !== input.tool_call_id) {
      throw new RouteError('This run already used its creator-search allowance.', 'partner_source_budget_exhausted', 409);
    }
    screeningRunId = row.id;
  });
  return c.json({ ok: true, screening_run_id: screeningRunId, reserved_requests: 1, max_spend_usd: 0.01 }, created ? 201 : 200);
}

/** Return a paid creator response that still needs import after a gateway restart. */
export async function pendingAgentCashCreatorSearch(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { workspaceId, agentId } = await authenticate(c);
  const pending = await withWorkspaceTransaction(c.env, workspaceId, async (tx) => tx.query<{
    runtime_run_id: string; agentcash_tool_call_id: string;
  }>(
    `SELECT config_snapshot->>'runtime_run_id' AS runtime_run_id, agentcash_tool_call_id
       FROM partner_screening_runs
      WHERE workspace_id=$1 AND agent_id=$2 AND source='agentcash_creators'
        AND status='running' AND api_requests_used=1 AND agentcash_tool_call_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 2`,
    [workspaceId, agentId],
  ));
  if (pending.rows.length === 0) return new Response(null, { status: 204 });
  if (pending.rows.length > 1) throw new RouteError('More than one creator import is pending.', 'partner_screening_conflict', 409);
  const row = pending.rows[0]!;
  if (!/^run_[0-9a-f]{32}$/.test(row.runtime_run_id) || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(row.agentcash_tool_call_id)) {
    throw new RouteError('The pending creator import has invalid runtime identity.', 'partner_screening_conflict', 409);
  }
  return c.json({ runtime_run_id: row.runtime_run_id, tool_call_id: row.agentcash_tool_call_id, arguments: AGENTCASH_CREATOR_SEARCH_ARGUMENTS });
}

/** Import one exact creator-search response as bounded public evidence. */
export async function importAgentCashCreatorSearch(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { workspaceId, agentId } = await authenticate(c);
  const input = parseAgentCashCreatorImport(await body(c));
  if (canonical(input.arguments) !== canonical(AGENTCASH_CREATOR_SEARCH_ARGUMENTS)) {
    throw new RouteError('The creator search does not match the fixed policy.', 'partner_source_policy_mismatch', 422);
  }
  const runtime = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
  let run: EngineRunRow | null = null;
  try { run = await runtime.findRuntimeRun(input.runtime_run_id, agentId); } finally { await runtime.close(); }
  if (!run || run.workspaceId !== workspaceId || run.agentId !== agentId) {
    throw new RouteError('This runtime run is no longer available.', 'runtime_run_inactive', 409);
  }

  let importedCandidates = 0;
  let created = false;
  let screeningRunId = '';
  await withWorkspaceTransaction(c.env, workspaceId, async (tx) => {
    const screening = await tx.query<{
      id: string; created_by: string; status: 'running' | 'completed' | 'failed';
      api_requests_used: number; agentcash_tool_call_id: string | null; candidates_discovered: number;
    }>(
      `SELECT id, created_by, status, api_requests_used, agentcash_tool_call_id, candidates_discovered
         FROM partner_screening_runs
        WHERE workspace_id=$1 AND agent_id=$2 AND idempotency_key=$3 AND source='agentcash_creators'
        FOR UPDATE`,
      [workspaceId, agentId, creatorRunKey(input.runtime_run_id)],
    );
    const row = screening.rows[0];
    if (!row || row.status === 'failed' || row.api_requests_used !== 1 || row.agentcash_tool_call_id !== input.tool_call_id) {
      throw new RouteError('This creator result does not have the matching payment lease.', 'partner_source_payment_not_authorized', 409);
    }
    screeningRunId = row.id;
    if (row.status === 'completed') {
      importedCandidates = row.candidates_discovered;
      return;
    }
    let result;
    try { result = parseAgentCashCreatorSearch(input.result); } catch {
      throw new RouteError('AgentCash creator search returned an unsupported response shape.', 'partner_source_invalid_response', 422);
    }
    importedCandidates = result.candidates.length;
    created = true;
    await completePartnerScreening(
      { tx, workspaceId, userId: row.created_by, role: 'admin', requireAdmin: () => undefined },
      { runId: row.id, agentId, result },
    );
  });
  return c.json({ ok: true, screening_run_id: screeningRunId, imported_candidates: importedCandidates }, created ? 201 : 200);
}

interface ContactLeaseRow {
  id: string;
  candidate_id: string;
  run_id: string;
  runtime_run_id: string;
  status: string;
  pending_kind: ContactCallKind | null;
  pending_tool_call_id: string | null;
  contact_data: { professional_emails?: string[]; phones?: unknown[]; social_profiles?: unknown[] };
  preferred_email: string | null;
  verification_poll_url: string | null;
  verification_poll_count: number;
  profile_url: string;
}

function candidateIdFromEnrichmentArguments(argumentsValue: Record<string, unknown>): string | null {
  const bodyValue = object(argumentsValue.body) ? argumentsValue.body : null;
  const records = bodyValue && Array.isArray(bodyValue.records) ? bodyValue.records : [];
  const first = object(records[0]) ? records[0] : null;
  return first && typeof first.record_id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(first.record_id)
    ? first.record_id : null;
}

function contactKind(argumentsValue: Record<string, unknown>): ContactCallKind | null {
  if (argumentsValue.url === AGENTCASH_CONTACT_ENRICH_URL && argumentsValue.method === 'POST') return 'enrichment';
  if (argumentsValue.url === AGENTCASH_EMAIL_VERIFY_URL && argumentsValue.method === 'POST') return 'verification';
  if (typeof argumentsValue.url === 'string' && argumentsValue.method === 'GET'
      && argumentsValue.url.startsWith(`${AGENTCASH_EMAIL_VERIFY_URL}/jobs/`)) return 'verification_poll';
  return null;
}

function expectedContactArguments(kind: ContactCallKind, row: ContactLeaseRow): Record<string, unknown> {
  if (kind === 'enrichment') return agentCashContactEnrichmentArguments(row.candidate_id, row.profile_url);
  if (kind === 'verification') {
    if (!row.preferred_email) throw new RouteError('No professional email is available to verify.', 'partner_contact_missing_email', 409);
    return agentCashEmailVerificationArguments(row.preferred_email);
  }
  if (!row.verification_poll_url) throw new RouteError('No email verification job is pending.', 'partner_contact_poll_missing', 409);
  return agentCashEmailVerificationPollArguments(row.verification_poll_url);
}

/** Reserve exactly one shortlisted candidate and one bounded contact call. */
export async function authorizeAgentCashContact(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { workspaceId, agentId } = await authenticate(c);
  const input = parseAgentCashContactAuthorization(await body(c));
  const runtime = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
  let run: EngineRunRow | null = null;
  try {
    run = await runtime.findRuntimeRun(input.runtime_run_id, agentId);
    requireActive(run, workspaceId, agentId);
  } finally { await runtime.close(); }
  const kind = contactKind(input.arguments);
  if (!kind) throw new RouteError('This AgentCash endpoint is not part of contact enrichment.', 'partner_contact_policy_mismatch', 422);

  let created = false;
  let enrichmentId = '';
  await withWorkspaceTransaction(c.env, workspaceId, async (tx) => {
    await requireCurrentPaidRun(tx, workspaceId, agentId, run.id, input.runtime_run_id);
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`partner-contact:${run.id}`]);
    const existing = await tx.query<ContactLeaseRow>(
      `SELECT e.id, e.candidate_id, e.run_id, e.runtime_run_id, e.status, e.pending_kind,
              e.pending_tool_call_id, e.contact_data, e.preferred_email,
              e.verification_poll_url, e.verification_poll_count, c.profile_url
         FROM partner_contact_enrichments e
         JOIN partner_candidates c ON c.id=e.candidate_id AND c.workspace_id=e.workspace_id
        WHERE e.workspace_id=$1 AND e.agent_id=$2 AND e.run_id=$3
        FOR UPDATE OF e`,
      [workspaceId, agentId, run.id],
    );
    const row = existing.rows[0];
    if (row?.pending_kind === kind && row.pending_tool_call_id === input.tool_call_id
        && canonical(input.arguments) === canonical(expectedContactArguments(kind, row))) {
      enrichmentId = row.id;
      return;
    }
    if (row?.pending_kind || ['completed', 'failed'].includes(row?.status ?? '')) {
      throw new RouteError('This run already used its contact-enrichment allowance.', 'partner_contact_budget_exhausted', 409);
    }

    if (kind === 'enrichment') {
      if (row) throw new RouteError('This run already selected a candidate for enrichment.', 'partner_contact_candidate_locked', 409);
      const candidateId = candidateIdFromEnrichmentArguments(input.arguments);
      if (!candidateId) throw new RouteError('The contact request does not identify one stored candidate.', 'partner_contact_policy_mismatch', 422);
      const candidate = await tx.query<{ id: string; profile_url: string }>(
        `SELECT id, profile_url FROM partner_candidates
          WHERE workspace_id=$1 AND agent_id=$2 AND id=$3
            AND source IN ('agentcash_people', 'agentcash_creators')
          FOR SHARE`,
        [workspaceId, agentId, candidateId],
      );
      const selected = candidate.rows[0];
      if (!selected || canonical(input.arguments) !== canonical(agentCashContactEnrichmentArguments(selected.id, selected.profile_url))) {
        throw new RouteError('The contact request does not match the stored candidate.', 'partner_contact_policy_mismatch', 422);
      }
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO partner_contact_enrichments
           (workspace_id, agent_id, candidate_id, run_id, runtime_run_id, status,
            pending_kind, pending_tool_call_id, enrichment_tool_call_id)
         VALUES ($1,$2,$3,$4,$5,'enrichment_reserved','enrichment',$6,$6)
         RETURNING id`,
        [workspaceId, agentId, candidateId, run.id, input.runtime_run_id, input.tool_call_id],
      );
      enrichmentId = inserted.rows[0]!.id;
      created = true;
      return;
    }

    if (!row || canonical(input.arguments) !== canonical(expectedContactArguments(kind, row))) {
      throw new RouteError('The contact request does not match the stored enrichment state.', 'partner_contact_policy_mismatch', 422);
    }
    if (kind === 'verification' && row.status !== 'enriched') {
      throw new RouteError('Professional contact enrichment must complete before verification.', 'partner_contact_sequence_invalid', 409);
    }
    if (kind === 'verification_poll' && (row.status !== 'verification_pending' || row.verification_poll_count >= 5)) {
      throw new RouteError('No bounded email verification poll is available.', 'partner_contact_sequence_invalid', 409);
    }
    await tx.query(
      `UPDATE partner_contact_enrichments
          SET status=$4, pending_kind=$5, pending_tool_call_id=$6, runtime_run_id=$7,
              verification_tool_call_id=COALESCE(verification_tool_call_id, $6),
              verification_poll_count=verification_poll_count + CASE WHEN $5='verification_poll' THEN 1 ELSE 0 END
        WHERE workspace_id=$1 AND agent_id=$2 AND id=$3`,
      [workspaceId, agentId, row.id, kind === 'verification' ? 'verification_reserved' : 'verification_pending', kind, input.tool_call_id, input.runtime_run_id],
    );
    enrichmentId = row.id;
    created = true;
  });
  return c.json({ ok: true, enrichment_id: enrichmentId, call_kind: kind }, created ? 201 : 200);
}

/** Import a leased response after the wallet call; no raw provider data is retained. */
export async function importAgentCashContact(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { workspaceId, agentId } = await authenticate(c);
  const input = parseAgentCashContactImport(await body(c));
  const runtime = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
  let run: EngineRunRow | null = null;
  try { run = await runtime.findRuntimeRun(input.runtime_run_id, agentId); } finally { await runtime.close(); }
  if (!run || run.workspaceId !== workspaceId || run.agentId !== agentId) {
    throw new RouteError('This runtime run is no longer available.', 'runtime_run_inactive', 409);
  }
  let state = '';
  await withWorkspaceTransaction(c.env, workspaceId, async (tx) => {
    const result = await tx.query<ContactLeaseRow>(
      `SELECT e.id, e.candidate_id, e.run_id, e.runtime_run_id, e.status, e.pending_kind,
              e.pending_tool_call_id, e.contact_data, e.preferred_email,
              e.verification_poll_url, e.verification_poll_count, c.profile_url
         FROM partner_contact_enrichments e
         JOIN partner_candidates c ON c.id=e.candidate_id AND c.workspace_id=e.workspace_id
        WHERE e.workspace_id=$1 AND e.agent_id=$2 AND e.run_id=$3
        FOR UPDATE OF e`,
      [workspaceId, agentId, run.id],
    );
    const row = result.rows[0];
    if (!row) throw new RouteError('No contact enrichment is bound to this run.', 'partner_contact_missing', 409);
    if (!row.pending_kind && ['enriched', 'verification_pending', 'completed'].includes(row.status)) {
      state = row.status;
      return;
    }
    const kind = row.pending_kind;
    if (!kind || row.pending_tool_call_id !== input.tool_call_id
        || canonical(input.arguments) !== canonical(expectedContactArguments(kind, row))) {
      throw new RouteError('This contact result does not have the matching lease.', 'partner_contact_payment_not_authorized', 409);
    }
    if (kind === 'enrichment') {
      let parsed;
      try { parsed = parseAgentCashContactEnrichment(input.result, row.candidate_id); } catch {
        throw new RouteError('Contact enrichment returned an unsupported response.', 'partner_contact_invalid_response', 422);
      }
      const preferred = parsed.professionalEmails[0] ?? null;
      state = preferred ? 'enriched' : 'completed';
      await tx.query(
        `UPDATE partner_contact_enrichments
            SET status=$4, pending_kind=NULL, pending_tool_call_id=NULL,
                contact_data=$5::jsonb, preferred_email=$6,
                monetary_cost_usd=0.05, fetched_at=now()
          WHERE workspace_id=$1 AND agent_id=$2 AND id=$3`,
        [workspaceId, agentId, row.id, state, JSON.stringify({
          professional_emails: parsed.professionalEmails,
          phones: parsed.phones,
          social_profiles: parsed.socialProfiles,
        }), preferred],
      );
      return;
    }
    let parsed;
    try { parsed = parseAgentCashEmailVerification(input.result, row.preferred_email!); } catch {
      throw new RouteError('Email verification returned an unsupported response.', 'partner_contact_invalid_response', 422);
    }
    state = parsed.pending ? 'verification_pending' : 'completed';
    await tx.query(
      `UPDATE partner_contact_enrichments
          SET status=$4, pending_kind=NULL, pending_tool_call_id=NULL,
              verification_job_id=$5, verification_poll_url=$6,
              verification_retry_after_seconds=$7, verification_status=$8,
              verification_score=$9, verification_checks=$10::jsonb,
              draft_eligible=$11, verified_at=CASE WHEN $12 THEN NULL ELSE now() END,
              monetary_cost_usd=CASE WHEN $13='verification' THEN 0.08 ELSE monetary_cost_usd END
        WHERE workspace_id=$1 AND agent_id=$2 AND id=$3`,
      [workspaceId, agentId, row.id, state, parsed.jobId, parsed.pollUrl, parsed.retryAfterSeconds,
        parsed.status, parsed.score, JSON.stringify(parsed.checks), parsed.draftEligible,
        parsed.pending, kind],
    );
  });
  return c.json({ ok: true, state });
}

/** Return already-paid spill identities for startup recovery; never creates a lease. */
export async function pendingAgentCashContacts(c: Context<{ Bindings: Env }>): Promise<Response> {
  const { workspaceId, agentId } = await authenticate(c);
  const pending = await withWorkspaceTransaction(c.env, workspaceId, async (tx) => tx.query<ContactLeaseRow & { tool_call_id: string }>(
    `SELECT e.id, e.candidate_id, e.run_id, e.runtime_run_id, e.status, e.pending_kind,
            e.pending_tool_call_id, e.pending_tool_call_id AS tool_call_id, e.contact_data,
            e.preferred_email, e.verification_poll_url, e.verification_poll_count, c.profile_url
       FROM partner_contact_enrichments e
       JOIN partner_candidates c ON c.id=e.candidate_id AND c.workspace_id=e.workspace_id
      WHERE e.workspace_id=$1 AND e.agent_id=$2 AND e.pending_kind IS NOT NULL
        AND e.pending_tool_call_id IS NOT NULL
      ORDER BY e.created_at
      LIMIT 10`,
    [workspaceId, agentId],
  ));
  return c.json({ pending: pending.rows.map((row) => ({
    runtime_run_id: row.runtime_run_id,
    tool_call_id: row.tool_call_id,
    arguments: expectedContactArguments(row.pending_kind!, row),
  })) });
}

function modelError(reason: string, status: number): Response {
  return Response.json(
    { error: { message: reason, type: 'runtime_bridge_error', code: reason } },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}

/**
 * Translate a trusted provider status into a fixed runtime code.
 *
 * Provider response bodies remain outside the Enterprise trust boundary: they
 * may contain request fragments or vendor diagnostics. Hermes still receives
 * enough information to distinguish reconnecting a credential, adding quota,
 * switching a stale model, waiting for a rate limit, and retrying capacity.
 */
function runtimeProviderError(response: Response): { readonly reason: string; readonly status: number } {
  const status = response.status >= 400 && response.status < 600 ? response.status : 502;
  if (status === 401 || status === 403) return { reason: 'runtime_provider_auth', status };
  if (status === 402) return { reason: 'runtime_provider_quota', status };
  if (status === 408 || status === 429) return { reason: 'runtime_provider_rate_limited', status };
  if (status === 404) return { reason: 'runtime_model_unavailable', status };
  if (status >= 500) return { reason: 'runtime_provider_unavailable', status };
  return { reason: 'runtime_provider_rejected', status };
}

interface RuntimeProviderConfig {
  readonly base: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly wireId: (catalogId: string) => string | null;
}

const RUNTIME_PROVIDERS: Readonly<Record<string, RuntimeProviderConfig>> = {
  openrouter: { base: OPENROUTER_BASE, headers: ATTRIBUTION_HEADERS, wireId: openRouterModelId },
  nous_portal: { base: NOUS_PORTAL_BASE, headers: NOUS_PORTAL_HEADERS, wireId: nousModelId },
};

export async function runtimeModels(c: Context<{ Bindings: Env }>): Promise<Response> {
  let db: RuntimeDb | undefined;
  try {
    const { workspaceId } = await authenticate(c);
    db = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
    const models = (await db.allowedRuntimeModels()).filter((model) => isProviderAllowed(c.env, model.provider));
    const providers = [...new Set(models.map((model) => model.provider))];
    if (providers.length === 0) return modelError('provider_not_allowed', 403);
    await Promise.all(providers.map((provider) => db!.resolveCredential(provider)));
    return c.json({
      object: 'list',
      data: models.flatMap((model) => {
        const config = RUNTIME_PROVIDERS[model.provider];
        const id = config?.wireId(model.model_id);
        return config && id ? [{ id, object: 'model', created: 0, owned_by: model.provider }] : [];
      }),
    });
  } catch (error) {
    return modelError(error instanceof RouteError ? error.reason : 'runtime_model_unavailable', error instanceof RouteError ? error.status : 503);
  } finally { await db?.close(); }
}
export interface ModelBridgeDb extends RuntimeBudgetDb {
  activeProfileRun(agentId: string): Promise<EngineRunRow | null>;
  allowedRuntimeModels(): Promise<{ model_id: string; provider: string }[]>;
  resolveCredential: AgentDb['resolveCredential'];
  recordModelCall: AgentDb['recordModelCall'];
  recordProviderRetryAfter?(runId: string, attempt: number, delay: ProviderRetryAfter): Promise<void>;
  settleRuntimeModelCall?(input: {
    reservation: {
      reservationId: string;
      resolution: 'completed' | 'rejected' | 'unresolved' | 'cancelled';
      usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
      actualCostUsd?: number;
    } | null;
    modelCall: Parameters<AgentDb['recordModelCall']>[0];
  }): Promise<void>;
}
export interface ModelProxyLifecycle {
  /** The response body now owns database cleanup until it is read or cancelled. */
  defer(): void;
  settled(): Promise<void>;
}
function budgetError(error: unknown): Response | null {
  if (!(error instanceof RuntimeBudgetError)) return null;
  const status = /(?:cost|token|call|parallel)_limit|exhausted/.test(error.reason) ? 429 : 409;
  return modelError(error.reason, status);
}
export async function proxyRuntimeModel(
  env: Env,
  db: ModelBridgeDb,
  workspaceId: string,
  agentId: string,
  value: unknown,
  fetchImpl: typeof fetch = fetch,
  lifecycle?: ModelProxyLifecycle,
): Promise<Response> {
  const proxyStartedAt = Date.now();
  if (!object(value) || typeof value.model !== 'string' || !Array.isArray(value.messages)) return modelError('bad_body', 400);
  const run = await db.activeProfileRun(agentId);
  if (!run || run.workspaceId !== workspaceId || run.agentId !== agentId || run.stopRequested || run.status !== 'working') return modelError('runtime_run_inactive', 409);
  const allowed = await db.allowedRuntimeModels();
  const selected = allowed.find((model) => model.model_id === run.modelId && isProviderAllowed(env, model.provider));
  const config = selected ? RUNTIME_PROVIDERS[selected.provider] : undefined;
  if (!selected || !config || value.model !== config.wireId(selected.model_id)) return modelError('runtime_model_forbidden', 403);
  // Whitelist request fields: fallback models, provider credentials,
  // routing URLs, and other caller-controlled routing cannot bypass the catalog.
  const forwarded: Record<string, unknown> = { model: value.model, messages: value.messages };
  for (const key of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning', 'response_format', 'stop', 'seed', 'frequency_penalty', 'presence_penalty']) {
    if (key in value) forwarded[key] = value[key];
  }
  if (!('reasoning' in forwarded) && typeof value.reasoning_effort === 'string') forwarded.reasoning = { effort: value.reasoning_effort };
  // Every streamed native call needs its own authoritative usage; otherwise a
  // multi-call run can only expose one terminal aggregate and key rotation can
  // misattribute the spend. The approved-budget path also depends on this.
  if (forwarded.stream === true) {
    const existing = object(forwarded.stream_options) ? forwarded.stream_options : {};
    forwarded.stream_options = { ...existing, include_usage: true };
  }
  let prepared;
  try {
    prepared = await prepareRuntimeBudget(db, run.id, selected.model_id, forwarded);
  } catch (error) {
    const response = budgetError(error);
    if (response) return response;
    throw error;
  }
  const credential = await db.resolveCredential(selected.provider);
  let reservation: RuntimeBudgetReservation | null = null;
  if (prepared) {
    try {
      reservation = await db.reserveRuntimeBudget!({
        runId: run.id,
        modelId: selected.model_id,
        inputTokenBound: prepared.inputTokenBound,
        outputTokenBound: prepared.outputTokenBound,
        reservedCostUsd: prepared.reservedCostUsd,
      });
    } catch (error) {
      const response = budgetError(error);
      if (response) return response;
      throw error;
    }
  }
  let response: Response;
  const providerStartedAt = Date.now();
  const proxyPrepareMs = Math.max(0, providerStartedAt - proxyStartedAt);
  const callTraceId = crypto.randomUUID();
  let providerHeadersMs: number | null = null;
  const observations: Record<ProviderStreamObservation, number | null> = {
    first_byte: null, first_frame: null, first_reasoning: null, first_content: null,
  };
  const recordTiming = (
    phase: 'headers' | 'first_reasoning' | 'first_content' | 'settled',
    status?: 'ok' | 'error' | 'stopped',
    usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null,
  ): void => {
    // These are bridge-observed arrival times, not an upstream compute clock:
    // downstream backpressure can delay reads. Reuse the accounting parser so
    // observation neither drains ahead of demand nor keeps another body copy.
    try {
      logEvent({
        at: 'runtime.provider_timing', phase,
        workspace_id: workspaceId, run_id: run.id, attempt: run.attempt,
        trace_id: run.traceId, call_trace_id: callTraceId,
        provider: selected.provider, model_id: selected.model_id,
        streamed: forwarded.stream === true, status,
        proxy_prepare_ms: proxyPrepareMs, provider_headers_ms: providerHeadersMs,
        provider_first_byte_observed_ms: observations.first_byte,
        provider_first_frame_observed_ms: observations.first_frame,
        provider_first_reasoning_observed_ms: observations.first_reasoning,
        provider_first_content_observed_ms: observations.first_content,
        provider_total_ms: phase === 'settled' ? Math.max(0, Date.now() - providerStartedAt) : null,
        input_tokens: usage?.inputTokens ?? null,
        output_tokens: usage?.outputTokens ?? null,
        cached_input_tokens: usage?.cachedInputTokens ?? null,
      });
    } catch { /* Observability must not fail a request or change usage settlement. */ }
  };
  const settle = async (
    usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | null,
    status: 'ok' | 'error' | 'stopped',
    resolution: 'completed' | 'rejected' | 'unresolved' | 'cancelled' | null,
  ): Promise<void> => {
    recordTiming('settled', status, usage);
    const counted = usage ?? (prepared && resolution === 'unresolved'
      ? {
          inputTokens: prepared.inputTokenBound,
          outputTokens: prepared.outputTokenBound,
          cachedInputTokens: 0,
        }
      : { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    const modelCall: Parameters<AgentDb['recordModelCall']>[0] = {
      runId: run.id,
      // Native Hermes owns its internal turn counter. A proxy call is still a
      // first-class usage row, but must not invent an Enterprise turn number.
      turn: null,
      modelId: selected.model_id,
      provider: selected.provider,
      keyId: credential.keyId,
      usage: {
        input_tokens: counted.inputTokens,
        output_tokens: counted.outputTokens,
        cached_input_tokens: counted.cachedInputTokens,
        reasoning_tokens: 0,
      },
      latencyMs: Math.max(0, Date.now() - providerStartedAt),
      status,
    };
    const budgetSettlement = reservation && resolution
      ? {
          reservationId: reservation.reservationId,
          resolution,
          ...(usage ? { usage } : {}),
          ...(usage && prepared ? { actualCostUsd: actualRuntimeCostUsd(prepared.context, usage) } : {}),
        }
      : null;
    if (db.settleRuntimeModelCall) {
      await db.settleRuntimeModelCall({ reservation: budgetSettlement, modelCall });
      return;
    }
    if (budgetSettlement) await db.reconcileRuntimeBudget!(budgetSettlement);
    await db.recordModelCall(modelCall);
  };
  try {
    response = await fetchImpl(`${config.base}/chat/completions`, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential.apiKey}`, ...config.headers },
      body: JSON.stringify(forwarded),
    });
    providerHeadersMs = Math.max(0, Date.now() - providerStartedAt);
    recordTiming('headers');
  } catch (error) {
    // Once fetch started, whether the provider accepted and billed the call is
    // unknown. Keep the reserved upper bound consumed before surfacing the
    // transport failure, so a retry cannot overspend the reviewed plan.
    await settle(null, 'error', reservation ? 'unresolved' : null);
    throw error;
  }
  if (!response.ok) {
    const failure = runtimeProviderError(response);
    const delay = ['runtime_provider_rate_limited', 'runtime_provider_unavailable'].includes(failure.reason)
      ? parseProviderRetryAfter(response.headers.get('Retry-After')) : null;
    try { await response.body?.cancel(); } catch { /* Rejection accounting must still settle. */ }
    await settle(null, 'error', reservation ? 'rejected' : null);
    if (delay) await db.recordProviderRetryAfter?.(run.id, run.attempt, delay);
    console.warn(JSON.stringify({
      at: 'runtime.model_rejected', provider: selected.provider,
      modelId: selected.model_id, status: failure.status, reason: failure.reason,
    }));
    const rejection = modelError(failure.reason, failure.status);
    if (delay?.header !== null && delay?.header !== undefined) rejection.headers.set('Retry-After', delay.header);
    return rejection;
  }
  lifecycle?.defer();
  const safeResponse = new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'application/json',
      'Cache-Control': 'no-store',
    },
  });
  return meterRuntimeResponse(safeResponse, async (usage) => {
    try {
      await settle(usage, usage ? 'ok' : 'error', reservation ? (usage ? 'completed' : 'unresolved') : null);
    } finally {
      await lifecycle?.settled();
    }
  }, (observation) => {
    observations[observation] = Math.max(0, Date.now() - providerStartedAt);
    if (observation === 'first_reasoning' || observation === 'first_content') recordTiming(observation);
  });
}
export async function runtimeChatCompletions(c: Context<{ Bindings: Env }>): Promise<Response> {
  let db: RuntimeDb | undefined;
  let deferred = false;
  try {
    const { workspaceId, agentId } = await authenticate(c);
    db = new RuntimeDb(c.env, workspaceId, crypto.randomUUID());
    return await proxyRuntimeModel(c.env, db, workspaceId, agentId, await body(c), fetch, {
      defer: () => { deferred = true; },
      settled: async () => { await db?.close(); },
    });
  } catch (error) {
    return modelError(error instanceof RouteError ? error.reason : 'runtime_model_unavailable', error instanceof RouteError ? error.status : 503);
  } finally {
    if (!deferred) await db?.close();
  }
}
