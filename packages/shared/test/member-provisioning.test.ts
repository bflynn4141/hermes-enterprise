import { describe, expect, it } from 'vitest';
import { memberProvisioningOperationSchema, memberProvisioningPresentation, nextMemberProvisioningStep,
  type MemberProvisioningOperation } from '../src/member-provisioning.js';

const base: MemberProvisioningOperation = {
  id: 'e9091a44-4720-43cf-991b-532021db04d2', workspace_id: '136ff4c3-bf24-472a-b9b2-a952b337b25b', revision: 0,
  preparation: 'queued', delivery: 'not_queued', membership: 'not_joined', cancellation: 'none', issue: null,
};
describe('Member provisioning public state and recovery', () => {
  it('keeps disconnected setup honest and actionable', () => {
    const operation = { ...base, preparation: 'awaiting_connection' as const };
    expect(memberProvisioningPresentation(operation)).toMatchObject({ label: 'Connect Cloud', action: 'connect_cloud' });
    expect(nextMemberProvisioningStep(operation)).toBe('wait_for_connection');
  });
  it.each(['queued', 'creating', 'configuring', 'verifying'] as const)('cannot queue an email during %s', preparation => {
    expect(memberProvisioningOperationSchema.safeParse({ ...base, preparation, delivery: 'queued' }).success).toBe(false);
    expect(memberProvisioningPresentation({ ...base, preparation }).label).toBe('Setting up agent');
  });
  it('resumes an uncertain create by reconciliation, never another create', () => {
    expect(nextMemberProvisioningStep({ ...base, preparation: 'creating' })).toBe('reconcile_create');
    expect(nextMemberProvisioningStep({ ...base, preparation: 'reconciliation_required', issue: 'creation_outcome_unknown' })).toBe('reconcile_create');
  });
  it('never replays an uncertain email or offers resend', () => {
    for (const delivery of ['sending', 'reconciliation_required'] as const) {
      const operation = { ...base, preparation: 'ready' as const, delivery };
      expect(nextMemberProvisioningStep(operation)).toBe('reconcile_delivery');
      expect(memberProvisioningPresentation(operation).action).not.toBe('resend');
    }
  });
  it('requires confirmed readiness to queue and deliver', () => {
    expect(nextMemberProvisioningStep({ ...base, preparation: 'ready' })).toBe('queue_email');
    expect(nextMemberProvisioningStep({ ...base, preparation: 'ready', delivery: 'queued' })).toBe('deliver_email');
    expect(memberProvisioningPresentation({ ...base, preparation: 'ready' })).toMatchObject({
      label: 'Agent ready', detail: 'Setup is verified. Invitation delivery has not been queued.',
    });
  });
  it('never presents a delayed cancellation as complete', () => {
    const operation = { ...base, preparation: 'creating' as const, cancellation: 'requested' as const };
    expect(memberProvisioningPresentation(operation)).toMatchObject({ label: 'Cancelling', canCancel: false });
    expect(nextMemberProvisioningStep(operation)).toBe('reconcile_cancellation');
  });
  it('does not overwrite the sent fact when the connection later expires', () => {
    const operation = { ...base, preparation: 'ready' as const, delivery: 'sent' as const, issue: 'cloud_reconnect_required' as const };
    expect(memberProvisioningPresentation(operation).label).toBe('Invited');
    expect(nextMemberProvisioningStep(operation)).toBe('wait');
  });
  it('shows unfinished setup as paused when the deployment is not advancing setup', () => {
    expect(memberProvisioningPresentation(base, { setupEnabled: false })).toMatchObject({
      label: 'Setup paused', canCancel: true, action: null,
    });
    expect(memberProvisioningPresentation({ ...base, preparation: 'ready' }, { setupEnabled: false }).label)
      .toBe('Agent ready');
    expect(memberProvisioningPresentation({
      ...base, preparation: 'ready', delivery: 'sent',
    }, { setupEnabled: false }).label).toBe('Invited');
  });
  it('keeps billing and unsupported bootstrap blocked', () => {
    for (const issue of ['billing_unverified', 'insufficient_credits', 'bootstrap_unsupported'] as const) {
      expect(nextMemberProvisioningStep({ ...base, issue })).toBe('needs_attention');
    }
    expect(memberProvisioningPresentation({ ...base, issue: 'insufficient_credits' }).action).toBe('review_billing');
    expect(memberProvisioningPresentation({ ...base, issue: 'bootstrap_unsupported' }).label).toBe('Needs attention');
    expect(memberProvisioningPresentation({ ...base, issue: 'authorization_revoked' })).toMatchObject({
      label: 'Setup paused', action: 'contact_admin',
    });
  });
  it('rejects provider data and secrets from the public contract', () => {
    expect(memberProvisioningOperationSchema.safeParse({ ...base, access_token: 'secret' }).success).toBe(false);
    expect(memberProvisioningOperationSchema.safeParse({ ...base, issue: 'arbitrary provider payload' }).success).toBe(false);
  });
  it('does not confuse a joined member with a cancellable invitation', () => {
    const operation = { ...base, preparation: 'ready' as const, delivery: 'sent' as const, membership: 'joined' as const };
    expect(memberProvisioningPresentation(operation)).toMatchObject({ label: 'Joined', canCancel: false });
    expect(nextMemberProvisioningStep(operation)).toBe('complete');
    expect(memberProvisioningOperationSchema.safeParse({ ...operation, cancellation: 'requested' }).success).toBe(false);
  });
});
