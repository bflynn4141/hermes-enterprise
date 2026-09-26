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
    // tables are FORCEd, and a BYPASSRLS role would undo that quietly. Only a
    // superuser may run this ALTER, and a hosted Postgres such as Neon has
    // none, so it runs only when a role actually holds one of the attributes.
    // A freshly created role never does.
    const { rows } = await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [role]);
    if (rows[0]?.rolsuper || rows[0]?.rolbypassrls) {
      await client.query(`ALTER ROLE ${ident(role)} NOBYPASSRLS NOSUPERUSER`);
    }
  }

  // `owner` owns the schema so that migrations can create objects in it; `app`
  // and `agent` get USAGE only, and their table grants come from 0004.
  // Handing the schema over requires being able to SET ROLE to the new owner.
  // A superuser always can; a hosted database's admin role (Neon's) must be
  // made a member first, which its CREATEROLE lets it do for a role it made.
  const { rows: self } = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
  if (!self[0]?.rolsuper) await client.query('GRANT "owner" TO CURRENT_USER');
  await client.query('ALTER SCHEMA public OWNER TO "owner"');
  await client.query('GRANT ALL ON SCHEMA public TO "owner"');
  await client.query('GRANT USAGE ON SCHEMA public TO "app", "agent"');
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');

  process.stdout.write('roles ready: owner, app, agent\n');
} finally {
  await client.end();
}
