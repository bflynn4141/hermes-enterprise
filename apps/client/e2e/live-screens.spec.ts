// Screenshots of the live app, into `qa/live/`.
//
// `qa/` holds the mock-mode screens; these are the same screens with a real
// Worker, a real Postgres and a real run behind them, so the two directories
// answer different questions: `qa/` is "does the client render this", `qa/live/`
// is "does the product do this".
//
// Run with the rest of the live suite (`pnpm e2e:live`), or on its own against
// a stack you already have up:
//
//   E2E_BASE_URL=http://localhost:8787 npx playwright test live-screens
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshWorkspace, psql, refreshStepUp } from '../scripts/live-fixture.mjs';

const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8787';
const SEED_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SEED_ADMIN = 'maya@nous.example';
const SEED_MEMBER = 'dana@nous.example';

const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'qa', 'live');
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

async function asUser(browser: Browser, devUser: string): Promise<BrowserContext> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-dev-user': devUser }, viewport: { width: 1680, height: 1000 } });
  await context.addInitScript((id) => {
    try {
      window.localStorage.setItem('hermes:dev-user', id as string);
    } catch {
      /* the header carries it either way */
    }
  }, devUser);
  return context;
}

const rows = (sql: string): string[] => psql(sql).split('\n').filter(Boolean);

/** Give the shell a beat to settle before the shutter, so nothing is mid-fade. */
const settle = (page: Page) => page.waitForTimeout(900);

/**
 * Open a section the way a person does: by clicking the sidebar.
 *
 * Deliberately not by `goto`ing the fragment. A `goto` that changes only the
 * hash is a same-document navigation and the shell reads the fragment once at
 * boot, so a fragment-first tour silently photographs the same screen over and
 * over — which is exactly what the first run of this file did.
 */
async function openSection(page: Page, name: string, breadcrumb: RegExp): Promise<void> {
  await page.getByRole('button', { name, exact: true }).first().click();
  // `.last()`, not `.first()`: the chat pane has a breadcrumb of its own
  // ("Nous / M3 surface") and it is first in the document. The app pane's is
  // the one that answers "did the navigation happen".
  await expect(page.locator('.breadcrumb').last()).toContainText(breadcrumb, { timeout: 10_000 });
}

test('live · the main screens', async ({ browser }) => {
  // A workspace of its own, for two reasons. The seeded one accumulates a
  // session per end-to-end run, and a sidebar of "P7 stop / P8 retry / P10
  // replay" is a picture of the test suite rather than of the product; and a
  // fresh one lets this file tell the whole story in order — empty, working,
  // answered, reviewed, decided — which is what the screens are for.
  const fixture = freshWorkspace('Partner Program');
  const ws = fixture.workspaceId;
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  refreshStepUp();

  const created = await page.request.post(`/w/${ws}/sessions`, {
    data: { title: 'Partner applications' },
    headers: { origin: ORIGIN },
  });
  const sessionId = (await created.json()).id as string;
  await page.goto(`/workspace/${ws}/s/${sessionId}`);
  await expect(page.getByText(/is ready\. Describe what you need/)).toBeVisible({ timeout: 15_000 });
  await settle(page);
  await shot(page, '01-shell-empty-session');

  await page.getByRole('textbox', { name: /^Message/ }).fill('What needs me before the partner work can move forward?');
  await page.getByRole('button', { name: 'Send message' }).click();
  // Caught mid-run: LoadingState, and the step rows as they arrive.
  await page.waitForTimeout(500);
  await shot(page, '02-run-working');

  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 25_000 });
  await settle(page);
  // Scrolled back to the top of the turn, because the transcript follows the
  // tail and the thing worth photographing is the answer, not the composer.
  await page.locator('.transcript-wrap .scroll').first().evaluate((el) => {
    el.scrollTop = 0;
  });
  await settle(page);
  // The finished turn, the ThinkingState rows, the TaskRows step list, and the
  // app pane that `run.focus` moved to the request Follow opened.
  await shot(page, '03-run-complete-and-follow');

  await openSection(page, 'Inbox', /Inbox/i);
  await settle(page);
  await shot(page, '04-inbox');

  // The review pane, reached the way a reviewer reaches it.
  await page.getByRole('button', { name: /^Review/ }).first().click();
  await settle(page);
  await shot(page, '05-request-review');

  // And the receipt the decision leaves behind.
  await page.getByRole('button', { name: 'Admit' }).click();
  await expect(page.getByText(/Admitted/).first()).toBeVisible({ timeout: 15_000 });
  await settle(page);
  await shot(page, '06-receipt');

  await openSection(page, 'Members', /Members|People|Team/i);
  await settle(page);
  await shot(page, '07-members');

  await openSection(page, 'History', /History|Decisions|Activity/i);
  await settle(page);
  await shot(page, '08-history');

  await openSection(page, 'Agents', /Iris|Overview/i);
  await settle(page);
  await shot(page, '09-agent-overview');

  await page.getByRole('tab', { name: 'Context' }).click();
  await settle(page);
  await shot(page, '10-agent-context');

  await page.getByRole('tab', { name: 'Traces' }).click();
  await settle(page);
  await shot(page, '11-traces');

  await openSection(page, 'Library', /Library|Skills|Documents/i);
  await settle(page);
  await shot(page, '12-library');

  await openSection(page, 'Settings', /Settings|Notifications/i);
  await settle(page);
  await shot(page, '13-settings');

  await context.close();
});

test('live · settings, with a rejected provider key', async ({ browser }) => {
  const fixture = freshWorkspace('Provider keys');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await page.goto(`/workspace/${fixture.workspaceId}`);
  await expect(page.getByText(/is ready\./)).toBeVisible({ timeout: 15_000 });
  refreshStepUp();

  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('tab', { name: 'Provider keys' }).click();
  await settle(page);
  await shot(page, '14-provider-keys-empty');

  await page.request.post(`/w/${fixture.workspaceId}/provider-keys`, {
    data: { provider: 'deepseek', label: 'Program key', key: 'sk-fake-key-for-live-screenshots-0001' },
    headers: { origin: ORIGIN },
  });
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('tab', { name: 'Provider keys' }).click();
  await expect(page.getByText('Invalid').first()).toBeVisible({ timeout: 15_000 });
  await settle(page);
  // The masked row, the status pill, and the rejection copy in the banner.
  await shot(page, '15-provider-keys-invalid');

  await page.getByRole('tab', { name: 'Data and privacy' }).click();
  await settle(page);
  await shot(page, '16-settings-privacy');
  await context.close();
});

test('live · the first-run empty states', async ({ browser }) => {
  const fixture = freshWorkspace('First run');

  const admin = await asUser(browser, fixture.adminEmail);
  const adminPage = await admin.newPage();
  await adminPage.goto(`/workspace/${fixture.workspaceId}`);
  await expect(adminPage.getByText(/is ready\./)).toBeVisible({ timeout: 15_000 });
  await settle(adminPage);
  await shot(adminPage, '17-empty-admin-shell');

  await adminPage.getByRole('button', { name: 'Inbox', exact: true }).first().click();
  await expect(adminPage.getByText('No reviews waiting')).toBeVisible();
  await settle(adminPage);
  await shot(adminPage, '18-empty-inbox');
  await admin.close();

  const member = await asUser(browser, fixture.memberEmail);
  const memberPage = await member.newPage();
  await memberPage.goto(`/workspace/${fixture.workspaceId}`);
  await expect(memberPage.getByText(/is ready\./)).toBeVisible({ timeout: 15_000 });
  await settle(memberPage);
  await shot(memberPage, '19-empty-member-shell');
  await member.close();
});

test('live · the Member seat on a request an Admin must decide', async ({ browser }) => {
  const requestId = rows(
    `SELECT id::text FROM requests WHERE workspace_id = '${SEED_WORKSPACE}' AND status = 'pending' ORDER BY created_at DESC LIMIT 1;`,
  )[0];
  test.skip(!requestId, 'no pending request to show');

  const context = await asUser(browser, SEED_MEMBER);
  const page = await context.newPage();
  await page.goto(`/workspace/${SEED_WORKSPACE}#inbox/request/${requestId}`);
  await expect(page.getByText('Admin decision required')).toBeVisible({ timeout: 15_000 });
  await settle(page);
  await shot(page, '20-member-review');
  await context.close();
});
