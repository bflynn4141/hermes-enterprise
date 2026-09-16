// The deployment migration runner. It verifies the immutable ledger and
// applies only migrations that are not already present. Full replay belongs in
// verify-migrations.mjs, which creates and destroys a disposable shadow DB.
import pg from 'pg';
import { OWNER_URL } from './db-config.mjs';
import { applyMigrations, fingerprint, loadMigrations } from './migration-lib.mjs';

const migrations = await loadMigrations();
const client = new pg.Client({ connectionString: OWNER_URL });
await client.connect();

try {
  const applied = await applyMigrations(client, migrations);
  const schemaFingerprint = await fingerprint(client);
  process.stdout.write(
    `\nmigrations ok: ${migrations.length} files, ${applied} pending migration(s) applied\n` +
      `schema fingerprint ${schemaFingerprint}\n`,
  );
} finally {
  await client.end();
}
