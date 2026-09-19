import { describe, expect, it } from 'vitest';
import type { InvitationEntity } from '@hermes/shared';
import { createAuth } from './auth.js';
import { invitationDeliveryMessage, invitationFailureMessage } from './invitation-copy.js';
import { createRest, RestError } from './rest.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const TRACE = '22222222-2222-4222-8222-222222222222';
const INVITATION: InvitationEntity = {
  id: '33333333-3333-4333-8333-333333333333',
  email: 'finance@example.test',
  role: 'member',
  status: 'pending',
  invited_at: '2026-09-19T20:00:00.000Z',
  version: 0,
};

describe('invitation diagnostics copy', () => {
  it.each([
    ['iris_capacity_unavailable', 'No verified Iris profile is available'],
    ['not_configured', 'not connected to WorkOS invitation delivery'],
    ['rate_limited', 'Too many invitation attempts'],
    ['admin_required', 'Only a workspace Admin'],
    ['invalid_session', 'session could not be verified'],
    ['csrf_failed', 'Refresh this page'],
    ['bad_email', 'Enter a valid email address'],
    ['bad_body', 'request was not valid'],
    ['bad_id', 'invitation no longer exists'],
    ['not_resendable', 'can no longer be resent'],
  ])('maps %s without echoing a server message', (reason, expected) => {
    const error = new RestError(409, reason, 'recipient@example.test bearer secret upstream body', null, TRACE);
    const copy = invitationFailureMessage(error);
    expect(copy).toContain(expected);
    expect(copy).toContain(`Reference: ${TRACE}`);
    expect(copy).not.toContain('recipient@example.test');
    expect(copy).not.toContain('bearer secret');
  });

  it('uses a safe generic message and preserves no untrusted text', () => {
    const copy = invitationFailureMessage(
      new RestError(500, 'unexpected_provider_shape', '{"email":"private@example.test"}', null, TRACE),
    );
    expect(copy).toBe(`Could not record the invitation. Try again. Reference: ${TRACE}.`);
  });

  it('retains the optional server correlation id on RestError', async () => {
    const rest = createRest({
      auth: createAuth('fake'),
      fetchImpl: async () => Response.json(
        { error: 'safe server copy', reason: 'iris_capacity_unavailable', trace_id: TRACE },
        { status: 409 },
      ),
    });
    await expect(rest.invite(WORKSPACE, { email: 'finance@example.test', role: 'member' })).rejects.toMatchObject({
      status: 409,
      reason: 'iris_capacity_unavailable',
      traceId: TRACE,
    });
  });

  it('describes queued, accepted, and sanitized failed delivery states', () => {
    expect(invitationDeliveryMessage({ ...INVITATION, delivery_status: 'queued' }))
      .toBe('Email delivery queued');
    expect(invitationDeliveryMessage({ ...INVITATION, delivery_status: 'delivered' }))
      .toBe('Sent by WorkOS');
    expect(invitationDeliveryMessage({
      ...INVITATION,
      delivery_status: 'failed',
      delivery_reason: 'workos_invitation_delivery_unavailable',
      delivery_trace_id: TRACE,
    })).toBe(`Email delivery will retry automatically. Reference: ${TRACE}.`);
    expect(invitationDeliveryMessage({
      ...INVITATION,
      delivery_status: 'failed',
      delivery_reason: 'workos_invitation_local_commit_failed',
      delivery_trace_id: TRACE,
    })).toBe(
      `WorkOS accepted the request, but Hermes could not save confirmation. Check WorkOS before resending. Reference: ${TRACE}.`,
    );
    expect(invitationDeliveryMessage({
      ...INVITATION,
      delivery_status: 'failed',
      delivery_reason: 'workos_invitation_delivery_outcome_unknown',
      delivery_trace_id: TRACE,
    })).toBe(`WorkOS may have accepted the email. Check WorkOS before resending. Reference: ${TRACE}.`);
  });

  it('uses safe fallback copy for an unknown historical failure category', () => {
    const invitation = {
      ...INVITATION,
      delivery_status: 'failed',
      delivery_reason: 'provider said finance@example.test',
      delivery_trace_id: TRACE,
    } as unknown as InvitationEntity;
    const copy = invitationDeliveryMessage(invitation);
    expect(copy).toBe(`Email delivery will retry automatically. Reference: ${TRACE}.`);
    expect(copy).not.toContain('finance@example.test');
  });
});
