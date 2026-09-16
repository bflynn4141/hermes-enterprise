import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

export async function loadMigrations() {
  const names = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
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

export async function fingerprint(client) {
  const { rows } = await client.query(FINGERPRINT_SQL);
  return sha256(JSON.stringify(rows[0].shape));
}

/**
 * Apply missing migrations. `force` exists only for the disposable shadow
 * verifier. A normal target never replays ledgered SQL. `MIGRATE_ALLOW_EDIT`
 * re-applies only a changed migration and is restricted to throwaway local DBs
 * by operator convention and the explicit opt-in.
 */
export async function applyMigrations(
  client,
  migrations,
  { force = false, allowEdit = process.env.MIGRATE_ALLOW_EDIT === '1' } = {},
) {
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
    const changed = Boolean(previous && previous !== migration.sha);
    if (changed && !allowEdit) {
      throw new Error(
        `${migration.filename} changed after it was applied. Add a new migration instead, ` +
          'or set MIGRATE_ALLOW_EDIT=1 while iterating against a throwaway database.',
      );
    }
    if (previous && !force && !changed) continue;

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
    process.stdout.write(`${force ? 're-applied' : changed ? 're-applied changed' : 'applied'} ${migration.filename}\n`);
  }
  return ran;
}
