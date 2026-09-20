import { defineConfig, devices } from '@playwright/test';

// The end-to-end suite runs against the mock-mode bundle: the whole client, its
// real reducer and its real REST client, with `packages/shared`'s mock stream
// behind them. That is enough for the scenarios that are about the *client's*
// behaviour (empty states, the triage list, the review pane, the badge).
//
// The scenarios that are about the *system* — two contexts deciding the same
// request, a connection dropped mid-run, the provider-key lifecycle, a fresh
// workspace's empty states — live in `e2e/live.spec.ts` and run against
// `wrangler dev` with Docker Postgres, `AUTH_MODE=fake` and `MODEL_SCRIPTED=1`.
// `pnpm e2e:live` boots all of that; `E2E_BASE_URL` points this config at it.
//
// The split is by file, not by tag, because the two suites cannot share a
// server: one wants the mock bundle on its own static server, the other wants
// the real bundle served by the Worker.
const port = Number(process.env.E2E_PORT ?? 4180);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: process.env.E2E_BASE_URL ? 90_000 : 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : [['list']],
  use: {
    baseURL,
    viewport: { width: 1680, height: 1000 },
    trace: 'retain-on-failure',
  },
  // The mock suite never runs against the live server and the live suite never
  // runs against the mock bundle: each asserts things only true of its own.
  // Selection is by file-name prefix, not by a hand-kept list: every live
  // scenario lives in `live*.spec.ts`, and everything else is the mock suite.
  // A list here went stale as mock specs were added, and `pnpm e2e:live` spent
  // its first fifteen files failing mock scenarios against the real Worker.
  ...(process.env.E2E_BASE_URL
    ? { testMatch: '**/live*.spec.ts' }
    : { testIgnore: ['**/live*.spec.ts'] }),
  // `devices['Desktop Chrome']` carries its own 1280×720 viewport, which wins
  // over the top-level `use.viewport` above. The mock suite has always run at
  // 1280 and its screenshots are cut for it; the live suite is written for the
  // 1680 desktop layout, where the app pane beside an open Iris panel is wide
  // enough for the tab lists. At 1280 that pane is 520px, under the 560px
  // container breakpoint, and Agents and Settings render their mobile selects.
  projects: [{
    name: 'chromium',
    use: { ...devices['Desktop Chrome'], ...(process.env.E2E_BASE_URL ? { viewport: { width: 1680, height: 1000 } } : {}) },
  }],
  ...(process.env.E2E_BASE_URL
    ? {}
    : {
        webServer: {
          command: `MOCK=1 PORT=${port} node build.mjs --serve`,
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 60_000,
        },
      }),
});
