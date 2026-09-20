// Public, secret-free projection of a durable invitation operation. Provider
// payloads and granular credentials never belong in client state. Preparation
// and delivery remain independent so an uncertain send cannot be replayed.
import { z } from 'zod';
import { uuidSchema } from './events.js';

export const memberPreparationSchema = z.enum([
  'awaiting_connection', 'queued', 'creating', 'configuring', 'verifying',
  'ready', 'reconciliation_required', 'failed',
]);
export const memberDeliverySchema = z.enum([
  'not_queued', 'queued', 'sending', 'sent', 'reconciliation_required', 'failed',
]);
export const memberProvisioningIssueSchema = z.enum([
  'cloud_not_connected', 'cloud_reconnect_required', 'billing_unverified',
  'insufficient_credits', 'cloud_contract_unverified', 'bootstrap_unsupported',
  'readiness_failed', 'creation_outcome_unknown', 'delivery_outcome_unknown',
  'delivery_rejected', 'authorization_revoked', 'temporary_failure',
]);
export const memberRoleTemplateSchema = z.enum(['partnerships-agent', 'finance-agent']);
export type MemberRoleTemplate = z.infer<typeof memberRoleTemplateSchema>;

export const memberProvisioningOperationSchema = z.object({
  id: uuidSchema,
  workspace_id: uuidSchema,
  revision: z.number().int().nonnegative(),
  preparation: memberPreparationSchema,
  delivery: memberDeliverySchema,
  membership: z.enum(['not_joined', 'joined']),
  cancellation: z.enum(['none', 'requested', 'complete']),
  issue: memberProvisioningIssueSchema.nullable(),
}).strict().superRefine((operation, context) => {
  if (operation.preparation !== 'ready' && operation.delivery !== 'not_queued') {
    context.addIssue({ code: 'custom', message: 'Email requires verified preparation', path: ['delivery'] });
  }
  if (operation.membership === 'joined' && operation.delivery !== 'sent') {
    context.addIssue({ code: 'custom', message: 'Joined requires a confirmed invitation', path: ['membership'] });
  }
  if (operation.membership === 'joined' && operation.cancellation !== 'none') {
    context.addIssue({ code: 'custom', message: 'Joined membership uses member removal, not invite cancellation', path: ['cancellation'] });
  }
});
export type MemberProvisioningOperation = z.infer<typeof memberProvisioningOperationSchema>;

export interface MemberProvisioningPresentation {
  label: string;
  detail: string;
  tone: 'neutral' | 'attention' | 'positive';
  action: 'connect_cloud' | 'review_billing' | 'contact_admin' | 'resend' | null;
  canCancel: boolean;
}

/** No provider text, simulated progress or optimistic completion in the cards. */
export function memberProvisioningPresentation(
  operation: MemberProvisioningOperation,
  options: { setupEnabled?: boolean } = {},
): MemberProvisioningPresentation {
  const value = memberProvisioningOperationSchema.parse(operation);
  const result = (label: string, detail: string, tone: MemberProvisioningPresentation['tone'],
    action: MemberProvisioningPresentation['action'] = null): MemberProvisioningPresentation => ({
    label, detail, tone, action, canCancel: value.membership !== 'joined' && value.cancellation === 'none',
  });
  if (value.membership === 'joined') return result('Joined', 'Their dedicated agent is ready.', 'positive');
  if (value.cancellation === 'complete') return result('Cancelled', 'This invitation has been cancelled.', 'neutral');
  if (value.cancellation === 'requested') return result('Cancelling', 'Confirming that setup and the invitation have stopped.', 'neutral');
  if (value.delivery === 'sent') return result('Invited', 'Waiting for them to join.', 'positive', 'resend');
  if (options.setupEnabled === false && value.preparation !== 'ready') {
    return result('Setup paused', 'Setup is paused. You can cancel this invitation or wait for setup to resume.', 'attention');
  }
  if (value.preparation === 'reconciliation_required' || value.delivery === 'reconciliation_required') {
    return result('Needs attention', 'Checking the previous attempt before trying again.', 'attention', 'contact_admin');
  }
  if (value.issue === 'cloud_not_connected' || value.issue === 'cloud_reconnect_required' || value.preparation === 'awaiting_connection') {
    return result('Connect Cloud', 'An admin needs to connect the organization to continue setup.', 'attention', 'connect_cloud');
  }
  if (value.issue === 'billing_unverified' || value.issue === 'insufficient_credits') {
    return result('Check billing', 'An admin needs to check the organization’s Cloud billing.', 'attention', 'review_billing');
  }
  if (value.issue === 'authorization_revoked') {
    return result('Setup paused', 'An active Admin needs to start this setup again.', 'attention', 'contact_admin');
  }
  if (value.delivery === 'failed' && value.issue === 'delivery_rejected') {
    return result('Invite not sent', 'Check the email address before resending.', 'attention', 'resend');
  }
  if (value.issue !== null || value.preparation === 'failed' || value.delivery === 'failed') {
    return result('Needs attention', 'Setup or invitation delivery could not finish.', 'attention', 'contact_admin');
  }
  if (value.delivery === 'queued' || value.delivery === 'sending') {
    return result('Sending invite', 'Their agent is ready. Sending the invitation.', 'neutral');
  }
  if (value.preparation === 'ready') {
    return result('Agent ready', 'Setup is verified. Invitation delivery has not been queued.', 'positive');
  }
  return result('Setting up agent', 'Hermes is preparing verified capacity in the background.', 'neutral');
}

export type MemberProvisioningNextStep =
  | 'wait_for_connection' | 'reserve_or_create' | 'reconcile_create'
  | 'configure' | 'verify' | 'queue_email' | 'deliver_email'
  | 'reconcile_delivery' | 'reconcile_cancellation' | 'wait' | 'needs_attention' | 'complete';

/**
 * Recovery planner only; execution belongs to a claimed, revision-checked job.
 * A persisted in-flight creation/send always reconciles instead of retrying.
 */
export function nextMemberProvisioningStep(operation: MemberProvisioningOperation): MemberProvisioningNextStep {
  const value = memberProvisioningOperationSchema.parse(operation);
  if (value.membership === 'joined' || value.cancellation === 'complete') return 'complete';
  if (value.cancellation === 'requested') return 'reconcile_cancellation';
  if (value.delivery === 'sent') return 'wait';
  if (value.delivery === 'sending' || value.delivery === 'reconciliation_required') return 'reconcile_delivery';
  if (value.preparation === 'creating' || value.preparation === 'reconciliation_required') return 'reconcile_create';
  if (value.preparation === 'awaiting_connection' || value.issue === 'cloud_not_connected' || value.issue === 'cloud_reconnect_required') return 'wait_for_connection';
  if (value.issue !== null || value.preparation === 'failed' || value.delivery === 'failed') return 'needs_attention';
  if (value.delivery === 'queued') return 'deliver_email';
  switch (value.preparation) {
    case 'queued': return 'reserve_or_create';
    case 'configuring': return 'configure';
    case 'verifying': return 'verify';
    case 'ready': return 'queue_email';
  }
}
