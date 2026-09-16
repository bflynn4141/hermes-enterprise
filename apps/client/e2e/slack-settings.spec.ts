import { expect, test } from '@playwright/test';

async function openSlack(page: import('@playwright/test').Page, url = '/') {
  await page.goto(url);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const app = page.getByRole('region', { name: 'Application' });
  await app.getByRole('tab', { name: 'Slack', exact: true }).click();
  await expect(app.getByRole('heading', { name: 'Slack', exact: true })).toBeVisible();
  return app;
}

test.describe('Slack connection settings', () => {
  test('explains the transport and approval boundary before an Admin connects', async ({ page }) => {
    const app = await openSlack(page);
    await expect(app.getByRole('button', { name: 'Connect Slack' })).toBeVisible();
    await expect(app.getByText('One private Hermes session')).toBeVisible();
    await expect(app.getByText('Mention the app; replies stay in the thread')).toBeVisible();
    await expect(app.getByText('Review only in the Hermes Inbox')).toBeVisible();
  });

  test('lets every signed-in member create an explicit one-time identity link', async ({ page }) => {
    const app = await openSlack(page, '/?seat=member&slack=connected');
    await expect(app.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
    await app.getByRole('button', { name: 'Create link command' }).click();
    await expect(app.getByText('link hmx_fixture_only_not_a_credential')).toBeVisible();
  });
});
