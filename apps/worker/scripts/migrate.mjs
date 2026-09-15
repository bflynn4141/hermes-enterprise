// The migration runner.
//
// It does three things, in this order:
//   1. applies every migration that has not been applied, each in its own
//      transaction, recording the file's sha256 in `schema_migrations`;
//   2. takes a fingerprint of the resulting schema (columns, constraints,
//      indexes, policies, triggers, grants);
//   3. re-applies every migration from the beginning and asserts the
//      fingerprint is unchanged.
//
// Step 3 is the part that earns its keep. "Idempotent" is easy to believe and
// easy to get wrong: a CREATE INDEX without IF NOT EXISTS, a policy created
// twice, an INSERT without ON CONFLICT. A half-applied deploy has to be
// recoverable by running the runner again, and this proves it is.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { OWNER_URL } from './db-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

async function loadMigrations() {
  const names = (await readdir(migrationsDir)).filter((n) => n.endsWith('.sql')).sort();
  if (names.length === 0) throw new Error(`no migrations found in ${migrationsDir}`);
  return Promise.all(
    names.map(async (filename) => {
      const sql = await readFile(join(migrationsDir, filename), 'utf8');
      return { filename, sql, sha: sha256(sql) };
    }),
  );
}

// The comparable shape of the schema. Ordered deterministically so two runs of
// the same schema hash identically.
const FINGERPRINT_SQL = `
  SELECT jsonb_build_object(
    'columns', (
      SELECT jsonb_agg(c ORDER BY c->>'t', c->>'c') FROM (
        SELECT jsonb_build_object('t', table_name, 'c', column_name, 'd', data_type,
                                  'n', is_nullable, 'df', column_default) AS c
        FROM information_schema.columns WHERE table_schema = 'public'
      ) x
    ),
    'constraints', (
      SELECT jsonb_agg(c ORDER BY c->>'n') FROM (
        SELECT jsonb_build_object('n', conname, 't', conrelid::regclass::text,
                                  'd', pg_get_constraintdef(oid)) AS c
        FROM pg_constraint WHERE connamespace = 'public'::regnamespace
      ) x
    ),
    'indexes', (
      SELECT jsonb_agg(c ORDER BY c->>'n') FROM (
        SELECT jsonb_build_object('n', indexname, 'd', indexdef) AS c
        FROM pg_indexes WHERE schemaname = 'public'
      ) x
    ),
    'policies', (
      SELECT jsonb_agg(c ORDER BY c->>'t', c->>'n') FROM (
        SELECT jsonb_build_object('t', tablename, 'n', policyname, 'q', qual, 'w', with_check) AS c
        FROM pg_policies WHERE schemaname = 'public'
      ) x
    ),
    'rls', (
      SELECT jsonb_agg(c ORDER BY c->>'t') FROM (
        SELECT jsonb_build_object('t', relname, 'e', relrowsecurity, 'f', relforcerowsecurity) AS c
        FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
      ) x
    ),
    'triggers', (
      SELECT jsonb_agg(c ORDER BY c->>'n') FROM (
        SELECT jsonb_build_object('n', tgname, 't', tgrelid::regclass::text,
                                  'd', pg_get_triggerdef(oid)) AS c
        FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text NOT LIKE 'pg_%'
      ) x
    ),
    'grants', (
      SELECT jsonb_agg(c ORDER BY c->>'g', c->>'t', c->>'p') FROM (
        SELECT jsonb_build_object('g', grantee, 't', table_name, 'p', privilege_type) AS c
        FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee IN ('app', 'agent', 'owner', 'PUBLIC')
      ) x
    ),
    'views', (
      SELECT jsonb_agg(c ORDER BY c->>'n') FROM (
        SELECT jsonb_build_object('n', viewname, 'd', definition) AS c
        FROM pg_views WHERE schemaname = 'public'
      ) x
    )
  ) AS shape
`;

async function fingerprint(client) {
  const { rows } = await client.query(FINGERPRINT_SQL);
  return sha256(JSON.stringify(rows[0].shape));
}

async function apply(client, migrations, { force }) {
  const applied = new Map();
  const ledgerExists = await client.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present",
  );
  if (ledgerExists.rows[0].present) {
    const { rows } = await client.query('SELECT filename, sha256 FROM schema_migrations');
    for (const row of rows) applied.set(row.filename, row.sha256);
  }

  let ran = 0;
  for (const migration of migrations) {
    const previous = applied.get(migration.filename);
    if (previous && previous !== migration.sha && process.env.MIGRATE_ALLOW_EDIT !== '1') {
      // Expand/contract: an applied migration is history. Changing one means
      // staging and production disagree about what "0002" is.
      throw new Error(
        `${migration.filename} changed after it was applied. Add a new migration instead, ` +
          'or set MIGRATE_ALLOW_EDIT=1 while iterating against a throwaway database.',
      );
    }
    if (previous && !force) continue;

    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)
         ON CONFLICT (filename) DO UPDATE SET sha256 = EXCLUDED.sha256, applied_at = now()`,
        [migration.filename, migration.sha],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(`${migration.filename} failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    ran += 1;
    process.stdout.write(`${force ? 're-applied' : 'applied'} ${migration.filename}\n`);
  }
  return ran;
}

const migrations = await loadMigrations();
const client = new pg.Client({ connectionString: OWNER_URL });
await client.connect();

try {
  const first = await apply(client, migrations, { force: false });
  const before = await fingerprint(client);

  const second = await apply(client, migrations, { force: true });
  const after = await fingerprint(client);

  if (before !== after) {
    throw new Error(
      'migrations are not idempotent: re-applying them changed the schema. ' +
        `Fingerprint ${before} became ${after}.`,
    );
  }

  process.stdout.write(
    `\nmigrations ok: ${migrations.length} files, ${first} applied, ${second} re-applied for the idempotence check\n` +
      `schema fingerprint ${before}\n`,
  );
} finally {
  await client.end();
}
