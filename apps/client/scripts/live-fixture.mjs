// Fixtures for the live end-to-end suite.
//
// Two commands, both of which exist because the Worker cannot do them itself in
// `AUTH_MODE=fake`:
//
//   fresh     a brand-new workspace with an Admin and a Member, for the
//             empty-state sweep. `POST /workspaces` now reaches the Worker
//             (server decision F1/F2) and `live-findings.spec.ts` drives it;
//             this stays because it also needs a *Member* in the workspace,
//             which the create route cannot produce without an invitation
//             round trip the empty-state scenarios are not about.
//   step-up   re-stamp `auth_sessions.authenticated_at`. The Worker now has a
//             development step-up of its own — `GET /auth/login?step_up=1` in
//             `AUTH_MODE=fake` (decision F4) — and this does the same thing
//             without a round trip, which is what a fixture wants.
//
// Everything else the suite needs — sessions, turns, decisions — goes through
// the real HTTP routes, because those are what is being tested.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const repoRoot = new URL('../../..', import.meta.url).pathname;

/**
 * The database every fixture and every live assertion talks to.
 *
 * `hermes_test`, not `hermes` (decision C43). This module is imported by the
 * live specs, which read rows back to assert on them and insert rows to set
 * scenarios up; pointed at `hermes` it was writing into the database the
 * developer's own Worker is showing them. `PGDATABASE` is honoured so that a
 * one-off run can be aimed elsewhere deliberately.
 */
export const DATABASE = process.env.PGDATABASE ?? 'hermes_test';

/**
 * `pnpm e2e:live` owns a labelled per-invocation container and exports its id
 * as `HERMES_TEST_DB_CONTAINER_ID` (scripts/test-db.mjs). The owned database
 * lives only there, so fixtures must exec into that container; the compose
 * `postgres` service is the developer's durable `hermes-postgres` and is used
 * only when a run is aimed at it deliberately without an owned container.
 */
const OWNED_CONTAINER = process.env.HERMES_TEST_DB_CONTAINER_ID ?? '';

export function psql(sql) {
  const args = OWNED_CONTAINER
    ? ['exec', OWNED_CONTAINER, 'psql', '-U', 'postgres', '-d', DATABASE, '-t', '-A', '-c', sql]
    : ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', DATABASE, '-t', '-A', '-c', sql];
  return execFileSync('docker', args, { encoding: 'utf8', cwd: repoRoot }).trim();
}

const q = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** A fresh workspace, its Admin, its Member and its agent. Returns the ids. */
export function freshWorkspace(name = `Live ${new Date().toISOString().slice(11, 19)}`) {
  const workspaceId = randomUUID();
  const adminId = randomUUID();
  const memberId = randomUUID();
  const agentId = randomUUID();
  const slug = `live-${workspaceId.slice(0, 8)}`;
  const adminEmail = `admin-${workspaceId.slice(0, 8)}@nous.example`;
  const memberEmail = `member-${workspaceId.slice(0, 8)}@nous.example`;

  psql(`
    BEGIN;
    INSERT INTO users (id, email, email_verified, name) VALUES
      (${q(adminId)}, ${q(adminEmail)}, true, 'Fresh Admin'),
      (${q(memberId)}, ${q(memberEmail)}, true, 'Fresh Member');
    SELECT set_config('app.workspace_id', ${q(workspaceId)}, true);
    SELECT set_config('app.user_id', ${q(adminId)}, true);
    INSERT INTO workspaces (id, name, slug, created_by) VALUES (${q(workspaceId)}, ${q(name)}, ${q(slug)}, ${q(adminId)});
    INSERT INTO workspace_settings (workspace_id) VALUES (${q(workspaceId)});
    INSERT INTO members (workspace_id, user_id, role, reviewer_roles) VALUES
      (${q(workspaceId)}, ${q(adminId)}, 'admin', ARRAY['access','finance']),
      (${q(workspaceId)}, ${q(memberId)}, 'member', ARRAY[]::text[]);
    INSERT INTO agents (id, workspace_id, name, responsibility, status)
      VALUES (${q(agentId)}, ${q(workspaceId)}, 'Iris', 'Partnerships', 'started');
    -- The Admin owns the agent, the way \`POST /workspaces\` and the dev seed
    -- arrange it. Since the private-agent boundaries (0054, PR92) an agent
    -- with no owner row is private to nobody: no session can be opened on it
    -- and every scenario that sends a turn fails with \`unknown_agent\`.
    INSERT INTO agent_owners (workspace_id, agent_id, member_id)
      SELECT workspace_id, ${q(agentId)}, id FROM members
       WHERE workspace_id = ${q(workspaceId)} AND user_id = ${q(adminId)};
    COMMIT;
  `);

  return { workspaceId, adminId, memberId, agentId, adminEmail, memberEmail, name };
}

/** Fake auth has no step-up route; this is what `/auth/callback` would do. */
export function refreshStepUp() {
  psql(`UPDATE auth_sessions SET authenticated_at = now() WHERE sid LIKE 'dev-%';`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2] ?? 'fresh';
  if (command === 'step-up') {
    refreshStepUp();
    process.stdout.write('step-up refreshed\n');
  } else {
    process.stdout.write(`${JSON.stringify(freshWorkspace(process.argv[3]), null, 2)}\n`);
  }
}
