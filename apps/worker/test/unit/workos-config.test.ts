import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { authConfigurationProblems } from '../../src/auth/workos.js';
import { deletionDeps } from '../../src/workflows-long/workspace-deletion.js';

const production = (overrides: Partial<Env> = {}): Env =>
  ({
    ENVIRONMENT: 'production',
    AUTH_MODE: 'workos',
    WORKOS_API_KEY: 'sk_test',
    WORKOS_CLIENT_ID: 'client_test',
    WORKOS_COOKIE_PASSWORD: 'a'.repeat(32),
    WORKOS_ISSUER: 'https://api.workos.com/user_management/client_test',
    ALLOWED_ORIGINS: 'https://app.hermes.test',
    WORKOS_REDIRECT_URI: 'https://app.hermes.test/auth/callback',
    ...overrides,
  }) as unknown as Env;

describe('WorkOS deployment configuration', () => {
  it('accepts an explicit same-origin HTTPS callback and complete secrets', () => {
    expect(authConfigurationProblems(production())).toEqual([]);
  });

  it('refuses fake auth in a deployed environment', () => {
    expect(authConfigurationProblems(production({ AUTH_MODE: 'fake' }))).toContain('AUTH_MODE');
  });

  it('requires every WorkOS secret, exact issuer, and a 32-byte cookie password', () => {
    const problems = authConfigurationProblems(
      production({
        WORKOS_API_KEY: undefined,
        WORKOS_CLIENT_ID: undefined,
        WORKOS_COOKIE_PASSWORD: 'short',
        WORKOS_ISSUER: undefined,
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining(['WORKOS_API_KEY', 'WORKOS_CLIENT_ID', 'WORKOS_COOKIE_PASSWORD', 'WORKOS_ISSUER']),
    );
  });

  it('refuses a callback outside the allowlisted origin or away from /auth/callback', () => {
    expect(
      authConfigurationProblems(
        production({ WORKOS_REDIRECT_URI: 'https://other.example/not-the-callback?code=leak' }),
      ),
    ).toContain('WORKOS_REDIRECT_URI');
  });
});

describe('linked workspace deletion', () => {
  it('fails closed when no WorkOS port can delete the upstream organization', async () => {
    const env = production({
      WORKOS_API_KEY: undefined,
      WORKOS_CLIENT_ID: undefined,
      WORKOS_COOKIE_PASSWORD: undefined,
    });

    await expect(deletionDeps(env).deleteOrganization('org_linked')).rejects.toThrow(/WorkOS is required/);
  });
});
