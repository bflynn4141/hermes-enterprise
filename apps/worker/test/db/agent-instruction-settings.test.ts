// Real tenant routes and run admission: edits cannot cross agents or rewrite
// an in-flight prompt. No provider calls are needed for this boundary.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import type { Env } from '../../src/env.js';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import { APP_URL, AGENT_URL } from '../../scripts/db-config.mjs';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const origin = 'https://hermes.test';
const env = { ENVIRONMENT: 'test', AUTH_MODE: 'fake', MODEL_GATEWAY_MODE: 'off', ENGINE_PAUSED: '0', ALLOWED_ORIGINS: origin, HYPERDRIVE_APP: { connectionString: APP_URL }, HYPERDRIVE_AGENT: { connectionString: AGENT_URL } } as unknown as Env;
const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
const call = (fx: Fixture, path: string, user = fx.adminId, body?: unknown) => worker.fetch(new Request(`${origin}/w/${fx.workspaceId}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-dev-user': user, origin, 'content-type': 'application/json', 'x-requested-from': 'skills' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env, ctx);
const save = (fx: Fixture, text: string, expected: string | null = null, agent = fx.agentId, user = fx.adminId) => call(fx, `/instructions?agent_id=${agent}`, user, { text, expected_current_id: expected });

async function addAgent(fx: Fixture): Promise<string> {
  const id = randomUUID();
  await withClient('owner', async (db) => { await db.query('BEGIN'); await setTenant(db, fx.workspaceId, fx.adminId); await db.query(`INSERT INTO agents(id,workspace_id,name,status) VALUES($1,$2,'Other agent','started')`, [id, fx.workspaceId]); await db.query('COMMIT'); });
  return id;
}

describe('selected-agent standing instructions', () => {
  it('appends saved versions with human provenance and refuses stale or member edits', async () => {
    const fx = await seedWorkspace();
    expect((await save(fx, 'Review evidence.', null, fx.agentId, fx.memberId)).status).toBe(403);
    const first = await save(fx, 'Review evidence.');
    expect(first.status).toBe(201);
    const version = await first.json() as { id: string; provenance: string };
    expect(version.provenance).toContain('Maya Chen');
    expect((await save(fx, 'Stale edit.')).status).toBe(409);
    expect((await save(fx, 'Updated instruction.', version.id)).status).toBe(201);
    const listed = await call(fx, `/instructions?agent_id=${fx.agentId}`, fx.memberId);
    const page = await listed.json() as { items: { text: string; state: string }[] };
    expect(page.items.filter((row) => row.state === 'current')).toEqual([expect.objectContaining({ text: 'Updated instruction.' })]);
    expect(page.items.some((row) => row.text === 'Review evidence.' && row.state === 'saved')).toBe(true);
  });

  it('isolates agent lists and writes, and rejects foreign-workspace agents', async () => {
    const fx = await seedWorkspace();
    const other = await addAgent(fx);
    await save(fx, 'Iris instruction.');
    const saved = await save(fx, 'Other instruction.', null, other);
    expect(saved.status).toBe(201);
    const list = await call(fx, `/instructions?agent_id=${other}`);
    expect(await list.json()).toMatchObject({ items: [expect.objectContaining({ text: 'Other instruction.' })], total: 1 });
    const foreign = await seedWorkspace();
    expect((await save(fx, 'Must not cross.', null, foreign.agentId)).status).toBe(404);
    expect((await call(fx, `/instructions?agent_id=${foreign.agentId}`)).status).toBe(404);
  });

  it('permits exactly one concurrent edit against the same version', async () => {
    const fx = await seedWorkspace();
    const responses = await Promise.all([save(fx, 'First edit.'), save(fx, 'Second edit.')]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  });

  it('captures instructions on admission and keeps an earlier run unchanged after editing', async () => {
    const fx = await seedWorkspace();
    const first = await save(fx, 'First prompt.');
    const version = await first.json() as { id: string };
    const runId = randomUUID();
    await withClient('owner', async (db) => { await db.query('BEGIN'); await setTenant(db, fx.workspaceId, fx.adminId); await db.query(`INSERT INTO runs(id,workspace_id,session_id,agent_id,status,model_id,client_turn_id) VALUES($1,$2,$3,$4,'completed','deepseek-flash','first')`, [runId, fx.workspaceId, fx.sessionId, fx.agentId]); await db.query('COMMIT'); });
    expect((await save(fx, 'Second prompt.', version.id)).status).toBe(201);
    const runtime = new PgAgentDb(env, fx.workspaceId, 'instruction-snapshot');
    try { expect(await runtime.loadSystemPrompt(runId)).toBe('First prompt.'); } finally { await runtime.close(); }
    await withClient('owner', async (db) => {
      await db.query('BEGIN'); await setTenant(db, fx.workspaceId, fx.adminId);
      const old = await db.query('SELECT instruction_snapshot,instruction_version_id FROM runs WHERE id=$1', [runId]);
      expect(old.rows[0]).toEqual({ instruction_snapshot: 'First prompt.', instruction_version_id: version.id });
      const next = await db.query(`INSERT INTO runs(workspace_id,session_id,agent_id,status,model_id,client_turn_id) VALUES($1,$2,$3,'completed','deepseek-flash','second') RETURNING instruction_snapshot`, [fx.workspaceId, fx.sessionId, fx.agentId]);
      expect(next.rows[0].instruction_snapshot).toBe('Second prompt.');
      await db.query('ROLLBACK');
    });
  });

  it('rejects blank/oversized content and an explicit cross-agent version snapshot', async () => {
    const fx = await seedWorkspace();
    expect((await save(fx, ' ')).status).toBe(400);
    expect((await save(fx, 'x'.repeat(8001))).status).toBe(400);
    const other = await addAgent(fx);
    const saved = await save(fx, 'Other prompt.', null, other);
    const version = await saved.json() as { id: string };
    await withClient('owner', async (db) => { await db.query('BEGIN'); await setTenant(db, fx.workspaceId, fx.adminId); await expect(db.query(`INSERT INTO runs(workspace_id,session_id,agent_id,status,model_id,instruction_version_id) VALUES($1,$2,$3,'completed','deepseek-flash',$4)`, [fx.workspaceId, fx.sessionId, fx.agentId, version.id])).rejects.toMatchObject({ code: '23514' }); await db.query('ROLLBACK'); });
  });
});
