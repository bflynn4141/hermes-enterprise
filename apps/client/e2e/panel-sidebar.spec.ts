// The sidebar's session list, before and after decision C34.
//
// Three clicks on New session, and a picture of what the list says. It is
// written so it runs against *either* codebase — the control's name and the
// sidebar's class are the same before and after — so the "before" shot is the
// real old behaviour rather than a mock-up of it:
//
//     git stash push -- apps/client/src
//     MOCK=1 pnpm --filter client build
//     QA_LABEL=before npx playwright test e2e/panel-sidebar.spec.ts
//     git stash pop && MOCK=1 pnpm --filter client build
//     QA_LABEL=after  npx playwright test e2e/panel-sidebar.spec.ts
import { expect, test } from '@playwright/test';

const label = process.env.QA_LABEL ?? 'after';

test('three clicks on New session', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/');
  const sidebar = page.locator('.sidebar');
  await expect(sidebar.getByRole('button', { name: 'Agents', exact: true })).toBeVisible({ timeout: 20_000 });

  const create = sidebar.getByRole('button', { name: 'New session' }).first();
  for (let i = 0; i < 3; i += 1) {
    await create.click();
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(800);
  await sidebar.screenshot({ path: `qa/panel/sidebar-${label}.png` });
  await page.screenshot({ path: `qa/panel/sidebar-${label}-shell.png` });
});

test('every workspace navigation control has a visible result', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/');
  const sidebar = page.locator('.sidebar');
  const app = page.getByRole('region', { name: 'Application' });
  await expect(sidebar.getByRole('button', { name: 'Agents', exact: true })).toBeVisible({ timeout: 20_000 });

  // The compact type scale matches the 80% browser-zoom reference without
  // shrinking layout or hit targets. Lock one library label and one native
  // heading so both sides of that boundary stay on the same scale.
  const navFont = await sidebar
    .getByRole('button', { name: 'Agents', exact: true })
    .locator('.sidebar-copy')
    .evaluate((label) => parseFloat(getComputedStyle(label).fontSize));
  const headingFont = await app
    .getByRole('heading', { name: 'Iris', exact: true })
    .evaluate((heading) => parseFloat(getComputedStyle(heading).fontSize));
  expect(navFont).toBeCloseTo(11.2, 1);
  expect(headingFont).toBeCloseTo(25.6, 1);

  const destinations = [
    ['Agents', 'Iris'],
    ['Inbox', 'Inbox'],
    ['Members', 'Members'],
    ['History', 'History'],
    ['Library', 'Library'],
    ['Settings', 'Settings'],
  ] as const;
  for (const [button, heading] of destinations) {
    await sidebar.getByRole('button', { name: button, exact: true }).click();
    await expect(app.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }

  // The primary targets use one vertical rhythm rather than touching each
  // other. Their left and right insets are equal inside the expanded rail.
  const boxes = await sidebar.locator('.sidebar-row[aria-label]').evaluateAll((rows) =>
    rows.slice(0, 7).map((row) => {
      const rect = row.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
    }),
  );
  expect(boxes).toHaveLength(7);
  for (const box of boxes) expect(box.height).toBeGreaterThanOrEqual(40);
  for (let index = 1; index < boxes.length; index += 1) expect(boxes[index]!.top - boxes[index - 1]!.bottom).toBeGreaterThanOrEqual(4);

  await sidebar.getByRole('button', { name: 'Search sessions', exact: true }).click();
  const search = sidebar.getByRole('textbox', { name: 'Search session history' });
  await search.fill('Partner');
  await expect(sidebar.locator('.sidebar-row[title]:not([aria-label])')).toHaveCount(1);
  await sidebar.getByRole('button', { name: 'Close session search', exact: true }).click();
  await expect(search).not.toBeVisible();

  // A recent session and New session both reopen Iris when it was hidden.
  await page.getByRole('button', { name: 'Hide Iris', exact: false }).first().click();
  await expect(page.locator('.pane-iris')).toHaveCount(0);
  await sidebar.locator('.sidebar-row[title]:not([aria-label])').first().click();
  await expect(page.locator('.pane-iris')).toBeVisible();
  await page.getByRole('button', { name: 'Hide Iris', exact: false }).first().click();
  await sidebar.getByRole('button', { name: 'New session', exact: true }).click();
  await expect(page.locator('.pane-iris')).toBeVisible();

  await sidebar.getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await expect(sidebar.locator('[data-sidebar-collapsed="true"]')).toBeVisible();
  await sidebar.getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  await expect(sidebar.locator('[data-sidebar-collapsed="false"]')).toBeVisible();
});

test('the removed privacy route falls back to Notifications without settings follow controls', async ({ page }) => {
  await page.goto('/#settings/Data%20and%20privacy');
  const app = page.getByRole('region', { name: 'Application' });
  await expect(app.getByRole('tab', { name: 'Notifications', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(app.getByRole('tab', { name: 'Data and privacy', exact: true })).toHaveCount(0);
  await expect(app.getByText('View pinned', { exact: true })).toHaveCount(0);
  await expect(app.getByRole('button', { name: 'Follow Iris', exact: true })).toHaveCount(0);
});

test('workspace and user menus route correctly and align to the left rail', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/');
  const sidebar = page.locator('.sidebar');
  const app = page.getByRole('region', { name: 'Application' });
  await expect(sidebar.getByRole('button', { name: 'Agents', exact: true })).toBeVisible({ timeout: 20_000 });

  const workspace = sidebar.locator('[data-workspace-trigger]');
  await workspace.click();
  await page.getByRole('button', { name: 'Workspace settings', exact: true }).click();
  await expect(app.getByRole('tab', { name: 'Organization', exact: true })).toHaveAttribute('aria-selected', 'true');
  await workspace.click();
  await page.getByRole('button', { name: 'Invite team members', exact: true }).click();
  await expect(app.getByRole('heading', { name: 'Members', exact: true })).toBeVisible();
  await workspace.click();
  await Promise.all([
    page.waitForURL((url) => url.pathname === '/' && url.hash === ''),
    page.getByRole('button', { name: 'Switch workspace', exact: true }).click(),
  ]);
  await expect(sidebar.getByRole('button', { name: 'Agents', exact: true })).toBeVisible();

  const account = sidebar.getByRole('button', { name: 'Your account', exact: true });
  await expect(account).toHaveAttribute('aria-haspopup', 'dialog');
  expect(await account.evaluate((button) => getComputedStyle(button).justifyContent)).toBe('flex-start');
  const accountBox = await account.boundingBox();
  const firstNavBox = await sidebar.getByRole('button', { name: 'Agents', exact: true }).boundingBox();
  expect(accountBox).not.toBeNull();
  expect(firstNavBox).not.toBeNull();
  expect(Math.abs(accountBox!.x - firstNavBox!.x)).toBeLessThanOrEqual(1);

  await account.click();
  await expect(page.getByRole('dialog', { name: 'Your account' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Notification settings', exact: true }).click();
  await expect(app.getByRole('tab', { name: 'Notifications', exact: true })).toHaveAttribute('aria-selected', 'true');
  await account.click();
  await page.getByRole('menuitem', { name: 'Provider keys', exact: true }).click();
  await expect(app.getByRole('tab', { name: 'Provider keys', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(app.getByRole('tab', { name: 'Data and privacy', exact: true })).toHaveCount(0);
  await expect(app.getByText('View pinned', { exact: true })).toHaveCount(0);
  await expect(app.getByRole('button', { name: 'Follow Iris', exact: true })).toHaveCount(0);
  await account.click();
  await expect(page.getByRole('menuitem', { name: 'Data and privacy', exact: true })).toHaveCount(0);

  const reduceMotion = page.getByRole('switch', { name: 'Reduce motion', exact: true });
  const before = await reduceMotion.getAttribute('aria-checked');
  await reduceMotion.click();
  await expect(reduceMotion).toHaveAttribute('aria-checked', before === 'true' ? 'false' : 'true');
  await page.keyboard.press('Escape');
  await expect(account).toBeFocused();

  await page.route('**/auth/logout', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Signed out</title>' }),
  );
  await account.click();
  const logout = page.waitForRequest((request) => new URL(request.url()).pathname === '/auth/logout');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  const request = await logout;
  expect(request.method()).toBe('GET');
  expect(new URL(request.url()).pathname).toBe('/auth/logout');
});
