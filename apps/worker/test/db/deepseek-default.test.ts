// The default rollout changes future work across tenants while preserving
// explicit session choices, past traces, and choices made after the migration.
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_EFFORT, DEFAULT_MODEL_ID } from '@hermes/shared';
import type { Tx } from '../../src/db/client.js';
import { promoteDefaultModel } from '../../src/keys/default-model.js';
import { syncNousPortalCatalog } from '../../src/model/nous-catalog.js';
import { NOUS_PORTAL_FIXTURE_MODELS } from '../../src/model/nous-dev.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';

const OLD = 'nous:anthropic/claude-sonnet-5';
const EXPLICIT = 'nous:google/gemini-3-flash';
const FILENAME = '0041_deepseek_default.sql';

describe('the DeepSeek default rollout', () => {
  it('migrates all workspace defaults and inherited or automated sessions once without changing history or later selections', async () => {
    const first = await seedWorkspace();
    const second = await seedWorkspace();
    const migration = await readFile(new URL(`../../migrations/${FILENAME}`, import.meta.url), 'utf8');
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      try {
        await setTenant(c, first.workspaceId, first.adminId);
        await syncNousPortalCatalog(c as unknown as Tx, NOUS_PORTAL_FIXTURE_MODELS);
        await c.query(`DELETE FROM schema_migrations WHERE filename=$1`, [FILENAME]);
        // Simulate the old catalog mapping so the rollout corrects an already
        // synced default instead of merely inserting a fresh placeholder.
        await c.query(`UPDATE catalog SET effort_map='{"low":"low","medium":"medium","high":"high"}'::jsonb, default_effort='medium' WHERE model_id=$1`, [DEFAULT_MODEL_ID]);
        const preservedRun = randomUUID();
        const ids: Record<string, string> = {};
        for (const [name, model, effort, title, archived, owner] of [
          ['inherited', OLD, 'medium', 'My work', false, first.adminId],
          ['member', OLD, 'medium', 'Member work', false, first.memberId],
          ['automation', EXPLICIT, null, 'Iris · Automated partner screening', false, first.adminId],
          ['explicit', EXPLICIT, null, 'Chosen by user', false, first.adminId],
          ['explicit-effort', OLD, 'high', 'Chosen effort', false, first.adminId],
          ['archived', OLD, 'medium', 'Archived', true, first.adminId],
          ['unsupported', DEFAULT_MODEL_ID, 'medium', 'Unsupported old effort', false, first.adminId],
        ] as const) {
          const id = randomUUID();
          ids[name] = id;
          await c.query(`INSERT INTO sessions (id, workspace_id, owner_id, agent_id, title, model_id, effort, archived) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, first.workspaceId, owner, first.agentId, title, model, effort, archived]);
        }
        await c.query(`INSERT INTO runs (id,workspace_id,session_id,agent_id,status,model_id,effort,client_turn_id) VALUES ($1,$2,$3,$4,'error',$5,'medium','old-failure')`, [preservedRun, first.workspaceId, ids.inherited, first.agentId, OLD]);
        await c.query(`UPDATE workspace_settings SET default_model_id=$2, default_effort='medium' WHERE workspace_id=$1`, [first.workspaceId, OLD]);
        await setTenant(c, second.workspaceId, second.adminId);
        await c.query(`UPDATE workspace_settings SET default_model_id=$2, default_effort='high' WHERE workspace_id=$1`, [second.workspaceId, OLD]);
        await c.query(migration);

        for (const fx of [first, second]) {
          await setTenant(c, fx.workspaceId, fx.adminId);
          expect((await c.query(`SELECT default_model_id,default_effort FROM workspace_settings WHERE workspace_id=$1`, [fx.workspaceId])).rows[0]).toEqual({ default_model_id: DEFAULT_MODEL_ID, default_effort: DEFAULT_EFFORT });
        }
        await setTenant(c, first.workspaceId, first.adminId);
        const sessions = (await c.query<{ id: string; model_id: string; effort: string | null }>(`SELECT id,model_id,effort FROM sessions WHERE workspace_id=$1`, [first.workspaceId])).rows;
        for (const name of ['inherited', 'member', 'automation', 'unsupported']) {
          expect(sessions.find((s) => s.id === ids[name])).toMatchObject({ model_id: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT });
        }
        expect(sessions.find((s) => s.id === first.sessionId)).toMatchObject({ model_id: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT });
        expect(sessions.find((s) => s.id === ids.explicit)).toMatchObject({ model_id: EXPLICIT, effort: null });
        expect(sessions.find((s) => s.id === ids['explicit-effort'])).toMatchObject({ model_id: OLD, effort: 'high' });
        expect(sessions.find((s) => s.id === ids.archived)).toMatchObject({ model_id: OLD, effort: 'medium' });
        expect((await c.query(`SELECT model_id,effort,attempt FROM runs WHERE id=$1`, [preservedRun])).rows[0]).toEqual({ model_id: OLD, effort: 'medium', attempt: 1 });
        expect((await c.query(`SELECT effort_map,default_effort,disabled_reason FROM catalog WHERE model_id=$1`, [DEFAULT_MODEL_ID])).rows[0]).toEqual({ effort_map: { low: 'low', high: 'high', max: 'max' }, default_effort: 'high', disabled_reason: null });
        expect((await c.query(`SELECT relforcerowsecurity FROM pg_class WHERE relname IN ('sessions','workspace_settings')`)).rows.every((row) => row.relforcerowsecurity)).toBe(true);

        await c.query(`INSERT INTO schema_migrations (filename,sha256) VALUES ($1,'test')`, [FILENAME]);
        await c.query(`UPDATE workspace_settings SET default_model_id=$2,default_effort='high' WHERE workspace_id=$1`, [first.workspaceId, OLD]);
        await c.query(`UPDATE sessions SET model_id=$2,effort='high' WHERE id=$1`, [ids.automation, OLD]);
        await c.query(migration);
        expect((await c.query(`SELECT default_model_id,default_effort FROM workspace_settings WHERE workspace_id=$1`, [first.workspaceId])).rows[0]).toEqual({ default_model_id: OLD, default_effort: 'high' });
        expect((await c.query(`SELECT model_id,effort FROM sessions WHERE id=$1`, [ids.automation])).rows[0]).toEqual({ model_id: OLD, effort: 'high' });
      } finally {
        // Even catalog writes and temporary ledger changes stay in this test.
        await c.query('ROLLBACK');
      }
    });
  });

  it('promotes an unusable default onto the exact model at product low effort after sync', async () => {
    const fx = await seedWorkspace();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      try {
        await setTenant(c, fx.workspaceId, fx.adminId);
        await syncNousPortalCatalog(c as unknown as Tx, NOUS_PORTAL_FIXTURE_MODELS);
        await c.query(`UPDATE workspace_settings SET default_model_id='deepseek-flash', default_effort='high' WHERE workspace_id=$1`, [fx.workspaceId]);
        expect(await promoteDefaultModel(c as unknown as Tx, fx.workspaceId, ['nous_portal'])).toEqual({ from: 'deepseek-flash', to: DEFAULT_MODEL_ID, effort: DEFAULT_EFFORT, sessions: 1 });
        expect(await promoteDefaultModel(c as unknown as Tx, fx.workspaceId, ['nous_portal'])).toBeNull();
      } finally {
        await c.query('ROLLBACK');
      }
    });
  });
});
