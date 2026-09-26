import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { mockUuid } from '@hermes/shared';
import { createApprovalDemoFixtures } from '../../model/approval-fixtures.js';
import { ApprovalDecisionHeader, ApprovalEvidence, ReviewerSequence, approvalActionLabel, approvalPrimaryAction, decisionError } from './Approval.js';

export function approvalFixtures() {
  return createApprovalDemoFixtures({
    workspaceId: mockUuid(1), sessionId: mockUuid(2), runId: mockUuid(3), requesterAgentId: mockUuid(42),
    mayaUserId: mockUuid(4), mayaMemberId: mockUuid(43), alexUserId: mockUuid(5), alexMemberId: mockUuid(6),
    at: (minutes = 0) => new Date(Date.UTC(2026, 8, 18, 12, minutes)).toISOString(),
  });
}

describe('approval decision copy', () => {
  it('handles the Worker authorization error codes specifically', () => {
    expect(decisionError({ reason: 'approval_expired' })).toContain('expired');
    expect(decisionError({ reason: 'reviewer_not_eligible' })).toContain('not eligible');
    expect(decisionError({ reason: 'self_review_forbidden' })).toContain('not eligible');
    expect(decisionError({ reason: 'duplicate_reviewer' })).toContain('already recorded');
  });
  it('uses the same copy-only decision in detail and compact surfaces', () => {
    const fixtures = approvalFixtures();
    const request = fixtures.requests.find((item) => item.approval?.approval_type === 'communication')!;
    const view = fixtures.views.get(request.id)!;
    if (view.payload.approval_type !== 'communication') throw new Error('Expected communication');
    view.payload.details.draft_only = true;
    request.payload = view.payload as unknown as Record<string, unknown>;
    expect(approvalPrimaryAction(view)).toBe('Approve draft');
    expect(approvalActionLabel(request)).toBe('Approve draft');
  });

  it('does not label authorization as a completed provider action', () => {
    const fixtures = approvalFixtures();
    const view = [...fixtures.views.values()].find((item) => item.payload.approval_type === 'shared_learning')!;
    expect(approvalPrimaryAction(view)).toBe('Approve publication');
  });

  it('shows each step quorum and the server eligibility reason without collapsing parallel requirements', () => {
    const view = [...approvalFixtures().views.values()][0]!;
    view.payload.policy.mode = 'parallel';
    view.steps[0]!.quorum = 2;
    view.steps[0]!.approvals_recorded = 1;
    view.steps[1]!.status = 'current';
    view.capabilities.allowed_decisions = [];
    view.capabilities.reason = 'You already voted on this revision.';
    const html = renderToStaticMarkup(<ApprovalDecisionHeader view={view} />);
    expect(html).toContain('1/2 approved');
    expect(html).toContain('0/1 approved');
    expect(html).toContain('Parallel review');
    expect(html).toContain('You already voted on this revision.');
  });

  it('keeps every vote and its note in the current revision history', () => {
    const view = [...approvalFixtures().views.values()][0]!;
    view.votes = ['First reviewer', 'Second reviewer'].map((name, index) => ({
      id: mockUuid(200 + index), step_id: view.steps[0]!.step_id, decision: 'approve',
      authorization_revision: 1, authorization_hash: view.payload.authorization.hash,
      reviewer_member_id: mockUuid(300 + index), reviewer_user_id: mockUuid(400 + index),
      reviewer_name: name, note: `${name} note`, idempotency_key: `vote-${index}`, recorded_at: '2026-09-18T12:00:00Z',
    }));
    const html = renderToStaticMarkup(<ReviewerSequence view={view} />);
    expect(html).toContain('First reviewer note');
    expect(html).toContain('Second reviewer note');
  });

  it('shows missing source content honestly and never makes arbitrary references into links', () => {
    const view = [...approvalFixtures().views.values()][0]!;
    view.payload.evidence[0]!.ref = 'javascript:alert(1)';
    const html = renderToStaticMarkup(<ApprovalEvidence view={view} />);
    expect(html).toContain('Agent’s note');
    expect(html).toContain('Reference:');
    expect(html).not.toContain('href=');
    view.payload.evidence = [];
    expect(renderToStaticMarkup(<ApprovalEvidence view={view} />)).toContain('No source references were supplied');
  });
});
