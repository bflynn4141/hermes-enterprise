// Real agent-role proofs for runtime replay, stop/attempt fences and rollback.
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { RuntimeDb } from '../../src/runtime/store.js';
import { dispatchRuntimeCall, type RuntimeCall } from '../../src/runtime/bridge.js';
import { loadRaindropRunSnapshot } from '../../src/ops/raindrop.js';
import { AGENT_URL, APP_URL } from '../../scripts/db-config.mjs';
import { seedPendingRequest, seedWorkspace, withClient, setTenant, type Fixture } from './helpers.js';

const env = { ENVIRONMENT: 'test', ENGINE_VERSION: '1', HYPERDRIVE_APP: { connectionString: APP_URL }, HYPERDRIVE_AGENT: { connectionString: AGENT_URL } } as unknown as Env;
const nativeCall = (remote: string, name = 'propose_instruction', args: Record<string, unknown> = { body: 'Use published evidence.', sources: [] }): RuntimeCall => ({ runtime_run_id: remote, tool_call_id: 'native-call-1', name, arguments: args });
const makeDb = (fx: Fixture) => new RuntimeDb(env, fx.workspaceId, 'trace-runtime-bridge');
async function owner<T>(fx: Fixture, fn: (q: <R>(sql: string, values?: unknown[]) => Promise<{ rows: R[] }>) => Promise<T>): Promise<T> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
    try { const result = await fn(<R,>(sql: string, values?: unknown[]) => c.query(sql, values) as unknown as Promise<{ rows: R[] }>); await c.query('COMMIT'); return result; }
    catch (error) { await c.query('ROLLBACK'); throw error; }
  });
}
async function seedRun(fx: Fixture): Promise<string> {
  return owner(fx, async (q) => {
    await q(`INSERT INTO agent_capabilities (workspace_id,agent_id,kind,title,tool_names)
             SELECT $1,$2,'can','Runtime test tools',ARRAY['propose_instruction','ask_for_context','list_requests']
             WHERE NOT EXISTS (SELECT 1 FROM agent_capabilities WHERE agent_id=$2)`, [fx.workspaceId,fx.agentId]);
    const { rows } = await q<{ id: string }>(
      `INSERT INTO runs (workspace_id,session_id,agent_id,status,model_id,client_turn_id,trace_id,mode)
       VALUES ($1,$2,$3,'working','deepseek-flash',$4,'trace-runtime','work') RETURNING id`,
      [fx.workspaceId, fx.sessionId, fx.agentId, crypto.randomUUID()]);
    const id = rows[0]!.id;
    await q(`INSERT INTO run_turns (workspace_id,run_id,turn,seq,role,provider_message)
             VALUES ($1,$2,0,0,'user','{"role":"user","content":"Start"}'::jsonb)`, [fx.workspaceId, id]);
    return id;
  });
}
async function mappedRun(fx: Fixture, store: RuntimeDb): Promise<{ id: string; remote: string }> {
  const id = await seedRun(fx); const remote = crypto.randomUUID();
  const run = (await store.loadRun(id))!;
  expect(await store.bindRun(id, run.attempt, remote, fx.sessionId, `agent-${fx.agentId}`)).toBe(true);
  return { id, remote };
}

describe('official runtime on the restricted agent role', () => {
  it('reads a content-free Raindrop snapshot from the canonical terminal trace', async () => {
    const fx = await seedWorkspace(); const store = makeDb(fx);
    try {
      const { id, remote } = await mappedRun(fx, store);
      await dispatchRuntimeCall(store, fx.workspaceId, fx.agentId, nativeCall(remote));
      await store.upsertAssistantMessage({
        runId: id,
        sessionId: fx.sessionId,
        turn: 0,
        text: 'Private applicant alice@example.com should never leave Hermes.',
        blocks: [],
        status: 'complete',
        workedMs: 250,
      });
      await store.setRunStatus(id, 'completed');

      const snapshot = await loadRaindropRunSnapshot(store, id);
      expect(snapshot).toMatchObject({
        id,
        runtimeKind: 'hermes',
        status: 'completed',
        outputPresent: true,
        outputCharacters: 62,
        tools: [{ name: 'propose_instruction', state: 'done' }],
      });
      expect(JSON.stringify(snapshot)).not.toContain('alice@example.com');
      expect(JSON.stringify(snapshot)).not.toContain('Use published evidence.');
    } finally { await store.close(); }
  });

  it('serializes simultaneous identical callbacks into one proposal and one trace result', async () => {
    const fx = await seedWorkspace(); const first = makeDb(fx); const second = makeDb(fx);
    try {
      const { id, remote } = await mappedRun(fx, first);
      const call = nativeCall(remote);
      const [a, b] = await Promise.all([
        dispatchRuntimeCall(first, fx.workspaceId, fx.agentId, call),
        dispatchRuntimeCall(second, fx.workspaceId, fx.agentId, call),
      ]);
      expect(a.reply).toEqual(b.reply);
      expect([a.events.length, b.events.length].filter((count) => count === 0)).toHaveLength(1);
      const history = await first.loadHistory(id, 20);
      expect(history.recent.map((turn) => turn.role)).toEqual(['user', 'assistant', 'tool']);
      const { rows } = await first.runtimeQuery<{ count: string }>('SELECT count(*)::text AS count FROM instruction_versions WHERE run_id=$1', [id]);
      expect(rows[0]?.count).toBe('1');
      await expect(dispatchRuntimeCall(first, fx.workspaceId, fx.agentId, { ...call, arguments: { body: 'Mutated instructions.' } })).rejects.toMatchObject({ reason: 'runtime_call_conflict' });
    } finally { await first.close(); await second.close(); }
  });
  it('answers a note on a malformed, unknown or foreign request with a reason the model can act on', async () => {
    const fx = await seedWorkspace(); const other = await seedWorkspace(); const store = makeDb(fx);
    try {
      const { remote } = await mappedRun(fx, store);
      await owner(fx, (q) => q(`INSERT INTO agent_capabilities (workspace_id,agent_id,kind,title,tool_names)
                                VALUES ($1,$2,'can','Notes',ARRAY['save_review_note'])`, [fx.workspaceId, fx.agentId]));
      const own = await seedPendingRequest(fx);
      const foreign = await seedPendingRequest(other);
      const note = (requestId: string, callId: string) => dispatchRuntimeCall(store, fx.workspaceId, fx.agentId, {
        runtime_run_id: remote, tool_call_id: callId, name: 'save_review_note', arguments: { request_id: requestId, body: 'Duplicate; keep one.' },
      });
      // The short ids a model copies from a summary are the common mistake.
      const short = await note(own.slice(0, 8), 'note-short');
      expect(short.reply).toMatchObject({ ok: false });
      expect((short.reply as { content: string }).content).toContain('full request id');
      for (const [requestId, callId] of [[crypto.randomUUID(), 'note-unknown'], [foreign, 'note-foreign']] as const) {
        const missing = await note(requestId, callId);
        expect(missing.reply).toMatchObject({ ok: false });
        expect((missing.reply as { content: string }).content).toContain('No request');
      }
      // A person created this request, so the note saves without a live
      // entity.updated the agent role may not publish about it.
      const saved = await note(own, 'note-own');
      expect(saved.reply).toMatchObject({ ok: true });
      expect(saved.events.filter((event) => event.kind === 'entity.updated')).toEqual([]);
      const { rows } = await store.runtimeQuery<{ count: string }>('SELECT count(*)::text AS count FROM request_notes WHERE request_id=$1', [own]);
      expect(rows[0]?.count).toBe('1');
    } finally { await store.close(); }
  });
  it('rolls back both the tool write and its reserved trace when the callback fails', async () => {
    const fx = await seedWorkspace(); const store = makeDb(fx);
    try {
      const { id } = await mappedRun(fx, store);
      await expect(store.withCallLock(fx.agentId, async () => {
        await store.proposeInstruction({ runId: id, toolCallId: 'rollback-call', agentId: fx.agentId, body: 'Must roll back.', sources: [] });
        await store.appendTurn({ runId: id, turn: 0, seq: 1, role: 'assistant', providerMessage: { role: 'assistant', content: 'Must roll back.' } });
        throw new Error('simulated callback failure');
      })).rejects.toThrow('simulated callback failure');
      expect((await store.loadHistory(id, 20)).recent).toHaveLength(1);
      const { rows } = await store.runtimeQuery<{ count: string }>('SELECT count(*)::text AS count FROM instruction_versions WHERE run_id=$1', [id]);
      expect(rows[0]?.count).toBe('0');
    } finally { await store.close(); }
  });
  it('cannot resolve another workspace, an old attempt, or a stopped run', async () => {
    const fx = await seedWorkspace(); const other = await seedWorkspace(); const store = makeDb(fx); const foreign = makeDb(other);
    try {
      const { id, remote } = await mappedRun(fx, store);
      expect(await foreign.findRuntimeRun(remote, fx.agentId)).toBeNull();
      await owner(fx, (q) => q('UPDATE runs SET attempt=attempt+1 WHERE id=$1', [id]));
      expect(await store.findRuntimeRun(remote, fx.agentId)).toBeNull();
      await expect(dispatchRuntimeCall(store, fx.workspaceId, fx.agentId, nativeCall(remote))).rejects.toMatchObject({ reason: 'runtime_run_inactive' });
      const current = (await store.loadRun(id))!;
      const next = crypto.randomUUID();
      expect(await store.bindRun(id, current.attempt, next, fx.sessionId, `agent-${fx.agentId}`)).toBe(true);
      await owner(fx, (q) => q('UPDATE runs SET stop_requested=true,status=\'stopping\' WHERE id=$1', [id]));
      await expect(dispatchRuntimeCall(store, fx.workspaceId, fx.agentId, nativeCall(next))).rejects.toMatchObject({ reason: 'runtime_run_inactive' });
      expect(await store.bindRun(id, current.attempt, next, fx.sessionId, `agent-${fx.agentId}`)).toBe(false);
    } finally { await store.close(); await foreign.close(); }
  });
  it('snapshots identical submissions across retries and allows model startup before mapping', async () => {
    const fx = await seedWorkspace(); const store = makeDb(fx);
    try {
      const id = await seedRun(fx); const run = (await store.loadRun(id))!;
      const request = { input: 'Original prompt', model: 'raw/model' };
      expect(await store.snapshotRequest(id, run.attempt, request)).toEqual(request);
      expect(await store.snapshotRequest(id, run.attempt, { input: 'Changed prompt' })).toEqual(request);
      expect((await store.activeProfileRun(fx.agentId))?.id).toBe(id);
      expect(await store.mappingPending(fx.agentId)).toBe(true);
      expect(await store.bindRun(id, run.attempt, 'native-run', fx.sessionId, `agent-${fx.agentId}`)).toBe(true);
      expect(await store.mappingPending(fx.agentId)).toBe(false);
    } finally { await store.close(); }
  });
  it('exposes only the immediately previous authority snapshot to a recovery attempt', async () => {
    const fx = await seedWorkspace(); const store = makeDb(fx);
    try {
      const id = await seedRun(fx);
      const previous = { input: 'Original prompt', _enterprise_tool_names: ['list_requests'], _enterprise_skills: [] };
      await store.snapshotRequest(id, 1, previous);
      await owner(fx, (q) => q(
        `UPDATE runs SET attempt=2,recovery_input='Resume stored evidence.' WHERE id=$1`,
        [id],
      ));
      expect(await store.recoveryAuthority(id, 2)).toEqual(previous);
      expect(await store.runtimeRequest(id, 2)).toBeNull();
      const next = { input: 'Resume stored evidence.', _enterprise_tool_names: ['list_requests'], _enterprise_skills: [] };
      await store.snapshotRequest(id, 2, next);
      expect(await store.runtimeRequest(id, 2)).toEqual(next);
      expect(await store.recoveryAuthority(id, 2)).toBeNull();
    } finally { await store.close(); }
  });
  it('keeps nested runtime startup operations in one rollback boundary', async () => {
    const fx = await seedWorkspace(); const store = makeDb(fx);
    try {
      const id = await seedRun(fx); const run = (await store.loadRun(id))!;
      await expect(store.withRuntimeTransaction(async () => {
        await store.snapshotRequest(id, run.attempt, { input: 'Rollback this startup.' });
        expect(await store.bindRun(id, run.attempt, 'rolled-back-native-run', fx.sessionId, `agent-${fx.agentId}`)).toBe(true);
        throw new Error('interrupt grouped startup');
      })).rejects.toThrow('interrupt grouped startup');
      expect(await store.binding(id)).toMatchObject({ runtimeRunId: null, runtimeAttempt: null });
      const request = await store.runtimeQuery<{ runtime_request: Record<string, unknown> | null }>(
        'SELECT runtime_request FROM runs WHERE id=$1', [id],
      );
      expect(request.rows[0]?.runtime_request).toBeNull();
    } finally { await store.close(); }
  });
  it('retains a question across callback requests and records the answer once', async () => {
    const fx = await seedWorkspace(); const store = makeDb(fx);
    try {
      const { id, remote } = await mappedRun(fx, store);
      const call = nativeCall(remote, 'ask_for_context', { key: 'deadline', question: 'When is the deadline?' });
      expect((await dispatchRuntimeCall(store, fx.workspaceId, fx.agentId, call)).reply).toEqual({ status: 'pending' });
      expect((await store.loadRun(id))?.status).toBe('waiting');
      const waitingClock = await store.runtimeQuery<{ runtime_wait_started_at: Date | null }>('SELECT runtime_wait_started_at FROM runs WHERE id=$1', [id]);
      expect(waitingClock.rows[0]?.runtime_wait_started_at).not.toBeNull();
      expect((await store.loadWorkspaceContext(fx.agentId)).find((field) => field.key === 'deadline')?.value).toBeNull();
      await owner(fx, (q) => q('UPDATE agent_context_fields SET value=$2 WHERE agent_id=$1 AND key=$3', [fx.agentId, 'Friday', 'deadline']));
      const answer = await dispatchRuntimeCall(store, fx.workspaceId, fx.agentId, call);
      expect(answer.reply).toMatchObject({ ok: true });
      expect((await dispatchRuntimeCall(store, fx.workspaceId, fx.agentId, call)).reply).toEqual(answer.reply);
      expect((await store.loadRun(id))?.status).toBe('working');
      const resumedClock = await store.runtimeQuery<{ runtime_wait_started_at: Date | null }>('SELECT runtime_wait_started_at FROM runs WHERE id=$1', [id]);
      expect(resumedClock.rows[0]?.runtime_wait_started_at).toBeNull();
      expect((await store.loadHistory(id, 20)).recent).toHaveLength(3);
    } finally { await store.close(); }
  });
  it('bootstraps only prior completed conversational messages and only before native session history exists', async () => {
    const fx = await seedWorkspace(); const store = makeDb(fx);
    try {
      await owner(fx, (q) => q(
        `INSERT INTO messages (workspace_id,session_id,seq,role,text,status,kind,created_at) VALUES
          ($1,$2,1,'user','Earlier question','complete',NULL,now()-interval '1 minute'),
          ($1,$2,2,'iris','Earlier answer','complete',NULL,now()-interval '1 minute'),
          ($1,$2,3,'iris','Incomplete text','incomplete',NULL,now()-interval '1 minute'),
          ($1,$2,4,'user','Guidance','complete','guidance',now()-interval '1 minute')`, [fx.workspaceId, fx.sessionId]));
      const id = await seedRun(fx); const run = (await store.loadRun(id))!;
      expect(await store.resolveRuntimeSessionId(run)).toBe(id);
      expect(await store.loadBootstrapHistory(run)).toEqual([{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }]);
      await store.bindRun(id, run.attempt, 'history-run', 'native-session-root', `agent-${fx.agentId}`);
      await owner(fx, (q) => q("UPDATE runs SET status='completed',ended_at=now() WHERE id=$1", [id]));
      const next = await seedRun(fx);
      const nextRun = (await store.loadRun(next))!;
      expect(await store.loadBootstrapHistory(nextRun)).toEqual([]);
      expect(await store.resolveRuntimeSessionId(nextRun)).toBe('native-session-root');
    } finally { await store.close(); }
  });
  it('allows only one active native submission per agent profile across sessions', async () => {
    const fx = await seedWorkspace(); const first = makeDb(fx); const second = makeDb(fx);
    try {
      const a = await seedRun(fx);
      const nextSession = await owner(fx, async (q) => {
        const { rows } = await q<{ id: string }>(`INSERT INTO sessions (workspace_id,owner_id,agent_id,title,model_id)
          VALUES ($1,$2,$3,'Second session','deepseek-flash') RETURNING id`, [fx.workspaceId,fx.adminId,fx.agentId]);
        return rows[0]!.id;
      });
      const b = await seedRun({ ...fx, sessionId: nextSession });
      const outcomes = await Promise.allSettled([first.snapshotRequest(a, 1, { input: 'a' }), second.snapshotRequest(b, 1, { input: 'b' })]);
      expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({ reason: { reason: 'runtime_profile_busy' } });
    } finally { await first.close(); await second.close(); }
  });
  it('lists only enabled OpenRouter catalog entries with the native chat transport', async () => {
    const fx = await seedWorkspace(); const store = makeDb(fx); const model = `openrouter:runtime-test/${crypto.randomUUID()}`;
    try {
      await withClient('owner', (c) => c.query(`INSERT INTO catalog (model_id,provider,label,transport,pricing_per_million,pricing_verified_on,context_length)
        VALUES ($1,'openrouter','Runtime test model','openrouter_chat','{}'::jsonb,now(),16384)`, [model]));
      expect(await store.allowedRuntimeModels()).toContainEqual({
        model_id: model, provider: 'openrouter', context_length: 16_384,
      });
      await withClient('owner', (c) => c.query('UPDATE catalog SET supports_tools=false WHERE model_id=$1', [model]));
      expect((await store.allowedRuntimeModels()).some((row) => row.model_id === model)).toBe(false);
    } finally {
      await store.close();
      await withClient('owner', (c) => c.query('DELETE FROM catalog WHERE model_id=$1', [model]));
    }
  });

  it('commits final results once and rolls back an interrupted finalization', async () => {
    const fx = await seedWorkspace(); const first = makeDb(fx); const second = makeDb(fx);
    try {
      const { id } = await mappedRun(fx, first);
      await expect(first.finalizeRuntime(id, 1, async () => {
        await first.addActiveMs(id, 99);
        throw new Error('interrupted final');
      })).rejects.toThrow('interrupted final');
      expect((await first.loadRun(id))?.activeMs).toBe(0);
      const results = await Promise.all([
        first.finalizeRuntime(id, 1, async () => { await first.addActiveMs(id, 50); await first.setRunStatus(id, 'completed'); return 'first'; }),
        second.finalizeRuntime(id, 1, async () => { await second.addActiveMs(id, 50); await second.setRunStatus(id, 'completed'); return 'second'; }),
      ]);
      expect(results.filter((result) => result !== null)).toHaveLength(1);
      expect((await first.loadRun(id))?.activeMs).toBe(50);
    } finally { await first.close(); await second.close(); }
  });
  it('carries only unapplied guidance into the next conversational run', async () => {
    const fx = await seedWorkspace(); const store = makeDb(fx);
    try {
      const { id } = await mappedRun(fx, store);
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      await owner(fx, (q) => q(`INSERT INTO messages (id,workspace_id,session_id,seq,role,text,status,kind,run_id) VALUES
        ($1,$3,$4,1,'user','Pending hint','streaming','guidance',$5),
        ($2,$3,$4,2,'user','Applied hint','complete','guidance',$5)`, [...ids,fx.workspaceId,fx.sessionId,id]));
      await store.carryGuidance(id, ids);
      const { rows } = await store.runtimeQuery<{ id: string; run_id: string | null }>('SELECT id,run_id FROM messages WHERE id=ANY($1::uuid[])', [ids]);
      expect(rows.find((row) => row.id === ids[0])?.run_id).toBeNull();
      expect(rows.find((row) => row.id === ids[1])?.run_id).toBe(id);
    } finally { await store.close(); }
  });

  it('bootstraps NULL-kind history in sequence while excluding current-run and future messages', async () => {
    const fx = await seedWorkspace(); const store = makeDb(fx);
    try {
      const id = await seedRun(fx); const run = (await store.loadRun(id))!;
      await owner(fx, (q) => q(
        `INSERT INTO messages (workspace_id,session_id,seq,role,text,status,kind,run_id,created_at) VALUES
          ($1,$2,2,'iris','Second in conversation','complete',NULL,NULL,now()-interval '2 minutes'),
          ($1,$2,1,'user','First in conversation','complete',NULL,NULL,now()-interval '1 minute'),
          ($1,$2,3,'user','Current run input','complete',NULL,$3,now()-interval '1 minute'),
          ($1,$2,4,'user','Future message','complete',NULL,NULL,now()+interval '1 minute'),
          ($1,$2,5,'system','Internal text','complete',NULL,NULL,now()-interval '1 minute'),
          ($1,$2,6,'user','Tagged guidance','complete','guidance',NULL,now()-interval '1 minute')`, [fx.workspaceId,fx.sessionId,id]));
      expect(await store.loadBootstrapHistory(run)).toEqual([
        { role: 'user', content: 'First in conversation' }, { role: 'assistant', content: 'Second in conversation' },
      ]);
    } finally { await store.close(); }
  });
  it('still bootstraps enterprise history when an earlier Hermes attempt never obtained a native run', async () => {
    const fx = await seedWorkspace(); const store = makeDb(fx);
    try {
      const old = await seedRun(fx);
      await owner(fx, async (q) => {
        await q("UPDATE runs SET status='error',runtime_kind='hermes',created_at=now()-interval '2 minutes' WHERE id=$1", [old]);
        await q(`INSERT INTO messages (workspace_id,session_id,seq,role,text,status,kind,run_id,created_at)
          VALUES ($1,$2,1,'user','Earlier question','complete',NULL,$3,now()-interval '1 minute')`, [fx.workspaceId,fx.sessionId,old]);
      });
      const id = await seedRun(fx);
      expect(await store.loadBootstrapHistory((await store.loadRun(id))!)).toEqual([{ role: 'user', content: 'Earlier question' }]);
    } finally { await store.close(); }
  });

});
