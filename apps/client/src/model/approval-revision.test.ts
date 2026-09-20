import { expect, it } from 'vitest';
import { approvalViewSchema } from '@hermes/shared';
import { createMockBackend } from './mock.js';
import { APPROVAL_DEMO_REQUEST_IDS } from './approval-fixtures.js';
import { proposalFrom } from '../app/views/Approval.js';

it('keeps draft revision content and rejects the prior authorization binding', async () => {
  const mock = createMockBackend({ scenario: 'approvals', communicationDraft: true });
  const url = `/w/${mock.workspaceId}/requests/${APPROVAL_DEMO_REQUEST_IDS.communication}/approval`;
  const original = approvalViewSchema.parse(await (await mock.fetchImpl(url)).json());
  if (original.payload.approval_type !== 'communication') throw new Error('Expected communication');
  const binding = { expected_authorization_revision: original.payload.authorization.revision, expected_authorization_hash: original.payload.authorization.hash };
  const proposal = proposalFrom(original, 'Shorter pilot invitation', { subject: 'One-week pilot', body: 'Hi Taylor, would a one-week pilot fit?' });
  expect(proposal.details).toMatchObject({ sender: original.payload.details.sender, recipients: original.payload.details.recipients, attachments: original.payload.details.attachments });
  const revisedResponse = await mock.fetchImpl(`${url}/revisions`, { method: 'POST', body: JSON.stringify({ ...binding, proposal, change_summary: 'Shortened the pilot.', idempotency_key: 'revise-draft' }) });
  expect(revisedResponse.status).toBe(200);
  const revised = approvalViewSchema.parse(await revisedResponse.json());
  expect(revised.payload.details).toMatchObject({ subject: 'One-week pilot', body: 'Hi Taylor, would a one-week pilot fit?' });
  expect(revised.payload.authorization.revision).toBe(2);
  expect(revised.steps[0]?.approvals_recorded).toBe(0);
  expect(revised.votes).toHaveLength(0);
  const stale = await mock.fetchImpl(`${url}/decisions`, { method: 'POST', body: JSON.stringify({ ...binding, decision: 'approve', idempotency_key: 'stale-approve' }) });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ reason: 'stale_authorization' });
});
