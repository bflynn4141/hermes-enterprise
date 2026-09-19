import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const original = { model_id: 'deepseek-flash', effort: null };
async function fixture() {
  const fx = await seedWorkspace();
  const modelId = `session-test-${randomUUID()}`;
  await withClient('owner', async client => {
    await client.query(`INSERT INTO catalog(model_id,provider,label,transport,effort_map,default_effort,pricing_per_million,pricing_verified_on)
      SELECT $1,provider,'Session test',transport,'{"low":"low","high":"high"}'::jsonb,'low',pricing_per_million,pricing_verified_on
      FROM catalog WHERE model_id='deepseek-flash'`, [modelId]);
  });
  const create = vi.fn().mockResolvedValue({ id: 'recorded' });
  const { env } = makeEnv({ MODEL_SCRIPTED: '1', RUN_ATTEMPT: { create } as unknown as Env['RUN_ATTEMPT'] });
  return { ...fx, modelId, create, env };
}
const path = (fx: Fixture) => `/w/${fx.workspaceId}/sessions/${fx.sessionId}`;

describe('confirmed model and effort admission', () => {
  it('saves model and validated effort together and rejects unsupported effort without changing either', async () => {
    const fx = await fixture();
    const changed = { model_id: fx.modelId, effort: 'high' };
    const saved = await asUser(fx.env, fx.adminId, path(fx), { method: 'PATCH', body: { ...changed, expected_settings: original } });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject(changed);
    const invalid = await asUser(fx.env, fx.adminId, path(fx), { method: 'PATCH', body: { effort: 'made-up', expected_settings: changed } });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ reason: 'invalid_effort' });
    expect(await (await asUser(fx.env, fx.adminId, path(fx))).json()).toMatchObject(changed);
    const unsupported = await asUser(fx.env, fx.adminId, path(fx), { method: 'PATCH', body: { model_id: original.model_id, effort: 'unsupported-effort' } });
    expect(unsupported.status).toBe(422);
  });

  it('rejects one competing stale settings mutation instead of silently overwriting the confirmed choice', async () => {
    const fx = await fixture();
    const responses = await Promise.all(['low', 'high'].map(effort => asUser(fx.env, fx.adminId, path(fx), {
      method: 'PATCH', body: { model_id: fx.modelId, effort, expected_settings: original },
    })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const accepted = await responses.find(response => response.status === 200)!.json() as { effort: string };
    const refused = await responses.find(response => response.status === 409)!.json();
    expect(refused).toMatchObject({ reason: 'settings_changed' });
    expect(await (await asUser(fx.env, fx.adminId, path(fx))).json()).toMatchObject({ model_id: fx.modelId, effort: accepted.effort });
  });

  it('refuses Send with stale settings before admitting a run or invoking a provider', async () => {
    const fx = await fixture();
    const response = await asUser(fx.env, fx.adminId, `${path(fx)}/turns`, { method: 'POST', body: {
      client_turn_id: randomUUID(), text: 'Use the confirmed model.', expected_settings: { model_id: fx.modelId, effort: 'high' },
    } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'settings_changed' });
    expect(fx.create).not.toHaveBeenCalled();
    await readTenant(fx.workspaceId, fx.adminId, async tx => {
      expect((await tx.query(`SELECT count(*)::int AS count FROM runs WHERE session_id=$1`, [fx.sessionId])).rows[0]?.count).toBe(0);
      expect((await tx.query(`SELECT count(*)::int AS count FROM messages WHERE session_id=$1`, [fx.sessionId])).rows[0]?.count).toBe(0);
    });
  });

  it('admits the confirmed model and effort once, preserving duplicate-turn identity after settings change', async () => {
    const fx = await fixture();
    const chosen = { model_id: fx.modelId, effort: 'high' };
    expect((await asUser(fx.env, fx.adminId, path(fx), { method: 'PATCH', body: { ...chosen, expected_settings: original } })).status).toBe(200);
    const body = { client_turn_id: randomUUID(), text: 'Use the confirmed model.', expected_settings: chosen };
    const sent = await asUser(fx.env, fx.adminId, `${path(fx)}/turns`, { method: 'POST', body });
    expect(sent.status, JSON.stringify(await sent.clone().json())).toBe(201);
    const first = await sent.json() as { run_id: string };
    await readTenant(fx.workspaceId, fx.adminId, async tx => {
      expect((await tx.query(`SELECT model_id,effort FROM runs WHERE id=$1`, [first.run_id])).rows[0]).toEqual(chosen);
    });
    expect((await asUser(fx.env, fx.adminId, path(fx), { method: 'PATCH', body: { effort: 'low', expected_settings: chosen } })).status).toBe(200);
    const duplicate = await asUser(fx.env, fx.adminId, `${path(fx)}/turns`, { method: 'POST', body });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ run_id: first.run_id });
    expect(fx.create).toHaveBeenCalledTimes(1);
  });

  it('guards Retry settings while allowing an already admitted attempt to replay idempotently', async () => {
    const fx = await fixture();
    const runId = randomUUID();
    await withClient('owner', async client => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(`INSERT INTO runs(id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,error,ended_at)
        VALUES($1,$2,$3,$4,'error','deepseek-flash',$5,'{"class":"transient","retryable":true,"reason":"timeout","message":"Try again"}',now())`,
      [runId, fx.workspaceId, fx.sessionId, fx.agentId, randomUUID()]);
      await client.query('COMMIT');
    });
    const retryPath = `${path(fx)}/runs/${runId}/retry`;
    const stale = await asUser(fx.env, fx.adminId, retryPath, { method: 'POST', body: {
      expected_attempt: 1, expected_settings: { model_id: fx.modelId, effort: 'high' },
    } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ reason: 'settings_changed' });
    expect(fx.create).not.toHaveBeenCalled();
    const retried = await asUser(fx.env, fx.adminId, retryPath, { method: 'POST', body: { expected_attempt: 1, expected_settings: original } });
    expect(retried.status, JSON.stringify(await retried.clone().json())).toBe(201);
    expect(await retried.json()).toMatchObject({ run_id: runId, attempt: 2 });
    const duplicate = await asUser(fx.env, fx.adminId, retryPath, { method: 'POST', body: {
      expected_attempt: 1, expected_settings: { model_id: fx.modelId, effort: 'high' },
    } });
    expect(duplicate.status).toBe(201);
    expect(await duplicate.json()).toMatchObject({ run_id: runId, attempt: 2 });
    expect(fx.create).toHaveBeenCalledTimes(1);
  });

  it('waits for the retry agent lock before holding the session lock used by settings changes', async () => {
    const fx = await fixture();
    await withClient('owner', async retry => {
      await retry.query('BEGIN');
      await setTenant(retry, fx.workspaceId, fx.adminId);
      // This is the first lock taken by manual and scheduled Retry. Send must
      // wait here before it can lock the session, or the two admissions cycle.
      await retry.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [fx.agentId]);
      const sending = asUser(fx.env, fx.adminId, `${path(fx)}/turns`, { method: 'POST', body: {
        client_turn_id: randomUUID(), text: 'After Retry releases its admission lock.', expected_settings: original,
      } });
      try {
        // Wait for the actual blocked Send query, not an arbitrary sleep.
        let blocked = false;
        for (let tries = 0; tries < 100; tries += 1) {
          const observed = await retry.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_locks
            WHERE locktype='transactionid' AND NOT granted AND transactionid::text=pg_current_xact_id()::text`);
          if ((observed.rows[0]?.count ?? 0) > 0) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(blocked).toBe(true);
        await withClient('owner', async editor => {
          await editor.query('BEGIN');
          await setTenant(editor, fx.workspaceId, fx.adminId);
          await editor.query("SET LOCAL lock_timeout='250ms'");
          await editor.query("UPDATE sessions SET title='Concurrent edit' WHERE id=$1", [fx.sessionId]);
          await editor.query('COMMIT');
        });
      } finally { await retry.query('COMMIT'); }
      const sent = await sending;
      expect(sent.status, JSON.stringify(await sent.clone().json())).toBe(201);
    });
  });

  it('returns a concurrent duplicate after its session-lock wait before applying a newly reached run cap', async () => {
    const fx = await fixture();
    const clientTurnId = randomUUID();
    const runId = randomUUID();
    await withClient('owner', async first => {
      await first.query('BEGIN');
      await setTenant(first, fx.workspaceId, fx.adminId);
      await first.query('UPDATE workspace_settings SET max_concurrent_runs=1 WHERE workspace_id=$1', [fx.workspaceId]);
      await first.query('UPDATE sessions SET next_seq=next_seq+1 WHERE id=$1', [fx.sessionId]);
      await first.query(`INSERT INTO runs(id,workspace_id,session_id,agent_id,status,model_id,client_turn_id)
        VALUES($1,$2,$3,$4,'working','deepseek-flash',$5)`, [runId, fx.workspaceId, fx.sessionId, fx.agentId, clientTurnId]);
      const duplicate = asUser(fx.env, fx.adminId, `${path(fx)}/turns`, { method: 'POST', body: {
        client_turn_id: clientTurnId, text: 'The same submitted turn.', expected_settings: original,
      } });
      try {
        let blocked = false;
        for (let tries = 0; tries < 100; tries += 1) {
          const observed = await first.query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_locks
            WHERE locktype='transactionid' AND NOT granted AND transactionid::text=pg_current_xact_id()::text`);
          if ((observed.rows[0]?.count ?? 0) > 0) { blocked = true; break; }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(blocked).toBe(true);
      } finally { await first.query('COMMIT'); }
      const response = await duplicate;
      expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
      expect(await response.json()).toMatchObject({ run_id: runId });
      expect(fx.create).not.toHaveBeenCalled();
    });
  });
});
