// Real agent-role updates must retain tenant and attempt fences even when an
// old provider request answers after its native run has been retried.
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { RuntimeDb } from '../../src/runtime/store.js';
import { AGENT_URL, APP_URL } from '../../scripts/db-config.mjs';
import { seedWorkspace, setTenant, withClient } from './helpers.js';

const env = { ENVIRONMENT: 'test', HYPERDRIVE_APP: { connectionString: APP_URL }, HYPERDRIVE_AGENT: { connectionString: AGENT_URL } } as unknown as Env;

describe('persisted provider retry deadlines', () => {
  it('keeps the longest deadline and refuses cross-tenant or old-attempt updates', async () => {
    const fx = await seedWorkspace();
    const other = await seedWorkspace();
    const runId = crypto.randomUUID();
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(`INSERT INTO runs (id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,attempt) VALUES ($1,$2,$3,$4,'working','deepseek-flash',$5,2)`, [runId, fx.workspaceId, fx.sessionId, fx.agentId, crypto.randomUUID()]);
      await client.query('COMMIT');
    });
    const store = new RuntimeDb(env, fx.workspaceId, 'retry-deadline-test');
    const foreign = new RuntimeDb(env, other.workspaceId, 'retry-deadline-foreign');
    const short = new Date('2026-09-19T17:01:00.000Z');
    const long = new Date('2026-09-19T19:00:00.000Z');
    const excessive = { notBefore: null, blockedReason: 'provider_retry_after_excessive' as const, header: null };
    try {
      await store.recordProviderRetryAfter(runId, 2, { notBefore: long, blockedReason: null, header: '7200' });
      await store.recordProviderRetryAfter(runId, 2, { notBefore: short, blockedReason: null, header: '60' });
      await store.recordProviderRetryAfter(runId, 1, excessive);
      await foreign.recordProviderRetryAfter(runId, 2, excessive);
      expect((await store.runtimeQuery(`SELECT recovery_not_before,recovery_blocked_reason FROM runs WHERE id=$1`, [runId])).rows[0])
        .toEqual({ recovery_not_before: long, recovery_blocked_reason: null });
      await store.recordProviderRetryAfter(runId, 2, excessive);
      expect((await store.runtimeQuery(`SELECT recovery_not_before,recovery_blocked_reason FROM runs WHERE id=$1`, [runId])).rows[0])
        .toEqual({ recovery_not_before: long, recovery_blocked_reason: 'provider_retry_after_excessive' });
    } finally { await store.close(); await foreign.close(); }
  });
});
