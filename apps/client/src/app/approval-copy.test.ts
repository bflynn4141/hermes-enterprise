import { describe, expect, it } from 'vitest';
import { mockUuid, type RequestEntity } from '@hermes/shared';
import { approvalEffectLabel, approvalStatusLabel, approvalWorkLabel, approvalWorkReason, approvalWorkStartedLine, matchesReviewerFilter } from './approval-copy.js';
import type { ApprovalView } from '@hermes/shared';

function legacyRequest(canDecide: boolean, kind: RequestEntity['kind'] = 'invoice'): RequestEntity {
  return {
    id: mockUuid(900), kind, status: 'pending', label: 'Vendor draft', title: null,
    subject: 'Vendor', session_id: null, run_id: null, created_at: '2026-09-18T12:00:00Z',
    version: 1, payload: { kind }, sources: [], missing: [],
    provenance: { kind: 'unknown', source: 'not_recorded', recorded_at: '2026-09-18T12:00:00Z' },
    presentation: { hidden: false, hidden_at: null, hidden_reason: null },
    decision_summary: {
      action: 'Approve invoice draft', primary: 'Invoice from Vendor', facts: [], consequence: null,
      approval_requirement: {
        mode: 'single', completed_steps: 0, total_steps: 1, remaining_approvals: 1,
        current: [{ label: 'Workspace Admin', approvals_recorded: 0, quorum: 1 }],
        pending_for_viewer: canDecide, waiting_on_others: !canDecide, expires_at: null,
      },
    },
  };
}

describe('approval result copy', () => {
  it('names each server state in reviewer words and humanizes an unknown one', () => {
    expect(approvalStatusLabel('pending')).toBe('Waiting for review');
    expect(approvalStatusLabel('changes_requested')).toBe('Changes requested');
    expect(approvalStatusLabel('withdrawn')).toBe('Withdrawn');
    expect(approvalWorkLabel('admitted')).toBe('Work started');
    expect(approvalWorkLabel('completed')).toBe('No follow-on work');
    expect(approvalEffectLabel('unavailable')).toBe('No external effect');
    expect(approvalEffectLabel('executed')).toBe('Done');
    expect(approvalWorkLabel('some_future_state')).toBe('Some future state');
  });

  it('turns a work reason code into one sentence and passes a sentence through', () => {
    expect(approvalWorkReason('no_runtime_continuation_requested')).toBe('This approval did not ask for any work to run afterwards.');
    expect(approvalWorkReason('resource_binding_hook_changed')).toMatch(/changed after approval/);
    expect(approvalWorkReason('profile_missing')).toBe('Profile missing.');
    expect(approvalWorkReason('The proposal was declined.')).toBe('The proposal was declined.');
    expect(approvalWorkReason(null)).toBeNull();
  });

  it('describes an admitted run_plan by its cap in major units', () => {
    const view = {
      work: { status: 'admitted' },
      payload: { approval_type: 'run_plan', details: { budget: { cap_minor: 15, currency: 'USD' } } },
    } as unknown as ApprovalView;
    expect(approvalWorkStartedLine(view)).toBe('Search started · $0.15 cap');
    expect(approvalWorkStartedLine({ ...view, work: { status: 'waiting' } } as unknown as ApprovalView)).toBeNull();
  });
});

describe('Inbox reviewer filters use the actual legacy decision authority', () => {
  it.each(['application', 'invoice', 'agreement'] as const)('places a member’s pending %s under Waiting on others', (kind) => {
    const request = legacyRequest(false, kind);
    expect(matchesReviewerFilter(request, 'for_me')).toBe(false);
    expect(matchesReviewerFilter(request, 'waiting')).toBe(true);
    expect(matchesReviewerFilter(request, 'all')).toBe(true);
  });

  it('keeps an Admin’s pending draft in For me', () => {
    const request = legacyRequest(true);
    expect(matchesReviewerFilter(request, 'for_me')).toBe(true);
    expect(matchesReviewerFilter(request, 'waiting')).toBe(false);
  });

  it('keeps setup work reachable without treating it as an approval vote', () => {
    const request = legacyRequest(false, 'task');
    request.decision_summary!.approval_requirement.waiting_on_others = false;
    expect(matchesReviewerFilter(request, 'for_me')).toBe(true);
    expect(matchesReviewerFilter(request, 'waiting')).toBe(false);
  });
});
