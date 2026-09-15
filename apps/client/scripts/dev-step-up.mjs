// Make the fake-auth dev sessions fresh enough to pass `requireStepUp`.
//
// Why this exists. Decisions and every provider-key route call `requireStepUp`,
// which compares `auth_sessions.authenticated_at` against a five-minute window.
// In `AUTH_MODE=workos` the client sends the person to `/auth/login?step_up=1`
// and WorkOS stamps a new `sid`. In `AUTH_MODE=fake` there is no such route:
// `apps/worker/src/auth/adapters.ts` writes `authenticated_at` once, on the
// INSERT for `sid = dev-<user id>`, and every later request only touches
// `last_seen_at`. So five minutes after a dev workspace is first opened, every
// guarded route answers `reauth_required` for ever and nothing in the product
// can clear it.
//
// The honest fix is a dev step-up route on the Worker (see "Server findings" in
// this app's README). Until that exists this script is the fixture: it
// re-stamps the row, which is exactly what `/auth/callback` does in the real
// flow, and it is what `pnpm e2e:live` runs before the scenarios that need
// step-up.
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
  ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'hermes', '-c', sql],
  { encoding: 'utf8', cwd: new URL('../../..', import.meta.url).pathname },
);
process.stdout.write(`step-up refreshed: ${out.trim()}\n`);
