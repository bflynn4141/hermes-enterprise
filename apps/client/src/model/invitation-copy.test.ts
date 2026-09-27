import { describe, expect, it } from 'vitest';
import type { InvitationEntity } from '@hermes/shared';
import { createAuth } from './auth.js';
import { invitationDeliveryMessage, invitationFailureMessage, invitationSuccessMessage } from './invitation-copy.js';
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
  it('acknowledges the state returned by the server instead of a cached rollout mode', () => {
    expect(invitationSuccessMessage({ ...INVITATION, status: 'accepted' })).toBe('Already a member');
    expect(invitationSuccessMessage({ ...INVITATION, delivery_status: 'queued' })).toBe('Invitation queued');
    expect(invitationSuccessMessage({ ...INVITATION, delivery_status: 'delivered' })).toBe('Invitation sent');
    expect(invitationSuccessMessage({ ...INVITATION, delivery_status: 'failed' }))
      .toBe('Invitation recorded · email not delivered');
    expect(invitationSuccessMessage({ ...INVITATION, delivery_status: 'not_required' }))
      .toBe('Invitation recorded');
    expect(invitationSuccessMessage(INVITATION)).toBe('Invitation recorded');
    expect(invitationSuccessMessage({
      ...INVITATION,
      delivery_status: 'not_required',
      provisioning: {
        id: '44444444-4444-4444-8444-444444444444',
        workspace_id: WORKSPACE,
        preparation: 'queued',
        delivery: 'not_queued',
        membership: 'not_joined',
        cancellation: 'none',
        issue: null,
        revision: 1,
      },
    })).toBe('Agent setup started');
  });

  it.each([
    ['iris_capacity_unavailable', 'There is no agent ready for a new member'],
    ['member_setup_role_unavailable', 'Finance agent setup is not available yet'],
    ['not_configured', 'Invitation emails are not turned on'],
    ['rate_limited', 'Too many invitation attempts'],
    ['admin_required', 'Only a workspace Admin'],
    ['invalid_session', 'session could not be verified'],
    ['csrf_failed', 'Refresh this page'],
    ['bad_email', 'Enter a valid email address'],
    ['bad_body', 'invitation could not be read'],
    ['bad_id', 'invitation no longer exists'],
    ['not_resendable', 'can no longer be resent'],
  ])('maps %s without echoing a server message', (reason, expected) => {
    const error = new RestError(409, reason, 'recipient@example.test bearer secret upstream body', null, TRACE);
    const copy = invitationFailureMessage(error);
    expect(copy).toContain(expected);
    expect(copy).not.toContain(TRACE);
    expect(copy).not.toMatch(/WorkOS|Reference/);
    expect(copy).not.toContain('recipient@example.test');
    expect(copy).not.toContain('bearer secret');
  });

  it('uses a safe generic message and preserves no untrusted text', () => {
    const copy = invitationFailureMessage(
      new RestError(500, 'unexpected_provider_shape', '{"email":"private@example.test"}', null, TRACE),
    );
    expect(copy).toBe('Could not record the invitation. Try again.');
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

  it('describes queued, accepted, local, and sanitized failed delivery states', () => {
    expect(invitationDeliveryMessage({ ...INVITATION, delivery_status: 'queued' }))
      .toBe('Invitation email waiting to send');
    expect(invitationDeliveryMessage({ ...INVITATION, delivery_status: 'delivered' }))
      .toBe('Invitation email sent');
    expect(invitationDeliveryMessage({ ...INVITATION, delivery_status: 'not_required' }))
      .toBe('No invitation email was sent.');
    expect(invitationDeliveryMessage({
      ...INVITATION,
      delivery_status: 'failed',
      delivery_reason: 'workos_invitation_delivery_unavailable',
      delivery_trace_id: TRACE,
    })).toBe('Email delivery will retry automatically.');
    expect(invitationDeliveryMessage({
      ...INVITATION,
      delivery_status: 'failed',
      delivery_reason: 'workos_invitation_delivery_not_configured',
      delivery_trace_id: TRACE,
    })).toBe('Invitation emails are not turned on yet. Ask the person who runs Hermes for your company.');
    expect(invitationDeliveryMessage({
      ...INVITATION,
      delivery_status: 'failed',
      delivery_reason: 'workos_invitation_local_commit_failed',
      delivery_trace_id: TRACE,
    })).toBe(
      'The invitation email was probably sent, but Hermes could not confirm it. Ask them to check their inbox before you resend.',
    );
    expect(invitationDeliveryMessage({
      ...INVITATION,
      delivery_status: 'failed',
      delivery_reason: 'workos_invitation_delivery_outcome_unknown',
      delivery_trace_id: TRACE,
    })).toBe('The invitation email may already have been sent. Ask them to check their inbox before you resend.');
  });

  it('uses safe fallback copy for an unknown historical failure category', () => {
    const invitation = {
      ...INVITATION,
      delivery_status: 'failed',
      delivery_reason: 'provider said finance@example.test',
      delivery_trace_id: TRACE,
    } as unknown as InvitationEntity;
    const copy = invitationDeliveryMessage(invitation);
    expect(copy).toBe('Email delivery will retry automatically.');
    expect(copy).not.toContain('finance@example.test');
  });
});

describe('invitations that carry roles (C97)', () => {
  it('ask for a recent sign-in, and send an existing member to Manage', () => {
    expect(invitationFailureMessage(new RestError(401, 'reauth_required', 'x')))
      .toBe('Inviting someone with roles needs a recent sign-in.');
    expect(invitationFailureMessage(new RestError(409, 'already_member', 'x')))
      .toBe('This person is already a member. Change their roles in Manage.');
  });
});
