import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Tx } from '../../src/db/client.js';
import { inspectRecoverySafety } from '../../src/runs/recovery-safety.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';

describe('recovery receipt and effect checks against Postgres', () => {
  it('keeps a pending paid lease intact and resumes its evidence after import', async () => {
    const fx = await seedWorkspace();
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      try {
        await setTenant(client, fx.workspaceId, fx.adminId);
        const screeningId = randomUUID();
        const runId = randomUUID();
        const nativeId = `run_${'d'.repeat(32)}`;
        await client.query(
          `INSERT INTO partner_screening_runs
             (id,workspace_id,agent_id,created_by,idempotency_key,source,authentication,
              config_snapshot,api_requests_max,api_requests_used,agentcash_tool_call_id)
           VALUES ($1,$2,$3,$4,$5,'agentcash_people','wallet','{"minimum_priority":40}',1,1,'paid-call')`,
          [screeningId, fx.workspaceId, fx.agentId, fx.adminId, `recovery:${screeningId}`],
        );
        await client.query(
          `INSERT INTO runs
             (id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,mode,
              runtime_kind,runtime_run_id,runtime_attempt)
           VALUES ($1,$2,$3,$4,'error','deepseek-flash',$5,'work','hermes',$6,1)`,
          [runId, fx.workspaceId, fx.sessionId, fx.agentId, `partner-screening:${screeningId}`, nativeId],
        );
        const tx = client as unknown as Tx;
        expect((await inspectRecoverySafety(tx, fx.workspaceId, runId)).blockedReason).toBe('payment_result_pending');
        expect((await client.query('SELECT attempt,runtime_run_id FROM runs WHERE id=$1', [runId])).rows[0])
          .toEqual({ attempt: 1, runtime_run_id: nativeId });
        expect((await client.query('SELECT api_requests_used,agentcash_tool_call_id FROM partner_screening_runs WHERE id=$1', [screeningId])).rows[0])
          .toEqual({ api_requests_used: 1, agentcash_tool_call_id: 'paid-call' });

        // Simulate the already-paid result import, with no provider call.
        await client.query("UPDATE partner_screening_runs SET status='completed',completed_at=now(),monetary_cost_usd=0.15 WHERE id=$1", [screeningId]);
        await client.query(
          `INSERT INTO run_steps (workspace_id,run_id,step_id,label,state,tool_call_id)
           VALUES ($1,$2,'hermes-tool-1','mcp__agentcash__fetch','done','hermes-tool-1')`,
          [fx.workspaceId, runId],
        );
        const safe = await inspectRecoverySafety(tx, fx.workspaceId, runId);
        expect(safe.blockedReason).toBeNull();
        expect(safe.resumeInput).toContain('do not start another search');

        // A bridge proposal whose response was lost is still an uncertain
        // write. Its assistant call is sufficient to prevent a fresh draft.
        await client.query(
          `INSERT INTO run_turns (workspace_id,run_id,turn,seq,role,provider_message)
           VALUES ($1,$2,0,0,'assistant',$3::jsonb)`,
          [fx.workspaceId, runId, JSON.stringify({ role: 'assistant', content: '',
            tool_calls: [{ id: 'old-native-proposal', name: 'propose_approval', arguments: '{}' }] })],
        );
        expect((await inspectRecoverySafety(tx, fx.workspaceId, runId)).blockedReason).toBe('side_effects_uncertain');
      } finally {
        await client.query('ROLLBACK');
      }
    });
  });
});
