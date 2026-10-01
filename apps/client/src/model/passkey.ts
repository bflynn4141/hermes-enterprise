// Creates the Admin's workspace-owner passkey (C103).
//
// The Worker issues a single-use challenge; the browser's authenticator creates
// a passkey for the deployment's relying party and returns an attestation. The
// private key never leaves the authenticator: Hermes forwards only the public
// attestation to Turnkey, which makes this passkey the sub-organization's root.
import type { WalletRootChallenge, WalletRootSubmit, MemberWalletOperation, MemberWalletStamp } from '@hermes/shared';

export class PasskeyError extends Error {
  constructor(readonly reason: 'unsupported' | 'cancelled' | 'failed') {
    super(reason);
  }
}

const TRANSPORTS = new Set(['internal', 'usb', 'nfc', 'ble', 'hybrid']);

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function toBase64url(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Ask the browser to offer this device's own authenticator first (Touch ID on a
 * Mac, Face ID or fingerprint on a phone) instead of opening with the "use a
 * phone or security key" chooser. A hint, not a restriction: security keys and
 * phones still work for people who choose them (WebAuthn Level 3 `hints`;
 * browsers without it ignore the field).
 */
const TOUCH_ID_FIRST = { hints: ['client-device'] } as Record<string, unknown>;

export async function createWorkspacePasskey(challenge: WalletRootChallenge): Promise<WalletRootSubmit['attestation']> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential || !navigator.credentials?.create) {
    throw new PasskeyError('unsupported');
  }
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge: fromBase64url(challenge.challenge),
        rp: { id: challenge.rp_id, name: 'Hermes' },
        user: { id: fromBase64url(challenge.user_handle), name: challenge.user_name, displayName: challenge.user_name },
        // ES256 first: Turnkey signs requests with P-256 passkeys.
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        // Custody needs a person, not just a device: require biometrics or a PIN.
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        attestation: 'none',
        timeout: 5 * 60 * 1000,
        ...TOUCH_ID_FIRST,
      },
    });
  } catch (error) {
    throw new PasskeyError(error instanceof DOMException && error.name === 'NotAllowedError' ? 'cancelled' : 'failed');
  }
  if (!(credential instanceof PublicKeyCredential)) throw new PasskeyError('cancelled');
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = (response.getTransports?.() ?? []).filter((t): t is WalletRootSubmit['attestation']['transports'][number] => TRANSPORTS.has(t));
  return {
    credential_id: toBase64url(credential.rawId),
    client_data_json: toBase64url(response.clientDataJSON),
    attestation_object: toBase64url(response.attestationObject),
    transports,
  };
}

/** Signs exactly the server-reviewed operation; no client-generated policy bytes. */
export async function signWorkspaceOperation(request: NonNullable<MemberWalletOperation['request']>): Promise<MemberWalletStamp> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential || !navigator.credentials?.get) throw new PasskeyError('unsupported');
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({ publicKey: {
      challenge: fromBase64url(request.challenge), rpId: request.rp_id,
      allowCredentials: [{ type: 'public-key', id: fromBase64url(request.credential_id) }],
      userVerification: 'required', timeout: 120_000, ...TOUCH_ID_FIRST,
    } });
  } catch (error) {
    throw new PasskeyError(error instanceof DOMException && error.name === 'NotAllowedError' ? 'cancelled' : 'failed');
  }
  if (!(credential instanceof PublicKeyCredential)) throw new PasskeyError('cancelled');
  const response = credential.response as AuthenticatorAssertionResponse;
  return { credentialId: toBase64url(credential.rawId), authenticatorData: toBase64url(response.authenticatorData),
    clientDataJson: toBase64url(response.clientDataJSON), signature: toBase64url(response.signature) };
}
