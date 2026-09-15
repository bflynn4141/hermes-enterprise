// `ALLOWED_PROVIDERS`, the one rule and the one refusal (decision R12).
//
// The rule is a variable rather than a constant because a customer bringing
// their own Anthropic account is a configuration change and not a deploy of new
// code — and because the adapters this narrows away are still compiled in and
// still tested. What must never happen is the variable going missing and the
// deployment quietly widening, which is the first test here.
import { describe, expect, it } from 'vitest';
import { PROVIDER_NOT_ALLOWED_COPY } from '@hermes/shared';
import { allowedProviders, isProviderAllowed, requireAllowedProvider } from '../../src/model/allowed.js';
import { RouteError } from '../../src/routes/tenant.js';

describe('which providers a deployment offers', () => {
  it('fails closed: no variable means OpenRouter, not everything', () => {
    expect(allowedProviders({})).toEqual(['openrouter']);
    expect(allowedProviders({ ALLOWED_PROVIDERS: '' })).toEqual(['openrouter']);
    expect(allowedProviders({ ALLOWED_PROVIDERS: '   ' })).toEqual(['openrouter']);
    // A name nobody recognises is dropped, and dropping every name falls back
    // rather than allowing none — "no provider at all" is a deployment that
    // cannot run a turn and would look like an outage.
    expect(allowedProviders({ ALLOWED_PROVIDERS: 'openrooter' })).toEqual(['openrouter']);
  });

  it('reads a list, trimming and ignoring what it does not know', () => {
    expect(allowedProviders({ ALLOWED_PROVIDERS: ' openrouter , anthropic ' })).toEqual(['openrouter', 'anthropic']);
    expect(isProviderAllowed({ ALLOWED_PROVIDERS: 'openrouter' }, 'deepseek')).toBe(false);
    expect(isProviderAllowed({ ALLOWED_PROVIDERS: 'openrouter' }, 'openrouter')).toBe(true);
  });

  it('refuses with one sentence, one reason and 422', () => {
    const env = { ALLOWED_PROVIDERS: 'openrouter' };
    expect(() => requireAllowedProvider(env, 'openrouter')).not.toThrow();
    for (const provider of ['deepseek', 'anthropic', 'openai']) {
      let caught: unknown;
      try {
        requireAllowedProvider(env, provider);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RouteError);
      const error = caught as RouteError;
      // 422, because the request is well-formed and names something real.
      expect(error.status).toBe(422);
      expect(error.reason).toBe('provider_not_allowed');
      expect(error.message).toBe(PROVIDER_NOT_ALLOWED_COPY);
      expect(error.message).toBe('Only OpenRouter keys can be used in this workspace');
    }
  });
});
