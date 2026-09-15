// One auth seam so local development never needs WorkOS (client-port spec §6).
//
// Cookies, the CSRF double-submit token and `X-Requested-From` behave the same
// in both modes, so the guarded paths are exercised locally exactly as they are
// in production. What differs is only how a session is established:
//   workos  the cookie is everything; step-up is a WorkOS authorization URL
//           with `max_age: 0`
//   fake    an `x-dev-user` header the Worker trusts *only* when its own
//           AUTH_MODE is `fake`, and a dev route that stamps a fresh
//           `authenticated_at` and bounces straight back
//
// The dev account switcher lives behind `mode === 'fake'`, which esbuild folds
// to `false` in a production build, so the switcher and the header name are
// eliminated; `build.mjs` greps `dist/app.js` to prove it.
import { STEPUP_KEY } from './constants.js';

export type AuthMode = 'workos' | 'fake';

export interface StepUpIntent {
  kind: 'decision' | 'provider_key';
  requestId?: string;
  keyId?: string;
  decision?: 'approve' | 'decline';
  note?: string;
  returnTo: string;
}

export interface AuthAdapter {
  readonly mode: AuthMode;
  headers(): Record<string, string>;
  signInUrl(returnTo: string): string;
  stepUpUrl(returnTo: string, reason: 'decision' | 'provider_key'): string;
  devUser(): string | null;
  setDevUser(id: string): void;
}

const DEV_USER_KEY = 'hermes:dev-user';

export function createAuth(mode: AuthMode = __AUTH_MODE__): AuthAdapter {
  let devUser: string | null = null;
  if (mode === 'fake') {
    try {
      devUser = localStorage.getItem(DEV_USER_KEY);
    } catch {
      devUser = null;
    }
  }
  return {
    mode,
    headers(): Record<string, string> {
      // Two gates, and the first one is the important one: `__AUTH_MODE__` is a
      // build-time constant, so in a production build esbuild folds this to
      // `return {}` and the header name is not in the bundle at all. The build
      // greps `dist/app.js` for it (spec §12.8).
      if (__AUTH_MODE__ !== 'fake') return {};
      if (mode !== 'fake' || !devUser) return {};
      return { 'x-dev-user': devUser };
    },
    signInUrl(returnTo) {
      return `/auth/signin?return_to=${encodeURIComponent(returnTo)}`;
    },
    stepUpUrl(returnTo, reason) {
      const path = mode === 'fake' ? '/auth/dev/step-up' : '/auth/step-up';
      return `${path}?return_to=${encodeURIComponent(returnTo)}&reason=${reason}`;
    },
    devUser: () => devUser,
    setDevUser(id) {
      devUser = id;
      try {
        localStorage.setItem(DEV_USER_KEY, id);
      } catch {
        /* a private window is still usable; the header simply stays unset */
      }
    },
  };
}

/**
 * The pending step-up intent. It is stored before the redirect and read on the
 * way back — and it is *never* replayed automatically: the review pane
 * re-renders in a "Re-authenticated — confirm to continue" state and waits for
 * a second, deliberate click (spec §6).
 */
export function storeStepUp(intent: StepUpIntent): void {
  try {
    sessionStorage.setItem(STEPUP_KEY, JSON.stringify(intent));
  } catch {
    /* ignore */
  }
}

export function readStepUp(): StepUpIntent | null {
  try {
    const raw = sessionStorage.getItem(STEPUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StepUpIntent;
    return parsed && typeof parsed.kind === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function clearStepUp(): void {
  try {
    sessionStorage.removeItem(STEPUP_KEY);
  } catch {
    /* ignore */
  }
}
