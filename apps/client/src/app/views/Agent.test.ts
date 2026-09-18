import { describe, expect, it } from 'vitest';
import type { RequestEntity } from '@hermes/shared';
import { requestRowCopy } from './Agent.js';

const communicationRequest = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'approval',
  status: 'pending',
  label: 'Draft outreach email — Suhayl Meghji (AgentCash people-search prospect)',
  subject: 'Draft outreach email — Suhayl Meghji (AgentCash people-search prospect)',
  title: 'DRAFT ONLY: a personalized invitation email prepared for human review from a stored profile.',
  payload: {
    approval_type: 'communication',
    details: {
      channel: 'email',
      draft_only: true,
      recipients: [{ name: 'Suhayl Meghji', address: null }],
    },
  },
  approval: { approval_type: 'communication' },
} as unknown as RequestEntity;

describe('requestRowCopy', () => {
  it('uses a deterministic two-line summary for draft communication approvals', () => {
    expect(requestRowCopy(communicationRequest)).toEqual({
      title: 'Draft outreach — Suhayl Meghji',
      summary: 'Review copy only · Nothing is sent',
      compact: true,
    });
  });

  it('keeps existing copy for other request types', () => {
    const request = {
      ...communicationRequest,
      kind: 'task',
      label: 'Set partner criteria',
      subject: 'Set partner criteria',
      title: 'Tell Iris what to look for.',
      approval: null,
    } as RequestEntity;

    expect(requestRowCopy(request)).toEqual({
      title: 'Set partner criteria',
      summary: 'Tell Iris what to look for.',
      compact: false,
    });
  });
});
