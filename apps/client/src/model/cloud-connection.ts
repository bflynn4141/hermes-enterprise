import type { CloudConnectionStatus } from '@hermes/shared';
export { cloudConnectionStatusSchema, type CloudConnectionStatus } from '@hermes/shared';

export function cloudConnectionPresentation(connection: CloudConnectionStatus, available = true) {
  const presentation = (() => {
    switch (connection.status) {
      case 'not_connected':
        return { label: 'Not connected', description: 'Connect your organization’s Nous Cloud account to set up agents from Hermes.', action: 'Connect Cloud', tone: 'neutral' } as const;
      case 'connecting':
        return { label: 'Connection pending', description: 'Finish connecting in Nous Cloud, or start again if you closed it.', action: 'Connect again', tone: 'neutral' } as const;
      case 'reconnect_required':
        return { label: 'Reconnect needed', description: 'Reconnect your organization’s account to restore Cloud access.', action: 'Reconnect Cloud', tone: 'attention' } as const;
      case 'verification_required':
        return { label: 'Verification needed', description: 'Cloud access is saved. Organization access and automatic agent setup still need verification.', action: 'Reconnect Cloud', tone: 'attention' } as const;
      case 'connected':
        return {
          label: 'Connected',
          description: connection.automatic_setup_ready
            ? 'Automatic agent setup is ready.'
            : 'Your account is connected. Automatic agent setup still needs verification.',
          action: null,
          tone: connection.automatic_setup_ready ? 'ready' : 'neutral',
        } as const;
    }
  })();

  // When Cloud is not offered yet, never present a Connect/Reconnect success path.
  if (!available && presentation.action) {
    return {
      label: 'Not available',
      description: 'Cloud connection is not available yet.',
      action: null,
      tone: 'neutral',
    } as const;
  }

  return presentation;
}

/** Map stable reasons, never provider error text (which can contain credentials). */
export function cloudConnectionErrorMessage(reason: string): string {
  switch (reason) {
    case 'admin_required': return 'Only an organization admin can connect Cloud.';
    case 'cloud_connection_unavailable': return 'Cloud connection is not available yet.';
    case 'cloud_connection_cancelled': return 'Connection was cancelled. You can try again.';
    case 'cloud_connection_expired': return 'The connection request expired. Please try again.';
    case 'cloud_organization_mismatch': return 'This Cloud account could not be verified for your organization.';
    default: return 'Cloud could not be connected. Please try again.';
  }
}
