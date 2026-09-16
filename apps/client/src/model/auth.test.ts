import { describe, expect, it } from 'vitest';
import { createAuth, sameOriginPath } from './auth.js';

describe('authentication navigation', () => {
  it('keeps the post-login destination same-origin', () => {
    expect(sameOriginPath('https://elsewhere.example/private')).toBe('/private');
    expect(createAuth('workos').signInUrl('/w/one?tab=inbox')).toBe(
      '/auth/login?return_to=%2Fw%2Fone%3Ftab%3Dinbox',
    );
  });

  it('sends visible sign-out controls to the Worker logout route', () => {
    expect(createAuth('workos').signOutUrl()).toBe('/auth/logout');
    expect(createAuth('workos').signOutUrl()).not.toContain('/auth/login');
  });
});
