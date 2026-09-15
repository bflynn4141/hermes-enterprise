// Screenshots of the four list screens, into `qa/tables/`.
//
// The screens that used to be — or were asked to become — the library's
// database table: Members (both tabs), the Inbox list, Library → Documents and
// the Traces list. They are all the product's own inline rows now (decision
// C46), and this file is the evidence for that, taken against the live stack.
//
// Run with the rest of the live suite (`pnpm e2e:live`), or on its own against
// a stack that is already up:
//
//   E2E_BASE_URL=http://localhost:8788 npx playwright test live-tables
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshWorkspace, refreshStepUp } from '../scripts/live-fixture.mjs';

const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8788';
const OUT = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'qa', 'tables');
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
const settle = (page: Page) => page.waitForTimeout(700);

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

async function openSection(page: Page, name: string, breadcrumb: RegExp): Promise<void> {
  await page.getByRole('button', { name, exact: true }).first().click();
  await expect(page.locator('.breadcrumb').last()).toContainText(breadcrumb, { timeout: 10_000 });
}

test('live · the four list screens', async ({ browser }) => {
  const fixture = freshWorkspace('Table shapes');
  const ws = fixture.workspaceId;
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  refreshStepUp();

  // One real turn, so the Inbox, the Library's drafts and the Traces list have
  // something in them that the product put there.
  const created = await page.request.post(`/w/${ws}/sessions`, { data: { title: 'Partner applications' }, headers: { origin: ORIGIN } });
  const sessionId = (await created.json()).id as string;
  // And one invitation, so the Invitations tab has a row with its actions.
  await page.request.post(`/w/${ws}/invitations`, { data: { email: 'rowan@nous.example', role: 'member' }, headers: { origin: ORIGIN } });

  await page.goto(`/workspace/${ws}/s/${sessionId}`);
  await page.getByRole('textbox', { name: /^Message/ }).fill('What needs me before the partner work can move forward?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 25_000 });

  await openSection(page, 'Members', /Members|People|Team/i);
  await settle(page);
  // No checkbox column, no "Evidence" header, no calculation footer.
  await expect(page.getByRole('columnheader')).toHaveCount(0);
  await expect(page.getByText('Evidence', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Manage' }).first()).toBeVisible();
  await shot(page, '01-members');

  await page.getByRole('tab', { name: 'Invitations' }).click();
  await expect(page.getByRole('button', { name: 'Resend' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw' }).first()).toBeVisible();
  await settle(page);
  await shot(page, '02-members-invitations');

  await openSection(page, 'Inbox', /Inbox/i);
  await settle(page);
  await shot(page, '03-inbox');

  await openSection(page, 'Library', /Library|Skills|Documents/i);
  await page.getByRole('tab', { name: 'Documents' }).click();
  await settle(page);
  await shot(page, '04-library-documents');

  await openSection(page, 'Agents', /Iris|Overview/i);
  await page.getByRole('tab', { name: 'Traces' }).click();
  await settle(page);
  await shot(page, '05-traces');

  // And the sidebar footer, which is a name and an avatar and no headcount
  // (decision C47).
  await expect(page.locator('aside.sidebar')).not.toContainText('joined');
  await context.close();
});
