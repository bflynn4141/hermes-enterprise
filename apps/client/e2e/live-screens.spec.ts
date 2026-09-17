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
//   E2E_BASE_URL=http://localhost:8788 npx playwright test live-screens
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshWorkspace, psql, refreshStepUp } from '../scripts/live-fixture.mjs';

const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8788';
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

  // The trace detail, with its arguments open: the screen that answers "what
  // did it read before it proposed that".
  await page.getByRole('button', { name: 'Open →' }).first().click();
  await expect(page.getByRole('button', { name: 'Show arguments and result' }).first()).toBeVisible({ timeout: 15_000 });
  await settle(page);
  await shot(page, '21-trace-detail');
  await page.getByRole('button', { name: 'Show arguments and result' }).first().click();
  await settle(page);
  await shot(page, '22-trace-tool-call');

  await page.getByRole('tab', { name: 'Skills' }).click();
  await settle(page);
  await shot(page, '23-agent-skills');

  await openSection(page, 'Library', /Library|Skills|Documents/i);
  await settle(page);
  await shot(page, '12-library');

  await openSection(page, 'Settings', /Settings|Notifications/i);
  await settle(page);
  await shot(page, '13-settings');

  // The three Settings tabs M5a wired: Usage after a real run, the caps card,
  // and the data-and-privacy page with the server's own retention facts on it.
  await page.getByRole('tab', { name: 'Usage' }).click();
  await expect(page.getByText('Estimated, billed by your provider', { exact: false })).toBeVisible({ timeout: 20_000 });
  await settle(page);
  await shot(page, '24-settings-usage');

  await page.getByRole('tab', { name: 'Agents' }).click();
  await settle(page);
  await shot(page, '25-settings-agents-caps');

  await page.getByRole('tab', { name: 'Organization' }).click();
  await settle(page);
  await shot(page, '26-settings-organization');

  await context.close();
});

/**
 * Onboarding, photographed through the routes that now exist.
 *
 * The stepper's first screen, the join screen, and the workspace picker at the
 * root path — which only became a screen at all once `GET /auth/session` with
 * no `?ws` started answering (server decision F7).
 */
test('live · onboarding and the workspace picker', async ({ browser }) => {
  const fixture = freshWorkspace('Onboarding tour');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();

  await page.goto('/onboarding/create');
  await expect(page.getByRole('heading', { name: 'Name your workspace' })).toBeVisible({ timeout: 15_000 });
  await settle(page);
  await shot(page, '27-onboarding-create');

  const invited = await page.request.post(`/w/${fixture.workspaceId}/invitations`, {
    data: { email: `tour-${fixture.workspaceId.slice(0, 8)}@nous.example`, role: 'member' },
    headers: { origin: ORIGIN },
  });
  const token = (await invited.json()).id as string;
  await page.goto(`/onboarding/join?token=${token}`);
  await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeVisible({ timeout: 15_000 });
  await settle(page);
  await shot(page, '28-onboarding-join');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Your workspaces' })).toBeVisible({ timeout: 15_000 });
  await settle(page);
  await shot(page, '29-workspace-picker');
  await context.close();
});

test('live · settings, with a verified provider key', async ({ browser }) => {
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

  // Nous Portal, because it is the only provider the route accepts (decision
  // R12), and `NOUS_PORTAL_FIXTURE=1` verifies it and syncs its models — so the
  // screenshot is of a working key rather than of a rejected one.
  await page.request.post(`/w/${fixture.workspaceId}/provider-keys`, {
    data: { provider: 'nous_portal', label: 'Program key', key: 'nous-fake-key-for-live-screenshots-0001' },
    headers: { origin: ORIGIN },
  });
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('tab', { name: 'Provider keys' }).click();
  // `visible=true` before `.first()`: the shell keeps a second copy of the pane
  // in the DOM for the narrow layout, so the first match in document order is a
  // hidden one and a plain `.first()` waits on it forever.
  await expect(page.getByText('Verified', { exact: true }).locator('visible=true').first()).toBeVisible({ timeout: 15_000 });
  await settle(page);
  // The masked row, the status pill, and the synced-model count.
  await shot(page, '15-provider-keys-verified');

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
