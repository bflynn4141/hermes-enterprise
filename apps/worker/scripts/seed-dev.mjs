// A development workspace, so `wrangler dev` has something to serve.
//
// Deliberately a script and not a migration: a migration runs in staging and
// production too, and a seeded user with a known id is exactly what fake auth
// trusts. Nothing here ever reaches a deployed environment.
//
// Idempotent: running it twice leaves one workspace.
import pg from 'pg';
import { OWNER_URL } from './db-config.mjs';
import { assertSeedTargetAllowed } from './seed-guard.mjs';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const MEMBER_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';

const target = assertSeedTargetAllowed(OWNER_URL, process.env.HERMES_SEED_ALLOW_NONLOCAL);
process.stdout.write(`seed target: ${target.display}\n`);
if (target.exceptionalOverride && !target.local && !target.test) {
  process.stdout.write('warning: HERMES_SEED_ALLOW_NONLOCAL=1 bypassed the development seed guard\n');
}

const client = new pg.Client({ connectionString: OWNER_URL });
await client.connect();

try {
  await client.query('BEGIN');
  await client.query(
    `INSERT INTO users (id, email, email_verified, name) VALUES
       ($1, 'maya@nous.example', true, 'Maya Chen'),
       ($2, 'dana@nous.example', true, 'Dana Kim')
     ON CONFLICT (id) DO NOTHING`,
    [ADMIN_ID, MEMBER_ID],
  );

  // Even the seed has to set the tenant key: every tenant table forces
  // row-level security, and the owner is not exempt.
  await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', WORKSPACE_ID]);
  await client.query('SELECT set_config($1, $2, true)', ['app.user_id', ADMIN_ID]);

  await client.query(
    `INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'Nous', 'nous', $2)
     ON CONFLICT (id) DO NOTHING`,
    [WORKSPACE_ID, ADMIN_ID],
  );
  await client.query(
    `INSERT INTO workspace_settings (workspace_id) VALUES ($1) ON CONFLICT (workspace_id) DO NOTHING`,
    [WORKSPACE_ID],
  );
  // The isolated test database is reused across runs. Keep its deterministic
  // seed on the product's current provider without overwriting a developer's
  // own model choice in the durable `hermes` database.
  if (target.test) {
    await client.query(
      `UPDATE workspace_settings
          SET default_model_id = 'nous:anthropic/claude-sonnet-5', default_effort = 'medium'
        WHERE workspace_id = $1`,
      [WORKSPACE_ID],
    );
  }
  await client.query(
    `INSERT INTO members (workspace_id, user_id, role, reviewer_roles) VALUES
       ($1, $2, 'admin', ARRAY['access','finance']),
       ($1, $3, 'member', ARRAY[]::text[])
     -- DO UPDATE rather than DO NOTHING: the member_directory trigger (0013)
     -- only fires on a write, and a re-seed that wrote nothing would leave the
     -- seeded workspace missing from the workspace switcher.
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [WORKSPACE_ID, ADMIN_ID, MEMBER_ID],
  );
  await client.query(
    `INSERT INTO agents (id, workspace_id, name, responsibility, status)
     VALUES ($1, $2, 'Iris', 'Partnerships', 'started')
     ON CONFLICT (id) DO NOTHING`,
    [AGENT_ID, WORKSPACE_ID],
  );
  await client.query(
    `INSERT INTO sessions (id, workspace_id, owner_id, title, model_id)
     VALUES ($1, $2, $3, 'Partner applications', 'nous:anthropic/claude-sonnet-5')
     ON CONFLICT (id) DO NOTHING`,
    [SESSION_ID, WORKSPACE_ID, ADMIN_ID],
  );
  await client.query('COMMIT');

  process.stdout.write(
    'development workspace seeded\n' +
      `  workspace  ${WORKSPACE_ID}\n` +
      `  admin      ${ADMIN_ID}  (maya@nous.example)\n` +
      `  member     ${MEMBER_ID}  (dana@nous.example)\n\n` +
      'try it:\n' +
      `  curl -H "x-dev-user: maya@nous.example" http://localhost:8787/w/${WORKSPACE_ID}/bootstrap\n`,
  );
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
