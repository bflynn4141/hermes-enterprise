import { AuthError } from '../auth/types.js';
import { classifyWorkOSError } from '../auth/workos.js';
import { TenancyError } from '../db/client.js';
import { logEvent } from '../keys/redact.js';

export type InvitationDiagnosticAction = 'create' | 'resend' | 'send_delivery' | 'resend_delivery';

interface InvitationDiagnostic {
  readonly action: InvitationDiagnosticAction;
  readonly checkpoint: string;
  readonly correlationId: string;
  readonly workspaceId: string;
  readonly invitationId?: string | null;
  readonly jobId?: string | null;
  readonly ok: boolean;
  readonly reason?: string | null;
  readonly status?: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIAGNOSTIC_CHECKPOINTS = new Set([
  'request_received',
  'setup_mode_rejected',
  'setup_role_rejected',
  'admin_and_rate_admitted',
  'organization_binding_checked',
  'invitation_stored',
  'duplicate_resolved',
  'invitation_locked',
  'successor_stored',
  'capacity_reserved',
  'capacity_transferred_or_reserved',
  'sync_and_expiry_jobs_prepared',
  'committed',
  'job_claimed',
  'job_payload_invalid',
  'provider_unavailable',
  'reservation_recheck_failed',
  'ambiguous_delivery_detected',
  'terminal_delivery_replayed',
  'delivery_already_resolved',
  'pending_and_reservation_rechecked',
  'provider_attempted',
  'provider_accepted',
  'provider_failed',
  'local_delivery_committed',
  'local_delivery_commit_failed',
]);
const DIAGNOSTIC_REASONS = new Set([
  'bad_body', 'bad_id', 'bad_email', 'admin_required', 'rate_limited', 'not_configured',
  'bad_role_template', 'member_setup_unavailable', 'member_setup_role_unavailable',
  'invitation_mode_conflict', 'invitation_role_conflict',
  'iris_capacity_unavailable', 'invite_failed', 'resend_failed', 'unknown_invitation',
  'not_resendable', 'already_accepted', 'no_session', 'unknown_user', 'invalid_session',
  'upstream_unavailable', 'forbidden_origin', 'csrf_failed', 'not_a_member', 'no_workspace',
  'bad_workspace_id', 'invitation_failed', 'already_member', 'duplicate', 'delivery_queued',
  'setup_queued',
  'workos_invitation_delivery_not_configured', 'workos_invitation_payload_invalid',
  'iris_capacity_reservation_missing', 'workos_invitation_delivery_rejected',
  'workos_invitation_delivery_unavailable', 'workos_invitation_delivery_outcome_unknown',
  'workos_invitation_local_commit_failed',
]);

export function invitationCorrelationId(value?: unknown): string {
  return typeof value === 'string' && UUID.test(value) ? value : crypto.randomUUID();
}

/**
 * Invitation logs are an explicit allowlist. Free text never reaches this
 * function, so a recipient address or an upstream response cannot be carried
 * through by a future error type whose message happens to look harmless.
 */
export function logInvitationDiagnostic(input: InvitationDiagnostic): void {
  const checkpoint = DIAGNOSTIC_CHECKPOINTS.has(input.checkpoint) ? input.checkpoint : 'unclassified';
  const reason = input.reason && DIAGNOSTIC_REASONS.has(input.reason) ? input.reason : input.reason ? 'invitation_failed' : null;
  logEvent({
    at: 'invitation.lifecycle',
    action: input.action,
    checkpoint,
    correlation_id: invitationCorrelationId(input.correlationId),
    workspace_id: UUID.test(input.workspaceId) ? input.workspaceId : 'invalid',
    ...(input.invitationId && UUID.test(input.invitationId) ? { invitation_id: input.invitationId } : {}),
    ...(input.jobId && UUID.test(input.jobId) ? { job_id: input.jobId } : {}),
    ok: input.ok,
    ...(reason ? { reason } : {}),
    ...(input.status ? { status: input.status } : {}),
  });
}

const ROUTE_REASONS = new Set([
  'bad_body',
  'bad_id',
  'bad_email',
  'bad_role_template',
  'admin_required',
  'rate_limited',
  'not_configured',
  'iris_capacity_unavailable',
  'invite_failed',
  'resend_failed',
  'unknown_invitation',
  'not_resendable',
  'already_accepted',
  'member_setup_unavailable',
  'member_setup_role_unavailable',
  'invitation_mode_conflict',
  'invitation_role_conflict',
]);

const SAFE_MESSAGES: Readonly<Record<string, string>> = {
  bad_body: 'The invitation request was not valid JSON.',
  bad_id: 'That invitation reference is not valid.',
  bad_email: 'Enter a valid email address.',
  bad_role_template: 'Choose a supported job role.',
  admin_required: 'Only a workspace Admin can invite members.',
  rate_limited: 'Too many invitation attempts were made. Wait a moment and try again.',
  not_configured: 'This workspace is not connected to WorkOS invitation delivery.',
  iris_capacity_unavailable: 'No verified Iris profile is available for this invitation.',
  invite_failed: 'The invitation could not be recorded.',
  resend_failed: 'The invitation resend could not be recorded.',
  unknown_invitation: 'That invitation no longer exists.',
  not_resendable: 'That invitation cannot be resent in its current state.',
  already_accepted: 'That invitation has already been accepted.',
  member_setup_unavailable: 'Background member setup is not available in this deployment.',
  member_setup_role_unavailable: 'Finance agent setup is not available yet. Choose an available job role.',
  invitation_mode_conflict: 'This address already has an invitation in a different delivery flow.',
  invitation_role_conflict: 'This address already has setup in progress for a different job role.',
  no_session: 'Your session has ended. Sign in and try again.',
  unknown_user: 'Your account could not be verified. Sign in and try again.',
  invalid_session: 'Your session could not be verified. Sign in and try again.',
  upstream_unavailable: 'WorkOS authentication is temporarily unavailable.',
  forbidden_origin: 'The invitation request came from an untrusted origin.',
  csrf_failed: 'The invitation request could not be verified. Refresh and try again.',
  not_a_member: 'Workspace not found.',
  no_workspace: 'Workspace not found.',
  bad_workspace_id: 'Workspace not found.',
  invitation_failed: 'The invitation could not be recorded.',
};

export class InvitationRequestError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    readonly traceId: string,
  ) {
    super(SAFE_MESSAGES[reason] ?? SAFE_MESSAGES.invitation_failed);
    this.name = 'InvitationRequestError';
  }
}

export function trackInvitationRequestFailure(input: {
  readonly action: 'create' | 'resend';
  readonly checkpoint: string;
  readonly correlationId: string;
  readonly workspaceId: string;
  readonly invitationId?: string | null;
  readonly error: unknown;
}): InvitationRequestError {
  let reason = 'invitation_failed';
  let status = 500;
  const routeError = input.error as { name?: unknown; reason?: unknown; status?: unknown };
  if (input.error instanceof Error && routeError.name === 'RouteError'
      && typeof routeError.reason === 'string' && ROUTE_REASONS.has(routeError.reason)
      && typeof routeError.status === 'number') {
    reason = routeError.reason;
    status = routeError.status;
  } else if (input.error instanceof AuthError) {
    reason = input.error.reason;
    status = input.error.status;
  } else if (input.error instanceof TenancyError) {
    reason = input.error.reason;
    status = input.error.reason === 'not_a_member' ? 404 : 400;
  }
  const traceId = invitationCorrelationId(input.correlationId);
  logInvitationDiagnostic({
    action: input.action,
    checkpoint: input.checkpoint,
    correlationId: traceId,
    workspaceId: input.workspaceId,
    invitationId: input.invitationId,
    ok: false,
    reason,
    status,
  });
  return new InvitationRequestError(status, reason, traceId);
}

export interface InvitationDeliveryFailure {
  readonly reason:
    | 'workos_invitation_delivery_rejected'
    | 'workos_invitation_delivery_unavailable'
    | 'workos_invitation_delivery_outcome_unknown';
  readonly retryAfterSeconds: number;
  readonly retryable: boolean;
}

export function classifyInvitationDeliveryFailure(error: unknown): InvitationDeliveryFailure {
  const status = (error as { status?: unknown })?.status;
  if (typeof status !== 'number' || status <= 0) {
    return {
      reason: 'workos_invitation_delivery_outcome_unknown',
      retryAfterSeconds: 0,
      retryable: false,
    };
  }
  if (status >= 400 && status < 500 && status !== 429) {
    return {
      reason: 'workos_invitation_delivery_rejected',
      retryAfterSeconds: 0,
      retryable: false,
    };
  }
  const classified = classifyWorkOSError(error);
  return classified.terminal
    ? { reason: 'workos_invitation_delivery_rejected', retryAfterSeconds: 0, retryable: false }
    : {
        reason: 'workos_invitation_delivery_unavailable',
        retryAfterSeconds: classified.retryAfter,
        retryable: true,
      };
}

export class InvitationDeliveryError extends Error {
  constructor(
    readonly reason: string,
    readonly retryAfterSeconds = 0,
    readonly retryable = true,
  ) {
    super(reason);
    this.name = 'InvitationDeliveryError';
  }
}
