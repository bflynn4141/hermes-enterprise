// Runtime elapsed time must exclude durable human waits on unchanged agent grants.
// Timestamped fixtures avoid sleeps and prove accounting survives execution retry.
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { RuntimeDb } from '../../src/runtime/store.js';
import { AGENT_URL, APP_URL } from '../../scripts/db-config.mjs';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const env = {
  ENVIRONMENT: 'test', ENGINE_VERSION: '1',
  HYPERDRIVE_APP: { connectionString: APP_URL }, HYPERDRIVE_AGENT: { connectionString: AGENT_URL },
} as unknown as Env;
const start = Date.parse('2026-01-01T00:00:00.000Z');
const end = start + 10_000;
async function update(fx: Fixture, runId: string, changes: string, values: unknown[] = []): Promise<void> {
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    await client.query(`UPDATE runs SET ${changes} WHERE id=$1`, [runId, ...values]);
    await client.query('COMMIT');
  });
}
async function fixture(): Promise<{ fx: Fixture; runId: string; store: RuntimeDb }> {
  const fx = await seedWorkspace();
  const runId = await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO runs (workspace_id,session_id,agent_id,status,model_id,client_turn_id,mode,
         runtime_kind,runtime_profile,runtime_request_attempt,runtime_attempt,runtime_started_at)
       VALUES ($1,$2,$3::uuid,'working','deepseek-flash',$4,'work','hermes','agent-' || ($3::uuid)::text,1,1,$5) RETURNING id`,
      [fx.workspaceId, fx.sessionId, fx.agentId, crypto.randomUUID(), new Date(start)]);
    await client.query('COMMIT');
    return rows[0]!.id;
  });
  return { fx, runId, store: new RuntimeDb(env, fx.workspaceId, 'trace-runtime-accounting') };
}
async function clock(store: RuntimeDb, runId: string): Promise<{ start: Date | null; wait: Date | null; ms: string }> {
  const { rows } = await store.runtimeQuery<{ start: Date | null; wait: Date | null; ms: string }>(
    'SELECT runtime_started_at AS start,runtime_wait_started_at AS wait,runtime_wait_ms AS ms FROM runs WHERE id=$1', [runId]);
  return rows[0]!;
}

describe('official runtime active-time accounting', () => {
  it('can calculate a fully active interval using the unchanged agent-role grants', async () => {
    const { runId, store } = await fixture();
    try { expect(await store.activeRuntimeMs(runId, 1, start, end)).toBe(10_000); }
    finally { await store.close(); }
  });
  it('subtracts accumulated completed human waits', async () => {
    const { fx, runId, store } = await fixture();
    try {
      await update(fx, runId, 'runtime_wait_ms=5000');
      expect(await store.activeRuntimeMs(runId, 1, start, end)).toBe(5_000);
    } finally { await store.close(); }
  });
  it('subtracts an unanswered wait through the measurement end as well as previous waits', async () => {
    const { fx, runId, store } = await fixture();
    try {
      await update(fx, runId, 'runtime_wait_ms=1000,runtime_wait_started_at=$2', [new Date(start + 3_000)]);
      expect(await store.activeRuntimeMs(runId, 1, start, end)).toBe(2_000);
    } finally { await store.close(); }
  });
  it('uses only this tenant run and current attempt', async () => {
    const { fx, runId, store } = await fixture();
    const other = await seedWorkspace();
    const foreign = new RuntimeDb(env, other.workspaceId, 'trace-runtime-accounting-foreign');
    try {
      await update(fx, runId, 'runtime_wait_ms=3000');
      expect(await store.activeRuntimeMs(runId, 1, start, end)).toBe(7_000);
      expect(await store.activeRuntimeMs(runId, 2, start, end)).toBe(0);
      expect(await store.activeRuntimeMs(crypto.randomUUID(), 1, start, end)).toBe(0);
      expect(await foreign.activeRuntimeMs(runId, 1, start, end)).toBe(0);
      await update(fx, runId, 'attempt=2');
      expect(await store.activeRuntimeMs(runId, 1, start, end)).toBe(0);
      expect(await store.activeRuntimeMs(runId, 2, start, end)).toBe(0);
    } finally { await store.close(); await foreign.close(); }
  });
  it('keeps the original attempt duration when execution retries during an existing human wait', async () => {
    const { fx, runId, store } = await fixture();
    try {
      await update(fx, runId, 'runtime_wait_started_at=$2', [new Date(start + 3_000)]);
      expect(await store.activeRuntimeMs(runId, 1, start + 8_000, end)).toBe(3_000);
      await update(fx, runId, 'runtime_wait_started_at=NULL,runtime_wait_ms=3000');
      expect(await store.activeRuntimeMs(runId, 1, start + 8_000, end)).toBe(7_000);
    } finally { await store.close(); }
  });
  it('falls back to the supplied start for mapped runs predating the durable clock', async () => {
    const { fx, runId, store } = await fixture();
    try {
      await update(fx, runId, 'runtime_started_at=NULL');
      expect(await store.activeRuntimeMs(runId, 1, start + 2_000, end)).toBe(8_000);
      expect(await store.activeRuntimeMs(runId, 1, end + 1_000, end)).toBe(0);
    } finally { await store.close(); }
  });
  it('records repeated wait polls once and accumulates each resumed wait only once', async () => {
    const { fx, runId, store } = await fixture();
    try {
      await store.startRuntimeWait(runId, 1);
      const first = await clock(store, runId);
      expect(first.wait).not.toBeNull();
      await store.startRuntimeWait(runId, 1);
      expect((await clock(store, runId)).wait).toEqual(first.wait);
      await store.endRuntimeWait(runId, 2);
      expect((await clock(store, runId)).wait).toEqual(first.wait);
      await update(fx, runId, "runtime_wait_started_at=clock_timestamp()-interval '1 second'");
      await store.endRuntimeWait(runId, 1);
      const resumed = await clock(store, runId);
      expect(resumed.wait).toBeNull();
      expect(Number(resumed.ms)).toBeGreaterThanOrEqual(1_000);
      await store.endRuntimeWait(runId, 1);
      expect((await clock(store, runId)).ms).toBe(resumed.ms);
      await store.startRuntimeWait(runId, 1);
      await update(fx, runId, "runtime_wait_started_at=clock_timestamp()-interval '1 second'");
      await store.endRuntimeWait(runId, 1);
      expect(Number((await clock(store, runId)).ms)).toBeGreaterThanOrEqual(Number(resumed.ms) + 1_000);
    } finally { await store.close(); }
  });
  it('preserves the attempt clock on submission replay and resets it only for a new attempt', async () => {
    const { fx, runId, store } = await fixture();
    try {
      await update(fx, runId, 'runtime_wait_ms=2000');
      await store.snapshotRequest(runId, 1, { input: 'First submission' });
      expect(await clock(store, runId)).toEqual({ start: new Date(start), wait: null, ms: '2000' });
      await store.snapshotRequest(runId, 1, { input: 'Changed proposal' });
      expect((await clock(store, runId)).start).toEqual(new Date(start));
      await update(fx, runId, 'attempt=2,runtime_wait_started_at=$2', [new Date(start + 2_000)]);
      await store.snapshotRequest(runId, 2, { input: 'Retry submission' });
      const next = await clock(store, runId);
      expect(next.start!.getTime()).toBeGreaterThan(start);
      expect(next.wait).toBeNull();
      expect(next.ms).toBe('0');
      expect(await store.activeRuntimeMs(runId, 1, start, end)).toBe(0);
    } finally { await store.close(); }
  });
  it('rolls back the wait clock with an interrupted callback transaction', async () => {
    const { fx, runId, store } = await fixture();
    try {
      await expect(store.withCallLock(fx.agentId, async () => {
        await store.startRuntimeWait(runId, 1);
        throw new Error('interrupted waiting callback');
      })).rejects.toThrow('interrupted waiting callback');
      expect(await clock(store, runId)).toEqual({ start: new Date(start), wait: null, ms: '0' });
    } finally { await store.close(); }
  });
});
