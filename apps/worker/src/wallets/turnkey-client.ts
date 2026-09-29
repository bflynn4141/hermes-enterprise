// Minimal Turnkey API client for workspace wallet setup.
//
// Every submit is classified so callers never mistake an unknown outcome for a
// failure (and retry into a duplicate sub-organization) or for a success:
//   completed  - Turnkey finished the activity; `result` is authoritative
//   rejected   - Turnkey refused it (policy or validation); nothing was created
//   pending    - Turnkey is waiting for more approvals (consensus)
//   ambiguous  - network error, timeout, 5xx, or an unfinished status; the
//                activity may or may not exist and must be reconciled
import { stampRequest, type TurnkeyApiKey } from './turnkey-stamp.js';

export type TurnkeyConfig = {
  baseUrl: string;
  parentOrgId: string;
  apiKey: TurnkeyApiKey;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type TurnkeyActivity = {
  id: string;
  status: string;
  fingerprint?: string;
  result?: Record<string, unknown>;
  failure?: { code?: number; message?: string };
};

export type SubmitOutcome =
  | { kind: 'completed'; activity: TurnkeyActivity }
  | { kind: 'rejected'; activity?: TurnkeyActivity; code?: string }
  | { kind: 'pending'; activity: TurnkeyActivity }
  | { kind: 'ambiguous'; reason: string; activityId?: string };

export class TurnkeyQueryError extends Error {
  constructor(readonly status: number | null, readonly code: string) {
    super(`Turnkey query failed (${status ?? 'network'} ${code})`);
  }
}

async function post(config: TurnkeyConfig, path: string, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const stamp = await stampRequest(body, config.apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? 15_000);
  try {
    return await (config.fetch ?? fetch)(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [stamp.name]: stamp.value },
      body,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Only the code is kept from an error body; provider messages never reach logs or users.
async function errorCode(response: Response): Promise<string> {
  try {
    const parsed = await response.json() as { code?: unknown };
    return typeof parsed.code === 'number' || typeof parsed.code === 'string' ? String(parsed.code) : 'unknown';
  } catch {
    return 'unparseable';
  }
}

export function classifyActivity(activity: TurnkeyActivity | undefined): SubmitOutcome {
  if (!activity?.id || typeof activity.status !== 'string') return { kind: 'ambiguous', reason: 'malformed_activity' };
  switch (activity.status) {
    case 'ACTIVITY_STATUS_COMPLETED': return { kind: 'completed', activity };
    case 'ACTIVITY_STATUS_REJECTED':
    case 'ACTIVITY_STATUS_FAILED': return { kind: 'rejected', activity, code: activity.status };
    case 'ACTIVITY_STATUS_CONSENSUS_NEEDED': return { kind: 'pending', activity };
    default: return { kind: 'ambiguous', reason: activity.status, activityId: activity.id };
  }
}

export async function submitActivity(config: TurnkeyConfig, path: string, type: string, organizationId: string,
  parameters: Record<string, unknown>): Promise<SubmitOutcome> {
  let response: Response;
  try {
    response = await post(config, path, { type, timestampMs: String(Date.now()), organizationId, parameters });
  } catch {
    return { kind: 'ambiguous', reason: 'transport' };
  }
  if (response.status >= 500) return { kind: 'ambiguous', reason: `http_${response.status}` };
  // A 4xx means Turnkey refused the request before creating an activity.
  if (!response.ok) return { kind: 'rejected', code: `http_${response.status}_${await errorCode(response)}` };
  try {
    const parsed = await response.json() as { activity?: TurnkeyActivity };
    return classifyActivity(parsed.activity);
  } catch {
    return { kind: 'ambiguous', reason: 'unparseable_response' };
  }
}

export async function query<T>(config: TurnkeyConfig, path: string, body: Record<string, unknown>): Promise<T> {
  let response: Response;
  try {
    response = await post(config, path, body);
  } catch {
    throw new TurnkeyQueryError(null, 'transport');
  }
  if (!response.ok) throw new TurnkeyQueryError(response.status, await errorCode(response));
  return await response.json() as T;
}

export type PasskeyAttestation = {
  credentialId: string;
  clientDataJson: string;
  attestationObject: string;
  transports: string[];
};

/** Creates a sub-organization whose only root user is one passkey holder. */
export function createRootedSubOrganization(config: TurnkeyConfig, input: {
  name: string; rootUserName: string; challenge: string; attestation: PasskeyAttestation;
}): Promise<SubmitOutcome> {
  return submitActivity(config, '/public/v1/submit/create_sub_organization', 'ACTIVITY_TYPE_CREATE_SUB_ORGANIZATION_V8',
    config.parentOrgId, {
      subOrganizationName: input.name,
      rootQuorumThreshold: 1,
      rootUsers: [{
        userName: input.rootUserName,
        apiKeys: [],
        oauthProviders: [],
        authenticators: [{ authenticatorName: 'Hermes workspace passkey', challenge: input.challenge, attestation: input.attestation }],
      }],
      // No email, SMS or OTP recovery: the passkey (and later, more admin
      // passkeys) are the only way in. Hermes never becomes a recovery path.
      disableEmailRecovery: true,
      disableEmailAuth: true,
      disableSmsAuth: true,
      disableOtpEmailAuth: true,
    });
}

export function subOrganizationResult(activity: TurnkeyActivity): { subOrganizationId: string; rootUserIds: string[] } | null {
  const result = activity.result?.createSubOrganizationResultV8 as { subOrganizationId?: unknown; rootUserIds?: unknown } | undefined;
  if (typeof result?.subOrganizationId !== 'string' || !Array.isArray(result.rootUserIds)
    || !result.rootUserIds.every((id): id is string => typeof id === 'string')) return null;
  return { subOrganizationId: result.subOrganizationId, rootUserIds: result.rootUserIds };
}

export async function findSubOrganizationsByName(config: TurnkeyConfig, name: string): Promise<string[]> {
  const { organizationIds } = await query<{ organizationIds?: string[] }>(config, '/public/v1/query/list_suborgs',
    { organizationId: config.parentOrgId, filterType: 'NAME', filterValue: name });
  return organizationIds ?? [];
}

export type RootReadBack = {
  threshold: number;
  rootUserIds: string[];
  users: { userId: string; apiKeyCount: number; credentialIds: string[] }[];
};

/** Reads a sub-organization's root quorum and users with the parent's read access. */
export async function readRoot(config: TurnkeyConfig, subOrganizationId: string): Promise<RootReadBack> {
  const { configs } = await query<{ configs?: { quorum?: { threshold?: number; userIds?: string[] } } }>(config,
    '/public/v1/query/get_organization_configs', { organizationId: subOrganizationId });
  const { users } = await query<{ users?: { userId: string; apiKeys?: unknown[]; authenticators?: { credentialId?: string }[] }[] }>(
    config, '/public/v1/query/list_users', { organizationId: subOrganizationId });
  return {
    threshold: configs?.quorum?.threshold ?? 0,
    rootUserIds: configs?.quorum?.userIds ?? [],
    users: (users ?? []).map((user) => ({
      userId: user.userId,
      apiKeyCount: user.apiKeys?.length ?? 0,
      credentialIds: (user.authenticators ?? []).map((a) => a.credentialId ?? ''),
    })),
  };
}

/** Credential ids compare as bytes: Turnkey may report base64 where the browser gave base64url. */
export function sameCredentialId(a: string, b: string): boolean {
  const bytes = (value: string) => {
    const normal = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    if (!/^[A-Za-z0-9+/]+$/.test(normal)) return null;
    try { return atob(normal.padEnd(Math.ceil(normal.length / 4) * 4, '=')); } catch { return null; }
  };
  const left = bytes(a), right = bytes(b);
  return left !== null && left.length > 0 && left === right;
}

/**
 * The customer-custody check: exactly one root user, threshold one, that user is
 * the enrolled passkey holder with no API keys, and nobody else exists yet. A
 * sub-organization that fails this is never marked ready.
 */
export function rootIsCustomerOwned(readBack: RootReadBack, expected: { rootUserId: string; credentialId: string }): boolean {
  const [user] = readBack.users;
  return readBack.threshold === 1
    && readBack.rootUserIds.length === 1 && readBack.rootUserIds[0] === expected.rootUserId
    && readBack.users.length === 1 && user!.userId === expected.rootUserId
    && user!.apiKeyCount === 0
    && user!.credentialIds.length === 1 && sameCredentialId(user!.credentialIds[0]!, expected.credentialId);
}
