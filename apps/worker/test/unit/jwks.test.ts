// Local access-token verification.
//
// The signatures here are real: the double signs with an RSA key it generates
// and publishes as a JWKS, so what is exercised is the production verifier, not
// a mock of it. What the fake replaces is only the network fetch, which is also
// what lets the cache and the refetch-on-unknown-kid be counted.
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { TokenError, setJwksFetcherForTests, verifyAccessToken } from '../../src/auth/jwks.js';
import { signAccessToken, signingKeys } from '../stubs/fake-workos.js';

const env = { WORKOS_CLIENT_ID: 'client_test' } as unknown as Env;

afterEach(() => setJwksFetcherForTests(null));

describe('verifying a WorkOS access token', () => {
  it('accepts a token signed by a published key', async () => {
    const keys = await signingKeys();
    setJwksFetcherForTests(() => Promise.resolve(keys.jwks));

    const token = await signAccessToken({ sub: 'user_1', sid: 'session_1' });
    const claims = await verifyAccessToken(env, token);

    expect(claims.sub).toBe('user_1');
    expect(claims.sid).toBe('session_1');
  });

  it('fetches the key set once and serves the next verification from the cache', async () => {
    const keys = await signingKeys();
    let fetches = 0;
    setJwksFetcherForTests(() => {
      fetches += 1;
      return Promise.resolve(keys.jwks);
    });

    await verifyAccessToken(env, await signAccessToken({ sub: 'user_1', sid: 'a' }));
    await verifyAccessToken(env, await signAccessToken({ sub: 'user_1', sid: 'b' }));

    expect(fetches).toBe(1);
  });

  it('refetches immediately on an unknown kid, because that is what a rotation looks like', async () => {
    const keys = await signingKeys();
    let fetches = 0;
    // First call serves an empty key set, as a stale cache would; the verifier
    // must not wait ten minutes to discover the new key.
    setJwksFetcherForTests(() => {
      fetches += 1;
      return Promise.resolve(fetches === 1 ? { keys: [] } : keys.jwks);
    });

    const claims = await verifyAccessToken(env, await signAccessToken({ sub: 'user_1', sid: 'a' }));

    expect(claims.sub).toBe('user_1');
    expect(fetches).toBe(2);
  });

  it('reports an expired token as expired, so the caller refreshes rather than signing out', async () => {
    const keys = await signingKeys();
    setJwksFetcherForTests(() => Promise.resolve(keys.jwks));
    const expired = await signAccessToken({
      sub: 'user_1',
      sid: 'a',
      exp: Math.floor(Date.now() / 1000) - 120,
    });

    await expect(verifyAccessToken(env, expired)).rejects.toMatchObject({ kind: 'expired' });
  });

  it('allows 60 seconds of clock skew, so two disagreeing clocks do not sign people out', async () => {
    const keys = await signingKeys();
    setJwksFetcherForTests(() => Promise.resolve(keys.jwks));
    const justExpired = await signAccessToken({
      sub: 'user_1',
      sid: 'a',
      exp: Math.floor(Date.now() / 1000) - 30,
    });

    await expect(verifyAccessToken(env, justExpired)).resolves.toMatchObject({ sub: 'user_1' });
  });

  it('refuses a token whose signature does not verify, expired or not', async () => {
    const keys = await signingKeys();
    setJwksFetcherForTests(() => Promise.resolve(keys.jwks));
    const token = await signAccessToken({ sub: 'user_1', sid: 'a' });
    const [header, payload, signature] = token.split('.');
    const forged = `${header}.${payload}.${(signature ?? '').slice(0, -4)}AAAA`;

    await expect(verifyAccessToken(env, forged)).rejects.toBeInstanceOf(TokenError);
  });
});
