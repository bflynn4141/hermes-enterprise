// `pnpm db:reset` — the demo database, back to the seed.
//
// Four steps that people were running by hand in the wrong order: tear the
// volume down, bring it up and wait for health, migrate, seed. It exists
// because "the demo data looks wrong" was usually a database that had been
// run against by a test suite, and because `db:down` on its own leaves you
// with no database at all, which is a worse place to be than where you
// started.
//
// Destructive by design: `db:down` is `docker compose down -v`, so every row
// in the local Postgres goes. It refuses to run when `NODE_ENV=production`
// and when a `DATABASE_URL` is set that does not point at localhost — this
// script should never be one typo away from somebody's real database.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function guard() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('db:reset refuses to run with NODE_ENV=production');
  }
  const url = process.env.DATABASE_URL ?? process.env.HYPERDRIVE_URL ?? '';
  if (url && !/@(localhost|127\.0\.0\.1|db|postgres)[:/]/.test(url)) {
    throw new Error(`db:reset refuses to run against a non-local DATABASE_URL: ${url.replace(/:[^:@/]*@/, ':***@')}`);
  }
}

function run(label, command, args) {
  process.stdout.write(`\n── ${label}\n`);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? 'signal ' + result.signal})`);
  }
}

try {
  guard();
  // `down -v` on a stack that was never up is a no-op, not an error, so this is
  // also the way to get a database from nothing.
  run('tearing down the database and its volume', 'pnpm', ['db:down']);
  run('starting Postgres and waiting for health', 'pnpm', ['db:up']);
  run('applying the migrations', 'pnpm', ['db:migrate']);
  run('seeding the demo workspace', 'pnpm', ['--filter', '@hermes/worker', 'db:seed']);
  process.stdout.write('\n✓ database reset: migrated and seeded\n');
} catch (error) {
  process.stderr.write(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
