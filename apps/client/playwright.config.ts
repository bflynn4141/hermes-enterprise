import { defineConfig, devices } from '@playwright/test';

// The end-to-end suite runs against the mock-mode bundle: the whole client, its
// real reducer and its real REST client, with `packages/shared`'s mock stream
// behind them. That is enough for the scenarios that are about the *client's*
// behaviour (empty states, the triage list, the review pane, the badge).
//
// The scenarios that are about the system — two browser contexts deciding the
// same request, a socket dropped mid-run, a provider 5xx — belong against
// `wrangler dev` with Docker Postgres and `AUTH_MODE=fake`, which lands with
// the M2 worker routes. Point `E2E_BASE_URL` at that server to run them there.
const port = Number(process.env.E2E_PORT ?? 4180);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL,
    viewport: { width: 1680, height: 1000 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
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
