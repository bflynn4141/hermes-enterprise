import { describe, expect, it } from 'vitest';
import { mockUuid, type RequestEntity } from '@hermes/shared';
import { matchesReviewerFilter } from './approval-copy.js';

function legacyRequest(canDecide: boolean, kind: RequestEntity['kind'] = 'invoice'): RequestEntity {
  return {
    id: mockUuid(900), kind, status: 'pending', label: 'Vendor draft', title: null,
    subject: 'Vendor', session_id: null, run_id: null, created_at: '2026-09-18T12:00:00Z',
    version: 1, payload: { kind }, sources: [], missing: [],
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
