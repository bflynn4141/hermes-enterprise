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
const localApp =
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP ??
  'postgres://app:localdev@127.0.0.1:5433/hermes';
const localAgent =
  process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_AGENT ??
  'postgres://agent:localdev@127.0.0.1:5433/hermes';

// Wrangler resolves Hyperdrive's local connection strings from the environment
// while it parses wrangler.jsonc, which happens before the pool applies its own
// miniflare options, so they are set here rather than only passed below.
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP = localApp;
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_AGENT = localAgent;

export default defineConfig({
  test: {
    projects: [
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
              hyperdrives: {
                HYPERDRIVE_APP: localApp,
                HYPERDRIVE_AGENT: localAgent,
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
