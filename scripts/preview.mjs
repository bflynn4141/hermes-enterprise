#!/usr/bin/env node
// Pull-request previews: one throwaway copy of the whole app per pull request.
//
//   node scripts/preview.mjs init --neon-org <org-id>   once per machine
//   node scripts/preview.mjs up <pr> [--comment]         create or update
//   node scripts/preview.mjs down <pr>                   delete everything
//   node scripts/preview.mjs list
//
// A preview is the development build (fake auth, scripted model, fixture
// catalog) deployed as its own Worker, `hermes-pr-<n>`, with its own Neon
// branch, Hyperdrive configs, queues and Workflows. Durable Objects are per
// Worker already. It never touches a staging or production resource: every
// Cloudflare name it creates or deletes must match `hermes-pr-<n>`, and every
// Neon call names the dedicated `hermes-previews` project.
//
// A shared passcode locks it (apps/worker/src/preview-gate.ts). The passcode
// and the per-preview secrets live in ~/.config/hermes-previews/state.json,
// never in the repository and never in a PR comment. See docs/PREVIEWS.md.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_DIR = join(ROOT, 'apps/worker');
const WRANGLER = join(WORKER_DIR, 'node_modules/.bin/wrangler');
const NEONCTL = ['-y', 'neonctl@6.0.0'];
const STATE_DIR = join(homedir(), '.config/hermes-previews');
const STATE_FILE = join(STATE_DIR, 'state.json');

const NEON_PROJECT_NAME = 'hermes-previews';
// The seed guard accepts a remote database only when its name says `test`.
const DATABASE = 'hermes_preview_test';
const DATABASE_OWNER = `${DATABASE}_owner`;
const BUCKET = 'hermes-uploads-previews';
const SEED_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const BRANCH_TTL_DAYS = 14;

// ---------------------------------------------------------------------------
// Guards and small helpers
// ---------------------------------------------------------------------------

const PREVIEW_NAME = /^hermes-pr-[1-9][0-9]{0,5}$/;

function previewName(pr) {
  const name = `hermes-pr-${pr}`;
  if (!PREVIEW_NAME.test(name)) throw new Error(`not a pull request number: ${pr}`);
  return name;
}

/** Every Cloudflare resource this script touches is named for one preview. */
function assertPreviewResource(resource) {
  if (!/^hermes-pr-[1-9][0-9]{0,5}(-[a-z-]+)?$/.test(resource)) {
    throw new Error(`refusing to touch ${resource}: not a preview resource`);
  }
}

const log = (message) => process.stdout.write(`${message}\n`);
const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');

/** The error lines of a command's output, without wrangler's log-file notices. */
function meaningful(output) {
  return output.split('\n').filter((line) => line.trim() && !/Logs were written|update available|^[─-]+$/.test(line))
    .slice(-6).join('\n');
}

function run(bin, args, { cwd = ROOT, env = {}, allowFailure = false, quiet = false } = {}) {
  const result = spawnSync(bin, args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${bin.split('/').pop()} ${args.slice(0, 3).join(' ')} failed:\n${meaningful(output)}`);
  }
  if (!quiet && result.status !== 0) log(meaningful(output));
  return { ok: result.status === 0, output };
}

const wrangler = (args, options) => run(WRANGLER, args, { cwd: WORKER_DIR, ...options });
const neon = (args, options) => run('npx', [...NEONCTL, ...args, '--output', 'json'], options);
const neonJson = (args) => JSON.parse(neon(args).output.replace(/^[^[{]*/, ''));

function loadState() {
  if (!existsSync(STATE_FILE)) return null;
  return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(STATE_FILE, 0o600);
}

function requireState() {
  const state = loadState();
  if (!state) throw new Error('run `node scripts/preview.mjs init --neon-org <org-id>` first');
  return state;
}

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** wrangler.jsonc without its comment lines, as the config tests read it. */
function baseConfig() {
  const text = readFileSync(join(WORKER_DIR, 'wrangler.jsonc'), 'utf8')
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Neon
// ---------------------------------------------------------------------------

function previewProject(state) {
  const project = neonJson(['projects', 'get', state.neonProjectId]);
  const name = project.name ?? project.project?.name;
  if (name !== NEON_PROJECT_NAME) {
    throw new Error(`Neon project ${state.neonProjectId} is named ${name}, not ${NEON_PROJECT_NAME}; refusing`);
  }
}

function connectionHost(state, branch) {
  const raw = neon(['connection-string', branch, '--project-id', state.neonProjectId,
    '--role-name', DATABASE_OWNER, '--database-name', DATABASE]).output;
  const url = raw.match(/postgres(?:ql)?:\/\/[^\s"]+/)?.[0];
  if (!url) throw new Error(`no connection string for branch ${branch}`);
  return { ownerUrl: url, host: new URL(url).hostname };
}

function roleUrl(host, role, password) {
  return `postgresql://${role}:${encodeURIComponent(password)}@${host}/${DATABASE}?sslmode=require`;
}

function branchExists(state, branch) {
  const listed = neonJson(['branches', 'list', '--project-id', state.neonProjectId]);
  const branches = Array.isArray(listed) ? listed : listed.branches ?? [];
  return branches.some((item) => item.name === branch);
}

// ---------------------------------------------------------------------------
// Cloudflare
// ---------------------------------------------------------------------------

function hyperdriveId(name) {
  const line = wrangler(['hyperdrive', 'list'], { quiet: true }).output
    .split('\n').find((row) => row.includes(` ${name} `));
  return line?.match(/[0-9a-f]{32}/)?.[0] ?? null;
}

function ensureHyperdrive(name, connectionString) {
  assertPreviewResource(name);
  const existing = hyperdriveId(name);
  if (existing) {
    wrangler(['hyperdrive', 'update', existing, '--connection-string', connectionString]);
    return existing;
  }
  wrangler(['hyperdrive', 'create', name, '--connection-string', connectionString, '--caching-disabled']);
  const created = hyperdriveId(name);
  if (!created) throw new Error(`Hyperdrive config ${name} was not created`);
  return created;
}

function ensureQueue(name) {
  assertPreviewResource(name);
  const result = wrangler(['queues', 'create', name], { allowFailure: true, quiet: true });
  if (!result.ok && !/already (exists|taken)|11009/i.test(result.output)) {
    throw new Error(`could not create queue ${name}:\n${result.output.slice(-1000)}`);
  }
}

/** The development config, renamed and re-bound for one preview. */
function previewConfig({ name, pr, origin, hyperdrive }) {
  const config = baseConfig();
  delete config.env;
  delete config.$schema;
  // `hermes-extract` becomes `hermes-pr-7-extract`, and so on.
  const scoped = (resource) => `${name}-${resource.replace(/^hermes-/, '')}`;

  config.name = name;
  config.main = join(WORKER_DIR, config.main);
  config.workers_dev = true;
  config.preview_urls = false;
  // The gate must see the app shell as well as the API; it hands every path
  // the Worker does not own to the assets binding itself.
  config.assets = { ...config.assets, directory: join(WORKER_DIR, config.assets.directory), run_worker_first: true };
  config.r2_buckets = [{ binding: 'UPLOADS', bucket_name: BUCKET }];
  config.workflows = config.workflows.map((workflow) => ({ ...workflow, name: scoped(workflow.name) }));
  config.analytics_engine_datasets = [{ binding: 'ANALYTICS', dataset: 'hermes_metrics_previews' }];
  config.queues = {
    producers: config.queues.producers.map((producer) => ({ ...producer, queue: scoped(producer.queue) })),
    consumers: config.queues.consumers.map((consumer) => ({
      ...consumer,
      queue: scoped(consumer.queue),
      ...(consumer.dead_letter_queue ? { dead_letter_queue: scoped(consumer.dead_letter_queue) } : {}),
    })),
  };
  // No Cron. The minute sweep would keep the preview's Neon compute awake all
  // day; committing requests already run their own jobs inline.
  config.triggers = { crons: [] };
  config.hyperdrive = [
    { binding: 'HYPERDRIVE_APP', id: hyperdrive.app },
    { binding: 'HYPERDRIVE_AGENT', id: hyperdrive.agent },
  ];
  config.vars = {
    ...config.vars,
    ENVIRONMENT: 'development',
    AUTH_MODE: 'fake',
    MODEL_SCRIPTED: '1',
    ALLOWED_ORIGINS: origin ?? 'https://preview-origin-pending.invalid',
    HERMES_ENTERPRISE_PUBLIC_URL: origin ?? 'https://preview-origin-pending.invalid',
    AUTOMATED_TRIGGERS_ENABLED: '0',
    PARTNER_SCREENING_AUTOMATE_DEFAULT_AGENTS: '0',
    R2_BUCKET: BUCKET,
    PREVIEW_PR: String(pr),
  };
  for (const resource of [...config.queues.consumers.map((c) => c.queue), ...config.workflows.map((w) => w.name)]) {
    assertPreviewResource(resource);
  }
  return config;
}

function deploy(config, secrets) {
  const dir = join(WORKER_DIR, '.wrangler/preview');
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, `${config.name}.json`);
  const secretsPath = join(dir, `${config.name}.secrets.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
  try {
    // A deploy uploads several megabytes; retry the network failures that
    // wrangler reports as `fetch failed`, and nothing else.
    for (let attempt = 1; ; attempt += 1) {
      const result = wrangler(['deploy', '--config', configPath, '--secrets-file', secretsPath], { allowFailure: true, quiet: true });
      if (result.ok) return result.output.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/)?.[0] ?? null;
      if (attempt === 3 || !/fetch failed|ECONNRESET|ETIMEDOUT|connectivity/i.test(result.output)) {
        throw new Error(`wrangler deploy failed:\n${result.output.slice(-2000)}`);
      }
      log(`deploy attempt ${attempt} hit a network error; retrying`);
    }
  } finally {
    writeFileSync(secretsPath, '{}');
  }
}

async function smoke(origin, passcode) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const health = await fetch(`${origin}/health`).catch(() => null);
    if (health?.ok) break;
    if (attempt === 12) throw new Error(`${origin}/health never answered 200 (last ${health?.status}: ${await health?.text()})`);
    await new Promise((done) => setTimeout(done, 5000));
  }
  const locked = await fetch(`${origin}/w/${SEED_WORKSPACE}/bootstrap`, { headers: { 'x-dev-user': 'maya@nous.example' } });
  if (locked.status !== 401) throw new Error(`the preview answered ${locked.status} without the passcode; expected 401`);
  const unlock = await fetch(`${origin}/__preview/unlock`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ passcode, next: '/' }),
  });
  const cookie = unlock.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`unlock failed with ${unlock.status}`);
  const bootstrap = await fetch(`${origin}/w/${SEED_WORKSPACE}/bootstrap`, {
    headers: { cookie, 'x-dev-user': 'maya@nous.example' },
  });
  if (!bootstrap.ok) throw new Error(`bootstrap answered ${bootstrap.status}: ${(await bootstrap.text()).slice(0, 300)}`);
  const app = await fetch(`${origin}/workspace/${SEED_WORKSPACE}`, { headers: { cookie, accept: 'text/html', 'sec-fetch-mode': 'navigate' } });
  if (!app.ok || !(await app.text()).includes('<div id="root">')) throw new Error(`the app shell answered ${app.status}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function init() {
  let state = loadState();
  if (!state?.neonProjectId) {
    const org = flag('--neon-org');
    if (!org) throw new Error('init needs --neon-org <org-id> (neonctl orgs list)');
    const created = neonJson(['projects', 'create', '--name', NEON_PROJECT_NAME, '--org-id', org,
      '--region-id', 'aws-us-east-1', '--database', DATABASE, '--role', DATABASE_OWNER]);
    const project = created.project ?? created;
    state = { neonProjectId: project.id, rolePassword: secret(24), passcode: secret(15), previews: {} };
    saveState(state);
    log(`created Neon project ${project.id}`);
  }
  previewProject(state);

  // The three roles on the parent branch; every preview branch inherits them.
  // Idempotent, so an interrupted init can simply run again.
  const { ownerUrl } = connectionHost(state, 'main');
  run('node', ['apps/worker/scripts/roles.mjs'], {
    env: { DATABASE_URL_SUPERUSER: ownerUrl, PGLOCALPASSWORD: state.rolePassword },
  });

  const bucket = wrangler(['r2', 'bucket', 'create', BUCKET], { allowFailure: true, quiet: true });
  if (!bucket.ok && !/already exists|10004/i.test(bucket.output)) throw new Error(bucket.output);
  wrangler(['r2', 'bucket', 'lifecycle', 'add', BUCKET, 'expire-previews', '--expire-days', '14', '--force'], { allowFailure: true });
  log(`ready: Neon project ${state.neonProjectId}, bucket ${BUCKET}`);
  log(`the preview passcode is in ${STATE_FILE}`);
}

/**
 * A preview runs fake sign-in, so it must never deploy code without the gate.
 * The smoke test would catch it, but only after the Worker was already live.
 */
function assertGatePresent() {
  const gate = join(WORKER_DIR, 'src/preview-gate.ts');
  const entry = readFileSync(join(WORKER_DIR, 'src/index.ts'), 'utf8');
  if (!existsSync(gate) || !entry.includes('previewGate(request, env)')) {
    throw new Error('this checkout has no preview gate (apps/worker/src/preview-gate.ts wired into index.ts); refusing to deploy fake sign-in unlocked');
  }
}

async function up(pr) {
  const name = previewName(pr);
  assertGatePresent();
  const state = requireState();
  previewProject(state);
  const preview = state.previews[name] ?? { kek: randomBytes(32).toString('base64'), hubTicket: secret(), cookie: secret() };
  state.previews[name] = preview;
  saveState(state);

  const branch = `pr-${pr}`;
  const fresh = !branchExists(state, branch);
  if (fresh) {
    const expires = new Date(Date.now() + BRANCH_TTL_DAYS * 86_400_000).toISOString();
    neon(['branches', 'create', '--project-id', state.neonProjectId, '--name', branch, '--parent', 'main',
      '--expires-at', expires, '--suspend-timeout', '300']);
    log(`created Neon branch ${branch} (expires ${expires.slice(0, 10)})`);
  }
  const { host } = connectionHost(state, branch);
  const urls = {
    owner: roleUrl(host, 'owner', state.rolePassword),
    app: roleUrl(host, 'app', state.rolePassword),
    agent: roleUrl(host, 'agent', state.rolePassword),
  };
  run('node', ['apps/worker/scripts/migrate.mjs'], { env: { DATABASE_URL_OWNER: urls.owner } });
  if (fresh) run('node', ['apps/worker/scripts/seed-dev.mjs'], { env: { DATABASE_URL_OWNER: urls.owner } });

  const hyperdrive = { app: ensureHyperdrive(`${name}-app`, urls.app), agent: ensureHyperdrive(`${name}-agent`, urls.agent) };
  for (const queue of ['extract', 'extract-dlq', 'renders', 'renders-dlq']) ensureQueue(`${name}-${queue}`);

  run('pnpm', ['--filter', '@hermes/client', 'build'], { env: { AUTH_MODE: 'fake' } });

  const secrets = {
    PREVIEW_PASSCODE: state.passcode,
    KEK_V1: preview.kek,
    HUB_TICKET_SECRET: preview.hubTicket,
    WORKOS_COOKIE_PASSWORD: preview.cookie,
  };
  let url = deploy(previewConfig({ name, pr, origin: preview.url, hyperdrive }), secrets);
  if (!url) throw new Error('wrangler did not report a workers.dev URL');
  if (url !== preview.url) {
    // The first deploy is what reveals the account's workers.dev subdomain;
    // the origin allowlist needs it, so deploy once more with it filled in.
    preview.url = url;
    saveState(state);
    url = deploy(previewConfig({ name, pr, origin: url, hyperdrive }), secrets) ?? url;
  }
  await smoke(url, state.passcode);
  log(`\npreview ready: ${url}/workspace/${SEED_WORKSPACE}`);

  if (process.argv.includes('--comment')) {
    const sha = run('git', ['rev-parse', '--short', 'HEAD'], { quiet: true }).output.trim();
    const body = [
      `**Preview:** ${url}/workspace/${SEED_WORKSPACE}`,
      '',
      `Built from \`${sha}\`. Sample data, fake sign-in and a scripted agent; no real Hermes agents, email or payments.`,
      'The passcode is the shared preview passcode (ask Brian). Closing the PR should be followed by `node scripts/preview.mjs down ' + pr + '`.',
    ].join('\n');
    run('gh', ['pr', 'comment', String(pr), '--edit-last', '--body', body], { allowFailure: true, quiet: true }).ok
      || run('gh', ['pr', 'comment', String(pr), '--body', body]);
    log('commented on the pull request');
  }
}

async function down(pr) {
  const name = previewName(pr);
  const state = requireState();
  previewProject(state);
  const config = previewConfig({ name, pr, origin: null, hyperdrive: { app: 'x', agent: 'x' } });
  const queues = config.queues.consumers.map((consumer) => consumer.queue);
  const problems = [];
  const gone = (output) => /not[ _]found|does not exist|10007|10200|could not find|11000/i.test(output);
  const attempt = (label, args) => {
    const result = wrangler(args, { allowFailure: true, quiet: true });
    if (!result.ok && !gone(result.output)) problems.push(`${label}: ${meaningful(result.output)}`);
  };

  // Cloudflare refuses to delete a Worker that still consumes a queue, so the
  // consumers come off first, then the Worker, then everything it used.
  for (const queue of queues) {
    assertPreviewResource(queue);
    attempt(`detach ${queue}`, ['queues', 'consumer', 'remove', queue, name]);
  }
  assertPreviewResource(name);
  attempt(`delete Worker ${name}`, ['delete', name, '--force']);
  for (const workflow of config.workflows) attempt(`delete Workflow ${workflow.name}`, ['workflows', 'delete', workflow.name]);
  for (const queue of queues) attempt(`delete queue ${queue}`, ['queues', 'delete', queue]);
  for (const role of ['app', 'agent']) {
    const id = hyperdriveId(`${name}-${role}`);
    if (id) attempt(`delete Hyperdrive ${name}-${role}`, ['hyperdrive', 'delete', id]);
  }
  if (branchExists(state, `pr-${pr}`)) {
    neon(['branches', 'delete', `pr-${pr}`, '--project-id', state.neonProjectId]);
  }

  if (problems.length > 0) {
    throw new Error(`some of ${name} is still there; run down again after fixing:\n${problems.join('\n')}`);
  }
  delete state.previews[name];
  saveState(state);
  log(`deleted ${name}`);
}

function list() {
  const state = requireState();
  const names = Object.keys(state.previews);
  if (names.length === 0) log('no previews');
  for (const name of names) log(`${name}  ${state.previews[name].url ?? '(not deployed)'}`);
}

const [command, pr] = process.argv.slice(2);
try {
  if (command === 'init') await init();
  else if (command === 'up' && pr) await up(pr);
  else if (command === 'down' && pr) await down(pr);
  else if (command === 'list') list();
  else {
    log('usage: node scripts/preview.mjs init --neon-org <id> | up <pr> [--comment] | down <pr> | list');
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`preview: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
