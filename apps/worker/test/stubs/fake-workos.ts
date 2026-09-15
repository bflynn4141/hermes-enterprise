// A WorkOS that runs in the test process.
//
// The SDK talks to api.workos.com, and WorkOS's own local story (Emulate) needs
// a live environment and credentials, so a test that wanted to prove "a
// deactivation event produces the same rows as our route" had two options:
// intercept HTTP, or implement the interface. The interface is smaller and says
// what it does, so this implements `WorkOSPort`.
//
// It is real where realism matters: the access token is a genuine RS256 JWT
// signed by a key this double publishes as a JWKS, so the production code path
// verifies a signature, handles an unknown `kid` and honours `exp` exactly as
// it does against WorkOS. It is fake where realism would only be ceremony: the
// "sealed" cookie is base64 JSON, because what the tests exercise is our
// handling of the seal, not iron-session's cryptography.
import type {
  WorkOSAuthentication,
  WorkOSEvent,
  WorkOSInvitation,
  WorkOSMembership,
  WorkOSPort,
  WorkOSUser,
} from '../../src/auth/workos.js';

interface Keys {
  privateKey: CryptoKey;
  /** The `kid` and `alg` a JWKS carries are not in the DOM's `JsonWebKey`. */
  jwks: { keys: (JsonWebKey & { kid?: string; alg?: string })[] };
  kid: string;
}

let keys: Keys | null = null;

/** One key pair for the whole test process; `kid` names it in the JWKS. */
export async function signingKeys(kid = 'test-key-1'): Promise<Keys> {
  if (keys && keys.kid === kid) return keys;
  // The Workers types declare `generateKey` as returning a key or a pair; RSA
  // always returns a pair, and the narrowing says so in one place.
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const generated: Keys = {
    privateKey: pair.privateKey,
    kid,
    jwks: { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] },
  };
  keys = generated;
  return generated;
}

const b64url = (input: string | Uint8Array): string => {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export async function signAccessToken(claims: {
  sub: string;
  sid: string;
  exp?: number;
  iat?: number;
  org_id?: string;
  role?: string;
}): Promise<string> {
  const { privateKey, kid } = await signingKeys();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
  const payload = b64url(
    JSON.stringify({
      iss: 'https://api.workos.com',
      iat: claims.iat ?? now,
      exp: claims.exp ?? now + 300,
      ...claims,
    }),
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

export const seal = (data: unknown): string => b64url(JSON.stringify(data));
export const unsealData = <T>(sealed: string): T | null => {
  try {
    const padded = sealed.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(sealed.length / 4) * 4, '=');
    return JSON.parse(atob(padded)) as T;
  } catch {
    return null;
  }
};

interface SealedPayload {
  accessToken: string;
  user: WorkOSUser;
}

/** A WorkOS failure of the kind the refresh path has to tell apart. */
export class FakeWorkOSError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class FakeWorkOS implements WorkOSPort {
  readonly users = new Map<string, WorkOSUser>();
  readonly memberships: WorkOSMembership[] = [];
  readonly invitations: WorkOSInvitation[] = [];
  readonly events: WorkOSEvent[] = [];
  readonly calls: { method: string; argument: unknown }[] = [];
  /** Set to make the next refresh fail the way WorkOS would. */
  refreshFailure: FakeWorkOSError | null = null;
  /** The code `/auth/callback` will be given, and who it resolves to. */
  pendingCode: { code: string; userId: string; organizationId: string | null; sid: string } | null = null;

  authorizationUrl(options: { redirectUri: string; state?: string; maxAge?: number }): string {
    this.calls.push({ method: 'authorizationUrl', argument: options });
    const url = new URL('https://api.workos.com/user_management/authorize');
    url.searchParams.set('redirect_uri', options.redirectUri);
    if (options.state) url.searchParams.set('state', options.state);
    if (options.maxAge !== undefined) url.searchParams.set('max_age', String(options.maxAge));
    return url.toString();
  }

  async authenticateWithCode(options: { code: string }): Promise<WorkOSAuthentication> {
    this.calls.push({ method: 'authenticateWithCode', argument: options });
    const pending = this.pendingCode;
    if (!pending || pending.code !== options.code) throw new FakeWorkOSError('bad code', 400, 'invalid_grant');
    const user = this.users.get(pending.userId);
    if (!user) throw new FakeWorkOSError('unknown user', 404);
    const accessToken = await signAccessToken({
      sub: user.id,
      sid: pending.sid,
      ...(pending.organizationId ? { org_id: pending.organizationId } : {}),
    });
    return {
      user,
      organizationId: pending.organizationId,
      accessToken,
      sealedSession: seal({ accessToken, user } satisfies SealedPayload),
    };
  }

  unseal(sealed: string): Promise<{ accessToken: string; user: WorkOSUser } | null> {
    return Promise.resolve(unsealData<SealedPayload>(sealed));
  }

  async refresh(sealed: string): Promise<{ sealedSession: string; accessToken: string }> {
    this.calls.push({ method: 'refresh', argument: sealed });
    if (this.refreshFailure) throw this.refreshFailure;
    const current = unsealData<SealedPayload>(sealed);
    if (!current) throw new FakeWorkOSError('bad cookie', 400, 'invalid_grant');
    const previous = JSON.parse(
      atob(
        (current.accessToken.split('.')[1] ?? '')
          .replace(/-/g, '+')
          .replace(/_/g, '/')
          .padEnd(Math.ceil((current.accessToken.split('.')[1] ?? '').length / 4) * 4, '='),
      ),
    ) as { sub: string; sid: string };
    const accessToken = await signAccessToken({ sub: previous.sub, sid: previous.sid });
    return { sealedSession: seal({ accessToken, user: current.user }), accessToken };
  }

  logoutUrl(): Promise<string> {
    return Promise.resolve('https://api.workos.com/user_management/sessions/logout');
  }

  createOrganization(name: string): Promise<{ id: string }> {
    this.calls.push({ method: 'createOrganization', argument: name });
    return Promise.resolve({ id: `org_${crypto.randomUUID().slice(0, 8)}` });
  }

  listOrganizationMemberships(options: {
    userId?: string;
    organizationId?: string;
  }): Promise<WorkOSMembership[]> {
    return Promise.resolve(
      this.memberships.filter(
        (membership) =>
          (!options.userId || membership.userId === options.userId) &&
          (!options.organizationId || membership.organizationId === options.organizationId),
      ),
    );
  }

  updateOrganizationMembership(membershipId: string, roleSlug: string): Promise<void> {
    this.calls.push({ method: 'updateOrganizationMembership', argument: { membershipId, roleSlug } });
    const membership = this.memberships.find((m) => m.id === membershipId);
    if (membership) this.memberships[this.memberships.indexOf(membership)] = { ...membership, role: roleSlug };
    return Promise.resolve();
  }

  deactivateOrganizationMembership(membershipId: string): Promise<void> {
    this.calls.push({ method: 'deactivateOrganizationMembership', argument: membershipId });
    const membership = this.memberships.find((m) => m.id === membershipId);
    if (membership) {
      this.memberships[this.memberships.indexOf(membership)] = { ...membership, status: 'inactive' };
    }
    return Promise.resolve();
  }

  sendInvitation(options: {
    email: string;
    organizationId: string;
    roleSlug: string;
    expiresInDays?: number;
  }): Promise<WorkOSInvitation> {
    this.calls.push({ method: 'sendInvitation', argument: options });
    const invitation: WorkOSInvitation = {
      id: `invitation_${crypto.randomUUID().slice(0, 8)}`,
      email: options.email,
      state: 'pending',
      acceptInvitationUrl: `https://auth.example/invite/${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + (options.expiresInDays ?? 7) * 86_400_000).toISOString(),
    };
    this.invitations.push(invitation);
    return Promise.resolve(invitation);
  }

  resendInvitation(invitationId: string): Promise<WorkOSInvitation> {
    this.calls.push({ method: 'resendInvitation', argument: invitationId });
    const existing = this.invitations.find((invitation) => invitation.id === invitationId);
    const invitation: WorkOSInvitation = {
      id: `invitation_${crypto.randomUUID().slice(0, 8)}`,
      email: existing?.email ?? 'unknown@example.test',
      state: 'pending',
      acceptInvitationUrl: `https://auth.example/invite/${crypto.randomUUID()}`,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    };
    this.invitations.push(invitation);
    return Promise.resolve(invitation);
  }

  revokeInvitation(invitationId: string): Promise<void> {
    this.calls.push({ method: 'revokeInvitation', argument: invitationId });
    return Promise.resolve();
  }

  listEvents(options: { after?: string | null; limit?: number }): Promise<WorkOSEvent[]> {
    const start = options.after ? this.events.findIndex((event) => event.id === options.after) + 1 : 0;
    return Promise.resolve(this.events.slice(start, start + (options.limit ?? 50)));
  }
}
