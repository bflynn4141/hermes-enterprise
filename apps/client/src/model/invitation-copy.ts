import type { InvitationEntity } from '@hermes/shared';
import { RestError } from './rest.js';

function withReference(message: string, error: RestError): string {
  return error.traceId ? `${message} Reference: ${error.traceId}.` : message;
}

/** User copy is keyed only on server-owned reason codes, never provider text. */
export function invitationFailureMessage(error: unknown): string {
  if (!(error instanceof RestError)) {
    return 'Could not record the invitation. Check your connection and try again.';
  }
  const message = error.reason === 'iris_capacity_unavailable'
    ? 'No verified Iris profile is available. Add ready capacity, then try again.'
    : error.reason === 'not_configured'
      ? 'This workspace is not connected to WorkOS invitation delivery.'
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
                  ? 'The invitation request was not valid. Refresh and try again.'
                  : error.reason === 'bad_id' || error.reason === 'unknown_invitation'
                    ? 'That invitation no longer exists. Refresh the member list.'
                    : error.reason === 'not_resendable' || error.reason === 'already_accepted'
                      ? 'That invitation can no longer be resent. Refresh the member list.'
                : 'Could not record the invitation. Try again.';
  return withReference(message, error);
}

export function invitationDeliveryMessage(invitation: InvitationEntity): string | null {
  if (!invitation.delivery_status || invitation.delivery_status === 'not_required') return null;
  if (invitation.delivery_status === 'queued') return 'Email delivery queued';
  if (invitation.delivery_status === 'sending') return 'Sending through WorkOS';
  if (invitation.delivery_status === 'delivered') return 'Sent by WorkOS';

  const message = invitation.delivery_reason === 'workos_invitation_delivery_rejected'
    ? 'WorkOS rejected the email. Check the address or WorkOS policy, then resend.'
    : invitation.delivery_reason === 'workos_invitation_payload_invalid'
      ? 'Email delivery needs Admin attention.'
      : invitation.delivery_reason === 'iris_capacity_reservation_missing'
        ? 'Email delivery is waiting for reserved Iris capacity.'
        : invitation.delivery_reason === 'workos_invitation_delivery_not_configured'
          ? 'Email delivery is waiting for WorkOS configuration.'
          : 'Email delivery will retry automatically.';
  return invitation.delivery_trace_id ? `${message} Reference: ${invitation.delivery_trace_id}.` : message;
}
