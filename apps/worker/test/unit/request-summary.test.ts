import { describe, expect, it } from 'vitest';
import type { ApprovalListProjection } from '@hermes/shared';
import { decisionSummary } from '../../src/domain/request-summary.js';
import type { RequestRow } from '../../src/domain/requests.js';

const baseRow = (payload: Record<string, unknown>): RequestRow => ({
  id: '00000000-0000-4000-8000-000000000001', kind: 'approval', status: 'pending', label: 'Data export', payload,
  session_id: null, run_id: null, created_at: new Date(), version: 1, note: null,
  decision_id: null, decided_at: null, decided_by_name: null,
});

describe('decision summaries', () => {
  it('derives disclosure facts and exact current quorum from validated policy data', () => {
    const payload = {
      kind: 'approval', approval_type: 'data_disclosure', summary: 'Share partner data', consequence: 'The recipient can retain the approved fields.', evidence: [], illustrative: false,
      details: { recipient: { organization: 'Acme' }, purpose: 'Partner review', items: [{ resource_id: 'partners', fields: ['name', 'status'] }], redactions: ['phone'], retention_until: '2026-10-01T00:00:00.000Z' },
      context: { requester: { agent_id: '00000000-0000-4000-8000-000000000002', member_id: null, user_id: null }, target_agent_ids: [], target_member_ids: [], target_resource_ids: [], source: { session_id: null, run_id: null, dependent_request_ids: [] } },
      authorization: { revision: 1, hash: `sha256:${'a'.repeat(64)}`, expires_at: '2026-09-19T00:00:00.000Z' },
      policy: { id: '00000000-0000-4000-8000-000000000003', key: 'data-review', version: 1, mode: 'sequential', prevent_self_review: true, require_distinct_reviewers: true, steps: [{ id: 'privacy', label: 'Privacy review', order: 0, reviewers: [{ kind: 'role', role: 'admin', minimum_distinct_members: 2 }], quorum: 2 }] },
      resource_bindings: [],
    };
    const projection: ApprovalListProjection = {
      approval_type: 'data_disclosure', authorization_status: 'pending', authorization_revision: 1,
      expires_at: '2026-09-19T00:00:00.000Z', pending_for_viewer: true, waiting_on_others: false,
      current_reviewer_names: ['Maya'], mode: 'sequential', completed_steps: 0, total_steps: 1,
      remaining_approvals: 1, current_steps: [{ label: 'Privacy review', approvals_recorded: 1, quorum: 2 }],
      effect_status: 'unavailable', work_status: 'waiting',
    };
    const summary = decisionSummary(baseRow(payload), projection);
    expect(summary.primary).toBe('Share 1 resource with Acme');
    expect(summary.facts).toContainEqual(expect.objectContaining({ label: 'Fields', value: '2', emphasis: 'risk' }));
    expect(summary.approval_requirement.current).toEqual([{ label: 'Privacy review', approvals_recorded: 1, quorum: 2 }]);
  });
});
