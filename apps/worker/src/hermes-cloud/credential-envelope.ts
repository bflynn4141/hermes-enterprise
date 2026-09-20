import type { SecretEnvelopeIdentity } from '../keys/envelope.js';

export type CloudCredentialKind = 'cloud_connection' | 'cloud_connection_attempt';

/**
 * Stable AAD domains for the two Cloud OAuth payload classes. An authorization
 * attempt contains PKCE/session material; a management grant contains durable
 * organization credentials. They must never authenticate as each other or as
 * a provider inference key even when a row id is reused across the hand-off.
 */
export const CLOUD_CREDENTIAL_NAMESPACES = {
  cloud_connection: 'hermes/cloud-management-grant/v1',
  cloud_connection_attempt: 'hermes/cloud-oauth-attempt/v1',
} as const;

export function cloudCredentialIdentity(
  kind: CloudCredentialKind,
  workspaceId: string,
  keyId: string,
): SecretEnvelopeIdentity {
  return { workspaceId, keyId, namespace: CLOUD_CREDENTIAL_NAMESPACES[kind] };
}
