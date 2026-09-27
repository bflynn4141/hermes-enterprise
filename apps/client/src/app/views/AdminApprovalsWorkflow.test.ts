import { describe, expect, it } from 'vitest';
import { WORKFLOW_APPROVALS } from '@hermes/shared';
import { workflowReviewerLine } from './AdminApprovalsWorkflow.js';

describe('approvals set by the workflow (C97)', () => {
  it('name each reviewer in plain words', () => {
    expect(WORKFLOW_APPROVALS.map(workflowReviewerLine)).toEqual([
      'Reviewed by the person the agent works for',
      'Reviewed by the new member',
      'Reviewed by the Finance person on the handoff',
      'Reviewed by another Admin, or a Shared Intelligence reviewer if there is no other Admin',
    ]);
  });

  it('use sentence case and curly apostrophes', () => {
    for (const approval of WORKFLOW_APPROVALS) {
      expect(approval.label[0]).toBe(approval.label[0]!.toUpperCase());
      expect(`${approval.label}${approval.description}${approval.reviewer}`).not.toContain("'");
      expect(approval.description.endsWith('.')).toBe(true);
    }
  });
});
