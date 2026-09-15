// The WorkOS boundary, as one interface.
//
// Everything this product asks of WorkOS is listed here, and nothing else in
// the code imports the SDK. Three reasons, in order of how much they matter:
//
//   1. It is the list a reviewer reads to answer "what does WorkOS know about
//      us, and what could a WorkOS outage stop?" — sign-in, organizations,
//      memberships, invitations and the events feed, and nothing about
//      requests, decisions or documents.
//   2. Authorisation is ours. WorkOS tells us who signed in and which
//      organization they picked; the `members` mirror decides what they may do.
//      A method that returned a permission would be a method in the wrong file.
//   3. Tests need a double. The SDK talks to api.workos.com and the pilot has
//      no emulator we can point it at (see docs/DECISIONS.md), so the tests
//      implement this interface instead of intercepting HTTP.
//
// `@workos-inc/node` publishes a `workerd` export condition that resolves to a
// fetch-based build, so importing the package by name is correct under wrangler
// and the `/worker` subpath is not needed.
import { WorkOS } from '@workos-inc/node';
import type { Env } from '../env.js';
import { AuthError } from './types.js';

export interface WorkOSUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly profilePictureUrl?: string | null;
}

export interface WorkOSAuthentication {
  readonly user: WorkOSUser;
  readonly organizationId: string | null;
  readonly accessToken: string;
  readonly sealedSession: string;
}

export interface WorkOSMembership {
  readonly id: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly role: string;
  readonly status: string;
}

export interface WorkOSInvitation {
  readonly id: string;
  readonly email: string;
  readonly state: string;
  readonly acceptInvitationUrl: string | null;
  readonly expiresAt: string;
}

export interface WorkOSEvent {
  readonly id: string;
  readonly event: string;
  readonly createdAt: string;
  readonly data: Record<string, unknown>;
}

export interface WorkOSPort {
  /**
   * `maxAge: 0` is the step-up: WorkOS documents it as forcing the user to
   * re-authenticate, and the new session arrives with a new `sid`, which is the
   * value `auth_sessions` is keyed on.
   */
  authorizationUrl(options: {
    redirectUri: string;
    state?: string;
    screenHint?: 'sign-in' | 'sign-up';
    invitationToken?: string;
    organizationId?: string;
    maxAge?: number;
  }): string;
  authenticateWithCode(options: { code: string; invitationToken?: string }): Promise<WorkOSAuthentication>;
  /** The sealed cookie's contents, without a network call. */
  unseal(sealed: string): Promise<{ accessToken: string; user: WorkOSUser } | null>;
  /** Exchanges the refresh token and re-seals. Network. */
  refresh(sealed: string): Promise<{ sealedSession: string; accessToken: string }>;
  logoutUrl(sealed: string, returnTo?: string): Promise<string>;
  createOrganization(name: string): Promise<{ id: string }>;
  listOrganizationMemberships(options: {
    userId?: string;
    organizationId?: string;
  }): Promise<WorkOSMembership[]>;
  updateOrganizationMembership(membershipId: string, roleSlug: string): Promise<void>;
  deactivateOrganizationMembership(membershipId: string): Promise<void>;
  sendInvitation(options: {
    email: string;
    organizationId: string;
    roleSlug: string;
    inviterUserId?: string;
    expiresInDays?: number;
  }): Promise<WorkOSInvitation>;
  resendInvitation(invitationId: string): Promise<WorkOSInvitation>;
  revokeInvitation(invitationId: string): Promise<void>;
  listEvents(options: { after?: string | null; limit?: number }): Promise<WorkOSEvent[]>;
}

/** The event kinds the poller subscribes to. Section 7 of the plan names them. */
export const WORKOS_EVENT_TYPES = [
  'organization_membership.created',
  'organization_membership.updated',
  'organization_membership.deleted',
  'user.deleted',
] as const;

export const isWorkOSConfigured = (env: Env): boolean =>
  Boolean(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID && env.WORKOS_COOKIE_PASSWORD);

/**
 * Terminal or transient?
 *
 * The distinction is the difference between signing someone out and asking them
 * to wait. `invalid_grant` means the refresh token is spent or revoked and no
 * amount of retrying will help, so the cookie goes. A timeout, a rate limit or
 * a 5xx means WorkOS is having a moment; the cookie stays and the client is
 * told to come back, because clearing it would turn a WorkOS blip into a
 * logout storm across every open tab.
 */
export function classifyWorkOSError(error: unknown): { terminal: boolean; retryAfter: number } {
  const candidate = error as { status?: number; code?: string; error?: string; rawData?: { error?: string } };
  const code = candidate?.code ?? candidate?.error ?? candidate?.rawData?.error;
  if (code === 'invalid_grant') return { terminal: true, retryAfter: 0 };
  const status = typeof candidate?.status === 'number' ? candidate.status : 0;
  if (status === 401 || status === 403 || status === 400) return { terminal: true, retryAfter: 0 };
  if (status === 429) return { terminal: false, retryAfter: 30 };
  return { terminal: false, retryAfter: 5 };
}

// ---------------------------------------------------------------------------
// The SDK-backed implementation
// ---------------------------------------------------------------------------

interface SdkUser {
  id: string;
  email: string;
  emailVerified: boolean;
  firstName?: string | null;
  lastName?: string | null;
  profilePictureUrl?: string | null;
}

const toUser = (user: SdkUser): WorkOSUser => ({
  id: user.id,
  email: user.email.toLowerCase(),
  emailVerified: user.emailVerified,
  firstName: user.firstName ?? null,
  lastName: user.lastName ?? null,
  profilePictureUrl: user.profilePictureUrl ?? null,
});

class SdkWorkOS implements WorkOSPort {
  private readonly workos: WorkOS;
  private readonly clientId: string;
  private readonly cookiePassword: string;

  constructor(env: Env) {
    this.clientId = env.WORKOS_CLIENT_ID as string;
    this.cookiePassword = env.WORKOS_COOKIE_PASSWORD as string;
    this.workos = new WorkOS(env.WORKOS_API_KEY as string, { clientId: this.clientId });
  }

  authorizationUrl(options: {
    redirectUri: string;
    state?: string;
    screenHint?: 'sign-in' | 'sign-up';
    invitationToken?: string;
    organizationId?: string;
    maxAge?: number;
  }): string {
    return this.workos.userManagement.getAuthorizationUrl({
      provider: 'authkit',
      clientId: this.clientId,
      redirectUri: options.redirectUri,
      ...(options.state === undefined ? {} : { state: options.state }),
      ...(options.screenHint === undefined ? {} : { screenHint: options.screenHint }),
      ...(options.invitationToken === undefined ? {} : { invitationToken: options.invitationToken }),
      ...(options.organizationId === undefined ? {} : { organizationId: options.organizationId }),
      ...(options.maxAge === undefined ? {} : { maxAge: options.maxAge }),
    });
  }

  async authenticateWithCode(options: { code: string; invitationToken?: string }): Promise<WorkOSAuthentication> {
    const response = await this.workos.userManagement.authenticateWithCode({
      clientId: this.clientId,
      code: options.code,
      ...(options.invitationToken === undefined ? {} : { invitationToken: options.invitationToken }),
      session: { sealSession: true, cookiePassword: this.cookiePassword },
    });
    if (!response.sealedSession) throw new Error('WorkOS returned no sealed session');
    return {
      user: toUser(response.user as SdkUser),
      organizationId: response.organizationId ?? null,
      accessToken: response.accessToken,
      sealedSession: response.sealedSession,
    };
  }

  async unseal(sealed: string): Promise<{ accessToken: string; user: WorkOSUser } | null> {
    const data = await this.workos.userManagement.getSessionFromCookie({
      sessionData: sealed,
      cookiePassword: this.cookiePassword,
    });
    if (!data) return null;
    return { accessToken: data.accessToken, user: toUser(data.user as SdkUser) };
  }

  async refresh(sealed: string): Promise<{ sealedSession: string; accessToken: string }> {
    const session = this.workos.userManagement.loadSealedSession({
      sessionData: sealed,
      cookiePassword: this.cookiePassword,
    });
    const result = (await session.refresh({ cookiePassword: this.cookiePassword })) as {
      authenticated: boolean;
      sealedSession?: string;
      accessToken?: string;
      reason?: string;
    };
    if (!result.authenticated || !result.sealedSession) {
      // The SDK reports a spent refresh token as a failed result rather than a
      // throw; `classifyWorkOSError` reads the same `reason` either way.
      throw Object.assign(new Error('refresh failed'), { code: result.reason ?? 'invalid_grant' });
    }
    return { sealedSession: result.sealedSession, accessToken: result.accessToken ?? '' };
  }

  async logoutUrl(sealed: string, returnTo?: string): Promise<string> {
    const session = this.workos.userManagement.loadSealedSession({
      sessionData: sealed,
      cookiePassword: this.cookiePassword,
    });
    return session.getLogoutUrl(returnTo === undefined ? {} : { returnTo });
  }

  async createOrganization(name: string): Promise<{ id: string }> {
    const organization = await this.workos.organizations.createOrganization({ name });
    return { id: organization.id };
  }

  async listOrganizationMemberships(options: {
    userId?: string;
    organizationId?: string;
  }): Promise<WorkOSMembership[]> {
    // The SDK's type insists on a userId; the API does not, and listing an
    // organization's memberships is exactly the call the reconciliation query
    // in the runbook makes.
    const list = await this.workos.userManagement.listOrganizationMemberships({
      ...(options.userId === undefined ? {} : { userId: options.userId }),
      ...(options.organizationId === undefined ? {} : { organizationId: options.organizationId }),
    } as unknown as Parameters<typeof this.workos.userManagement.listOrganizationMemberships>[0]);
    return list.data.map((membership) => ({
      id: membership.id,
      userId: membership.userId,
      organizationId: membership.organizationId,
      role: membership.role?.slug ?? 'member',
      status: membership.status,
    }));
  }

  async updateOrganizationMembership(membershipId: string, roleSlug: string): Promise<void> {
    await this.workos.userManagement.updateOrganizationMembership(membershipId, { roleSlug });
  }

  async deactivateOrganizationMembership(membershipId: string): Promise<void> {
    await this.workos.userManagement.deactivateOrganizationMembership(membershipId);
  }

  async sendInvitation(options: {
    email: string;
    organizationId: string;
    roleSlug: string;
    inviterUserId?: string;
    expiresInDays?: number;
  }): Promise<WorkOSInvitation> {
    const invitation = await this.workos.userManagement.sendInvitation({
      email: options.email,
      organizationId: options.organizationId,
      roleSlug: options.roleSlug,
      ...(options.inviterUserId === undefined ? {} : { inviterUserId: options.inviterUserId }),
      expiresInDays: options.expiresInDays ?? 7,
    });
    return {
      id: invitation.id,
      email: invitation.email,
      state: invitation.state,
      acceptInvitationUrl: invitation.acceptInvitationUrl ?? null,
      expiresAt: invitation.expiresAt,
    };
  }

  async resendInvitation(invitationId: string): Promise<WorkOSInvitation> {
    const invitation = await this.workos.userManagement.resendInvitation(invitationId);
    return {
      id: invitation.id,
      email: invitation.email,
      state: invitation.state,
      acceptInvitationUrl: invitation.acceptInvitationUrl ?? null,
      expiresAt: invitation.expiresAt,
    };
  }

  async revokeInvitation(invitationId: string): Promise<void> {
    await this.workos.userManagement.revokeInvitation(invitationId);
  }

  async listEvents(options: { after?: string | null; limit?: number }): Promise<WorkOSEvent[]> {
    const list = await this.workos.events.listEvents({
      events: [...WORKOS_EVENT_TYPES] as never,
      ...(options.after ? { after: options.after } : {}),
      limit: options.limit ?? 50,
    });
    return list.data.map((event) => ({
      id: event.id,
      event: event.event,
      createdAt: event.createdAt,
      data: event.data as unknown as Record<string, unknown>,
    }));
  }
}

/**
 * Test seam. The tests hand in a `FakeWorkOS` that implements the interface
 * above; nothing else may set this, and it is unset in every deployed path.
 */
let portOverride: ((env: Env) => WorkOSPort) | null = null;

export function setWorkOSPortForTests(factory: ((env: Env) => WorkOSPort) | null): void {
  portOverride = factory;
}

export function workosPort(env: Env): WorkOSPort {
  if (portOverride) return portOverride(env);
  if (!isWorkOSConfigured(env)) {
    throw new AuthError(
      'WORKOS_API_KEY, WORKOS_CLIENT_ID and WORKOS_COOKIE_PASSWORD are required in workos auth mode',
      'not_configured',
      503,
    );
  }
  return new SdkWorkOS(env);
}

/** Null rather than a throw, for the paths where WorkOS is optional. */
export function optionalWorkosPort(env: Env): WorkOSPort | null {
  if (portOverride) return portOverride(env);
  return isWorkOSConfigured(env) ? new SdkWorkOS(env) : null;
}
