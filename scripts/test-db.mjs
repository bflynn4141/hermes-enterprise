// Disposable, worktree-owned Postgres for automated tests.
//
// Local tests never use docker-compose's durable `hermes-postgres` container
// or its `hermes` / `hermes_test` databases. Every invocation creates one
// labelled Postgres container on a Docker-assigned loopback port, migrates a
// uniquely named database inside it, and removes only that exact owned
// container. Vitest verifies the ownership manifest before a DB-backed project
// starts, so a bare or misconfigured invocation fails closed.
//
// GitHub Actions is the one exception: its workflow declares a disposable
// Postgres service. It is accepted only when GITHUB_ACTIONS and CI are both
// true and the target is explicit and loopback-local.
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEV_DATABASE = 'hermes';
export let TEST_DATABASE = '';

export const OWNER_LABEL = 'com.hermes.test-owner';
export const DATABASE_URL_KEYS = [
  'DATABASE_URL_SUPERUSER',
  'DATABASE_URL_OWNER',
  'DATABASE_URL_APP',
  'DATABASE_URL_AGENT',
];
const CONTAINER_PORT = '5432/tcp';
const TEST_IMAGE = 'postgres:17.8-alpine';
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const fail = (message) => new Error(`test database isolation: ${message}`);
const sleepSync = (milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
const loopback = (host) => host === '127.0.0.1' || host === 'localhost' || host === '::1';

function command(commandName, args, { cwd = repoRoot, env = process.env, stdio = 'pipe' } = {}) {
  return spawnSync(commandName, args, { cwd, env, stdio, encoding: stdio === 'pipe' ? 'utf8' : undefined });
}

function checked(commandName, args, options = {}) {
  const result = command(commandName, args, options);
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw fail(`${commandName} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function worktreeKey(root = repoRoot) {
  const realRoot = fs.realpathSync(root);
  return createHash('sha256').update(realRoot).digest('hex').slice(0, 10);
}

export function ownedTargetEnvironment(target) {
  return {
    PGHOST: target.host,
    PGPORT: target.port,
    PGDATABASE: target.database,
    PGSUPERUSER: 'postgres',
    PGSUPERPASSWORD: 'postgres',
    PGLOCALPASSWORD: 'localdev',
    HERMES_TEST_DB_OWNER_TOKEN: target.ownerToken,
    HERMES_TEST_DB_CONTAINER_ID: target.containerId,
    HERMES_TEST_DB_CONTAINER_NAME: target.containerName,
  };
}

export function hyperdriveStrings(database = process.env.PGDATABASE, env = process.env) {
  if (!database) throw fail('PGDATABASE must be explicit before constructing Hyperdrive URLs');
  const host = env.PGHOST;
  const port = env.PGPORT;
  if (!host || !port) throw fail('PGHOST and PGPORT must be explicit before constructing Hyperdrive URLs');
  const secret = env.PGLOCALPASSWORD ?? 'localdev';
  return {
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP: `postgres://app:${secret}@${host}:${port}/${database}`,
    CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_AGENT: `postgres://agent:${secret}@${host}:${port}/${database}`,
  };
}

/** Remove inherited direct URLs and rebuild Hyperdrive from the explicit target. */
export function isolatedTestEnvironment(env = process.env) {
  const isolated = { ...env };
  for (const key of DATABASE_URL_KEYS) delete isolated[key];
  Object.assign(isolated, hyperdriveStrings(isolated.PGDATABASE, isolated));
  return isolated;
}

export function targetFromEnvironment(env = process.env) {
  const target = {
    ownerToken: env.HERMES_TEST_DB_OWNER_TOKEN ?? '',
    containerId: env.HERMES_TEST_DB_CONTAINER_ID ?? '',
    containerName: env.HERMES_TEST_DB_CONTAINER_NAME ?? '',
    host: env.PGHOST ?? '',
    port: env.PGPORT ?? '',
    database: env.PGDATABASE ?? '',
  };
  const missing = Object.entries(target).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    throw fail(`local DB-backed tests require an owned target manifest; missing ${missing.join(', ')}. Run pnpm db:test instead of bare Vitest.`);
  }
  return target;
}

export function inspectContainer(containerId) {
  const result = command('docker', ['inspect', containerId]);
  if (result.status !== 0) return null;
  const rows = JSON.parse(result.stdout || '[]');
  const row = rows[0];
  if (!row) return null;
  const binding = row.NetworkSettings?.Ports?.[CONTAINER_PORT]?.find((candidate) => loopback(candidate.HostIp));
  const databaseEntry = row.Config?.Env?.find((entry) => entry.startsWith('POSTGRES_DB='));
  return {
    id: row.Id ?? '',
    name: String(row.Name ?? '').replace(/^\//, ''),
    ownerToken: row.Config?.Labels?.[OWNER_LABEL] ?? '',
    running: row.State?.Running === true,
    database: databaseEntry?.slice('POSTGRES_DB='.length) ?? '',
    host: binding?.HostIp ?? '',
    port: binding?.HostPort ?? '',
  };
}

export function assertOwnedTestTarget(target, { inspect = inspectContainer } = {}) {
  if (!loopback(target.host)) throw fail(`local test target must be loopback, received ${target.host || '(empty)'}`);
  if (!/^\d{2,5}$/.test(target.port)) throw fail(`local test target has invalid port ${target.port || '(empty)'}`);
  if (!/^hermes_test_[a-z0-9_]+$/.test(target.database)) {
    throw fail(`local test database must be uniquely owned; refusing ${target.database || '(empty)'}`);
  }
  if (target.database === 'hermes_test' || target.containerName === 'hermes-postgres') {
    throw fail('refusing the shared Hermes development/test target');
  }
  const actual = inspect(target.containerId);
  if (!actual) throw fail(`owned container ${target.containerId} does not exist`);
  const expected = {
    id: target.containerId,
    name: target.containerName,
    ownerToken: target.ownerToken,
    running: true,
    database: target.database,
    host: target.host,
    port: target.port,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw fail(`owned container verification failed for ${key}: expected ${String(value)}, received ${String(actual[key])}`);
    }
  }
  return target;
}

export function resolveVitestTarget(env = process.env, { needsDatabase = true, inspect = inspectContainer } = {}) {
  if (!needsDatabase) {
    return { host: '127.0.0.1', port: '1', database: 'hermes_test_unowned', github: false };
  }
  const github = env.GITHUB_ACTIONS === 'true';
  if (github) {
    if (env.CI !== 'true') throw fail('GitHub Actions target requires CI=true');
    if (!/^\d+$/.test(env.GITHUB_RUN_ID ?? '')) throw fail('GitHub Actions target requires GITHUB_RUN_ID');
    const host = env.PGHOST ?? '';
    const port = env.PGPORT ?? '';
    const database = env.PGDATABASE ?? '';
    if (!loopback(host) || !/^\d{2,5}$/.test(port) || !database) {
      throw fail('GitHub Actions must declare loopback PGHOST, PGPORT, and PGDATABASE');
    }
    return { host, port, database, github: true };
  }
  const target = targetFromEnvironment(env);
  assertOwnedTestTarget(target, { inspect });
  return { ...target, github: false };
}

export function cleanupOwnedTestTarget(
  target,
  { inspect = inspectContainer, stop = (id) => checked('docker', ['stop', '--time', '5', id]) } = {},
) {
  const actual = inspect(target.containerId);
  if (!actual) return { removed: false, alreadyAbsent: true };
  assertOwnedTestTarget(target, { inspect: () => actual });
  stop(target.containerId);
  return { removed: true, alreadyAbsent: false };
}

function createOwnedContainer(onOwned) {
  const key = worktreeKey();
  const nonce = randomUUID().replaceAll('-', '').slice(0, 8);
  const ownerToken = `${key}-${process.pid}-${nonce}`;
  const database = `hermes_test_${key}_${process.pid}_${nonce}`;
  const containerName = `hermes-test-${key}-${process.pid}-${nonce}`;
  let containerId = '';
  try {
    const run = checked('docker', [
      'run', '--detach', '--rm',
      '--name', containerName,
      '--label', `${OWNER_LABEL}=${ownerToken}`,
      '--env', 'POSTGRES_USER=postgres',
      '--env', 'POSTGRES_PASSWORD=postgres',
      '--env', `POSTGRES_DB=${database}`,
      '--env', 'POSTGRES_INITDB_ARGS=--locale=C --encoding=UTF8',
      '--publish', '127.0.0.1::5432',
      TEST_IMAGE,
      'postgres', '-c', 'max_connections=200', '-c', 'log_statement=none',
    ]);
    containerId = (run.stdout ?? '').trim();
    const actual = inspectContainer(containerId);
    if (!actual?.port) throw fail(`Docker did not publish a loopback port for owned container ${containerId}`);
    const target = { ownerToken, containerId, containerName, host: '127.0.0.1', port: actual.port, database };
    assertOwnedTestTarget(target);
    onOwned(target);

    const deadline = Date.now() + 90_000;
    for (;;) {
      const ready = command('docker', ['exec', containerId, 'pg_isready', '-U', 'postgres', '-d', database]);
      if (ready.status === 0) break;
      if (Date.now() > deadline) throw fail(`owned Postgres ${containerName} did not become ready`);
      sleepSync(250);
    }
    return target;
  } catch (error) {
    const actual = containerId ? inspectContainer(containerId) : null;
    if (
      actual
      && actual.id === containerId
      && actual.name === containerName
      && actual.ownerToken === ownerToken
      && actual.database === database
    ) {
      command('docker', ['stop', '--time', '5', containerId]);
    }
    throw error;
  }
}

function runRepo(commandName, args, env) {
  checked(commandName, args, { stdio: 'inherit', env: isolatedTestEnvironment({ ...process.env, ...env }) });
}

let activeTarget = null;
let exitCleanupRegistered = false;

function registerExitCleanup() {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once('exit', () => {
    if (!activeTarget) return;
    try {
      cleanupOwnedTestTarget(activeTarget);
    } catch (error) {
      process.stderr.write(`${String(error)}\n`);
    }
  });
}

/** Create, migrate, and optionally seed this invocation's owned local target. */
export function ensureTestDatabase({ seed = true } = {}) {
  if (activeTarget) {
    assertOwnedTestTarget(activeTarget);
    return activeTarget.database;
  }
  let target = null;
  try {
    target = createOwnedContainer((created) => {
      target = created;
      activeTarget = created;
      registerExitCleanup();
    });
    for (const key of DATABASE_URL_KEYS) delete process.env[key];
    Object.assign(process.env, ownedTargetEnvironment(target));
    Object.assign(process.env, hyperdriveStrings(target.database, process.env));
    TEST_DATABASE = target.database;
    runRepo('pnpm', ['db:migrate'], ownedTargetEnvironment(target));
    if (seed) runRepo('pnpm', ['--filter', '@hermes/worker', 'db:seed'], ownedTargetEnvironment(target));
    process.stdout.write(`owned test database ${target.database} ready on ${target.host}:${target.port}\n`);
    return target.database;
  } catch (error) {
    if (target) {
      try { cleanupOwnedTestTarget(target); } catch { /* preserve the original setup error */ }
    }
    activeTarget = null;
    throw error;
  }
}

export function cleanupTestDatabase() {
  if (!activeTarget) return { removed: false, alreadyAbsent: true };
  const target = activeTarget;
  activeTarget = null;
  return cleanupOwnedTestTarget(target);
}

/** psql inside this process's verified owned container only. */
export function psql(database, sql, { quiet = true } = {}) {
  if (!activeTarget || database !== activeTarget.database) {
    return { ok: false, out: '', err: `refusing psql outside this process's owned test database ${activeTarget?.database ?? '(none)'}` };
  }
  assertOwnedTestTarget(activeTarget);
  const result = command('docker', [
    'exec', activeTarget.containerId,
    'psql', '-U', 'postgres', '-d', database,
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql,
  ]);
  if (result.status !== 0 && !quiet) process.stderr.write(result.stderr ?? '');
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: result.stderr ?? '' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  ensureTestDatabase();
  process.stdout.write(`${TEST_DATABASE} is owned by this process; press Ctrl-C to stop and remove it\n`);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.once(signal, () => {
      cleanupTestDatabase();
      process.exit(code);
    });
  }
  setInterval(() => undefined, 60_000);
}
