import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { DATABASE_URL_KEYS, isolatedTestEnvironment, resolveVitestTarget } from '../../scripts/test-db.mjs';

// The Node projects import the Worker's own modules, which import the runtime's
// built-in `cloudflare:*` modules. Node has no such modules, so they resolve to
// stand-ins; the classes that use them for real are covered by the workerd
// project, where the real modules exist.
const here = dirname(fileURLToPath(import.meta.url));
const nodeAlias = {
  '@hermes/shared': join(here, '../../packages/shared/src/index.ts'),
  'cloudflare:workers': join(here, 'test/stubs/cloudflare-workers.ts'),
  'cloudflare:workflows': join(here, 'test/stubs/cloudflare-workflows.ts'),
};

// Three projects, because the three kinds of test need three different things.
//
//   unit    pure logic (instance ids, registries, config parity). No runtime.
//   db      Docker Postgres over a real connection, as each of the three roles.
//           These are the tests that prove row-level security, the grant matrix
//           and the jobs claim, so they must run against a real server.
//   worker  the Worker in workerd, through @cloudflare/vitest-pool-workers,
//           reading the same wrangler.jsonc a deploy uses. It reaches the same
//           Docker Postgres through the local Hyperdrive connection strings.
//
// DB-backed projects require either the narrow GitHub Actions service contract
// or the local launcher's verified ownership manifest. Unit-only commands stay
// Docker-free even though Vitest eagerly evaluates this whole config.
const requestedProjects = process.argv.flatMap((argument, index, argv) => {
  if (argument === '--project') return argv[index + 1] ? [argv[index + 1]!] : [];
  if (argument.startsWith('--project=')) return [argument.slice('--project='.length)];
  return [];
});
const needsDatabase = requestedProjects.length === 0
  || requestedProjects.some((project) => project === 'db' || project === 'worker');
const target = resolveVitestTarget(process.env, { needsDatabase });
const database = target.database;
const host = target.host;
const port = target.port;
const password = process.env.PGLOCALPASSWORD ?? 'localdev';
const connection = (role: 'app' | 'agent'): string =>
  `postgres://${role}:${encodeURIComponent(password)}@${host}:${port}/${database}`;

// `db-config.mjs` is imported later by database test modules. Set the already
// verified explicit target before those imports; never replace it with a
// global `hermes_test` default.
for (const key of DATABASE_URL_KEYS) delete process.env[key];
Object.assign(process.env, isolatedTestEnvironment({
  ...process.env,
  PGHOST: host,
  PGPORT: port,
  PGDATABASE: database,
}));

// Never inherit Hyperdrive URLs from a developer shell. Both local and GitHub
// targets are explicit above, so the URLs are deterministically rebuilt from
// that same verified host, port and database.
const localApp = connection('app');
const localAgent = connection('agent');

// Wrangler resolves Hyperdrive's local connection strings from the environment
// while it parses wrangler.jsonc, which happens before the pool applies its own
// miniflare options, so they are set here rather than only passed below.
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP = localApp;
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_AGENT = localAgent;

/**
 * The M0 spike is the one thing in this repository that talks to a real
 * provider. Its project exists only when `HERMES_SPIKE_KEY` is set, so CI —
 * which never sets it — cannot run it even by accident, and `pnpm test` on a
 * developer machine without a key does not either.
 */
const spikeProjects = process.env.HERMES_SPIKE_KEY
  ? [
      {
        resolve: { alias: nodeAlias },
        test: {
          name: 'spike',
          environment: 'node' as const,
          include: ['scripts/spike.ts'],
          testTimeout: 180_000,
          hookTimeout: 180_000,
        },
      },
    ]
  : [];

export default defineConfig({
  test: {
    projects: [
      ...spikeProjects,
      {
        resolve: { alias: nodeAlias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/unit/**/*.test.ts'],
        },
      },
      {
        resolve: { alias: nodeAlias },
        test: {
          name: 'db',
          environment: 'node',
          include: ['test/db/**/*.test.ts'],
          // One database, many tests: they share a server, so they run one file
          // at a time rather than racing over the same rows.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              // Exercise native workerd fetch against an offline Runs API.
              // Other hosts keep their existing network behavior.
              outboundService: 'runtime-transport-fixture',
              workers: [{
                name: 'runtime-transport-fixture',
                modules: true,
                scriptPath: join(here, 'test/stubs/runtime-upstream.mjs'),
                compatibilityDate: '2026-08-15',
              }],
              hyperdrives: {
                HYPERDRIVE_APP: localApp,
                HYPERDRIVE_AGENT: localAgent,
              },
              // `.dev.vars` is a developer's file, and the pool reads it: a
              // machine set up for "real local mode" (README) has
              // MODEL_SCRIPTED="0" and NOUS_PORTAL_FIXTURE="0" in it, and every
              // worker test that drives a run would then reach for a real
              // provider on a real key. These bindings are forced here so the
              // suite's behaviour does not depend on a file it does not own.
              // Same reasoning as `pnpm e2e:live`'s `.dev.vars.test`
              // (decision C37).
              bindings: {
                AUTH_MODE: 'fake',
                MODEL_SCRIPTED: '1',
                OPENROUTER_FIXTURE: '1',
                NOUS_PORTAL_FIXTURE: '1',
              },
            },
          }),
        ],
        test: {
          name: 'worker',
          include: ['test/worker/**/*.test.ts'],
          testTimeout: 30_000,
          // node-postgres is CommonJS; the module runner has to transform it
          // rather than hand workerd a `require`.
          server: { deps: { inline: ['pg', 'pg-pool', 'pg-protocol', 'pgpass'] } },
        },
      },
    ],
  },
});
