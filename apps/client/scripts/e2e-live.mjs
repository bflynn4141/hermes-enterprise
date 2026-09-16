// `pnpm e2e:live` — the whole stack, then the live scenarios, then down again.
//
// ## Two stacks, and they share nothing (decision C43)
//
// | | dev stack | test stack |
// |---|---|---|
// | database | `hermes` | `hermes_test` |
// | Worker | :8787, `pnpm --filter @hermes/worker dev` | :8788, started and stopped by this script |
// | variables | `apps/worker/.dev.vars` | `apps/worker/.dev.vars.test`, generated here |
// | model | whatever `.dev.vars` says, possibly a real provider | always `MODEL_SCRIPTED=1` |
//
// This suite used to run against `hermes` — the same database the developer's
// own Worker is looking at. Fifty scenarios each proposing a request meant the
// Inbox somebody was reading filled with scripted "Ada Ling" rows, their
// session list filled with "P4 race" and "T1 send-scroll", and the workspace
// default model they had chosen was put back to the seed's by `db:seed`. The
// only cure was `pnpm db:reset`, which also destroyed their provider key. A
// suite you cannot run while the product is open is a suite that gets run less.
//
// Nothing here can reach the dev stack: the database name and the port are both
// asserted before anything starts, and `hermes` or 8787 is a hard stop.
//
// Seven steps, in order, each one waited for rather than slept through:
//
//   1. Docker Postgres up and answering (`pnpm db:up`).
//   2. `hermes_test` created if absent, then roles and migrations *in it*.
//   3. The development workspace seeded into `hermes_test`.
//   4. The client built with `AUTH_MODE=fake` into `dist/`, which is what the
//      Worker's Static Assets binding serves. This is the real bundle, not the
//      mock one: the live suite is about what the server does.
//   5. `apps/worker/.dev.vars.test` written from `.dev.vars` with the three
//      values the suite cannot be allowed to inherit forced to their test
//      values, and asserted before anything is started.
//   6. `wrangler dev --local --env-file .dev.vars.test` on `E2E_BASE_URL`'s
//      port (8787 by default), waited for by polling `/health`, then probed
//      with one scripted turn.
//   7. Playwright with `E2E_BASE_URL` pointing at it.
//
// A Worker this script started is stopped on the way out, including on Ctrl-C.
//
// ## Why the env file, and not `env:` on the spawn (decision C37)
//
// This script used to hand `wrangler dev` `MODEL_SCRIPTED=1` and
// `OPENROUTER_FIXTURE=1` in the child process's environment. Wrangler does not
// read the process environment for bindings: it reads `.dev.vars`, and
// `.dev.vars` wins. So a developer who set `MODEL_SCRIPTED="0"` in `.dev.vars`
// to try the product against the real OpenRouter API — which is the documented
// way to do that (`apps/client/README.md`, "Real local mode") — was running the
// entire live suite, thirty-odd scenarios with a turn each, against a real
// provider on their own key, and nothing said so.
//
// `--env-file` is the fix rather than `--var`, because it is the only one that
// is *exclusive*: wrangler skips `.dev.vars` entirely when an env file is named
// (`getVarsForDev`, `if (!envFiles?.length)`), where `--var` is merged
// underneath the secrets `.dev.vars` loads and would lose the same race again.
//
// The file is generated rather than committed: it carries the local Postgres
// strings and the local KEK from `.dev.vars`, and a committed copy would be a
// key in the repository and a second place to keep in sync. It is gitignored
// by the existing `.dev.vars` rules extended with `.dev.vars.*`.
import { spawn, spawnSync } from 'node:child_process';
import { DEV_DATABASE, TEST_DATABASE, ensureTestDatabase, hyperdriveStrings, psql } from '../../../scripts/test-db.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removePrivateTempFile, writePrivateTempFile } from './private-temp-file.mjs';

const clientDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(clientDir));
const workerDir = path.join(repoRoot, 'apps', 'worker');
// 8788, not 8787. The dev Worker's port is not a default this script is allowed
// to have: the two stacks are separate on purpose, and a default that collides
// with the one somebody is watching is the whole bug being fixed here.
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8788';
const PORT = new URL(BASE).port || '8788';
let worker = null;

const stopWorker = () => {
  if (worker && !worker.killed) worker.kill('SIGTERM');
};

if (PORT === '8787') {
  process.stderr.write(`\nrefusing to run: 8787 is the dev Worker's port. The test stack runs on 8788 (decision C43).\n`);
  process.exit(1);
}

/**
 * The values the suite forces, whatever `.dev.vars` says.
 *
 * `MODEL_SCRIPTED` and `OPENROUTER_FIXTURE` are the two that cost money when
 * they are wrong. `AUTH_MODE` is here because every scenario authenticates with
 * `x-dev-user`, and a `workos` worker would fail all of them in a way that
 * reads like a client bug.
 */
const FORCED = {
  AUTH_MODE: 'fake',
  MODEL_SCRIPTED: '1',
  OPENROUTER_FIXTURE: '1',
  // The two that make the test Worker a different stack rather than a second
  // front door onto the developer's rows.
  ...hyperdriveStrings(TEST_DATABASE),
};

const run = (command, args, cwd, env = {}) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) {
    process.stderr.write(`\n${command} ${args.join(' ')} failed\n`);
    process.exit(result.status ?? 1);
  }
};

const die = (message) => {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
};

/**
 * Is *our* Worker answering, or is something else on this port?
 *
 * `/health` is a popular path. 8788 on the machine this was written on was an
 * unrelated project's server answering `{"ok":true,...}`, which a bare
 * `response.ok` read as "the Worker is up" and then as "refusing to reuse a
 * Worker I did not start". The shape is the discriminator: this Worker answers
 * `{ status, version, checks: [...] }`.
 *
 * Returns 'hermes', 'foreign' or null.
 */
const probeHealth = async () => {
  try {
    const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
    const body = await response.json().catch(() => null);
    if (body && typeof body === 'object' && Array.isArray(body.checks) && typeof body.version === 'string') return 'hermes';
    return 'foreign';
  } catch {
    return null;
  }
};

const healthy = async () => (await probeHealth()) === 'hermes';

async function waitForHealth(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    if (await healthy()) return true;
    if (Date.now() > deadline) return false;
    await sleep(500);
  }
}

// --- 1..3 the test database --------------------------------------------------
const database = ensureTestDatabase();
if (database !== TEST_DATABASE || database === DEV_DATABASE) {
  die(`refusing to run: the test database resolved to "${database}", expected "${TEST_DATABASE}".`);
}
process.stdout.write(`test stack: ${TEST_DATABASE} on :${PORT} (the dev stack's ${DEV_DATABASE} on :8787 is not touched)\n`);

// --- 3b stale runs from a Worker that was killed mid-run ---------------------
//
// `wrangler dev` going away in the middle of a run leaves the row `working`
// forever: the reaper is a cron trigger, and cron triggers do not fire in local
// development (wrangler says so on every boot). Three of those is the seeded
// workspace's whole concurrency budget, and the symptom is a 429
// `max_concurrent_runs` on the next turn — which reads like a product bug and
// is a dead process. They are swept here, where the database is already being
// prepared, and only when they are older than five minutes so a run belonging
// to a Worker somebody is watching is never touched.
const swept = psql(
  TEST_DATABASE,
  `UPDATE runs SET status = 'stopped' WHERE status = 'working' AND started_at < now() - interval '5 minutes' RETURNING id;`,
);
const sweptCount = swept.out.split('\n').filter(Boolean).length;
if (sweptCount > 0) process.stdout.write(`swept ${sweptCount} stale working run(s) left by a killed Worker\n`);

// --- 4 the bundle the Worker serves -----------------------------------------
run('node', ['build.mjs'], clientDir, { AUTH_MODE: 'fake' });

// --- 5 the variables the test worker runs on --------------------------------

/** `KEY="value"` lines into an object, the way dotenv reads them. */
function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

const devVarsPath = path.join(workerDir, '.dev.vars');
const testVarsPath = path.join(workerDir, '.dev.vars.test');

// Synchronous on purpose: Node's `exit` event cannot await work. This removes
// a stale copy from an interrupted prior run too, even if this run fails before
// it starts Wrangler.
process.once('exit', () => removePrivateTempFile(testVarsPath));
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  process.once(signal, () => {
    stopWorker();
    process.exit(code);
  });
}

if (!fs.existsSync(devVarsPath)) {
  die(`apps/worker/.dev.vars is missing. Copy .dev.vars.example to it first — the test file is generated from it.`);
}

const base = parseEnvFile(fs.readFileSync(devVarsPath, 'utf8'));
// The Worker checks `Origin` on every state-changing request, and its allowed
// list is written for 8787. The suite can be pointed at another port — which is
// how it runs beside a "real local mode" Worker — so the base URL is added
// rather than assumed.
const origins = new Set((base.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean));
origins.add(new URL(BASE).origin);
origins.add(`http://127.0.0.1:${PORT}`);
origins.add(`http://localhost:${PORT}`);

const testVars = { ...base, ...FORCED, ALLOWED_ORIGINS: [...origins].join(',') };
writePrivateTempFile(
  testVarsPath,
  [
    '# Generated by apps/client/scripts/e2e-live.mjs on every run. Do not edit:',
    '# it is rewritten from .dev.vars with the test values forced (decision C37).',
    '',
    ...Object.entries(testVars).map(([key, value]) => `${key}="${value}"`),
    '',
  ].join('\n'),
);

// Read back rather than trusting the write: this is the assertion the whole
// arrangement exists for, and it costs one file read.
const written = parseEnvFile(fs.readFileSync(testVarsPath, 'utf8'));
for (const [key, value] of Object.entries(FORCED)) {
  if (written[key] !== value) {
    die(`refusing to run: ${testVarsPath} has ${key}="${written[key] ?? ''}", expected "${value}".`);
  }
}
// And the one that would be catastrophic to get wrong, stated as its own check
// rather than trusted to the loop above: no connection string may name the dev
// database.
for (const [key, value] of Object.entries(written)) {
  if (key.startsWith('CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING') && !value.endsWith(`/${TEST_DATABASE}`)) {
    die(`refusing to run: ${key} points at "${value.replace(/:[^:@/]*@/, ':***@')}", not at ${TEST_DATABASE}.`);
  }
}
process.stdout.write(
  `test worker variables: AUTH_MODE=fake MODEL_SCRIPTED=1 OPENROUTER_FIXTURE=1 database=${TEST_DATABASE}\n`,
);

// --- 6 the Worker ------------------------------------------------------------
//
// A Worker already answering on that port is *not* reused any more. It was,
// because
// re-running the suite against a stack you are watching in a browser is the
// normal way to use it — but that stack is started by `pnpm --filter
// @hermes/worker dev`, which reads `.dev.vars`, which is exactly the file this
// script no longer trusts. Reuse is still available, behind a flag that says
// out loud what it is opting into.
const occupant = await probeHealth();
if (occupant === 'foreign') {
  die(
    [
      `something that is not this Worker is already listening on ${BASE}.`,
      ``,
      `Free the port, or point the suite at another one:`,
      `  E2E_BASE_URL=http://localhost:8798 pnpm e2e:live`,
    ].join('\n'),
  );
}
if (occupant === 'hermes') {
  die(
    [
      `a Worker is already answering on ${BASE}, and this suite will not reuse it.`,
      ``,
      `A Worker this script did not start was configured from apps/worker/.dev.vars:`,
      `it may be on a real provider, and it is certainly pointed at the dev`,
      `database. Stop it and run this again. There is no flag for reusing it —`,
      `the whole point of the test stack is that it is not the dev stack.`,
    ].join('\n'),
  );
}

{
  process.stdout.write(`starting wrangler dev --local on ${PORT} with .dev.vars.test\n`);
  worker = spawn(
    'npx',
    ['wrangler', 'dev', '--local', '--port', PORT, '--env-file', testVarsPath],
    {
      cwd: workerDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    },
  );
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

// --- 6b the scripted-provider probe -----------------------------------------
//
// The file assertion above proves what we *asked* for. This proves what the
// running Worker *is*: one turn on the seeded workspace, and the scripted
// provider's own sentence coming back. A Worker on a real provider either has
// no verified key for the seeded workspace and fails the turn, or answers
// something else — either way this stops before thirty scenarios do it again.
const SEED_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SCRIPTED_MARKER = 'pending your decision in the Inbox';

async function probeScriptedProvider() {
  const headers = { 'content-type': 'application/json', origin: BASE, 'x-dev-user': 'maya@nous.example' };
  const session = await fetch(`${BASE}/w/${SEED_WORKSPACE}/sessions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ title: 'e2e provider probe' }),
  });
  if (!session.ok) return `could not create a session: ${session.status} ${(await session.text()).slice(0, 200)}`;
  const sessionId = (await session.json()).id;

  const turn = await fetch(`${BASE}/w/${SEED_WORKSPACE}/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ text: 'Screen the applicant.', client_turn_id: randomUUID() }),
  });
  if (!turn.ok) return `the probe turn was refused: ${turn.status} ${(await turn.text()).slice(0, 200)}`;

  const deadline = Date.now() + 45_000;
  for (;;) {
    const response = await fetch(`${BASE}/w/${SEED_WORKSPACE}/sessions/${sessionId}/messages`, { headers });
    if (response.ok) {
      const body = await response.text();
      if (body.includes(SCRIPTED_MARKER)) return null;
    }
    if (Date.now() > deadline) {
      return `no scripted reply in 45s. The Worker is probably not on MODEL_SCRIPTED=1.`;
    }
    await sleep(1000);
  }
}

if (process.env.E2E_SKIP_PROBE !== '1') {
  const failure = await probeScriptedProvider();
  if (failure) {
    stopWorker();
    die(
      [
        `refusing to run the suite: the scripted-provider probe failed.`,
        `  ${failure}`,
        ``,
        `Every scenario sends a turn. If the Worker is on a real provider they`,
        `all cost money. Check apps/worker/.dev.vars and README "Real local mode".`,
      ].join('\n'),
    );
  }
  process.stdout.write('scripted-provider probe: the Worker answered from the script\n');
}

// --- 7 the scenarios ---------------------------------------------------------
const args = process.argv.slice(2);
const playwright = spawnSync('npx', ['playwright', 'test', ...args], {
  cwd: clientDir,
  stdio: 'inherit',
  env: { ...process.env, E2E_BASE_URL: BASE },
});
stopWorker();
process.exit(playwright.status ?? 1);
