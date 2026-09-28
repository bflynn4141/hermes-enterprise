import type { InvitationEntity } from '@hermes/shared';
import { RestError } from './rest.js';

/**
 * User copy is keyed only on server-owned reason codes, never provider text.
 * Trace ids stay in the error for logs and support; they are not rendered
 * (docs/DESIGN.md, "Never on screen").
 */
export function invitationFailureMessage(error: unknown): string {
  if (!(error instanceof RestError)) {
    return 'Could not record the invitation. Check your connection and try again.';
  }
  return error.reason === 'iris_capacity_unavailable'
    ? 'There is no agent ready for a new member. Add one under Admin → Capacity, then try again.'
    : error.reason === 'member_setup_unavailable'
      ? 'Setting up new members is paused right now. Nothing was changed.'
    : error.reason === 'member_setup_role_unavailable'
      ? 'Finance agent setup is not available yet. Choose an available job role.'
    : error.reason === 'invitation_mode_conflict'
      ? 'This address already has an invitation. Use the existing invitation card.'
    : error.reason === 'invitation_role_conflict'
      ? 'This address already has setup in progress for a different job role.'
    : error.reason === 'not_configured'
      ? 'Invitation emails are not turned on for this workspace yet. Ask the person who runs Hermes for your company.'
      : error.reason === 'rate_limited'
        ? 'Too many invitation attempts were made. Wait a moment and try again.'
        : error.reason === 'admin_required'
          ? 'Only a workspace Admin can invite members.'
          : ['no_session', 'unknown_user', 'invalid_session'].includes(error.reason)
            ? 'Your session could not be verified. Sign in and try again.'
            : ['forbidden_origin', 'csrf_failed'].includes(error.reason)
              ? 'Refresh this page and try the invitation again.'
              : error.reason === 'bad_email'
                ? 'Enter a valid email address.'
                : error.reason === 'bad_body'
                  ? 'The invitation could not be read. Refresh and try again.'
                  : error.reason === 'bad_id' || error.reason === 'unknown_invitation'
                    ? 'That invitation no longer exists. Refresh the member list.'
                    : error.reason === 'not_resendable' || error.reason === 'already_accepted'
                      ? 'That invitation can no longer be resent. Refresh the member list.'
                      : error.reason === 'unknown_role'
                        ? 'One of those roles no longer exists. Reload and try again.'
                        : error.reason === 'too_many_roles'
                          ? 'A person can hold at most 32 roles.'
                          : error.reason === 'reauth_required'
                            ? 'Inviting someone with roles needs a recent sign-in.'
                            : error.reason === 'already_member'
                              ? 'This person is already a member. Change their roles in Manage.'
                : 'Could not record the invitation. Try again.';
}

/** Acknowledge the state the server actually persisted, not a cached rollout mode. */
export function invitationSuccessMessage(invitation: InvitationEntity): string {
  if (invitation.status === 'accepted') return 'Already a member';
  if (invitation.provisioning) return 'Agent setup started';
  if (invitation.delivery_status === 'queued') return 'Invitation queued';
  if (invitation.delivery_status === 'sending') return 'Invitation sending';
  if (invitation.delivery_status === 'delivered') return 'Invitation sent';
  if (invitation.delivery_status === 'failed') return 'Invitation recorded · email not delivered';
  // Local / setup-only / missing delivery fields: recorded, not emailed.
  return 'Invitation recorded';
}

/**
 * The invitation card's delivery line. Invitation emails go out through the
 * workspace's sign-in provider; the card calls it that rather than by its
 * vendor name, and never shows the delivery trace id.
 */
export function invitationDeliveryMessage(invitation: InvitationEntity): string | null {
  if (invitation.delivery_status === 'not_required') {
    return 'No invitation email was sent.';
  }
  if (!invitation.delivery_status) return null;
  if (invitation.delivery_status === 'queued') return 'Invitation email waiting to send';
  if (invitation.delivery_status === 'sending') return 'Sending the invitation email';
  if (invitation.delivery_status === 'delivered') return 'Invitation email sent';

  return invitation.delivery_reason === 'workos_invitation_delivery_rejected'
    ? 'The invitation email was refused. Check the address, then resend.'
    : invitation.delivery_reason === 'workos_invitation_payload_invalid'
      ? 'The invitation email could not be sent. Resend it, or ask the person who runs Hermes for your company.'
      : invitation.delivery_reason === 'iris_capacity_reservation_missing'
        ? 'The agent set aside for this person is no longer available. Add one under Admin → Capacity, then resend.'
        : invitation.delivery_reason === 'workos_invitation_delivery_not_configured'
          ? 'Invitation emails are not turned on yet. Ask the person who runs Hermes for your company.'
          : invitation.delivery_reason === 'workos_invitation_delivery_outcome_unknown'
            ? 'The invitation email may already have been sent. Ask them to check their inbox before you resend.'
            : invitation.delivery_reason === 'workos_invitation_local_commit_failed'
              ? 'The invitation email was probably sent, but Hermes could not confirm it. Ask them to check their inbox before you resend.'
              : 'Email delivery will retry automatically.';
}
