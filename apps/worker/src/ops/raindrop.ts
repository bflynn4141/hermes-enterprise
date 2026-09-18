import type { Env } from '../env.js';
import type { RunErrorInput } from '../engine/agent-db.js';

const EVENT_ENDPOINT = 'https://api.raindrop.ai/v1/events/track';
const SIGNAL_ENDPOINT = 'https://api.raindrop.ai/v1/signals/track';
const REQUEST_TIMEOUT_MS = 2_500;

type RaindropEnv = Pick<
  Env,
  'ENVIRONMENT' | 'RAINDROP_OBSERVABILITY_MODE' | 'RAINDROP_PROJECT_ID' | 'RAINDROP_WRITE_KEY'
>;

export interface RaindropSnapshotDb {
  runtimeQuery<T>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}

interface ToolSnapshot {
  name: string;
  state: string;
}

interface SnapshotRow {
  id: string;
  workspace_id: string;
  session_id: string;
  agent_id: string | null;
  runtime_kind: string;
  status: string;
  model_id: string;
  mode: string;
  active_ms: number | string;
  attempt: number;
  trace_id: string | null;
  ended_at: Date | string | null;
  error: RunErrorInput | null;
  output_present: boolean;
  output_characters: number | string;
  tools: ToolSnapshot[];
}

export interface RaindropRunSnapshot {
  id: string;
  workspaceId: string;
  sessionId: string;
  agentId: string | null;
  runtimeKind: string;
  status: string;
  modelId: string;
  mode: string;
  activeMs: number;
  attempt: number;
  traceId: string | null;
  endedAt: string;
  error: RunErrorInput | null;
  outputPresent: boolean;
  outputCharacters: number;
  tools: ToolSnapshot[];
}

export type RaindropExportResult =
  | { status: 'disabled'; reason: 'mode_off' | 'missing_write_key' }
  | { status: 'skipped'; reason: 'run_missing' | 'run_not_terminal' | 'not_hermes' }
  | { status: 'sent'; eventId: string; signal: string | null }
  | { status: 'failed'; eventId: string | null; httpStatus: number | null };

const terminalStatuses = new Set(['completed', 'stopped', 'error']);
const safeToken = (value: string | null | undefined, fallback: string): string => {
  const candidate = value?.trim() ?? '';
  return /^[a-zA-Z0-9_.:/-]{1,96}$/.test(candidate) ? candidate : fallback;
};

/**
 * Load only operational metadata. Prompt, response, tool arguments and tool
 * results never cross this query boundary, so a future exporter refactor
 * cannot accidentally serialize them.
 */
export async function loadRaindropRunSnapshot(
  db: RaindropSnapshotDb,
  runId: string,
): Promise<RaindropRunSnapshot | null> {
  const { rows } = await db.runtimeQuery<SnapshotRow>(
    `SELECT r.id, r.workspace_id, r.session_id, r.agent_id, r.runtime_kind,
            r.status, r.model_id, r.mode, r.active_ms, r.attempt, r.trace_id,
            r.ended_at, r.error,
            EXISTS (
              SELECT 1 FROM messages m
               WHERE m.run_id = r.id AND m.role = 'iris'
                 AND m.status IN ('complete', 'incomplete')
                 AND length(trim(m.text)) > 0
            ) AS output_present,
            COALESCE((
              SELECT max(length(m.text)) FROM messages m
               WHERE m.run_id = r.id AND m.role = 'iris'
                 AND m.status IN ('complete', 'incomplete')
            ), 0) AS output_characters,
            COALESCE((
              SELECT jsonb_agg(
                jsonb_build_object('name', st.label, 'state', st.state)
                ORDER BY st.created_at, st.id
              )
                FROM run_steps st
               WHERE st.run_id = r.id AND st.tool_call_id IS NOT NULL
            ), '[]'::jsonb) AS tools
       FROM runs r
      WHERE r.id = $1`,
    [runId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    runtimeKind: row.runtime_kind,
    status: row.status,
    modelId: row.model_id,
    mode: row.mode,
    activeMs: Math.max(0, Number(row.active_ms) || 0),
    attempt: row.attempt,
    traceId: row.trace_id,
    endedAt: row.ended_at instanceof Date
      ? row.ended_at.toISOString()
      : typeof row.ended_at === 'string'
        ? row.ended_at
        : new Date().toISOString(),
    error: row.error,
    outputPresent: row.output_present,
    outputCharacters: Math.max(0, Number(row.output_characters) || 0),
    tools: Array.isArray(row.tools)
      ? row.tools.map((tool) => ({
          name: safeToken(tool.name, 'unknown_tool'),
          state: safeToken(tool.state, 'unknown'),
        })).slice(0, 100)
      : [],
  };
}

async function opaqueId(namespace: string, value: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${namespace}:${value}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function operationalSummary(run: RaindropRunSnapshot): string {
  const tools = run.tools.length === 0
    ? 'No tool calls were recorded.'
    : `Tools: ${run.tools.map((tool) => `${tool.name} (${tool.state})`).join(', ')}.`;
  const response = run.outputPresent
    ? `A final assistant response was recorded (${run.outputCharacters} characters).`
    : 'No final assistant response was recorded.';
  return `Run ${safeToken(run.status, 'unknown')} after ${run.activeMs} ms. ${response} ${tools}`;
}

async function postBatch(
  fetcher: typeof fetch,
  endpoint: string,
  writeKey: string,
  projectId: string | undefined,
  body: readonly Record<string, unknown>[],
): Promise<number> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${writeKey}`,
  };
  if (projectId?.trim()) headers['X-Raindrop-Project-Id'] = projectId.trim();
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response.status;
}

/**
 * Best-effort export after Hermes has committed and delivered its terminal
 * state. This function never throws and never includes user or applicant text.
 */
export async function exportRaindropRun(
  env: RaindropEnv,
  db: RaindropSnapshotDb,
  runId: string,
  fetcher: typeof fetch = fetch,
): Promise<RaindropExportResult> {
  if (env.RAINDROP_OBSERVABILITY_MODE !== 'active') return { status: 'disabled', reason: 'mode_off' };
  const writeKey = env.RAINDROP_WRITE_KEY?.trim();
  if (!writeKey) return { status: 'disabled', reason: 'missing_write_key' };

  let run: RaindropRunSnapshot | null = null;
  let eventId: string | null = null;
  try {
    run = await loadRaindropRunSnapshot(db, runId);
    if (!run) return { status: 'skipped', reason: 'run_missing' };
    if (run.runtimeKind !== 'hermes') return { status: 'skipped', reason: 'not_hermes' };
    if (!terminalStatuses.has(run.status)) return { status: 'skipped', reason: 'run_not_terminal' };

    eventId = `hermes-${await opaqueId('run-attempt', `${run.id}:${run.attempt}`)}`;
    const userId = `agent-${await opaqueId('agent', run.agentId ?? run.workspaceId)}`;
    const convoId = `session-${await opaqueId('session', run.sessionId)}`;
    const traceRef = await opaqueId('trace', run.traceId ?? run.id);
    const errorClass = run.error ? safeToken(run.error.class, 'other') : null;
    const errorReason = run.error ? safeToken(run.error.reason, 'other') : null;
    const toolNames = run.tools.map((tool) => tool.name);
    const event = {
      event: 'hermes.run',
      event_id: eventId,
      user_id: userId,
      timestamp: run.endedAt,
      ai_data: {
        model: safeToken(run.modelId, 'unknown'),
        input: `Hermes agent run in ${safeToken(run.mode, 'unknown')} mode.`,
        output: operationalSummary(run),
        convo_id: convoId,
      },
      properties: {
        environment: safeToken(env.ENVIRONMENT, 'unknown'),
        runtime: 'hermes',
        status: safeToken(run.status, 'unknown'),
        mode: safeToken(run.mode, 'unknown'),
        attempt: run.attempt,
        active_ms: run.activeMs,
        output_present: run.outputPresent,
        output_characters: run.outputCharacters,
        tool_count: run.tools.length,
        tool_names: toolNames,
        tool_states: run.tools.map((tool) => tool.state),
        trace_ref: traceRef,
        ...(errorClass ? { error_class: errorClass } : {}),
        ...(errorReason ? { error_reason: errorReason } : {}),
        ...(run.error ? { retryable: run.error.retryable } : {}),
      },
      attachments: [],
    };
    const eventStatus = await postBatch(fetcher, EVENT_ENDPOINT, writeKey, env.RAINDROP_PROJECT_ID, [event]);
    if (eventStatus < 200 || eventStatus >= 300) return { status: 'failed', eventId, httpStatus: eventStatus };

    const signalName = run.status === 'error'
      ? 'Hermes run ended with an error'
      : run.tools.length > 0 && !run.outputPresent
        ? 'Hermes used tools without a final response'
        : null;
    if (signalName) {
      const signalStatus = await postBatch(fetcher, SIGNAL_ENDPOINT, writeKey, env.RAINDROP_PROJECT_ID, [{
        event_id: eventId,
        signal_name: signalName,
        timestamp: run.endedAt,
        sentiment: 'NEGATIVE',
        signal_type: 'agent',
        properties: {
          source: 'hermes_runtime',
          category: run.status === 'error' ? 'terminal_error' : 'missing_final_response',
          status: safeToken(run.status, 'unknown'),
          tool_count: run.tools.length,
        },
      }]);
      if (signalStatus < 200 || signalStatus >= 300) return { status: 'failed', eventId, httpStatus: signalStatus };
    }
    return { status: 'sent', eventId, signal: signalName };
  } catch {
    return { status: 'failed', eventId, httpStatus: null };
  }
}
