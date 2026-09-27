// A private local stack for the email-intake walkthrough (decision C98):
// its own Postgres container with every migration and the seeded "Nous"
// workspace, the client built with AUTH_MODE=fake, and `wrangler dev` on its
// own port with the scripted model. Nothing here touches the developer's
// `hermes` database or port 8787; the container is removed on exit.
//
//   node scripts/email-intake-stack.mjs            # stays up until Ctrl-C
//   EMAIL_STACK_PORT=8796 node scripts/email-intake-stack.mjs
//
// `startEmailIntakeStack()` is also what `record-email-intake.mjs` calls.
// Mail reaches the Worker the way Cloudflare Email Routing delivers it in
// development: POST the raw message to /cdn-cgi/handler/email.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEV_DATABASE, cleanupTestDatabase, ensureTestDatabase, hyperdriveStrings, psql } from '../../../scripts/test-db.mjs';
import { removePrivateTempFile, writePrivateTempFile } from './private-temp-file.mjs';

const clientDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workerDir = path.join(clientDir, '..', 'worker');

export const SEED = {
  workspace: '11111111-1111-4111-8111-111111111111',
  maya: 'maya@nous.example',
  dana: 'dana@nous.example',
};

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[match[1]] = value;
  }
  return out;
}

async function healthy(base) {
  try {
    const body = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) })).json();
    return Array.isArray(body?.checks) && typeof body?.version === 'string';
  } catch {
    return false;
  }
}

export async function startEmailIntakeStack({ port = Number(process.env.EMAIL_STACK_PORT ?? 8795) } = {}) {
  if (port === 8787) throw new Error('8787 is the dev Worker; the walkthrough stack runs elsewhere.');
  const base = `http://localhost:${port}`;
  if (await healthy(base)) throw new Error(`${base} is already answering; stop it first.`);

  const database = ensureTestDatabase();
  if (database === DEV_DATABASE) throw new Error('refusing to use the developer database');
  // The story's cast: Dana holds Finance, so the hand-off reaches someone else.
  // The catalog line stands in for the sync a connected Nous Portal performs;
  // the Worker still answers from the script (MODEL_SCRIPTED=1), so no model
  // is called and nothing is spent.
  const setup = psql(database, `
    UPDATE catalog SET disabled_reason = NULL WHERE model_id = 'nous:anthropic/claude-sonnet-5';
    BEGIN;
    SELECT set_config('app.workspace_id', '${SEED.workspace}', true);
    UPDATE members SET reviewer_roles = ARRAY['access']::text[]
     WHERE workspace_id='${SEED.workspace}' AND user_id=(SELECT id FROM users WHERE email='${SEED.maya}');
    UPDATE members SET reviewer_roles = ARRAY['finance']::text[]
     WHERE workspace_id='${SEED.workspace}' AND user_id=(SELECT id FROM users WHERE email='${SEED.dana}');
    COMMIT;`, { quiet: false });
  if (!setup.ok) throw new Error(`could not prepare the walkthrough workspace: ${setup.err}`);

  const build = spawnSync('node', ['build.mjs'], { cwd: clientDir, stdio: 'inherit', env: { ...process.env, AUTH_MODE: 'fake' } });
  if (build.status !== 0) throw new Error('client build failed');

  const devVars = parseEnvFile(fs.readFileSync(path.join(workerDir, '.dev.vars'), 'utf8'));
  const varsPath = path.join(workerDir, '.dev.vars.email-intake');
  const vars = {
    ...devVars,
    AUTH_MODE: 'fake',
    AGENT_RUNTIME: 'legacy',
    MODEL_SCRIPTED: '1',
    OPENROUTER_FIXTURE: '1',
    NOUS_PORTAL_FIXTURE: '1',
    ...hyperdriveStrings(database),
    ALLOWED_ORIGINS: `http://localhost:${port},http://127.0.0.1:${port}`,
  };
  writePrivateTempFile(varsPath, Object.entries(vars).map(([key, value]) => `${key}="${value}"`).join('\n') + '\n');
  const worker = spawn('npx', ['wrangler', 'dev', '--local', '--port', String(port), '--env-file', varsPath], {
    cwd: workerDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env },
  });
  const log = [];
  const logFile = process.env.EMAIL_STACK_LOG;
  const keep = (chunk) => {
    log.push(String(chunk));
    if (logFile) fs.appendFileSync(logFile, String(chunk));
  };
  worker.stdout.on('data', keep);
  worker.stderr.on('data', keep);
  const deadline = Date.now() + 120_000;
  while (!(await healthy(base))) {
    if (Date.now() > deadline || worker.exitCode !== null) {
      worker.kill('SIGTERM');
      throw new Error(`the Worker never answered /health:\n${log.join('').slice(-3000)}`);
    }
    await sleep(500);
  }
  const stop = () => {
    if (!worker.killed) worker.kill('SIGTERM');
    removePrivateTempFile(varsPath);
    cleanupTestDatabase();
  };
  return { base, database, stop, log };
}

/** Deliver one raw message the way Email Routing hands it to email() in development. */
export async function deliverEmail(base, { from, to, raw }) {
  const url = new URL('/cdn-cgi/handler/email', base);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'message/rfc822' }, body: raw });
  return { status: response.status, body: await response.text() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stack = await startEmailIntakeStack();
  process.stdout.write(`\nemail-intake stack ready at ${stack.base} (database ${stack.database}). Ctrl-C to stop.\n`);
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
    process.once(signal, () => { stack.stop(); process.exit(code); });
  }
  setInterval(() => undefined, 60_000);
}
