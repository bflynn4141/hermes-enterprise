// `PgAgentDb` against the real `agent` role.
//
// This is the test that catches the difference between "the SQL is right" and
// "the role may run it". The engine tests use an in-memory `AgentDb` and would
// happily pass with a `RETURNING id` the `agent` role has no SELECT for — which
// is exactly the bug this file was written after finding: `stream_events` is
// INSERT-only for that role, so the outbox id comes from the sequence instead.
//
// Every method here runs on the agent Hyperdrive connection string, under the
// same row-level security a deployed step runs under.
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import { APP_URL, AGENT_URL } from '../../scripts/db-config.mjs';
import { seedWorkspace, withClient, setTenant, type Fixture } from './helpers.js';

const env = {
  ENVIRONMENT: 'test',
  ENGINE_VERSION: '1',
  HYPERDRIVE_APP: { connectionString: APP_URL },
  HYPERDRIVE_AGENT: { connectionString: AGENT_URL },
} as unknown as Env;

/** A run row for the engine to drive, written by `owner` as a route would. */
async function seedRun(fx: Fixture): Promise<string> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO runs (workspace_id, session_id, status, model_id, client_turn_id, trace_id)
       VALUES ($1, $2, 'working', 'deepseek-flash', 'agent-db-test', 'trace-agent-db')
       RETURNING id`,
      [fx.workspaceId, fx.sessionId],
    );
    await c.query(
      `INSERT INTO run_turns (workspace_id, run_id, turn, seq, role, provider_message)
       VALUES ($1, $2, 0, 0, 'user', '{"role":"user","content":"go"}'::jsonb)`,
      [fx.workspaceId, rows[0]!.id],
    );
    await c.query('COMMIT');
    return rows[0]!.id;
  });
}

const APPLICATION = {
  kind: 'application',
  applicant: { name: 'Ada Ling', email: 'ada.ling@example.com' },
  proposed_role: 'Research fellow',
  score: 70,
  score_max: 100,
  criteria: [{ id: 'c1', label: 'Publications', points: 40, points_max: 50, evidence: 'three papers', source_ids: [] }],
  sources: [],
  missing: [],
};

describe('PgAgentDb on the agent role', () => {
  it('reads the run, its session mode and the workspace agent', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      const run = await db.loadRun(runId);
      expect(run).toMatchObject({ id: runId, sessionId: fx.sessionId, mode: 'work', agentId: fx.agentId });
      expect(await db.stopRequested(runId)).toBe(false);
      expect(await db.resumeTurn(runId)).toBe(0);
    } finally {
      await db.close();
    }
  });

  it('writes the outbox without needing SELECT on stream_events', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      const written = await db.emit([
        { kind: 'run.step', sessionId: fx.sessionId, payload: { run_id: runId, step_id: 'provider' } },
        { kind: 'message.reset', sessionId: fx.sessionId, payload: { run_id: runId, turn: 0 } },
      ]);
      expect(written).toHaveLength(2);
      // Ids come back strictly increasing, which is what replay depends on.
      expect(BigInt(written[1]!.id)).toBeGreaterThan(BigInt(written[0]!.id));
    } finally {
      await db.close();
    }
  });

  it('is refused by the trigger when it tries to publish a kind it may not', async () => {
    const fx = await seedWorkspace();
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      await expect(
        db.emit([{ kind: 'decision.recorded', sessionId: null, payload: { request_id: 'x' } }]),
      ).rejects.toThrow(/the agent role may publish/);
    } finally {
      await db.close();
    }
  });

  it('proposes a request idempotently on (run_id, tool_call_id)', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      const input = {
        runId,
        sessionId: fx.sessionId,
        toolCallId: 'call_1',
        kind: 'application' as const,
        subject: 'ada.ling@example.com',
        subjectKey: 'email:ada.ling@example.com',
        label: 'Ada Ling',
        payload: APPLICATION,
      };
      const first = await db.proposeRequest(input);
      const second = await db.proposeRequest(input);
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.requestId).toBe(first.requestId);

      const note = await db.saveReviewNote({ runId, toolCallId: 'call_2', requestId: first.requestId, body: 'two of three references reachable' });
      expect((await db.saveReviewNote({ runId, toolCallId: 'call_2', requestId: first.requestId, body: 'again' })).noteId).toBe(note.noteId);
    } finally {
      await db.close();
    }
  });

  it('cannot move a request out of pending, because the role has no UPDATE', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      const { requestId } = await db.proposeRequest({
        runId,
        sessionId: fx.sessionId,
        toolCallId: 'call_pending',
        kind: 'application',
        subject: 'ada',
        subjectKey: 'email:ada.ling@example.com',
        label: 'Ada Ling',
        payload: APPLICATION,
      });
      const row = (await db.getRequest(requestId)) as { status: string };
      expect(row.status).toBe('pending');
    } finally {
      await db.close();
    }
  });

  it('keeps the assistant message keyed on (run_id, turn), so a retry replaces it', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      const first = await db.upsertAssistantMessage({
        runId,
        sessionId: fx.sessionId,
        turn: 0,
        text: 'half a sen',
        blocks: [],
        status: 'incomplete',
        workedMs: 10,
      });
      const second = await db.upsertAssistantMessage({
        runId,
        sessionId: fx.sessionId,
        turn: 0,
        text: 'a whole sentence.',
        blocks: [],
        status: 'complete',
        workedMs: 20,
      });
      expect(second.messageId).toBe(first.messageId);
      expect(await db.resumeTurn(runId)).toBe(1);

      await withClient('owner', async (c) => {
        await c.query('BEGIN');
        await setTenant(c, fx.workspaceId, fx.adminId);
        const { rows } = await c.query(`SELECT text, status FROM messages WHERE run_id = $1 AND turn = 0`, [runId]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ text: 'a whole sentence.', status: 'complete' });
        await c.query('COMMIT');
      });
    } finally {
      await db.close();
    }
  });

  it('counts step attempts, which is what message.reset carries', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      const step = { runId, turn: 0, stepId: 'provider', label: 'Thinking', state: 'active' as const, toolCallId: null };
      expect((await db.enterStep(step)).stepAttempt).toBe(1);
      expect((await db.enterStep(step)).stepAttempt).toBe(2);
      await db.finishStep({ ...step, state: 'done' });
    } finally {
      await db.close();
    }
  });

  it('records a model call, appends turns and meters active time', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      await db.recordModelCall({
        runId,
        turn: 0,
        modelId: 'deepseek-flash',
        provider: 'deepseek',
        keyId: null,
        usage: { input_tokens: 1000, output_tokens: 100, cached_input_tokens: 0, reasoning_tokens: 0 },
        latencyMs: 250,
        status: 'ok',
      });
      const appended = await db.appendTurn({
        runId,
        turn: 1,
        seq: 0,
        role: 'tool',
        toolCallId: 'call_1',
        providerMessage: { role: 'tool', tool_call_id: 'call_1', content: '{"untrusted":true}' },
      });
      expect(appended.created).toBe(true);
      // The same tool call again: one row, because of the partial unique index.
      expect((await db.appendTurn({
        runId,
        turn: 1,
        seq: 0,
        role: 'tool',
        toolCallId: 'call_1',
        providerMessage: { role: 'tool', tool_call_id: 'call_1', content: '{"untrusted":true}' },
      })).created).toBe(false);

      expect(await db.addActiveMs(runId, 120)).toBe(120);
      await db.setRunStatus(runId, 'completed', { error: null });
      const run = await db.loadRun(runId);
      expect(run?.status).toBe('completed');
    } finally {
      await db.close();
    }
  });

  it('sets and reads a context field, and sees a run waiting on a key', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      await db.setContextField({ runId, toolCallId: 'call_ctx', agentId: fx.agentId, key: 'cohort_cap', value: '30', scope: 'reply' });
      expect(await db.readContextField(fx.agentId, 'cohort_cap')).toBe('30');
      expect(await db.isAwaitingContext('cohort_cap')).toBe(false);
      await db.setRunStatus(runId, 'waiting', { waitingFor: 'cohort_cap', waitingLabel: 'What is the cap?' });
      expect(await db.isAwaitingContext('cohort_cap')).toBe(true);
    } finally {
      await db.close();
    }
  });

  it('cannot see another workspace\'s run, because row-level security still applies', async () => {
    const mine = await seedWorkspace();
    const theirs = await seedWorkspace();
    const theirRun = await seedRun(theirs);
    const db = new PgAgentDb(env, mine.workspaceId, 'trace-agent-db');
    try {
      expect(await db.loadRun(theirRun)).toBeNull();
    } finally {
      await db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// F3 · the request the agent proposed says so on the workspace stream
// ---------------------------------------------------------------------------

describe('F3 · proposeRequest publishes request.created', () => {
  it('writes the outbox row in the same transaction as the request', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      const result = await db.proposeRequest({
        runId,
        sessionId: fx.sessionId,
        toolCallId: 'call_f3',
        kind: 'application',
        subject: 'ada.ling@example.com',
        subjectKey: 'email:ada.ling@example.com',
        label: 'Ada Ling',
        payload: APPLICATION,
      });
      expect(result.created).toBe(true);
      expect(result.events).toHaveLength(1);
      const event = result.events![0]!;
      expect(event.kind).toBe('request.created');
      // Workspace-scoped, because the Inbox of every member is what needs it —
      // not the socket of the session that happened to propose it.
      expect(event.sessionId).toBeNull();
      expect(event.payload).toMatchObject({
        request_id: result.requestId,
        status: 'pending',
        label: 'Ada Ling',
        run_id: runId,
      });

      const row = await withClient('owner', async (c) => {
        await c.query('BEGIN');
        await setTenant(c, fx.workspaceId, fx.adminId);
        const { rows } = await c.query<{ kind: string; session_id: string | null }>(
          `SELECT kind, session_id::text FROM stream_events
            WHERE workspace_id = $1 AND kind = 'request.created'
              AND payload ->> 'request_id' = $2`,
          [fx.workspaceId, result.requestId],
        );
        await c.query('COMMIT');
        return rows[0];
      });
      expect(row?.kind).toBe('request.created');
      expect(row?.session_id).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('publishes nothing on a replayed step, so the Inbox gets one row', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      const input = {
        runId,
        sessionId: fx.sessionId,
        toolCallId: 'call_replay',
        kind: 'application' as const,
        subject: 'ada.ling@example.com',
        subjectKey: 'email:ada.ling@example.com',
        label: 'Ada Ling',
        payload: APPLICATION,
      };
      const first = await db.proposeRequest(input);
      const second = await db.proposeRequest(input);
      expect(second.created).toBe(false);
      expect(second.requestId).toBe(first.requestId);
      expect(second.events ?? []).toHaveLength(0);

      const count = await withClient('owner', async (c) => {
        await c.query('BEGIN');
        await setTenant(c, fx.workspaceId, fx.adminId);
        const { rows } = await c.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM stream_events
            WHERE workspace_id = $1 AND kind = 'request.created' AND payload ->> 'request_id' = $2`,
          [fx.workspaceId, first.requestId],
        );
        await c.query('COMMIT');
        return rows[0]!.n;
      });
      expect(count).toBe('1');
    } finally {
      await db.close();
    }
  });

  it('publishes entity.updated when a note is saved', async () => {
    const fx = await seedWorkspace();
    const runId = await seedRun(fx);
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      const proposed = await db.proposeRequest({
        runId,
        sessionId: fx.sessionId,
        toolCallId: 'call_note_req',
        kind: 'application',
        subject: 'ada.ling@example.com',
        subjectKey: 'email:ada.ling@example.com',
        label: 'Ada Ling',
        payload: APPLICATION,
      });
      const note = await db.saveReviewNote({
        runId,
        toolCallId: 'call_note',
        requestId: proposed.requestId,
        body: 'Two of three references replied.',
      });
      expect(note.created).toBe(true);
      expect(note.events).toHaveLength(1);
      expect(note.events![0]!.kind).toBe('entity.updated');
      expect(note.events![0]!.sessionId).toBeNull();
      expect(note.events![0]!.payload).toMatchObject({
        entity_type: 'request',
        entity_id: proposed.requestId,
      });
    } finally {
      await db.close();
    }
  });

  it('still refuses an event about a request the agent did not write', async () => {
    const fx = await seedWorkspace();
    const db = new PgAgentDb(env, fx.workspaceId, 'trace-agent-db');
    try {
      // A `requests` row with no `run_id` is a row no tool made. The trigger's
      // widening is "about a request it wrote", not "about a request".
      const requestId = await withClient('owner', async (c) => {
        await c.query('BEGIN');
        await setTenant(c, fx.workspaceId, fx.adminId);
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO requests (workspace_id, kind, label, payload, session_id)
           VALUES ($1, 'application', 'Human made', '{"kind":"application"}'::jsonb, $2)
           RETURNING id`,
          [fx.workspaceId, fx.sessionId],
        );
        await c.query('COMMIT');
        return rows[0]!.id;
      });
      await expect(
        db.emit([
          {
            kind: 'request.created',
            sessionId: null,
            payload: { request_id: requestId, kind: 'application', status: 'pending', label: 'x', run_id: null, session_id: null },
          },
        ]),
      ).rejects.toThrow(/the agent role may publish/);
    } finally {
      await db.close();
    }
  });
});
