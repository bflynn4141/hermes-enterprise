// `hermes_test`: the database the automated suites own.
//
// Why it exists (decision C43). Every test suite in this repository used to run
// against `hermes` — the same database the developer's own `wrangler dev` on
// :8787 is looking at. So `pnpm e2e:live` filled the Inbox somebody was reading
// with scripted "Ada Ling" requests, one set per run, and `pnpm db:reset` was
// the only way to clear them, which also destroyed their provider key. A suite
// that cannot be run while the product is open is a suite that gets run less.
//
// The separation is one database name, and everything else follows from it:
// `apps/worker/scripts/db-config.mjs` assembles every connection string from
// `PGDATABASE`, so pointing the migrations, the seed, the db tests and the test
// Worker's Hyperdrive strings at `hermes_test` is the same one variable in five
// places.
//
// This script is idempotent and is safe to run before every suite: create the
// database if it is not there, roles (cluster-wide, so shared), migrations,
// seed. It never touches `hermes`.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_DATABASE = 'hermes_test';
export const DEV_DATABASE = 'hermes';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** psql as the superuser, inside the compose container. */
export function psql(database, sql, { quiet = true } = {}) {
  const result = spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.status !== 0 && !quiet) {
    process.stderr.write(result.stderr ?? '');
  }
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: result.stderr ?? '' };
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) {
    process.stderr.write(`\n${command} ${args.join(' ')} failed\n`);
    process.exit(result.status ?? 1);
  }
}

/**
 * Make sure `hermes_test` exists, is migrated and is seeded.
 *
 * `containerUp` is skipped by callers who have already run `pnpm db:up`, which
 * is most of them; it is here so this script also works on its own.
 */
export function ensureTestDatabase({ containerUp = true, seed = true } = {}) {
  if (containerUp) run('pnpm', ['db:up'], {});

  const exists = psql('postgres', `SELECT 1 FROM pg_database WHERE datname = '${TEST_DATABASE}'`);
  if (!exists.ok) {
    process.stderr.write(`\ncould not reach Postgres to look for ${TEST_DATABASE}:\n${exists.err}\n`);
    process.exit(1);
  }
  if (exists.out !== '1') {
    const created = psql('postgres', `CREATE DATABASE ${TEST_DATABASE}`, { quiet: false });
    if (!created.ok) {
      process.stderr.write(`\ncould not create ${TEST_DATABASE}\n`);
      process.exit(1);
    }
    process.stdout.write(`created database ${TEST_DATABASE}\n`);
  }

  const env = { PGDATABASE: TEST_DATABASE };
  run('pnpm', ['db:migrate'], env);
  if (seed) run('pnpm', ['--filter', '@hermes/worker', 'db:seed'], env);
  return TEST_DATABASE;
}

/**
 * The local connection strings for a database, in the shape wrangler wants.
 *
 * Assembled here rather than imported from `db-config.mjs` because that module
 * reads `PGDATABASE` once, at import, and this is called for a database the
 * caller names.
 */
export function hyperdriveStrings(database) {
  const host = process.env.PGHOST ?? '127.0.0.1';
  const port = process.env.PGPORT ?? '5433';
  const secret = process.env.PGLOCALPASSWORD ?? 'localdev';
  return {
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP: `postgres://app:${secret}@${host}:${port}/${database}`,
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_AGENT: `postgres://agent:${secret}@${host}:${port}/${database}`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureTestDatabase();
  process.stdout.write(`${TEST_DATABASE} is ready\n`);
}
