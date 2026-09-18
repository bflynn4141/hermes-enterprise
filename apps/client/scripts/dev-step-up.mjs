// Make the fake-auth dev sessions fresh enough to pass `requireStepUp`.
//
// Why this exists. Decisions and every mutating provider-key route call
// `requireStepUp`, which compares `auth_sessions.authenticated_at` against a
// five-minute window. Reading masked connection health does not need step-up.
// In `AUTH_MODE=workos` the client sends the person to `/auth/login?step_up=1`
// and WorkOS advances the access token's `auth_time` while retaining `sid`. In
// `AUTH_MODE=fake` there is no external challenge:
// `apps/worker/src/auth/adapters.ts` writes `authenticated_at` once, on the
// INSERT for `sid = dev-<user id>`, and every later request only touches
// `last_seen_at`. So five minutes after a dev workspace is first opened, every
// guarded route answers `reauth_required` for ever and nothing in the product
// can clear it.
//
// The Worker now has a fake-mode step-up route. This script remains the batch
// fixture that `pnpm e2e:live` uses before scenarios that need every seeded
// session fresh; it re-stamps the same row the route does.
//
// It goes through the Docker container rather than a Postgres driver on
// purpose: `apps/client` has no database dependency and should not grow one to
// run its own tests.
//
//   node scripts/dev-step-up.mjs            every dev session
//   node scripts/dev-step-up.mjs maya@…     one user, by email or id
import { execFileSync } from 'node:child_process';

const who = process.argv[2] ?? null;
const predicate = who
  ? `AND user_id IN (SELECT id FROM users WHERE id::text = '${who.replace(/'/g, "''")}' OR email = lower('${who.replace(/'/g, "''")}'))`
  : '';

const sql = `UPDATE auth_sessions SET authenticated_at = now() WHERE sid LIKE 'dev-%' ${predicate};`;

const out = execFileSync(
  'docker',
  // The *dev* database by default: this is the hand-run tool for the stack on
  // :8787, and the test stack re-stamps through the live fixture instead
  // (decision C43). `PGDATABASE` aims it elsewhere when that is wanted.
  ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', process.env.PGDATABASE ?? 'hermes', '-c', sql],
  { encoding: 'utf8', cwd: new URL('../../..', import.meta.url).pathname },
);
process.stdout.write(`step-up refreshed: ${out.trim()}\n`);
