// `POST /demo/request-access` — the public request-access form.
//
// A visitor with a forwarded passcode asks to be invited to the demo
// workspace. The route answers one of three outcomes on 200; everything else
// (a wrong passcode, a domain outside the allowlist, a budget exceeded) is an
// `errorBodySchema` with its own `reason`, so the page keys its copy off the
// reason rather than off a sentence.
import { z } from 'zod';

export const DEMO_ACCESS_EMAIL_MAX = 320;
export const DEMO_ACCESS_PASSCODE_MAX = 200;

export const demoAccessRequestSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(DEMO_ACCESS_EMAIL_MAX).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/),
    passcode: z.string().min(1).max(DEMO_ACCESS_PASSCODE_MAX),
  })
  .strict();
export type DemoAccessRequest = z.infer<typeof demoAccessRequestSchema>;

/**
 * `invited` means a WorkOS invitation is queued for that address, whether it
 * was created just now or a pending one was resent; the page says the same
 * thing either way, because the difference is not something the visitor can
 * act on. `already_member` names an address that is already active in the
 * workspace, which the route reveals only after the passcode matched.
 */
export const demoAccessResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unavailable'), reason: z.literal('demo_access_not_configured') }).strict(),
  z.object({ status: z.literal('invited'), email: z.string().max(DEMO_ACCESS_EMAIL_MAX) }).strict(),
  z.object({ status: z.literal('already_member'), email: z.string().max(DEMO_ACCESS_EMAIL_MAX) }).strict(),
]);
export type DemoAccessResponse = z.infer<typeof demoAccessResponseSchema>;

/** The refusals the route can answer with, and the page renders. */
export const DEMO_ACCESS_ERROR_REASONS = [
  'bad_email',
  'bad_passcode',
  'demo_passcode_invalid',
  'demo_domain_not_allowed',
  'rate_limited',
] as const;
export type DemoAccessErrorReason = (typeof DEMO_ACCESS_ERROR_REASONS)[number];
