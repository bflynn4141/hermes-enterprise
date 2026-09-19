// Exercise real tenant routes, revision races and admission snapshots.
import { beforeEach, expect, it } from 'vitest';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, withClient, setTenant, type Fixture } from './helpers.js';
import { captureContext } from '../../src/context-snapshot.js';
import type { TenantWork } from '../../src/routes/tenant.js';
import { FakeR2 } from '../stubs/fake-r2.js';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../src/env.js';
let fx: Fixture;
const bucket = new FakeR2();
const env = makeEnv({ UPLOADS: bucket as unknown as R2Bucket }).env;
beforeEach(async () => {
  fx = await seedWorkspace();
});
const path = () => `/w/${fx.workspaceId}/agents/${fx.agentId}/context-notes`;
it('admin saves provenance, member can read but cannot write, and stale edits cannot overwrite', async () => {
  const member = await asUser(env, fx.memberId, path(), {
    method: 'POST',
    body: { title: 'Territory', text: 'Europe' },
  });
  expect(member.status).toBe(403);
  const added = await asUser(env, fx.adminId, path(), { method: 'POST', body: { title: 'Territory', text: 'Europe' } });
  expect(added.status).toBe(201);
  const note = (await added.json()) as { id: string };
  const read = await asUser(env, fx.memberId, path());
  expect(await read.json()).toMatchObject({
    items: [{ title: 'Territory', revision: 1, author_id: fx.adminId, origin: 'human' }],
  });
  const updated = await asUser(env, fx.adminId, `${path()}/${note.id}`, {
    method: 'PATCH',
    body: { title: 'Territory', text: 'Canada', expected_revision: 1 },
  });
  expect(updated.status).toBe(200);
  const stale = await asUser(env, fx.adminId, `${path()}/${note.id}`, {
    method: 'DELETE',
    body: { expected_revision: 1 },
  });
  expect(stale.status).toBe(409);
  const other = await seedWorkspace();
  const forged = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${other.agentId}/context-notes`, {
    method: 'POST',
    body: { title: 'Forged', text: 'No' },
  });
  expect(forged.status).toBe(404);
});
it('binds only selected ready sources by hash and rejects changed, missing and oversized sources', async () => {
  await withClient('owner', async (db) => {
    await db.query('BEGIN');
    await setTenant(db, fx.workspaceId, fx.adminId);
    const source = randomUUID(),
      hash = 'a'.repeat(64),
      key = `w/${fx.workspaceId}/uploads/${source}`;
    await db.query(
      `INSERT INTO agent_files(id,workspace_id,agent_id,name,storage_key,size_bytes,mime,sha256,extraction_status,text_length) VALUES($1,$2,$3,'rubric', $4,20,'text/plain',$5,'ready',20)`,
      [source, fx.workspaceId, fx.agentId, key, hash],
    );
    await bucket.put(`${key}.txt`, 'Checked fact: blue.');
    const work = { tx: db, workspaceId: fx.workspaceId } as unknown as TenantWork;
    expect(await captureContext(work, env, fx.agentId, [])).toMatchObject({ sources: [] });
    expect(
      await captureContext(work, env, fx.agentId, [{ id: source, kind: 'agent_file', sha256: hash }]),
    ).toMatchObject({ sources: [{ id: source, sha256: hash, text: 'Checked fact: blue.' }] });
    await expect(
      captureContext(work, env, fx.agentId, [{ id: source, kind: 'agent_file', sha256: 'b'.repeat(64) }]),
    ).rejects.toMatchObject({ reason: 'context_source_changed' });
    await expect(
      captureContext(work, env, randomUUID(), [{ id: source, kind: 'agent_file', sha256: hash }]),
    ).rejects.toMatchObject({ reason: 'context_source_missing' });
    await db.query("UPDATE agent_files SET extraction_status='failed' WHERE id=$1", [source]);
    await expect(
      captureContext(work, env, fx.agentId, [{ id: source, kind: 'agent_file', sha256: hash }]),
    ).rejects.toMatchObject({ reason: 'context_source_unready' });
    await db.query("UPDATE agent_files SET extraction_status='ready' WHERE id=$1", [source]);
    await db.query('UPDATE agent_files SET text_length=24001 WHERE id=$1', [source]);
    await expect(
      captureContext(work, env, fx.agentId, [{ id: source, kind: 'agent_file', sha256: hash }]),
    ).rejects.toMatchObject({ reason: 'context_source_budget' });
    await db.query('ROLLBACK');
  });
});
it('snapshots notes at every run admission, then preserves the old revision after edit', async () => {
  const added = await asUser(env, fx.adminId, path(), { method: 'POST', body: { title: 'Region', text: 'Europe' } });
  const note = (await added.json()) as { id: string };
  const run = randomUUID();
  await withClient('owner', async (db) => {
    await db.query('BEGIN');
    await setTenant(db, fx.workspaceId, fx.adminId);
    await db.query(
      `INSERT INTO runs(id,workspace_id,session_id,agent_id,status,model_id,client_turn_id) VALUES($1,$2,$3,$4,'working','deepseek-flash',$5)`,
      [run, fx.workspaceId, fx.sessionId, fx.agentId, run],
    );
    await db.query('COMMIT');
  });
  await asUser(env, fx.adminId, `${path()}/${note.id}`, {
    method: 'PATCH',
    body: { title: 'Region', text: 'Canada', expected_revision: 1 },
  });
  await withClient('owner', async (db) => {
    await db.query('BEGIN');
    await setTenant(db, fx.workspaceId, fx.adminId);
    const saved = await db.query('SELECT context_snapshot FROM runs WHERE id=$1', [run]);
    expect(saved.rows[0].context_snapshot).toMatchObject({ notes: [{ text: 'Europe', revision: 1 }] });
    await db.query('ROLLBACK');
  });
});
it('admits a selected source atomically and idempotent retry retains the original text after source removal', async () => {
  const source = randomUUID(),
    hash = 'c'.repeat(64),
    key = `w/${fx.workspaceId}/uploads/${source}`;
  await withClient('owner', async (db) => {
    await db.query('BEGIN');
    await setTenant(db, fx.workspaceId, fx.adminId);
    await db.query(
      `INSERT INTO agent_files(id,workspace_id,agent_id,name,storage_key,size_bytes,mime,sha256,extraction_status,text_length) VALUES($1,$2,$3,'rubric',$4,20,'text/plain',$5,'ready',20)`,
      [source, fx.workspaceId, fx.agentId, key, hash],
    );
    await db.query('COMMIT');
  });
  await bucket.put(`${key}.txt`, 'Checked fact: blue.');
  const runtime = makeEnv({
    UPLOADS: bucket as unknown as R2Bucket,
    MODEL_SCRIPTED: '1',
    RUN_ATTEMPT: { create: async () => ({ id: 'test' }) } as unknown as Env['RUN_ATTEMPT'],
  }).env;
  const payload = {
    client_turn_id: randomUUID(),
    text: 'What is the checked fact?',
    attachments: [{ id: source, sha256: hash, kind: 'agent_file' }],
  };
  const admitted = await asUser(runtime, fx.adminId, `/w/${fx.workspaceId}/sessions/${fx.sessionId}/turns`, {
    method: 'POST',
    body: payload,
  });
  expect(admitted.status).toBe(201);
  await withClient('owner', async (db) => {
    await db.query('BEGIN');
    await setTenant(db, fx.workspaceId, fx.adminId);
    const row = await db.query('SELECT context_snapshot FROM runs WHERE client_turn_id=$1', [payload.client_turn_id]);
    expect(row.rows[0].context_snapshot.sources[0]).toMatchObject({ sha256: hash, text: 'Checked fact: blue.' });
    await db.query('DELETE FROM agent_files WHERE id=$1', [source]);
    await db.query('COMMIT');
  });
  const retried = await asUser(runtime, fx.adminId, `/w/${fx.workspaceId}/sessions/${fx.sessionId}/turns`, {
    method: 'POST',
    body: payload,
  });
  expect(retried.status).toBe(200);
});
