import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApprovalProposal, ApprovalView } from '@hermes/shared';
import type { Env } from '../../src/env.js';
import { withTenantTransaction } from '../../src/db/client.js';
import { proposeApproval } from '../../src/domain/approvals.js';
import { persistApprovalContinuation } from '../../src/runtime/continuation-intent.js';
import { RuntimeDb } from '../../src/runtime/store.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { INBOX_HEADERS } from './m4-fixtures.js';

const MODEL = 'openrouter:anthropic/claude-sonnet-5';

function proposal(fx: Fixture): ApprovalProposal {
  return {
    kind: 'approval',
    approval_type: 'run_plan',
    summary: 'Continue the reviewed partner research plan.',
    consequence: 'Authorize one linked run inside the exact model and spend limits.',
    evidence: [],
    illustrative: false,
    details: {
      goal: 'Produce a cited shortlist.',
      steps: [{ id: 'research', label: 'Research candidates', agent_id: fx.agentId, output: 'Cited shortlist' }],
      participating_agents: [{ agent_id: fx.agentId, role: 'Researcher' }],
      deliverables: ['Cited shortlist'],
      schedule: 'Run once after final approval.',
      budget: {
        currency: 'USD', estimated_min_minor: 10, estimated_max_minor: 100, cap_minor: 500,
        estimated_input_tokens: 500, estimated_output_tokens: 200,
        total_token_cap: 2_000, call_cap: 2, max_output_tokens_per_call: 200,
        max_parallel_calls: 1, model_ids: [MODEL], metered_tools: [], retries_included: 1,
        illustrative: false,
      },
    },
  };
}

async function installFixture(): Promise<{ fx: Fixture; memberMemberId: string; sourceRunId: string }> {
  const fx = await seedWorkspace();
  const sourceRunId = randomUUID();
  let memberMemberId = '';
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    const members = await client.query<{ id: string; user_id: string }>(
      'SELECT id, user_id FROM members WHERE workspace_id = $1', [fx.workspaceId],
    );
    const adminMemberId = members.rows.find((row) => row.user_id === fx.adminId)!.id;
    memberMemberId = members.rows.find((row) => row.user_id === fx.memberId)!.id;
    await client.query(
      `UPDATE sessions SET model_id = $2, effort = 'medium' WHERE id = $1`,
      [fx.sessionId, MODEL],
    );
    await client.query(
      `INSERT INTO agent_owners (workspace_id, agent_id, member_id) VALUES ($1,$2,$3)`,
      [fx.workspaceId, fx.agentId, adminMemberId],
    );
    await client.query(
      `INSERT INTO approval_policies
         (workspace_id, key, version, approval_type, requester_agent_id, max_budget_minor,
          priority, mode, prevent_self_review, steps)
       VALUES ($1,'runtime-plan',1,'run_plan',$2,500,10,'parallel',true,$3::jsonb)`,
      [fx.workspaceId, fx.agentId, JSON.stringify([{
        id: 'runtime-review', label: 'Runtime plan reviewer', order: 0,
        reviewers: [{ kind: 'member', member_id: memberMemberId }], quorum: 1,
      }])],
    );
    await client.query(
      `INSERT INTO runs
         (id, workspace_id, session_id, agent_id, status, model_id, client_turn_id, trace_id, mode)
       VALUES ($1,$2,$3,$4,'working',$5,$6,$7,'work')`,
      [sourceRunId, fx.workspaceId, fx.sessionId, fx.agentId, MODEL, randomUUID(), randomUUID()],
    );
    await client.query('COMMIT');
  });
  return { fx, memberMemberId, sourceRunId };
}

describe('approved continuation runtime', () => {
  it('admits one linked run, reserves every model call, and projects completion', async () => {
    const { fx, sourceRunId } = await installFixture();
    const toolCallId = 'approval-tool-call';
    const base = makeEnv();
    const created: Array<{ id: string; params: unknown }> = [];
    const env = {
      ...base.env,
      ENVIRONMENT: 'development',
      AGENT_RUNTIME: 'hermes',
      MODEL_SCRIPTED: '1',
      ALLOWED_PROVIDERS: 'openrouter',
      HERMES_BRIDGE_SECRET: 'approval-runtime-test-secret-value-000000',
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [fx.agentId]: {
          workspace_id: fx.workspaceId,
          base_url: 'http://127.0.0.1:17777',
          api_key: 'local-test-only',
        },
      }),
      RUN_ATTEMPT: {
        create: async (input: { id: string; params: unknown }) => { created.push(input); return {}; },
      },
    } as unknown as Env;

    const approved = await withTenantTransaction(
      env, 'app', { workspaceId: fx.workspaceId, userId: fx.adminId }, async (tx) => {
        const view = await proposeApproval(
          { tx, workspaceId: fx.workspaceId, jobs: [], agentId: fx.agentId, sessionId: fx.sessionId, runId: sourceRunId },
          {
            label: 'Bounded partner research', policy_key: 'runtime-plan', proposal: proposal(fx),
            target_agent_ids: [], target_member_ids: [], target_resource_ids: [], dependent_request_ids: [],
            idempotency_key: `proposal:${randomUUID()}`,
          },
        );
        await persistApprovalContinuation(tx, {
          workspaceId: fx.workspaceId, runId: sourceRunId, toolCallId,
          requesterAgentId: fx.agentId, sourceSessionId: fx.sessionId,
          targetAgentId: fx.agentId, targetSessionId: fx.sessionId, approval: view,
        });
        return view;
      },
    );

    // The original run can finish normally after proposing. Admission waits
    // for that profile to become free rather than running two native stacks.
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query("UPDATE runs SET status = 'completed', ended_at = now() WHERE id = $1", [sourceRunId]);
      await client.query('COMMIT');
    });

    const decision = await asUser(
      env, fx.memberId, `/w/${fx.workspaceId}/requests/${approved.request_id}/approval/decisions`,
      {
        method: 'POST', headers: INBOX_HEADERS,
        body: {
          decision: 'approve', expected_authorization_revision: approved.payload.authorization.revision,
          expected_authorization_hash: approved.payload.authorization.hash,
          idempotency_key: `vote:${randomUUID()}`, note: null,
        },
      },
    );
    expect(decision.status).toBe(201);
    expect(created).toHaveLength(1);

    const admitted = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const result = await client.query<{
        run_id: string; continuation_state: string; work_status: string; budget_state: string; done_at: Date | null;
      }>(
        `SELECT c.admitted_run_id AS run_id, c.state AS continuation_state,
                ar.work_status, b.state AS budget_state, j.done_at
           FROM approval_continuations c
           JOIN approval_requests ar ON ar.request_id = c.request_id
           JOIN approval_runtime_budgets b ON b.continuation_id = c.id
           JOIN jobs j ON j.id = ar.finalization_job_id
          WHERE c.request_id = $1`,
        [approved.request_id],
      );
      return result.rows[0]!;
    });
    expect(admitted).toMatchObject({
      continuation_state: 'admitted', work_status: 'admitted', budget_state: 'active',
    });
    expect(admitted.done_at).not.toBeNull();
    expect(created[0]?.id).toBe(`${admitted.run_id}-a1`);

    const store = new RuntimeDb(env, fx.workspaceId, 'approval-runtime-db-test');
    try {
      const context = await store.runtimeBudgetForRun(admitted.run_id);
      expect(context).toMatchObject({ modelId: MODEL, state: 'active', maxOutputTokensPerCall: 200 });

      const reservation = await store.reserveRuntimeBudget({
        runId: admitted.run_id, modelId: MODEL,
        inputTokenBound: 100, outputTokenBound: 50, reservedCostUsd: 0.001,
      });
      await expect(store.reserveRuntimeBudget({
        runId: admitted.run_id, modelId: MODEL,
        inputTokenBound: 100, outputTokenBound: 50, reservedCostUsd: 0.001,
      })).rejects.toMatchObject({ reason: 'approval_budget_parallel_limit' });
      await store.settleRuntimeModelCall({
        reservation: {
          reservationId: reservation.reservationId, resolution: 'completed',
          usage: { inputTokens: 80, outputTokens: 40, cachedInputTokens: 10 }, actualCostUsd: 0.00084,
        },
        modelCall: {
          runId: admitted.run_id, turn: null, modelId: MODEL, provider: 'openrouter', keyId: null,
          usage: { input_tokens: 80, output_tokens: 40, cached_input_tokens: 10, reasoning_tokens: 0 },
          latencyMs: 25, status: 'ok',
        },
      });
      // Reconciliation is replay-safe and does not double charge.
      await store.reconcileRuntimeBudget({
        reservationId: reservation.reservationId, resolution: 'completed',
        usage: { inputTokens: 80, outputTokens: 40, cachedInputTokens: 10 }, actualCostUsd: 0.00084,
      });
      await expect(store.runtimeQuery("UPDATE approval_runtime_budgets SET state = 'active' WHERE id = $1", [reservation.budgetId]))
        .rejects.toThrow(/permission denied/i);

      await store.setRunStatus(admitted.run_id, 'completed');
    } finally {
      await store.close();
    }

    const final = await readTenant(fx.workspaceId, fx.adminId, async (client) => {
      const result = await client.query<{
        continuation_state: string; work_status: string; budget_state: string;
        actual_tokens: string; calls_reconciled: number; model_calls: string;
      }>(
        `SELECT c.state AS continuation_state, ar.work_status, b.state AS budget_state,
                b.actual_tokens::text, b.calls_reconciled,
                (SELECT count(*)::text FROM model_calls mc WHERE mc.run_id = c.admitted_run_id) AS model_calls
           FROM approval_continuations c
           JOIN approval_requests ar ON ar.request_id = c.request_id
           JOIN approval_runtime_budgets b ON b.continuation_id = c.id
          WHERE c.request_id = $1`,
        [approved.request_id],
      );
      return result.rows[0]!;
    });
    expect(final).toEqual({
      continuation_state: 'completed', work_status: 'completed', budget_state: 'closed',
      actual_tokens: '120', calls_reconciled: 1, model_calls: '1',
    });
  });
});
