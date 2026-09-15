// The GitHub Actions workflows, and the wrangler config they deploy.
//
// A workflow file is code that only ever runs in production: there is no way to
// run one locally, and a mistake in it is discovered by a failed deploy at the
// worst possible time. CI runs `actionlint`, which knows YAML and the Actions
// schema. This file knows *us* — the properties this repository requires and no
// linter could guess — and it runs everywhere `pnpm test:unit` runs, including
// on a machine with no actionlint installed.
//
// The YAML is parsed by a deliberately small reader rather than a dependency.
// It is enough for the questions below (does this job name an environment, does
// every deploy have a concurrency group, does any `run:` interpolate a secret)
// and adding a YAML parser to the worker's dependencies to answer them would be
// a runtime dependency carried for a test.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const workflowDir = join(root, '.github/workflows');

const files = readdirSync(workflowDir).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
const read = (name: string): string => readFileSync(join(workflowDir, name), 'utf8');

/**
 * Indentation-aware enough to answer "which top-level keys are here" and "what
 * is under `jobs:`". Comments and blank lines are dropped; everything else is
 * kept as `{ indent, key, value }`.
 */
interface Line {
  readonly indent: number;
  readonly key: string;
  readonly value: string;
  readonly raw: string;
}

function lines(text: string): Line[] {
  const out: Line[] = [];
  let inBlock = false;
  let blockIndent = 0;
  for (const raw of text.split('\n')) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    // A `run: |` block's body is shell, not YAML, and must not be read as keys.
    if (inBlock && indent > blockIndent) continue;
    inBlock = false;
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(raw.trim());
    if (!match) continue;
    const [, key = '', value = ''] = match;
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      inBlock = true;
      blockIndent = indent;
    }
    out.push({ indent, key, value, raw });
  }
  return out;
}

/** Top-level `jobs:` entries, with their body lines. */
function jobs(text: string): Map<string, Line[]> {
  const parsed = lines(text);
  const start = parsed.findIndex((line) => line.indent === 0 && line.key === 'jobs');
  const result = new Map<string, Line[]>();
  if (start === -1) return result;
  const jobIndent = parsed[start + 1]?.indent ?? 2;
  let current: string | null = null;
  for (const line of parsed.slice(start + 1)) {
    if (line.indent === 0) break;
    if (line.indent === jobIndent) {
      current = line.key;
      result.set(current, []);
    } else if (current) {
      result.get(current)?.push(line);
    }
  }
  return result;
}

const has = (body: Line[], key: string): boolean => body.some((line) => line.key === key);
const valueOf = (body: Line[], key: string): string | undefined =>
  body.find((line) => line.key === key)?.value;

describe('the workflow files', () => {
  it('exist, and cover CI, both deploys and the backup', () => {
    expect(files.sort()).toEqual(
      ['backup-nightly.yml', 'ci.yml', 'deploy-production.yml', 'deploy-staging.yml'].sort(),
    );
  });

  it('each parse into a name, a trigger and at least one job', () => {
    for (const file of files) {
      const text = read(file);
      const top = lines(text).filter((line) => line.indent === 0).map((line) => line.key);
      expect(top, `${file} has no name`).toContain('name');
      expect(top, `${file} has no trigger`).toContain('on');
      expect(top, `${file} has no jobs`).toContain('jobs');
      expect(jobs(text).size, `${file} declares no jobs`).toBeGreaterThan(0);
    }
  });

  it('give every job a runner and a timeout', () => {
    for (const file of files) {
      for (const [name, body] of jobs(read(file))) {
        expect(has(body, 'runs-on'), `${file}:${name} has no runs-on`).toBe(true);
        // Without one, a hung step burns six hours of runner time before
        // anybody notices the deploy did not happen.
        expect(has(body, 'timeout-minutes'), `${file}:${name} has no timeout-minutes`).toBe(true);
      }
    }
  });

  it('pin every action to a major version rather than a moving ref', () => {
    for (const file of files) {
      for (const line of read(file).split('\n')) {
        const match = /^\s*-?\s*uses:\s*(\S+)/.exec(line);
        if (!match?.[1]) continue;
        const ref = match[1];
        expect(ref, `${file} uses an unpinned action: ${ref}`).toContain('@');
        expect(ref, `${file} tracks a branch: ${ref}`).not.toMatch(/@(main|master|latest)$/);
      }
    }
  });

  it('read-only by default: no workflow grants write permissions', () => {
    for (const file of files) {
      const text = read(file);
      expect(text, `${file} does not declare permissions`).toContain('permissions:');
      // The pipeline is inside the BYOK trust boundary; a workflow that can
      // write to the repository is a workflow that can change what deploys.
      expect(text, `${file} grants write permissions`).not.toMatch(/permissions:[\s\S]{0,200}write/);
    }
  });

  describe('the deploys', () => {
    const deploys = ['deploy-staging.yml', 'deploy-production.yml'];

    it('never cancel in progress, because a half-run deploy is the bad state', () => {
      for (const file of deploys) {
        const text = read(file);
        expect(text, `${file} has no concurrency group`).toContain('concurrency:');
        // A cancelled `wrangler deploy` can leave the Worker and the migrations
        // disagreeing about the schema, which expand/contract cannot save.
        expect(text, `${file} cancels in progress`).toContain('cancel-in-progress: false');
      }
    });

    it('run migrations from MIGRATIONS_DATABASE_URL, before the deploy', () => {
      for (const file of deploys) {
        const text = read(file);
        expect(text).toContain('secrets.MIGRATIONS_DATABASE_URL');
        expect(text).toContain('scripts/migrate.mjs');
        // Order: migrate, then build, then deploy. Expand/contract is what
        // makes that safe, and the reverse order is what makes it not.
        expect(text.indexOf('scripts/migrate.mjs')).toBeLessThan(text.indexOf('command: deploy'));
      }
    });

    it('build the client and smoke-test /health', () => {
      for (const file of deploys) {
        const text = read(file);
        expect(text).toContain('@hermes/client build');
        expect(text).toContain('/health');
      }
    });

    it('name a GitHub Environment on the job that holds the deploy credential', () => {
      for (const file of deploys) {
        const deploy = jobs(read(file)).get('deploy');
        expect(deploy, `${file} has no deploy job`).toBeDefined();
        // An environment secret is not readable from a pull request, and the
        // production environment is where the required reviewer lives.
        expect(has(deploy ?? [], 'environment'), `${file}:deploy names no environment`).toBe(true);
      }
    });

    it('make production manual, confirmed and gated behind a preflight', () => {
      const text = read('deploy-production.yml');
      expect(text).toContain('workflow_dispatch:');
      expect(text).not.toMatch(/^\s\sschedule:/m);
      // No `push:` trigger at all: production is never deployed by merging.
      expect(text).not.toMatch(/^\s\spush:/m);
      const deploy = jobs(text).get('deploy');
      expect(valueOf(deploy ?? [], 'environment')).toBe('production');
      expect(valueOf(deploy ?? [], 'needs')).toBe('preflight');
    });

    it('deploy staging from main automatically', () => {
      const text = read('deploy-staging.yml');
      expect(text).toContain('branches: [main]');
      expect(valueOf(jobs(text).get('deploy') ?? [], 'environment')).toBe('staging');
    });

    it('run gitleaks and the unit project on both paths', () => {
      for (const file of deploys) {
        const text = read(file);
        expect(text, `${file} does not scan for secrets`).toContain('gitleaks');
        // Exports parity, the migration filename test and "wrangler.jsonc
        // carries no secret" all live in the unit project.
        expect(text, `${file} does not run the unit project`).toContain('test:unit');
      }
    });
  });

  describe('CI', () => {
    const text = read('ci.yml');

    it('runs typecheck, the full suite, the grant assertion and both dry runs', () => {
      expect(text).toContain('pnpm typecheck');
      expect(text).toContain('pnpm test');
      expect(text).toContain('test/db/grants.test.ts');
      expect(text).toContain('--dry-run --env staging');
      expect(text).toContain('--dry-run --env production');
    });

    it('lints the workflow files', () => {
      expect(text).toContain('actionlint');
    });

    it('scans for secrets', () => {
      expect(text).toContain('gitleaks');
    });
  });

  describe('the nightly backup', () => {
    const text = read('backup-nightly.yml');

    it('is scheduled, and has a dry run that needs no secret', () => {
      expect(text).toContain('cron:');
      expect(jobs(text).has('dry-run')).toBe(true);
      expect(jobs(text).has('dump')).toBe(true);
    });

    it('documents every secret it uses, in the file that uses them', () => {
      for (const secret of [
        'BACKUP_DATABASE_URL',
        'BACKUP_R2_ACCOUNT_ID',
        'BACKUP_R2_ACCESS_KEY_ID',
        'BACKUP_R2_SECRET_ACCESS_KEY',
      ]) {
        expect(text, `${secret} is not documented`).toContain(secret);
      }
      // The two scopes that make the credential safe to hold overnight.
      expect(text).toContain('write-only');
      expect(text).toContain('read-only');
    });

    it('keeps the dump job off pull requests', () => {
      const dump = jobs(text).get('dump') ?? [];
      const condition = valueOf(dump, 'if') ?? '';
      expect(condition).toContain('schedule');
      expect(condition).not.toContain('pull_request');
    });
  });

  it('never interpolates a secret into a shell command', () => {
    // `${{ secrets.X }}` inside a `run:` is how a secret reaches a process
    // list, a shell history and, if the value contains a quote, an injection.
    // Every one of them is passed through `env:` instead.
    for (const file of files) {
      const text = read(file);
      let inRun = false;
      let runIndent = 0;
      for (const raw of text.split('\n')) {
        const indent = raw.length - raw.trimStart().length;
        if (inRun && indent > runIndent) {
          expect(raw, `${file} interpolates a secret into a run block`).not.toMatch(/\$\{\{\s*secrets\./);
          continue;
        }
        inRun = false;
        if (/^\s*run:\s*[|>]/.test(raw)) {
          inRun = true;
          runIndent = indent;
        } else if (/^\s*run:\s*\S/.test(raw)) {
          expect(raw, `${file} interpolates a secret into a run line`).not.toMatch(/\$\{\{\s*secrets\./);
        }
      }
    }
  });
});

describe('migration filenames', () => {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');
  const migrations = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).sort();

  it('are `NNNN_short_name.sql`, numbered without a gap and without a collision', () => {
    expect(migrations.length).toBeGreaterThan(0);
    const seen = new Set<number>();
    migrations.forEach((name, index) => {
      // The runner sorts by filename and records the sha, so a filename that
      // does not sort the way it numbers is a migration applied out of order.
      expect(name, `${name} is not NNNN_short_name.sql`).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      const number = Number(name.slice(0, 4));
      expect(seen.has(number), `${name} reuses a number`).toBe(false);
      seen.add(number);
      expect(number, `${name} is out of sequence`).toBe(index + 1);
    });
  });

  it('are never edited after the fact, which is what the sha in the runner is for', () => {
    // A guard against the shape of mistake, not the mistake itself: the runner
    // refuses a file whose sha changed, and this asserts the numbering that
    // makes "add a new one instead" possible.
    const last = migrations[migrations.length - 1] ?? '';
    expect(Number(last.slice(0, 4))).toBe(migrations.length);
  });
});
