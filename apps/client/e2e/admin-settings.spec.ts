import { expect, test, type Page } from '@playwright/test';

type MockRequest = { path: string; method: string };

async function recordMockRequests(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const requests: Array<{ path: string; method: string }> = [];
    Object.defineProperty(window, '__hermesMockRequests', { value: requests });
    window.addEventListener('hermes:mock-request', (event) => {
      requests.push((event as CustomEvent<{ path: string; method: string }>).detail);
    });
  });
}

async function mockRequests(page: Page): Promise<MockRequest[]> {
  return page.evaluate(() => (window as unknown as { __hermesMockRequests: MockRequest[] }).__hermesMockRequests);
}

test('Admin owns workspace controls while Settings stays personal', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/#settings/Organization');
  const app = page.getByRole('region', { name: 'Application' });

  await expect(app.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
  await expect(app.getByRole('tab', { name: 'Organization', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/#admin\/Organization$/);
  await expect(app.getByRole('tablist', { name: 'Admin sections' }).getByRole('tab')).toHaveCount(4);
  await expect(app.getByRole('tab', { name: 'Agents', exact: true })).toBeVisible();
  await expect(app.getByRole('tab', { name: 'Connections', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-settings-desktop.png'), fullPage: true });

  await app.getByRole('combobox', { name: 'Settings view' }).selectOption('user');
  await expect(app.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(app.getByRole('tab', { name: 'Notifications', exact: true })).toBeVisible();
  await expect(app.getByRole('tab', { name: 'Slack account', exact: true })).toBeVisible();
  await expect(app.getByRole('tab', { name: 'Data and privacy', exact: true })).toBeVisible();
  await expect(app.getByRole('tab', { name: 'Provider keys', exact: true })).toHaveCount(0);
  await expect(app.getByRole('combobox', { name: 'Settings view' })).toHaveValue('user');
  await app.getByRole('combobox', { name: 'Settings view' }).selectOption('admin');
  await expect(app.getByRole('tab', { name: 'Organization', exact: true })).toHaveAttribute('aria-selected', 'true');
  await app.getByRole('tab', { name: 'Organization', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(app.getByRole('tab', { name: 'Agents', exact: true })).toBeFocused();
  await expect(app.getByRole('tab', { name: 'Agents', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('a Member direct or legacy Admin link falls back before privileged effects run', async ({ page }) => {
  await recordMockRequests(page);
  await page.goto('/?seat=member&workflowRole=partnerships&runtimeCapacity=stepup#settings/Runtime%20capacity');
  const app = page.getByRole('region', { name: 'Application' });

  await expect(app.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(app.getByRole('tab', { name: 'Notifications', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/#settings\/Notifications$/);
  await expect(page.getByRole('button', { name: 'Admin', exact: true })).toHaveCount(0);
  await expect(app.getByRole('combobox', { name: 'Settings view' })).toHaveCount(0);
  await expect(app.getByText('User View', { exact: true })).toBeVisible();
  await expect(app.getByRole('heading', { name: 'Hermes capacity' })).toHaveCount(0);

  const account = page.getByRole('button', { name: 'Your account', exact: true });
  await account.click();
  await expect(page.getByRole('menuitem', { name: 'Model providers', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const composer = page.getByRole('region', { name: /conversation$/ }).getByRole('textbox');
  await composer.fill('A member can still use the configured workspace model.');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await expect(page.getByText('Ask a workspace Admin to connect Nous Portal.')).toHaveCount(0);

  await page.getByRole('button', { name: 'Members', exact: true }).first().click();
  await expect(app.getByRole('tab', { name: 'Invitations', exact: true })).toHaveCount(0);
  await expect(app.getByText('Alex Rivera')).toContainText('You');
  await expect(app.getByText('maya@nous.example')).toHaveCount(0);
  await page.getByRole('button', { name: 'Library', exact: true }).first().click();

  const requests = await mockRequests(page);
  expect(requests.filter((request) => request.path.includes('/provider-keys'))).toEqual([]);
  expect(requests.filter((request) => request.path.includes('/invitations'))).toEqual([]);
  expect(requests.filter((request) => request.path.includes('/admin/runtime-discovery-grants'))).toEqual([]);
  expect(requests.filter((request) => request.path.includes('/admin/hermes-capacity'))).toEqual([]);
});

test('Member Settings preserve personal Slack linking and safe privacy facts', async ({ page }) => {
  await page.goto('/?seat=member&slack=connected&email=connected');
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  const app = page.getByRole('region', { name: 'Application' });

  await app.getByRole('tab', { name: 'Slack account', exact: true }).click();
  await expect(app.getByRole('heading', { name: 'Slack account', exact: true })).toBeVisible();
  await expect(app.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
  await expect(app.getByText('Permissions', { exact: true })).toHaveCount(0);
  await app.getByRole('button', { name: 'Create link command' }).click();
  await expect(app.getByText('link hmx_fixture_only_not_a_credential')).toBeVisible();

  await app.getByRole('tab', { name: 'Data and privacy', exact: true }).click();
  await expect(app.getByRole('heading', { name: 'Data and privacy', exact: true })).toBeVisible();
  await expect(app.getByText('What is kept, and for how long')).toBeVisible();
  await expect(app.getByText('Program key')).toHaveCount(0);
  await expect(app.getByText(/a1b2|Attested|No attestation/)).toHaveCount(0);
  await expect(app.getByText('Synthetic or consented data only')).toBeVisible();
  await expect(app.getByText('Removed when a deletion request is processed')).toBeVisible();

  await page.getByRole('button', { name: 'Library', exact: true }).first().click();
  await app.getByRole('tab', { name: 'Connections', exact: true }).click();
  await expect(app.getByText('Read-only Gmail connected')).toBeVisible();
  await expect(app.getByText('Outbound sender connected')).toBeVisible();
  await expect(app.getByText('Imported snapshots')).toHaveCount(0);
  await expect(app.getByText('Waiting messages')).toHaveCount(0);
  await expect(app.getByText(/· null/)).toHaveCount(0);
});

test('Admin navigation stays compact at the narrow desktop floor', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 760 });
  await page.goto('/#admin/Organization');
  const app = page.getByRole('region', { name: 'Application' });
  await expect(app.getByRole('combobox', { name: 'Admin section' })).toHaveCount(0);
  await expect(app.getByRole('combobox', { name: 'Settings view' })).toHaveValue('admin');
  for (const tab of await app.getByRole('tablist', { name: 'Admin sections' }).getByRole('tab').all()) {
    await expect(tab).toBeVisible();
  }
  const positions = await app.getByRole('tablist', { name: 'Admin sections' }).getByRole('tab').evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().top));
  expect(new Set(positions).size).toBe(1);
  await app.getByRole('tab', { name: 'Agents', exact: true }).click();
  await app.getByRole('button', { name: 'Model providers', exact: true }).click();
  await expect(app.locator('.admin-settings-view').getByRole('heading', { name: 'Model providers', exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-settings-narrow.png'), fullPage: true });
  const overflow = await app.locator('.admin-settings-page').evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('Model provider details and actions remain readable in the standard desktop pane', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/#admin/Provider%20keys');
  const app = page.getByRole('region', { name: 'Application' });
  const row = app.locator('.provider-key-row').first();

  await expect(row.getByText('Verified', { exact: true })).toBeVisible();
  for (const action of ['Sync models', 'Re-verify', 'Rotate', 'Remove']) {
    await expect(row.getByRole('button', { name: action, exact: true })).toBeVisible();
  }
  const statusWidth = await row.locator('.row-main').evaluate((element) => element.getBoundingClientRect().width);
  expect(statusWidth).toBeGreaterThanOrEqual(180);
  const overflow = await app.locator('.admin-settings-page').evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('admin-settings-1280.png'), fullPage: true });
});
