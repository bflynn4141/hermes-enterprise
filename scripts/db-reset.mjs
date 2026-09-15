// `pnpm db:reset` — the **dev** database, back to the seed.
//
// Three things it is careful about, and the third is new (decision C43):
//
//   * it is destructive by design, so it refuses to run with
//     `NODE_ENV=production` or with a `DATABASE_URL` that is not local;
//   * it recreates `hermes` rather than tearing the volume down. `db:down` is
//     `docker compose down -v`, which takes every database on the container
//     with it — including `hermes_test`, which a suite may be using, and which
//     this command has no business touching;
//   * it **keeps the seed workspace's provider keys**. They are the one thing
//     in the dev database that cannot be regenerated: a verified OpenRouter key
//     is somebody's real credential, wrapped, and losing it means going back to
//     the provider dashboard for a new one. The rows are copied out before the
//     drop and copied back after the seed, which works because the seed's
//     workspace id is a constant.
//
// `hermes_test` is never touched. `pnpm db:test:up` is its equivalent, and it
// is idempotent rather than destructive because nothing in it is anybody's.
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

const SEED_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const DEV_DATABASE = 'hermes';
const KEYS_FILE = '/tmp/hermes-provider-keys.csv';

/** psql as the superuser, inside the compose container. */
function psql(database, sql) {
  return spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql],
    { cwd: root, encoding: 'utf8' },
  );
}

try {
  guard();
  run('starting Postgres and waiting for health', 'pnpm', ['db:up']);

  // --- keep the keys ---------------------------------------------------------
  // Best effort: a first run has no database and no table, and that is not an
  // error — there is simply nothing to keep.
  const saved = psql(
    DEV_DATABASE,
    `\\copy (SELECT * FROM workspace_provider_keys WHERE workspace_id = '${SEED_WORKSPACE}') TO '${KEYS_FILE}' CSV`,
  );
  const keptKeys = saved.status === 0;
  if (keptKeys) {
    const count = psql(DEV_DATABASE, `SELECT count(*) FROM workspace_provider_keys WHERE workspace_id = '${SEED_WORKSPACE}'`);
    process.stdout.write(`\n── keeping ${(count.stdout ?? '0').trim()} provider key row(s) for the seed workspace\n`);
  }

  // --- recreate just this database -------------------------------------------
  process.stdout.write(`\n── recreating the ${DEV_DATABASE} database (hermes_test is not touched)\n`);
  // Three calls, not one: psql wraps a multi-statement `-c` in a transaction,
  // and `DROP DATABASE` cannot run inside one.
  psql('postgres', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DEV_DATABASE}' AND pid <> pg_backend_pid()`);
  const dropped = psql('postgres', `DROP DATABASE IF EXISTS ${DEV_DATABASE}`);
  if (dropped.status !== 0) throw new Error(`could not drop ${DEV_DATABASE}:\n${dropped.stderr ?? ''}`);
  const created = psql('postgres', `CREATE DATABASE ${DEV_DATABASE}`);
  if (created.status !== 0) throw new Error(`could not create ${DEV_DATABASE}:\n${created.stderr ?? ''}`);

  run('applying the migrations', 'pnpm', ['db:migrate']);
  run('seeding the demo workspace', 'pnpm', ['--filter', '@hermes/worker', 'db:seed']);

  // --- put the keys back -----------------------------------------------------
  let restored = 0;
  if (keptKeys) {
    const back = psql(DEV_DATABASE, `\\copy workspace_provider_keys FROM '${KEYS_FILE}' CSV`);
    if (back.status === 0) {
      const count = psql(DEV_DATABASE, `SELECT count(*) FROM workspace_provider_keys WHERE workspace_id = '${SEED_WORKSPACE}'`);
      restored = Number.parseInt((count.stdout ?? '0').trim(), 10) || 0;
      process.stdout.write(`\n── restored ${restored} provider key row(s)\n`);
    } else {
      process.stderr.write(`\n! the provider keys could not be restored; the CSV is still at ${KEYS_FILE} inside the postgres container\n`);
    }
  }

  process.stdout.write(
    `\n✓ ${DEV_DATABASE} reset: migrated and seeded${restored > 0 ? `, ${restored} provider key row(s) kept` : ''}\n`,
  );
} catch (error) {
  process.stderr.write(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
