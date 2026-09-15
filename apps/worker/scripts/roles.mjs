// Creates the three database roles and hands the schema to `owner`.
//
// Roles are cluster objects, not schema objects, so they cannot live in a
// migration: a migration runs as `owner`, and `owner` does not exist yet the
// first time. In staging and production these three roles are created once by
// whoever provisions the Neon project; locally this script is that person.
//
// Idempotent: running it twice is a no-op.
import pg from 'pg';
import { LOCAL_ROLE_PASSWORD, ROLES, SUPERUSER_URL } from './db-config.mjs';

// Role names and passwords cannot be bound as parameters in CREATE ROLE, so
// they are quoted here. Both inputs come from this repository's own config,
// never from a request, but quoting them is still cheaper than remembering why
// it was safe not to.
const ident = (value) => `"${value.replaceAll('"', '""')}"`;
const literal = (value) => `'${value.replaceAll("'", "''")}'`;

const client = new pg.Client({ connectionString: SUPERUSER_URL });
await client.connect();

try {
  for (const role of ROLES) {
    // CREATE ROLE has no IF NOT EXISTS, so the existence check is explicit.
    const { rowCount } = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
    if (rowCount === 0) {
      await client.query(`CREATE ROLE ${ident(role)} LOGIN PASSWORD ${literal(LOCAL_ROLE_PASSWORD)}`);
      process.stdout.write(`created role ${role}\n`);
    } else {
      await client.query(`ALTER ROLE ${ident(role)} LOGIN PASSWORD ${literal(LOCAL_ROLE_PASSWORD)}`);
      process.stdout.write(`role ${role} already exists\n`);
    }
    // None of the three may bypass row-level security, including owner: the
    // tables are FORCEd, and a BYPASSRLS role would undo that quietly.
    await client.query(`ALTER ROLE ${ident(role)} NOBYPASSRLS NOSUPERUSER`);
  }

  // `owner` owns the schema so that migrations can create objects in it; `app`
  // and `agent` get USAGE only, and their table grants come from 0004.
  await client.query('ALTER SCHEMA public OWNER TO "owner"');
  await client.query('GRANT ALL ON SCHEMA public TO "owner"');
  await client.query('GRANT USAGE ON SCHEMA public TO "app", "agent"');
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');

  process.stdout.write('roles ready: owner, app, agent\n');
} finally {
  await client.end();
}
