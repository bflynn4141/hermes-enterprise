// Real browser → turn route → Workflow → set_focus → socket → pane.
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

test('prompt navigation follows, preserves manual views, resets filters and never creates Inbox rows', async ({ browser }) => {
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
  await expect(pane(page).getByText('View pinned', { exact: true })).toHaveCount(0);
  await expect(pane(page).getByRole('button', { name: 'Follow Iris', exact: true })).toHaveCount(0);
  const requests = async () => (await (await page.request.get(`/w/${fixture.workspaceId}/requests`)).json()).items;
  expect(await requests()).toHaveLength(0);

  await send(page, 'Show me pending applications', 'navigation_pending');
  await expect(pane(page).getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(pane(page).getByRole('tab', { name: 'Needs review', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(pane(page).getByLabel('Request type')).toHaveValue('application');
  await expect(pane(page).getByLabel('Search requests')).toHaveValue('');

  await send(page, 'Show resolved applications matching Ada', 'navigation_resolved');
  await expect(pane(page).getByRole('tab', { name: 'Resolved', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(pane(page).getByLabel('Search requests')).toHaveValue('Ada');

  // Manual filters are part of the pinned view, not disposable local state.
  await pane(page).getByLabel('Search requests').fill('My own search');
  await send(page, 'Who is in this workspace?', 'navigation_members');
  await expect(pane(page).getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(pane(page).getByLabel('Search requests')).toHaveValue('My own search');
  await page.getByRole('button', { name: /Prompt-driven views/ }).first().click();
  await expect(pane(page).getByRole('heading', { name: 'Members', exact: true })).toBeVisible();

  await send(page, 'What context are you missing?', 'navigation_context');
  await expect(pane(page).getByRole('tab', { name: 'Context', exact: true })).toHaveAttribute('aria-selected', 'true');
  await send(page, 'Show the Inbox', 'navigation_inbox');
  await expect(pane(page).getByRole('tab', { name: 'Needs review', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(pane(page).getByLabel('Request type')).toHaveValue('all');
  await expect(pane(page).getByLabel('Search requests')).toHaveValue('');
  expect(await requests()).toHaveLength(0);

  await page.screenshot({ path: 'qa/navigation/desktop-inbox.png', fullPage: false });
  await pane(page).getByLabel('Request type').selectOption('invoice');
  await page.reload();
  await expect(pane(page).getByLabel('Request type')).toHaveValue('invoice');
  await expect(pane(page).getByText('View pinned', { exact: true })).toHaveCount(0);
  await expect(page.locator('.msg-iris').filter({ hasText: 'Iris is focused on' })).toHaveCount(5);

  // Small screens keep the conversation visible while the App pane follows in
  // the background. Switching panes reveals the same complete destination.
  await page.getByRole('button', { name: /Prompt-driven views/ }).first().click();
  await page.setViewportSize({ width: 900, height: 900 });
  await pane(page).getByRole('button', { name: 'Chat', exact: true }).click();
  await send(page, 'Show me pending applications', 'navigation_pending');
  await page.locator('.pane-iris').getByRole('button', { name: 'App', exact: true }).click();
  await expect(pane(page).getByLabel('Request type')).toHaveValue('application');
  await expect(pane(page)).toHaveAttribute('data-active', 'true');
  await page.screenshot({ path: 'qa/navigation/narrow-inbox.png', fullPage: false });
  expect(await requests()).toHaveLength(0);
  await context.close();
});
