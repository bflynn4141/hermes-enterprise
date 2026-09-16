import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';

const sdk = vi.hoisted(() => ({
  refresh: vi.fn(),
  getSessionFromCookie: vi.fn(),
}));

vi.mock('@workos-inc/node', () => ({
  WorkOS: class {
    readonly userManagement = {
      loadSealedSession: () => ({ refresh: sdk.refresh }),
      getSessionFromCookie: sdk.getSessionFromCookie,
    };
  },
}));

import { SdkWorkOS } from '../../src/auth/workos.js';

const env = {
  WORKOS_API_KEY: 'sk_test',
  WORKOS_CLIENT_ID: 'client_test',
  WORKOS_COOKIE_PASSWORD: 'a'.repeat(32),
} as unknown as Env;

describe('WorkOS session refresh', () => {
  beforeEach(() => vi.clearAllMocks());

  it('extracts the rotated access token from the refreshed sealed session', async () => {
    sdk.refresh.mockResolvedValue({ authenticated: true, sealedSession: 'sealed-refreshed-session' });
    sdk.getSessionFromCookie.mockResolvedValue({
      accessToken: 'rotated.jwt.token',
      user: {
        id: 'user_1',
        email: 'maya@nous.research',
        emailVerified: true,
      },
    });

    const result = await new SdkWorkOS(env).refresh('sealed-expired-session');

    expect(result).toEqual({
      sealedSession: 'sealed-refreshed-session',
      accessToken: 'rotated.jwt.token',
    });
    expect(sdk.getSessionFromCookie).toHaveBeenCalledWith({
      sessionData: 'sealed-refreshed-session',
      cookiePassword: 'a'.repeat(32),
    });
  });

  it('fails closed when the refreshed session cannot provide an access token', async () => {
    sdk.refresh.mockResolvedValue({ authenticated: true, sealedSession: 'sealed-refreshed-session' });
    sdk.getSessionFromCookie.mockResolvedValue(null);

    await expect(new SdkWorkOS(env).refresh('sealed-expired-session')).rejects.toThrow(
      'WorkOS refreshed the session without an access token',
    );
  });
});
