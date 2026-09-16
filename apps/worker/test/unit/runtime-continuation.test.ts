import { describe, expect, it, vi } from 'vitest';
import type { ApprovalView } from '@hermes/shared';
import type { Tx } from '../../src/db/client.js';
import {
  approvalContinuationRetryBlock,
  persistApprovalContinuation,
  reviewedContinuationMessage,
} from '../../src/runtime/continuation.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const REQUEST = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';
const TARGET = '44444444-4444-4444-8444-444444444444';
const MEMBER = '55555555-5555-4555-8555-555555555555';
const SESSION = '66666666-6666-4666-8666-666666666666';
const RUN = '77777777-7777-4777-8777-777777777777';
const POLICY = '88888888-8888-4888-8888-888888888888';
const HASH = `sha256:${'a'.repeat(64)}`;

const approval = (): ApprovalView => ({
  request_id: REQUEST,
  workspace_id: WORKSPACE,
  status: 'pending',
  payload: {
    kind: 'approval',
    approval_type: 'run_plan',
    summary: 'Run the reviewed plan.',
    consequence: 'A bounded continuation may start after final approval.',
    evidence: [],
    illustrative: false,
    details: {
      goal: 'Produce the reviewed report.',
      steps: [{ id: 'report', label: 'Prepare report', agent_id: TARGET, output: 'Reviewed report' }],
      participating_agents: [{ agent_id: TARGET, role: 'Researcher' }],
      deliverables: ['Reviewed report'],
      schedule: 'Once, immediately after approval.',
      budget: {
        currency: 'USD', estimated_min_minor: 0, estimated_max_minor: 10, cap_minor: 20,
        total_token_cap: 2_000, call_cap: 2, max_output_tokens_per_call: 500,
        max_parallel_calls: 1, model_ids: ['openrouter:model-a'], metered_tools: [],
        retries_included: 1, illustrative: false,
      },
    },
    context: {
      requester: { agent_id: AGENT, member_id: MEMBER, user_id: MEMBER },
      target_agent_ids: [TARGET], target_member_ids: [], target_resource_ids: [],
      source: { session_id: SESSION, run_id: RUN, dependent_request_ids: [] },
    },
    authorization: { revision: 1, hash: HASH, expires_at: '2026-09-30T17:00:00-07:00' },
    policy: {
      id: POLICY, key: 'run-plan', version: 1, mode: 'sequential', prevent_self_review: true,
      require_distinct_reviewers: true,
      steps: [{ id: 'owner', label: 'Owner', order: 0, reviewers: [{ kind: 'member', member_id: MEMBER }], quorum: 1 }],
    },
    resource_bindings: [],
  },
  identities: {
    requester_agent: { id: AGENT, name: 'Iris', email: null },
    target_agents: [{ id: TARGET, name: 'Theo', email: null, responsible_member_id: MEMBER, responsible_member_name: 'Maya' }],
    reviewers: [],
  },
  votes: [],
  steps: [{ step_id: 'owner', label: 'Owner', order: 0, status: 'current', approvals_recorded: 0, quorum: 1, current_reviewer_member_ids: [MEMBER] }],
  capabilities: { allowed_decisions: [], eligible_step_ids: [], can_route: false, can_submit_revision: false, reason: null },
  effect: { kind: 'none', status: 'not_required', effect_id: null, reason: null },
  work: { status: 'waiting', continuation_id: null, reason: null },
  finalized_at: null,
});

describe('approval continuation intent', () => {
  it('persists only revision-bound target coordinates from the reviewed approval', async () => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql.includes('SELECT agent_id, read_only FROM sessions')) {
        return { rows: [{ agent_id: TARGET, read_only: false }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO approval_continuations')) return { rows: [{ id: POLICY }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const result = await persistApprovalContinuation({ query } as unknown as Tx, {
      workspaceId: WORKSPACE, runId: RUN, toolCallId: 'call-1', requesterAgentId: AGENT,
      sourceSessionId: SESSION, targetAgentId: TARGET, targetSessionId: SESSION, approval: approval(),
    });
    expect(result).toEqual({ continuationId: POLICY, created: true });
    const insertCall = query.mock.calls.find(([sql]) => sql.includes('INSERT INTO approval_continuations'));
    const values = insertCall?.[1] as unknown[] | undefined;
    expect(values).toBeDefined();
    if (!values) throw new Error('missing insert values');
    expect(values).toContain(HASH);
    expect(values).toContain(`agent-${TARGET}`);
    expect(JSON.parse(String(values[9]))).toEqual({ target_agent_id: TARGET, target_session_id: SESSION });
  });

  it('refuses a continuation target the server did not authorize', async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [], rowCount: 0 }));
    await expect(persistApprovalContinuation({ query } as unknown as Tx, {
      workspaceId: WORKSPACE, runId: RUN, toolCallId: 'call-1', requesterAgentId: AGENT,
      sourceSessionId: SESSION, targetAgentId: MEMBER, targetSessionId: SESSION, approval: approval(),
    })).rejects.toThrow('approval_continuation_target_not_authorized');
    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).toContain('SELECT id, request_id');
  });

  it('derives the next-run input from reviewed fields, not viewer authority or votes', () => {
    const message = reviewedContinuationMessage(approval());
    expect(message).toContain('Run the reviewed plan.');
    expect(message).toContain(HASH);
    expect(message).not.toContain('allowed_decisions');
    expect(message).not.toContain('current_reviewer_member_ids');
  });
});

describe('approved retry gate', () => {
  it('enforces the reviewed retry count', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('SELECT c.id AS continuation_id')
      ? { rows: [{
          continuation_id: POLICY, continuation_state: 'admitted', expires_at: new Date('2026-09-30T00:00:00Z'),
          approval_status: 'approved', work_status: 'admitted', budget_state: 'active', retry_cap: 1,
        }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    await expect(approvalContinuationRetryBlock({ query } as unknown as Tx, RUN, 3, new Date('2026-09-15T00:00:00Z')))
      .resolves.toBe('approval_retry_limit');
    expect(query).toHaveBeenCalledOnce();
  });

  it('clears the projected error only for an authorized retry', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('SELECT c.id AS continuation_id')
      ? { rows: [{
          continuation_id: POLICY, continuation_state: 'admitted', expires_at: new Date('2026-09-30T00:00:00Z'),
          approval_status: 'approved', work_status: 'admitted', budget_state: 'active', retry_cap: 1,
        }], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    await expect(approvalContinuationRetryBlock({ query } as unknown as Tx, RUN, 2, new Date('2026-09-15T00:00:00Z')))
      .resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
