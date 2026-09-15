// `pnpm --filter @hermes/worker db:test` — the db project, on `hermes_test`.
//
// It used to be `node scripts/roles.mjs && vitest run --project db` with
// `PGDATABASE` unset, which meant `hermes`: the same database the developer's
// own Worker is looking at, written to by tests that create workspaces, runs
// and decisions. The tests are correct either way; the developer's Inbox was
// not. `hermes_test` is now the only database any suite writes to (decision
// C43), and this script is what makes sure it exists before vitest starts.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_DATABASE, ensureTestDatabase, hyperdriveStrings } from '../../../scripts/test-db.mjs';

const workerDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Seeded too: `test/db/harness.ts` builds its own rows, but the catalog the
// health check counts comes from the migrations and the seed.
ensureTestDatabase();

const result = spawnSync('npx', ['vitest', 'run', '--project', 'db', ...process.argv.slice(2)], {
  cwd: workerDir,
  stdio: 'inherit',
  env: { ...process.env, PGDATABASE: TEST_DATABASE, ...hyperdriveStrings(TEST_DATABASE) },
});
process.exit(result.status ?? 1);
