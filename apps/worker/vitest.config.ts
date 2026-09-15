import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// The Node projects import the Worker's own modules, which import the runtime's
// built-in `cloudflare:*` modules. Node has no such modules, so they resolve to
// stand-ins; the classes that use them for real are covered by the workerd
// project, where the real modules exist.
const here = dirname(fileURLToPath(import.meta.url));
const nodeAlias = {
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
// `hermes_test`, never `hermes` (decision C43). The db and worker projects both
// write rows — workspaces, runs, decisions — and `hermes` is the database the
// developer's own `wrangler dev` on :8787 is showing them. `pnpm db:test` and
// `pnpm e2e:live` create and migrate `hermes_test`; a bare `vitest run` here
// picks it up from these defaults rather than falling back to the dev database.
const localApp =
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP ??
  'postgres://app:localdev@127.0.0.1:5433/hermes_test';
const localAgent =
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_AGENT ??
  'postgres://agent:localdev@127.0.0.1:5433/hermes_test';

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
              // MODEL_SCRIPTED="0" and OPENROUTER_FIXTURE="0" in it, and every
              // worker test that drives a run would then reach for a real
              // provider on a real key. These three are forced here so the
              // suite's behaviour does not depend on a file it does not own.
              // Same reasoning as `pnpm e2e:live`'s `.dev.vars.test`
              // (decision C37).
              bindings: {
                AUTH_MODE: 'fake',
                MODEL_SCRIPTED: '1',
                OPENROUTER_FIXTURE: '1',
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
