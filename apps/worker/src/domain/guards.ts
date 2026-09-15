// The guards that belong to the decision route rather than to authentication.
//
// `src/auth/guards.ts` owns Origin and CSRF, which every state-changing route
// shares, and `requireStepUp` lives beside `getSession`. This file owns the one
// guard only the decision path has: the request must say which surface it came
// from.
//
// `X-Requested-From: inbox` is not a security boundary by itself — a header is
// as forgeable as the client that sets it — and it is not pretending to be one.
// It is the fourth of five checks, and its job differs from the others': Origin
// says the page is ours, CSRF says the tab is ours, step-up says the person is
// present, and this says the *code path* was the review pane. A decision that
// arrives from anywhere else in our own client — a stray retry, a helper that
// replays a POST, a future route that copies this one — is a bug we want to see
// as a 403 rather than as a recorded decision nobody made in the Inbox.
//
// It is also why the browser can never reach this route by navigation: a form
// post or a link cannot set a custom header, so the preflight the header forces
// is itself a check the Origin allowlist then answers.
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { RouteError } from '../routes/tenant.js';

/** The only value the decision route accepts. */
export const INBOX_SURFACE = 'inbox';

export function requireRequestedFrom(c: Context<{ Bindings: Env }>, expected: string = INBOX_SURFACE): void {
  const header = c.req.header('x-requested-from');
  if (header !== expected) {
    throw new RouteError(`this action must be made from the ${expected}`, 'wrong_surface', 403);
  }
}
