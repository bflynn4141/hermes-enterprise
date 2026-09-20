// Real browser → turn route → Workflow → set_focus → socket → a link in the reply → pane.
// Only model output is scripted, explicitly selected by the test header.
import { expect, test, type Page } from '@playwright/test';
import { freshWorkspace, refreshStepUp } from '../scripts/live-fixture.mjs';

const origin = process.env.E2E_BASE_URL ?? 'http://localhost:8788';
const pane = (page: Page) => page.getByRole('region', { name: 'Application' });
test.skip(!process.env.E2E_BASE_URL, 'Navigation integration requires the isolated real Worker, not the mock client.');

async function send(page: Page, text: string, scenario: string) {
  const replies = page.locator('.msg-iris').filter({ hasText: 'Iris is focused on' });
  const before = await replies.count();
  await page.route('**/turns', async (route) => {
    await route.continue({ headers: { ...route.request().headers(), 'x-scripted-script': scenario } });
  });
  const composer = page.getByRole('textbox', { name: /^Message/ });
  await expect(composer).toBeEnabled();
  await composer.fill(text);
  const sent = page.waitForResponse((response) => response.url().endsWith('/turns') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Send message' }).click();
  const response = await sent;
  expect(response.status(), await response.text()).toBeLessThan(300);
  await expect(replies).toHaveCount(before + 1, { timeout: 40_000 });
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0, { timeout: 40_000 });
  await page.unroute('**/turns');
}

/** The link a navigation reply leaves behind, scoped to the transcript. */
const offered = (page: Page, label: RegExp) => page.locator('.focus-link').getByRole('button', { name: label });

test('prompt navigation offers a link, never moves the pane on its own, resets filters and never creates Inbox rows', async ({ browser }) => {
  const fixture = freshWorkspace('Prompt navigation test');
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-dev-user': fixture.adminEmail } });
  await context.addInitScript((email) => localStorage.setItem('hermes:dev-user', email), fixture.adminEmail);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.request.get(`/w/${fixture.workspaceId}/bootstrap`);
  refreshStepUp();
  // Fake key + the development fixture only; no provider network or billing.
  const added = await page.request.post(`/w/${fixture.workspaceId}/provider-keys`, {
    data: { provider: 'nous_portal', label: 'Navigation test fixture', key: ['sk', 'or', 'v1', '0'.repeat(24)].join('-') }, headers: { origin },
  });
  expect(added.status(), await added.text()).toBe(201);
  const created = await page.request.post(`/w/${fixture.workspaceId}/sessions`, {
    data: { title: 'Prompt-driven views', mode: 'work', model_id: 'nous:anthropic/claude-sonnet-4.6' }, headers: { origin },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = await created.json();
  await page.goto(`/workspace/${fixture.workspaceId}/s/${id}`);
  await expect(pane(page).getByRole('heading', { name: 'Iris', exact: true })).toBeVisible();
  const requests = async () => (await (await page.request.get(`/w/${fixture.workspaceId}/requests`)).json()).items;
  expect(await requests()).toHaveLength(0);

  // The pane stays where the person left it; the reply offers the view.
  await send(page, 'Show me pending applications', 'navigation_pending');
  await expect(pane(page).getByRole('heading', { name: 'Iris', exact: true })).toBeVisible();
  await expect(offered(page, /^Open Inbox · Needs review$/)).toBeVisible();
  await offered(page, /^Open Inbox · Needs review$/).click();
  await expect(pane(page).getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(pane(page).getByRole('tab', { name: 'Needs review', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(pane(page).getByLabel('Request type')).toHaveValue('application');
  await expect(pane(page).getByLabel('Search requests')).toHaveValue('');

  await send(page, 'Show resolved applications matching Ada', 'navigation_resolved');
  // Still on the view the person opened, filters untouched, until they click.
  await expect(pane(page).getByRole('tab', { name: 'Needs review', exact: true })).toHaveAttribute('aria-selected', 'true');
  await offered(page, /^Open Inbox · Resolved$/).click();
  await expect(pane(page).getByRole('tab', { name: 'Resolved', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(pane(page).getByLabel('Search requests')).toHaveValue('Ada');

  // A person's own filter is theirs until they choose otherwise.
  await pane(page).getByLabel('Search requests').fill('My own search');
  await send(page, 'Who is in this workspace?', 'navigation_members');
  await expect(pane(page).getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(pane(page).getByLabel('Search requests')).toHaveValue('My own search');
  await offered(page, /^Open Members/).click();
  await expect(pane(page).getByRole('heading', { name: 'Members', exact: true })).toBeVisible();

  await send(page, 'What context are you missing?', 'navigation_context');
  await offered(page, /^Open Iris · Context$/).click();
  await expect(pane(page).getByRole('tab', { name: 'Context', exact: true })).toHaveAttribute('aria-selected', 'true');
  await send(page, 'Show the Inbox', 'navigation_inbox');
  await offered(page, /^Open Inbox · Needs review$/).click();
  await expect(pane(page).getByRole('tab', { name: 'Needs review', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(pane(page).getByLabel('Request type')).toHaveValue('all');
  await expect(pane(page).getByLabel('Search requests')).toHaveValue('');
  expect(await requests()).toHaveLength(0);

  await page.screenshot({ path: 'qa/navigation/desktop-inbox.png', fullPage: false });
  await pane(page).getByLabel('Request type').selectOption('invoice');
  await page.reload();
  await expect(pane(page).getByLabel('Request type')).toHaveValue('invoice');
  await expect(page.locator('.msg-iris').filter({ hasText: 'Iris is focused on' })).toHaveCount(5);

  // Small screens: the conversation stays put, and the link switches panes.
  await page.setViewportSize({ width: 900, height: 900 });
  await pane(page).getByRole('button', { name: 'Chat', exact: true }).click();
  await send(page, 'Show me pending applications', 'navigation_pending');
  await offered(page, /^Open Inbox · Needs review$/).click();
  await expect(pane(page)).toHaveAttribute('data-active', 'true');
  await expect(pane(page).getByLabel('Request type')).toHaveValue('application');
  await page.screenshot({ path: 'qa/navigation/narrow-inbox.png', fullPage: false });
  expect(await requests()).toHaveLength(0);
  await context.close();
});
