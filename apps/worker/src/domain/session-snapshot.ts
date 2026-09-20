// Recover a conversation entirely from committed rows. A single SQL statement
// gives history, checkpoints, run state and cursor the same MVCC boundary.
// Session ownership and tenant/agent identities share that same statement.
// Agent ownership can change without transferring a person's conversation:
// hydration follows the owner rule used by session reads, replay and sockets.
import {
  messageSchema, sessionSnapshotSchema, streamEventSchema,
  type Message, type SessionSnapshot, type SessionSnapshotStream, type StreamEvent,
} from '@hermes/shared';
import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';
import { runtimeLocation } from '../runtime/config.js';
import { RouteError } from '../routes/tenant.js';
import { VISIBLE } from './session-visibility.js';

export function projectSessionMessage(row: Record<string, unknown>): Message {
  const created = row.created_at;
  const sources = row.role === 'user' && !row.kind && Array.isArray(row.context_sources) ? row.context_sources : [];
  return messageSchema.parse({
    id: row.id, session_id: row.session_id, seq: row.seq, role: row.role, kind: row.kind ?? null,
    text: row.text, blocks: row.blocks, status: row.status, run_id: row.run_id ?? null,
    worked_ms: row.worked_ms ?? null, incomplete: row.status === 'incomplete',
    ...(sources.length ? { attachments: sources.map((source: { id: string; name: string; sha256: string }) => ({ id: source.id, label: source.name.slice(0, 200), kind: 'source', status: 'ready', sha256: source.sha256 })) } : {}),
    ...(created ? { at: new Date(created instanceof Date ? created : String(created)).toISOString() } : {}),
  });
}

/** The final row wins over checkpoints; only a new attempt/step can reset text. */
export function reconstructSessionStream(
  run: { id: string; attempt: number; status: string },
  events: readonly StreamEvent[],
  messages: readonly Message[],
): SessionSnapshotStream | null {
  let stream: SessionSnapshotStream | null = null;
  let deltas = new Map<number, string>();
  const seen = new Set<string>();
  for (const event of [...events].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    if (event.kind !== 'message.reset' && event.kind !== 'message.delta' && event.kind !== 'message.final') continue;
    const payload = event.payload;
    if (payload.run_id !== run.id || payload.attempt !== run.attempt) continue;
    const stepAttempt: number = 'step_attempt' in payload ? payload.step_attempt : stream?.step_attempt ?? 1;
    if (stream && (payload.turn < stream.turn || (payload.turn === stream.turn && stepAttempt < stream.step_attempt))) continue;
    const newer = !stream || payload.turn > stream.turn || stepAttempt > stream.step_attempt;
    if (newer) {
      stream = { run_id: run.id, attempt: run.attempt, turn: payload.turn, step_attempt: stepAttempt,
        message_id: payload.message_id, text: '', seq: -1, status: 'streaming' };
      deltas = new Map();
    }
    if (!stream) continue;
    if (event.kind === 'message.final') {
      stream = { ...stream, message_id: event.payload.message_id, text: event.payload.text, status: 'final' };
    } else if (event.kind === 'message.delta' && stream.status !== 'final') {
      const previous = deltas.get(event.payload.seq);
      if (previous !== undefined && previous !== event.payload.delta) {
        throw new RouteError('The durable checkpoint conflicts with an earlier value.', 'snapshot_incomplete', 409);
      }
      deltas.set(event.payload.seq, event.payload.delta);
      stream.message_id = event.payload.message_id;
    }
  }
  const final = stream
    ? messages.find((message) => message.id === stream?.message_id && message.status !== 'streaming')
    : run.attempt === 1 && ['completed', 'error', 'stopped'].includes(run.status)
      ? [...messages].reverse().find((message) => message.run_id === run.id && message.role === 'iris' && message.status !== 'streaming')
      : undefined;
  if (final) {
    stream = { run_id: run.id, attempt: run.attempt, turn: stream?.turn ?? 0, step_attempt: stream?.step_attempt ?? 1,
      message_id: final.id, text: final.text, seq: stream?.seq ?? -1, status: 'final' };
  }
  if (stream?.status === 'streaming') {
    const ordered = [...deltas.entries()].sort(([a], [b]) => a - b);
    if (ordered.some(([seq], index) => seq !== index)) {
      throw new RouteError('The durable checkpoint is incomplete. Reload the session again.', 'snapshot_incomplete', 409);
    }
    stream.text = ordered.map(([, delta]) => delta).join('');
    stream.seq = ordered.at(-1)?.[0] ?? -1;
  } else if (stream) {
    stream.seq = Math.max(stream.seq, ...deltas.keys());
  }
  return stream;
}

interface SnapshotRow {
  session: Record<string, unknown>;
  run: SessionSnapshot['run'];
  recovery: SessionSnapshot['recovery'];
  messages: Record<string, unknown>[];
  events: unknown[];
  watermark: string;
}

export async function loadSessionSnapshot(
  tx: Tx, env: Env, workspaceId: string, userId: string, sessionId: string,
): Promise<SessionSnapshot> {
  const { rows } = await tx.query<SnapshotRow>(
    `WITH visible_session AS MATERIALIZED (
       SELECT s.* FROM sessions s
        JOIN agents a ON a.workspace_id=s.workspace_id AND a.id=s.agent_id
        WHERE s.workspace_id=$1 AND s.id=$3 AND ${VISIBLE}
     ), selected_run AS MATERIALIZED (
       SELECT r.* FROM runs r JOIN visible_session s
         ON r.workspace_id=s.workspace_id AND r.session_id=s.id AND r.agent_id=s.agent_id
        ORDER BY (r.status IN ('working','waiting','stopping')) DESC, r.created_at DESC, r.id DESC LIMIT 1
     ), attempt_events AS MATERIALIZED (
       SELECT e.* FROM stream_events e JOIN visible_session s ON e.workspace_id=s.workspace_id AND e.session_id=s.id
       JOIN selected_run r
         ON e.payload->>'run_id'=r.id::text AND e.payload->>'attempt'=r.attempt::text
        WHERE e.kind IN ('run.started','run.status','message.reset','message.delta','message.final')
     ), message_page AS MATERIALIZED (
       SELECT m.*, (SELECT jsonb_agg(jsonb_build_object('id',source->>'id','name',source->>'name','sha256',source->>'sha256'))
         FROM runs bound, jsonb_array_elements(bound.context_snapshot->'sources') source
         WHERE bound.id=m.run_id AND bound.workspace_id=m.workspace_id) AS context_sources
       FROM messages m JOIN visible_session s ON m.workspace_id=s.workspace_id AND m.session_id=s.id
        ORDER BY m.seq DESC LIMIT 51
     )
     SELECT to_jsonb(s) || jsonb_build_object('status', COALESCE(v.status,'idle')) AS session,
       CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
         'id',r.id,'session_id',r.session_id,'agent_id',r.agent_id,'status',r.status,'attempt',r.attempt,
         'title',started.payload->'title','model_id',r.model_id,'effort',r.effort,
         'started_at',clock.admitted_at,'admitted_at',clock.admitted_at,
         'execution_started_at',CASE WHEN r.runtime_request_attempt=r.attempt THEN r.runtime_started_at ELSE started.created_at END,
         'ended_at',r.ended_at,'waiting_for',r.waiting_for,'waiting_label',r.waiting_label,'active_ms',r.active_ms,'error',r.error,
         'guidance',(SELECT jsonb_build_object('id',g.id,'text',g.text,
           'status',CASE WHEN g.status='streaming' THEN 'pending' ELSE 'applied' END)
           FROM messages g WHERE g.workspace_id=$1 AND g.session_id=s.id AND g.role='user' AND g.kind='guidance'
             AND g.status IN ('streaming','complete')
             AND (g.run_id=r.id OR (g.run_id IS NULL AND g.status='streaming' AND g.created_at<=r.created_at))
           ORDER BY g.seq DESC LIMIT 1),
         'steps',COALESCE((SELECT jsonb_agg(to_jsonb(step)-'turn' ORDER BY step.turn,step.id) FROM (
           SELECT rs.step_id AS id,rs.turn,rs.label,rs.state,rs.tool_call_id,rs.step_attempt
             FROM run_steps rs WHERE rs.workspace_id=$1 AND rs.run_id=r.id AND rs.started_at>=clock.admitted_at
             ORDER BY rs.turn,rs.step_id LIMIT 100
         ) step),'[]'::jsonb),
         'queue',COALESCE((SELECT jsonb_agg(item ORDER BY item.position) FROM (
           SELECT q.id,q.text,q.status,q.position FROM run_queue q WHERE q.workspace_id=$1 AND q.run_id=r.id
            ORDER BY q.position LIMIT 50
         ) item),'[]'::jsonb)
       ) END AS run,
       CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object(
         'next_retry_at',r.recovery_next_at,'not_before',r.recovery_not_before,
         'cancelled',r.recovery_cancelled,'blocked_reason',r.recovery_blocked_reason
       ) END AS recovery,
       COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.seq DESC) FROM message_page m),'[]'::jsonb) AS messages,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'id',e.id::text,'workspace_id',e.workspace_id,'session_id',e.session_id,'kind',e.kind,'payload',e.payload,
         'schema_version',e.schema_version,'trace_id',COALESCE(e.trace_id,'unknown'),'at',e.created_at
       ) ORDER BY e.id) FROM attempt_events e WHERE e.kind LIKE 'message.%'),'[]'::jsonb) AS events,
       COALESCE((SELECT max(e.id) FROM stream_events e WHERE e.workspace_id=$1 AND e.session_id=s.id),0)::text AS watermark
     FROM visible_session s
     LEFT JOIN selected_run r ON true
     LEFT JOIN v_session_status v ON v.session_id=s.id
     LEFT JOIN LATERAL (SELECT e.payload,e.created_at FROM attempt_events e WHERE e.kind='run.started' ORDER BY e.id LIMIT 1) started ON true
     LEFT JOIN LATERAL (SELECT CASE WHEN r.attempt=1 THEN r.created_at ELSE COALESCE(
       (SELECT e.created_at FROM attempt_events e WHERE e.kind='run.status' AND e.payload->>'status'='working' ORDER BY e.id LIMIT 1),
       started.created_at,r.started_at) END AS admitted_at) clock ON true`,
    [workspaceId, userId, sessionId],
  );
  const row = rows[0];
  if (!row) throw new RouteError('no such session', 'unknown_session', 404);
  const messages = row.messages.slice(0, 50).reverse().map(projectSessionMessage);
  if (row.run) {
    row.run.admitted_at = new Date(row.run.admitted_at).toISOString();
    row.run.started_at = row.run.admitted_at;
    row.run.execution_started_at = row.run.execution_started_at ? new Date(row.run.execution_started_at).toISOString() : null;
    row.run.ended_at = row.run.ended_at ? new Date(row.run.ended_at).toISOString() : null;
  }
  if (row.recovery) {
    row.recovery.next_retry_at = row.recovery.next_retry_at ? new Date(row.recovery.next_retry_at).toISOString() : null;
    row.recovery.not_before = row.recovery.not_before ? new Date(row.recovery.not_before).toISOString() : null;
  }
  const session = row.session;
  return sessionSnapshotSchema.parse({
    workspace_id: workspaceId,
    session: { id: session.id, agent_id: session.agent_id, title: session.title, mode: session.mode,
      model_id: session.model_id, effort: session.effort ?? null,
      runtime: runtimeLocation(env, workspaceId, String(session.agent_id), session.runtime === 'local' ? 'local' : 'cloud'),
      pinned: session.pinned, archived: session.archived, focus_ref: session.focus_ref ?? null,
      status: session.status, last_activity_at: session.last_activity_at ?? null },
    run: row.run, recovery: row.recovery,
    messages: { items: messages, cursor: row.messages.length > 50 && messages[0] ? String(messages[0].seq) : null, total: null },
    stream: row.run ? reconstructSessionStream(row.run, row.events.map((event) => streamEventSchema.parse(event)), messages) : null,
    watermark: row.watermark,
  });
}
