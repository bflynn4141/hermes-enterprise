// `pnpm e2e:live` — the whole stack, then the live scenarios, then down again.
//
// Six steps, in order, each one waited for rather than slept through:
//
//   1. Docker Postgres up and answering (`pnpm db:up`).
//   2. Roles and migrations (`pnpm db:migrate`).
//   3. The development workspace seeded, so the seeded Admin and Member exist.
//   4. The client built with `AUTH_MODE=fake` into `dist/`, which is what the
//      Worker's Static Assets binding serves. This is the real bundle, not the
//      mock one: the live suite is about what the server does.
//   5. `wrangler dev --local` on 8787, waited for by polling `/health`.
//   6. Playwright with `E2E_BASE_URL` pointing at it.
//
// A Worker this script started is stopped on the way out, including on Ctrl-C.
// A Worker that was already running on 8787 is left alone and reused, because
// re-running the suite against a stack you are watching in a browser is the
// normal way to use it.
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const clientDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(clientDir));
const workerDir = path.join(repoRoot, 'apps', 'worker');
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8787';

const run = (command, args, cwd, env = {}) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) {
    process.stderr.write(`\n${command} ${args.join(' ')} failed\n`);
    process.exit(result.status ?? 1);
  }
};

const healthy = async () => {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
};

async function waitForHealth(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await healthy()) return true;
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}

// --- 1..3 database -----------------------------------------------------------
run('pnpm', ['db:up'], repoRoot);
run('pnpm', ['db:migrate'], repoRoot);
run('pnpm', ['--filter', '@hermes/worker', 'db:seed'], repoRoot);

// --- 4 the bundle the Worker serves -----------------------------------------
run('node', ['build.mjs'], clientDir, { AUTH_MODE: 'fake' });

// --- 5 the Worker ------------------------------------------------------------
let worker = null;
const alreadyUp = await healthy();
if (alreadyUp) {
  process.stdout.write(`reusing the Worker already answering on ${BASE}\n`);
} else {
  process.stdout.write('starting wrangler dev --local on 8787\n');
  worker = spawn('npx', ['wrangler', 'dev', '--local', '--port', '8787'], {
    cwd: workerDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    // `OPENROUTER_FIXTURE=1` makes the Worker answer OpenRouter's `/key` and
    // `/models` from a built-in fixture rather than the network, so
    // `live-openrouter.spec.ts` can verify a key and sync a catalog offline.
    // The Worker refuses the seam outside `ENVIRONMENT=development`.
    env: { ...process.env, AUTH_MODE: 'fake', MODEL_SCRIPTED: '1', OPENROUTER_FIXTURE: '1' },
  });
  // Kept, not discarded: when the suite fails because the Worker did not come
  // up, the reason is in here and nowhere else.
  const log = [];
  worker.stdout.on('data', (chunk) => log.push(String(chunk)));
  worker.stderr.on('data', (chunk) => log.push(String(chunk)));

  if (!(await waitForHealth(90_000))) {
    process.stderr.write(`the Worker never answered /health:\n${log.join('').slice(-4000)}\n`);
    worker.kill('SIGTERM');
    process.exit(1);
  }
}

const stopWorker = () => {
  if (worker && !worker.killed) worker.kill('SIGTERM');
};
process.on('SIGINT', () => {
  stopWorker();
  process.exit(130);
});

// --- 6 the scenarios ---------------------------------------------------------
const args = process.argv.slice(2);
const playwright = spawnSync('npx', ['playwright', 'test', ...args], {
  cwd: clientDir,
  stdio: 'inherit',
  env: { ...process.env, E2E_BASE_URL: BASE },
});
stopWorker();
process.exit(playwright.status ?? 1);
