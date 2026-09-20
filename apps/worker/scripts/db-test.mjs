// Run DB-backed Vitest projects against one explicitly owned target.
//
// Local invocations create and remove a per-process container. GitHub Actions
// uses only the workflow's declared disposable service. CI=true by itself is
// deliberately not an escape hatch: local workers have historically set it
// and then mutated the shared `hermes_test` database.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupTestDatabase,
  ensureTestDatabase,
  isolatedTestEnvironment,
  resolveVitestTarget,
} from '../../../scripts/test-db.mjs';

const workerDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const github = process.env.GITHUB_ACTIONS === 'true';
const withWorker = process.argv.includes('--with-worker');
const passthrough = process.argv.slice(2).filter(
  (argument) => argument !== '--with-worker' && argument !== '--',
);

function run(project, extra = []) {
  const result = spawnSync('npx', ['vitest', 'run', '--project', project, ...extra], {
    cwd: workerDir,
    stdio: 'inherit',
    env: isolatedTestEnvironment(process.env),
  });
  return result.status ?? 1;
}

let status = 1;
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(signal, () => {
    if (!github) cleanupTestDatabase();
    process.exit(code);
  });
}
try {
  if (github) {
    resolveVitestTarget(process.env, { needsDatabase: true });
  } else {
    ensureTestDatabase();
  }

  status = run('db', passthrough);
  if (status === 0 && withWorker) status = run('worker');
} finally {
  if (!github) cleanupTestDatabase();
}

process.exit(status);
