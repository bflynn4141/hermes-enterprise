// One auth seam so local development never needs WorkOS (client-port spec §6).
//
// Cookies, the CSRF double-submit token and `X-Requested-From` behave the same
// in both modes, so the guarded paths are exercised locally exactly as they are
// in production. What differs is only how a session is established:
//   workos  the cookie is everything; step-up is `/auth/login?step_up=1`,
//           which asks WorkOS for `max_age: 0`
//   fake    an `x-dev-user` header the Worker trusts *only* when its own
//           AUTH_MODE is `fake`
//
// The spec asked for a dev step-up route that stamps a fresh
// `authenticated_at` and bounces straight back. The Worker did not have one,
// so `stepUpUrl` used to return null in fake mode and the callers rendered the
// challenge inline. Server decision F4 built it: `GET /auth/login?step_up=1`
// re-stamps the row in `AUTH_MODE=fake` and redirects to `return_to`. So there
// is now one URL for both modes and one code path in the callers.
//
// What did *not* change is the rule that matters: the intent is stored before
// the redirect and read on the way back, and it is never replayed. The pane
// re-renders as "Re-authenticated — confirm to continue" and waits for a
// second, deliberate click. `apps/client/scripts/dev-step-up.mjs` still
// re-stamps the row from the shell, which is what the fixtures use.
//
// The dev account switcher lives behind `mode === 'fake'`, which esbuild folds
// to `false` in a production build, so the switcher and the header name are
// eliminated; `build.mjs` greps `dist/app.js` to prove it.
import { STEPUP_KEY } from './constants.js';

export type AuthMode = 'workos' | 'fake';

export interface StepUpIntent {
  /** `workspace` is the delete/undelete pair; `decision: 'decline'` is the undelete. */
  kind: 'decision' | 'provider_key' | 'workspace' | 'effect';
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
  /**
   * Where to send the browser for a fresh `authenticated_at`. Never null now
   * that fake mode has a step-up of its own; the type keeps the null so a
   * caller written against the old seam still compiles.
   */
  stepUpUrl(returnTo: string, reason: 'decision' | 'provider_key'): string | null;
  devUser(): string | null;
  setDevUser(id: string): void;
}

const DEV_USER_KEY = 'hermes:dev-user';

/**
 * The seeded pair `apps/worker/scripts/seed-dev.mjs` writes: an Admin and a
 * Member, which is exactly what the two-context Playwright scenarios need.
 * The Admin is the default, because a fake-mode client with no header gets a
 * 401 on bootstrap and a sign-in screen that has nothing to sign in to.
 */
export const DEV_USERS = [
  { id: 'maya@nous.example', label: 'Admin', name: 'Maya Chen' },
  { id: 'dana@nous.example', label: 'Member', name: 'Dana Kim' },
] as const;
export const DEFAULT_DEV_USER = DEV_USERS[0].id;

/**
 * The Worker collapses any `return_to` that is not a same-origin *path* to
 * `/` (the open-redirect fix). Sending it a full URL therefore silently loses
 * the destination, so the path is extracted here.
 */
export function sameOriginPath(returnTo: string): string {
  try {
    const url = new URL(returnTo, typeof window === 'undefined' ? 'http://localhost' : window.location.origin);
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

export function createAuth(mode: AuthMode = __AUTH_MODE__): AuthAdapter {
  let devUser: string | null = null;
  if (mode === 'fake') {
    try {
      devUser = localStorage.getItem(DEV_USER_KEY) ?? DEFAULT_DEV_USER;
    } catch {
      devUser = DEFAULT_DEV_USER;
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
      // `/auth/login`, not `/auth/signin`: the Worker names it after what it
      // does, and there is no second route to shim through.
      return `/auth/login?return_to=${encodeURIComponent(sameOriginPath(returnTo))}`;
    },
    stepUpUrl(returnTo, reason) {
      // One URL in both modes. In `workos` it asks WorkOS for `max_age: 0`; in
      // `fake` the Worker re-stamps the dev row and bounces back. `reason` is
      // not a query parameter: what the step-up was *for* is the client's own
      // pending intent, and putting it in a URL would let a link claim it.
      void reason;
      return `/auth/login?step_up=1&return_to=${encodeURIComponent(sameOriginPath(returnTo))}`;
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
