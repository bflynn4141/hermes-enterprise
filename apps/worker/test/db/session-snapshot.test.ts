import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { sessionSnapshotSchema } from '@hermes/shared';
import type { Env } from '../../src/env.js';
import type { Tx } from '../../src/db/client.js';
import { loadSessionSnapshot } from '../../src/domain/session-snapshot.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const admittedAt = '2026-09-19T10:00:00.000Z';
const executionAt = '2026-09-19T10:00:04.000Z';
type Seed = Fixture & { runId: string; messageId: string };
async function mutate<T>(fx: Fixture, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    try { const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  });
}
async function append(fx: Seed, tx: Tx, kind: string, payload: Record<string, unknown>, at = executionAt): Promise<string> {
  const row = await tx.query<{ id: string }>(
    `INSERT INTO stream_events(workspace_id,session_id,kind,payload,trace_id,created_at)
     VALUES($1,$2,$3,$4::jsonb,'snapshot-test',$5) RETURNING id::text`,
    [fx.workspaceId, fx.sessionId, kind, JSON.stringify({ run_id: fx.runId, ...payload }), at]);
  return row.rows[0]!.id;
}
async function fixture(): Promise<Seed> {
  const fx = { ...await seedWorkspace(), runId: randomUUID(), messageId: randomUUID() };
  await mutate(fx, async (tx) => {
    await tx.query(`INSERT INTO runs(id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,created_at,started_at)
      VALUES($1,$2,$3,$4,'working','deepseek-flash',$5,$6,$6)`,
    [fx.runId, fx.workspaceId, fx.sessionId, fx.agentId, randomUUID(), admittedAt]);
    await tx.query(`INSERT INTO messages(id,workspace_id,session_id,seq,role,text,status,run_id,turn)
      VALUES($1,$2,$3,1,'iris','','streaming',$4,0)`, [fx.messageId, fx.workspaceId, fx.sessionId, fx.runId]);
    await tx.query(`INSERT INTO messages(workspace_id,session_id,seq,role,text,run_id)
      VALUES($1,$2,0,'user','Keep the complete answer.',$3)`, [fx.workspaceId, fx.sessionId, fx.runId]);
  });
  return fx;
}
async function checkpoint(fx: Seed): Promise<string> {
  return mutate(fx, async (tx) => {
    await tx.query(`UPDATE runs SET runtime_request_attempt=1,runtime_started_at=$2 WHERE id=$1`, [fx.runId, executionAt]);
    const identity = { attempt: 1, turn: 0, step_attempt: 1, message_id: fx.messageId };
    await append(fx, tx, 'message.reset', identity);
    await append(fx, tx, 'message.delta', { ...identity, seq: 0, delta: 'saved ' });
    return append(fx, tx, 'message.delta', { ...identity, seq: 1, delta: 'prefix' });
  });
}
const path = (fx: Fixture) => `/w/${fx.workspaceId}/sessions/${fx.sessionId}/snapshot`;
async function get(fx: Fixture, env = makeEnv().env) {
  const response = await asUser(env, fx.adminId, path(fx));
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return sessionSnapshotSchema.parse(body);
}

describe('selected-session snapshot HTTP boundary', () => {
  it('hydrates before execution and after checkpoints without launching or subscribing to a provider', async () => {
    const fx = await fixture();
    const create = vi.fn();
    const { env, hubCalls } = makeEnv({ RUN_ATTEMPT: { create } as unknown as Env['RUN_ATTEMPT'] });
    const initial = await get(fx, env);
    expect(initial.run).toMatchObject({ id: fx.runId, attempt: 1, admitted_at: admittedAt, execution_started_at: null, started_at: admittedAt });
    expect(initial.stream).toBeNull();
    expect(initial.messages.items.map(message => message.role)).toEqual(['user', 'iris']);
    const watermark = await checkpoint(fx);
    const streaming = await get(fx, env);
    expect(streaming.run?.execution_started_at).toBe(executionAt);
    expect(streaming.stream).toMatchObject({ text: 'saved prefix', seq: 1, message_id: fx.messageId, status: 'streaming' });
    expect(streaming.watermark).toBe(watermark);
    expect(create).not.toHaveBeenCalled();
    expect(hubCalls).toEqual([]);
  });

  it('returns persisted final text while the terminal status is still pending', async () => {
    const fx = await fixture();
    await checkpoint(fx);
    await mutate(fx, tx => tx.query(`UPDATE messages SET text='saved prefix and final answer',status='complete' WHERE id=$1`, [fx.messageId]));
    const finalizing = await get(fx);
    expect(finalizing.run?.status).toBe('working');
    expect(finalizing.stream).toMatchObject({ text: 'saved prefix and final answer', status: 'final' });
  });

  it('preserves selected-session failures and blank incomplete messages across reload', async () => {
    const fx = await fixture();
    const error = { class: 'transient', retryable: true, reason: 'hermes_provider_rate_limited', message: 'The provider is rate limited.' };
    await mutate(fx, async tx => {
      await tx.query(`UPDATE runs SET status='error',error=$2::jsonb,ended_at=$3,recovery_not_before=$4 WHERE id=$1`,
        [fx.runId, JSON.stringify(error), executionAt, '2026-09-19T10:01:04.000Z']);
      await tx.query(`UPDATE messages SET status='incomplete' WHERE id=$1`, [fx.messageId]);
      const otherSession = randomUUID();
      await tx.query(`INSERT INTO sessions(id,workspace_id,owner_id,agent_id,title,model_id) VALUES($1,$2,$3,$4,'Other','deepseek-flash')`,
        [otherSession, fx.workspaceId, fx.adminId, fx.agentId]);
      await tx.query(`INSERT INTO runs(workspace_id,session_id,agent_id,status,model_id,client_turn_id)
        VALUES($1,$2,$3,'completed','deepseek-flash',$4)`, [fx.workspaceId, otherSession, fx.agentId, randomUUID()]);
    });
    const snapshot = await get(fx);
    expect(snapshot.run).toMatchObject({ id: fx.runId, status: 'error', error });
    expect(snapshot.recovery?.not_before).toBe('2026-09-19T10:01:04.000Z');
    expect(snapshot.messages.items[1]).toMatchObject({ id: fx.messageId, status: 'incomplete', incomplete: true, text: '' });
    const history = await asUser(makeEnv().env, fx.adminId, `/w/${fx.workspaceId}/sessions/${fx.sessionId}/messages`);
    expect(await history.json()).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ id: fx.messageId, incomplete: true })]) });
  });

  it('starts a newer admitted retry clock without hydrating the old attempt prefix or execution time', async () => {
    const fx = await fixture();
    await checkpoint(fx);
    const retryAt = '2026-09-19T10:02:00.000Z';
    await mutate(fx, async tx => {
      await tx.query(`INSERT INTO run_steps(workspace_id,run_id,step_id,label,state,started_at)
        VALUES($1,$2,'old-step','Old attempt','failed',$3)`, [fx.workspaceId, fx.runId, executionAt]);
      await tx.query(`UPDATE runs SET attempt=2 WHERE id=$1`, [fx.runId]);
      await append(fx, tx, 'run.status', { attempt: 2, status: 'working' }, retryAt);
    });
    const retry = await get(fx);
    expect(Date.parse(retry.run!.admitted_at)).toBe(Date.parse(retryAt));
    expect(retry.run).toMatchObject({ attempt: 2, execution_started_at: null, steps: [] });
    expect(retry.stream).toBeNull();
  });

  it('carries the title\'s provenance, so a reload cannot mistake a turn-named session for a person\'s', async () => {
    // The seeded session was inserted with a real title and no provenance,
    // which the insert trigger records as a person's (migration 0065).
    const fx = await fixture();
    const snapshot = await get(fx);
    expect(snapshot.session.title).toBe('Partner applications');
    expect(snapshot.session.title_source).toBe('manual');
  });

  it('preserves session-owner hydration after agent reassignment without granting the agent owner or another tenant access', async () => {
    const fx = await fixture();
    const other = await fixture();
    const { env } = makeEnv();
    await checkpoint(fx);
    await mutate(fx, async tx => {
      await tx.query(`INSERT INTO session_shares(workspace_id,session_id,created_by,token_hash,audience,message_cutoff_seq)
        VALUES($1,$2,$3,$4,'link',10)`, [fx.workspaceId, fx.sessionId, fx.adminId, randomUUID()]);
    });
    expect((await asUser(env, fx.memberId, path(fx))).status).toBe(404);
    expect((await asUser(env, other.adminId, path(fx))).status).toBe(404);
    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/sessions/${other.sessionId}/snapshot`)).status).toBe(404);
    await mutate(fx, tx => tx.query(`INSERT INTO agent_owners(workspace_id,agent_id,member_id)
      SELECT $1,$2,id FROM members WHERE workspace_id=$1 AND user_id=$3`, [fx.workspaceId, fx.agentId, fx.memberId]));
    const owned = await get(fx, env);
    expect(owned.session.id).toBe(fx.sessionId);
    expect(owned.run?.id).toBe(fx.runId);
    expect(owned.stream?.text).toBe('saved prefix');
    expect((await asUser(env, fx.memberId, path(fx))).status).toBe(404);
    expect((await asUser(env, other.adminId, path(fx))).status).toBe(404);
    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/sessions/${other.sessionId}/snapshot`)).status).toBe(404);
  });

  it('hydrates pending and applied guidance independently of the latest fifty messages', async () => {
    const fx = await fixture();
    const guidanceId = randomUUID();
    await mutate(fx, async tx => {
      await tx.query(`INSERT INTO messages(id,workspace_id,session_id,seq,role,kind,text,status,run_id)
        VALUES($1,$2,$3,3,'user','guidance','Keep the original scope.','streaming',$4),
          (gen_random_uuid(),$2,$3,2,'user','guidance','Earlier instruction.','complete',$4)`,
      [guidanceId, fx.workspaceId, fx.sessionId, fx.runId]);
      await tx.query(`INSERT INTO messages(workspace_id,session_id,seq,role,text,status)
        SELECT $1,$2,seq,'system','Later transcript entry','complete' FROM generate_series(4,56) seq`,
      [fx.workspaceId, fx.sessionId]);
    });
    const pending = await get(fx);
    expect(pending.messages.items).toHaveLength(50);
    expect(pending.messages.items.some(message => message.id === guidanceId)).toBe(false);
    expect(pending.run?.guidance).toEqual({ id: guidanceId, text: 'Keep the original scope.', status: 'pending' });
    await mutate(fx, tx => tx.query("UPDATE messages SET status='complete' WHERE id=$1", [guidanceId]));
    const applied = await get(fx);
    expect(applied.run?.guidance).toEqual({ id: guidanceId, text: 'Keep the original scope.', status: 'applied' });
  });

  it('hydrates only carried guidance eligible when the selected run was admitted', async () => {
    const fx = await fixture();
    const carriedId = randomUUID();
    await mutate(fx, async tx => {
      await tx.query(`INSERT INTO messages(id,workspace_id,session_id,seq,role,kind,text,status,created_at)
        VALUES($1,$2,$3,2,'user','guidance','Carried instruction.','streaming',$4::timestamptz-interval '1 second')`,
      [carriedId, fx.workspaceId, fx.sessionId, admittedAt]);
      await tx.query(`INSERT INTO messages(workspace_id,session_id,seq,role,kind,text,status,created_at)
        VALUES($1,$2,3,'user','guidance','For the next run.','streaming',$3::timestamptz+interval '1 second')`,
      [fx.workspaceId, fx.sessionId, admittedAt]);
      await tx.query(`INSERT INTO messages(workspace_id,session_id,seq,role,kind,text,status,run_id)
        VALUES($1,$2,4,'user','guidance','Another run instruction.','streaming',$3)`,
      [fx.workspaceId, fx.sessionId, randomUUID()]);
    });
    const snapshot = await get(fx);
    expect(snapshot.run?.guidance).toEqual({ id: carriedId, text: 'Carried instruction.', status: 'pending' });
  });

  it('uses one SQL visibility boundary even when another commit lands before serialization', async () => {
    const fx = await fixture();
    const watermark = await checkpoint(fx);
    const { env } = makeEnv();
    let statements = 0;
    const snapshot = await readTenant(fx.workspaceId, fx.adminId, async tx => loadSessionSnapshot({
      async query<T extends import('pg').QueryResultRow>(sql: string, values?: readonly unknown[]) {
        statements += 1;
        const result = await tx.query<T>(sql, values ? [...values] : undefined);
        await mutate(fx, async writer => {
          await writer.query(`UPDATE messages SET text='new final',status='complete' WHERE id=$1`, [fx.messageId]);
          await writer.query(`UPDATE runs SET status='completed' WHERE id=$1`, [fx.runId]);
          await append(fx, writer, 'run.status', { attempt: 1, status: 'completed' });
        });
        return result;
      },
    }, env, fx.workspaceId, fx.adminId, fx.sessionId));
    expect(statements).toBe(1);
    expect(snapshot.watermark).toBe(watermark);
    expect(snapshot.run?.status).toBe('working');
    expect(snapshot.stream?.text).toBe('saved prefix');
    const newer = await get(fx);
    expect(newer.run?.status).toBe('completed');
    expect(newer.stream?.text).toBe('new final');
    expect(BigInt(newer.watermark)).toBeGreaterThan(BigInt(snapshot.watermark));
  });

  it('repairs a late lower-id checkpoint on a repeated snapshot even when the head is unchanged', async () => {
    const fx = await fixture();
    await checkpoint(fx);
    await withClient('owner', async delayed => {
      await delayed.query('BEGIN');
      await setTenant(delayed, fx.workspaceId, fx.adminId);
      try {
        const lowId = await append(fx, delayed, 'message.delta', {
          attempt: 1, turn: 0, step_attempt: 1, message_id: fx.messageId, seq: 2, delta: ' repaired',
        });
        const highId = await mutate(fx, tx => append(fx, tx, 'run.step', {
          attempt: 1, turn: 0, step_id: 'later', label: 'Later event', state: 'done',
        }));
        expect(BigInt(highId)).toBeGreaterThan(BigInt(lowId));
        const before = await get(fx);
        expect(before.watermark).toBe(highId);
        expect(before.stream?.text).toBe('saved prefix');
        await delayed.query('COMMIT');
        const after = await get(fx);
        expect(after.watermark).toBe(before.watermark);
        expect(after.stream).toMatchObject({ text: 'saved prefix repaired', seq: 2 });
      } catch (error) { await delayed.query('ROLLBACK'); throw error; }
    });
  });
});
