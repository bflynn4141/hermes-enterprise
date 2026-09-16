// Prove the entire migration catalog can be replayed without changing the
// resulting schema. This never points at the configured target database: it
// creates a random sibling database, verifies there, then drops it in finally.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { OWNER_URL, SUPERUSER_URL } from './db-config.mjs';
import { applyMigrations, fingerprint, loadMigrations } from './migration-lib.mjs';

const database = `hermes_migration_shadow_${process.pid}_${randomBytes(4).toString('hex')}`;
const ident = (value) => `"${value.replaceAll('"', '""')}"`;
const withDatabase = (connectionString, name) => {
  const url = new URL(connectionString);
  url.pathname = `/${name}`;
  return url.toString();
};

const admin = new pg.Client({ connectionString: withDatabase(SUPERUSER_URL, 'postgres') });
let shadow;
let created = false;
await admin.connect();

try {
  await admin.query(`CREATE DATABASE ${ident(database)} OWNER "owner" TEMPLATE template0`);
  created = true;
  shadow = new pg.Client({ connectionString: withDatabase(OWNER_URL, database) });
  await shadow.connect();

  const migrations = await loadMigrations();
  const first = await applyMigrations(shadow, migrations, { allowEdit: false });
  const before = await fingerprint(shadow);
  const replayed = await applyMigrations(shadow, migrations, { force: true, allowEdit: false });
  const after = await fingerprint(shadow);

  if (before !== after) {
    throw new Error(
      'migrations are not idempotent: replaying them changed the shadow schema. ' +
        `Fingerprint ${before} became ${after}.`,
    );
  }

  process.stdout.write(
    `\nmigration replay ok in disposable shadow database: ${first} applied, ${replayed} replayed\n` +
      `schema fingerprint ${before}\n`,
  );
} finally {
  if (shadow) await shadow.end().catch(() => {});
  try {
    if (created) await admin.query(`DROP DATABASE IF EXISTS ${ident(database)} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
