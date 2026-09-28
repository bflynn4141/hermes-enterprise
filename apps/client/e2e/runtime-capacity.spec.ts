import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { expectAdminPage, openAdminPage } from './admin-nav.js';

const ENTERPRISE_AGENT_ID = '4d623027-d550-488e-8582-345c38704ad9';
const CONTROL_SECRET = 'fixture-control-secret-long-enough';
const START = '/?data=empty&runtimeCapacity=stepup';

async function satisfyStepUp(context: BrowserContext, page: Page): Promise<() => number> {
  let requests = 0;
  await page.route('**/auth/login?**', async (route) => {
    requests += 1;
    const login = new URL(route.request().url());
    const returnTo = login.searchParams.get('return_to') ?? '/';
    await context.addCookies([{ name: 'hermes_runtime_stepup', value: '1', url: login.origin, sameSite: 'Lax' }]);
    await route.fulfill({ status: 302, headers: { location: returnTo } });
  });
  return () => requests;
}

async function openRuntimeCapacity(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.goto(START);
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  const app = page.getByRole('region', { name: 'Application' });
  await openAdminPage(page, 'Capacity');
  await expect(app.getByRole('heading', { name: 'Capacity', exact: true })).toBeVisible();
  return app;
}

test.describe('Hermes runtime capacity setup', () => {
  test('steps up, prepares a copy-once credential, verifies readiness, and revokes capacity', async ({ context, page }, testInfo) => {
    const stepUpRequests = await satisfyStepUp(context, page);
    const app = await openRuntimeCapacity(page);
    expect(stepUpRequests()).toBe(1);
    await expect(page).toHaveURL(/runtimeCapacity=stepup/);

    await app.getByLabel('Job role').selectOption('finance-agent');
    await app.getByLabel(/^Agent ID/).fill(ENTERPRISE_AGENT_ID);
    await app.getByRole('button', { name: 'Create setup code' }).click();

    const credential = app.getByRole('group', { name: 'New setup code' });
    await expect(credential).toBeVisible();
    await expect(credential.locator('code')).toHaveText('d'.repeat(64));
    await credential.getByRole('button', { name: 'Hide setup code' }).click();
    await expect(credential).toHaveCount(0);
    await app.getByRole('button', { name: 'Refresh' }).click();
    await expect(app.getByText('d'.repeat(64))).toHaveCount(0);

    await app.getByLabel(/^Cloud agent ID/).fill('cmu5pw0yq0006gm0a7e2njary');
    await expect(app.locator('.runtime-grant-state strong').filter({ hasText: /^Finance$/ })).toBeVisible();
    await app.getByLabel('Name for this agent').fill('Finance pool 1');
    await app.getByLabel('Connection address').fill('https://not-ready.example.test/plugin');
    await app.getByLabel('Connection secret').fill(CONTROL_SECRET);
    await app.getByRole('button', { name: 'Check and add' }).click();
    await expect(app.getByRole('alert')).toContainText('did not pass Hermes’s checks');
    await expect(app.getByLabel('Connection secret')).toHaveValue(CONTROL_SECRET);

    await app.getByLabel('Connection address').fill('https://ready.example.test/plugin');
    await app.getByRole('button', { name: 'Check and add' }).click();
    await expect(app.getByText('Finance pool 1 passed every check')).toBeVisible();
    await expect(app.getByLabel('Connection secret')).toHaveValue('');
    await expect(app.getByText('Ready for a new member', { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('runtime-capacity-desktop.png'), fullPage: true });

    await app.getByRole('button', { name: 'Remove' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove this agent?' });
    await expect(dialog).toContainText('taken out of use');
    await dialog.getByRole('button', { name: 'Remove' }).click();
    await expect(app.getByText('Removed.', { exact: true })).toBeVisible();
    await expect(app.getByText('Removed', { exact: true })).toBeVisible();
    await expect(app.getByText(/plugin/)).toHaveCount(0);
  });

  test('keeps the complete setup usable at a narrow viewport', async ({ context, page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 760 });
    await satisfyStepUp(context, page);
    const app = await openRuntimeCapacity(page);

    await expect(app.getByRole('heading', { name: 'Create a setup code' })).toBeVisible();
    await expect(app.getByRole('heading', { name: 'Connect and check the agent' })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Create setup code' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('runtime-capacity-narrow.png'), fullPage: true });
    const contentOverflow = await app.locator('.runtime-capacity').evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(contentOverflow).toBeLessThanOrEqual(1);
    await expect(app.getByRole('tablist', { name: 'Admin sections' })).toBeVisible();
  });
});
