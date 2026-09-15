// `GET /w/:ws/traces` and `GET /w/:ws/traces/:runId`.
//
// A trace is a run, read back. The list is what the Agent > Traces tab shows;
// the detail is what "Open →" opens, and it is the only place in the product
// where a person can see, in one order, what the agent read before it proposed
// something: its steps, the tool calls it made and the results it was handed,
// the URLs `fetch_url` actually retrieved, where it moved the viewer's focus,
// and which tools it was allowed to use at all.
//
// Two rules the shape follows from:
//
//   * a tool result is shown exactly as the model saw it, truncation marker
//     and all. A trace that quietly re-expanded a truncated result would be a
//     trace of a run that did not happen;
//   * nothing here is new authority. Every row is already readable by a member
//     through `messages`, `requests` or the replay stream — under this
//     workspace's key, through `inWorkspace`, like every other tenant route.
//     Opening a trace advances nothing and decides nothing.
//
// See decision F8.
import type { Context } from 'hono';
import { paginatedSchema, refSchema, traceEntitySchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { TOOL_RESULT_TRUNCATION_MARKER } from '../engine/constants.js';
import { inWorkspace, pathUuid } from './tenant.js';
import { RouteError } from './tenant.js';

const tracePage = paginatedSchema(traceEntitySchema);
const LIST_LIMIT = 100;
/** A trace shows a call and its result; neither is allowed to be a document. */
const FIELD_MAX = 20_000;

interface RunRow {
  id: string;
  session_id: string;
  title: string | null;
  status: string;
  mode: string;
  model_id: string;
  active_ms: number;
  attempt: number;
  waiting_for: string | null;
  started_at: Date;
  step_count: string;
}

interface StepRow {
  step_id: string;
  label: string;
  state: 'todo' | 'active' | 'done' | 'failed';
  tool_call_id: string | null;
  step_attempt: number;
}

/** `waiting` is the only status that is something a person has to do. */
const needsYou = (run: RunRow): boolean => run.status === 'waiting';

const subtitle = (run: RunRow): string => {
  const seconds = Math.round(run.active_ms / 1000);
  const worked = seconds > 0 ? `${seconds}s worked` : 'not started';
  const steps = `${run.step_count} step${run.step_count === '1' ? '' : 's'}`;
  return `${worked} · ${steps} · attempt ${run.attempt}`;
};

const toTraceEntity = (run: RunRow, steps: StepRow[], extra: Record<string, unknown> = {}): unknown =>
  traceEntitySchema.parse({
    id: run.id,
    run_id: run.id,
    name: run.title ?? 'Run',
    type: `${run.mode} · ${run.model_id}`,
    status: run.status,
    sub: subtitle(run),
    needs_you: needsYou(run),
    ref: { section: 'agents', view: 'trace', id: run.id },
    steps: steps.map((step) => ({
      id: step.step_id,
      label: step.label,
      state: step.state,
      tool_call_id: step.tool_call_id,
      step_attempt: step.step_attempt,
    })),
    mode: run.mode,
    model_id: run.model_id,
    active_ms: run.active_ms,
    step_count: Number(run.step_count),
    version: run.attempt,
    ...extra,
  });

const RUN_SELECT = `
  SELECT r.id, r.session_id, s.title, r.status, r.mode, r.model_id, r.active_ms, r.attempt,
         r.waiting_for, r.started_at,
         (SELECT count(*) FROM run_steps st WHERE st.run_id = r.id)::text AS step_count
    FROM runs r
    JOIN sessions s ON s.id = r.session_id`;

export async function listTraces(c: Context<{ Bindings: Env }>): Promise<Response> {
  const limit = Math.min(LIST_LIMIT, Math.max(1, Number(c.req.query('limit') ?? LIST_LIMIT) || LIST_LIMIT));
  const sessionId = c.req.query('session');

  const items = await inWorkspace(c, async (work) => {
    const values: unknown[] = [work.workspaceId];
    let where = 'WHERE r.workspace_id = $1';
    if (sessionId) {
      values.push(sessionId);
      where += ` AND r.session_id = $${values.length}`;
    }
    values.push(limit);
    const runs = await work.tx.query<RunRow>(
      `${RUN_SELECT} ${where} ORDER BY r.started_at DESC, r.id DESC LIMIT $${values.length}`,
      values,
    );
    if (runs.rows.length === 0) return [];
    // One query for every run's steps rather than one per run: a Traces tab
    // with fifty runs on it is fifty round trips otherwise, inside a
    // transaction that is holding a pooled connection open.
    const steps = await work.tx.query<StepRow & { run_id: string }>(
      `SELECT run_id, step_id, label, state, tool_call_id, step_attempt
         FROM run_steps
        WHERE workspace_id = $1 AND run_id = ANY ($2::uuid[])
        ORDER BY turn, created_at`,
      [work.workspaceId, runs.rows.map((r) => r.id)],
    );
    const byRun = new Map<string, StepRow[]>();
    for (const step of steps.rows) {
      const list = byRun.get(step.run_id) ?? [];
      list.push(step);
      byRun.set(step.run_id, list);
    }
    return runs.rows.map((run) => toTraceEntity(run, byRun.get(run.id) ?? []));
  });

  return c.json(tracePage.parse({ items, cursor: null, total: items.length }));
}

interface TurnRow {
  turn: number;
  role: string;
  provider_message: {
    tool_calls?: { id: string; name: string; arguments: string }[];
    tool_call_id?: string;
    content?: string;
  };
  tool_call_id: string | null;
}

/** Every `url` a `fetch_url` result mentions, in the order it was fetched. */
function fetchedUrls(turns: TurnRow[]): string[] {
  const urls: string[] = [];
  for (const turn of turns) {
    if (turn.role !== 'tool') continue;
    const content = turn.provider_message.content ?? '';
    try {
      const envelope = JSON.parse(content) as { tool?: string; data?: { url?: unknown; final_url?: unknown } };
      if (envelope.tool !== 'fetch_url') continue;
      const url = envelope.data?.final_url ?? envelope.data?.url;
      if (typeof url === 'string') urls.push(url.slice(0, 2000));
    } catch {
      // A truncated envelope is not JSON any more. It still says which tool it
      // came from in `tool_calls`, and the call itself is listed above, so
      // dropping it here loses nothing a reader cannot see.
    }
  }
  return urls.slice(0, 100);
}

export async function getTrace(c: Context<{ Bindings: Env }>): Promise<Response> {
  const runId = pathUuid(c, 'runId');

  const entity = await inWorkspace(c, async (work) => {
    const runs = await work.tx.query<RunRow>(`${RUN_SELECT} WHERE r.workspace_id = $1 AND r.id = $2`, [
      work.workspaceId,
      runId,
    ]);
    const run = runs.rows[0];
    if (!run) throw new RouteError('no such run in this workspace', 'not_found', 404);

    const steps = await work.tx.query<StepRow>(
      `SELECT step_id, label, state, tool_call_id, step_attempt
         FROM run_steps WHERE workspace_id = $1 AND run_id = $2 ORDER BY turn, created_at`,
      [work.workspaceId, runId],
    );
    const turns = await work.tx.query<TurnRow>(
      `SELECT turn, role, provider_message, tool_call_id
         FROM run_turns WHERE workspace_id = $1 AND run_id = $2 ORDER BY turn, seq`,
      [work.workspaceId, runId],
    );

    // The assistant turns hold the calls, the tool turns hold the results, and
    // `tool_call_id` is what joins them — which is also the id the client's
    // ToolChips are keyed on, so the trace and the transcript agree.
    const results = new Map<string, string>();
    for (const turn of turns.rows) {
      if (turn.role === 'tool' && turn.tool_call_id) {
        results.set(turn.tool_call_id, String(turn.provider_message.content ?? ''));
      }
    }
    const toolCalls: unknown[] = [];
    for (const turn of turns.rows) {
      if (turn.role !== 'assistant') continue;
      for (const call of turn.provider_message.tool_calls ?? []) {
        const result = results.get(call.id) ?? null;
        toolCalls.push({
          tool_call_id: call.id.slice(0, 128),
          name: call.name.slice(0, 64),
          turn: turn.turn,
          arguments: call.arguments ? call.arguments.slice(0, FIELD_MAX) : null,
          result: result ? result.slice(0, FIELD_MAX) : null,
          truncated: result ? result.includes(TOOL_RESULT_TRUNCATION_MARKER) : false,
        });
      }
    }

    // Where the pane was sent, read from the outbox rather than recomputed:
    // `run.focus` is what the client actually acted on.
    const focusRows = await work.tx.query<{ created_at: Date; payload: Record<string, unknown> }>(
      `SELECT created_at, payload FROM stream_events
        WHERE workspace_id = $1 AND kind = 'run.focus' AND payload ->> 'run_id' = $2
        ORDER BY id LIMIT 100`,
      [work.workspaceId, runId],
    );
    const focus = focusRows.rows.map((row) => {
      const ref = refSchema.safeParse(row.payload.ref);
      return {
        at: row.created_at.toISOString(),
        ref: ref.success ? ref.data : null,
        entity_type: String(row.payload.entity_type ?? '').slice(0, 32),
        entity_id: String(row.payload.entity_id ?? '').slice(0, 128),
      };
    });

    // The allowlist as it was for this run: the agent's capability rows
    // intersected with the run's mode, which is `runs.mode` and not the
    // session's, for the reason the engine gives — a person switching the
    // selector mid-run does not change what the run already in flight may do.
    const allowed = await work.tx.query<{ name: string }>(
      `SELECT unnest(c.tool_names) AS name
         FROM agent_capabilities c
         JOIN agents a ON a.id = c.agent_id
        WHERE c.workspace_id = $1
        ORDER BY name`,
      [work.workspaceId],
    );

    return toTraceEntity(run, steps.rows, {
      tool_calls: toolCalls,
      fetched_urls: fetchedUrls(turns.rows),
      focus,
      allowed_tools: [...new Set(allowed.rows.map((r) => r.name))].slice(0, 40),
    });
  });

  return c.json(entity);
}
