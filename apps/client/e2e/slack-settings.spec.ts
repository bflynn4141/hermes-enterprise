import { expect, test } from '@playwright/test';

async function openSlack(page: import('@playwright/test').Page, url = '/', member = false) {
  await page.goto(url);
  const app = page.getByRole('region', { name: 'Application' });
  if (member) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await app.getByRole('tab', { name: 'Slack account', exact: true }).click();
    await expect(app.getByRole('heading', { name: 'Slack account', exact: true })).toBeVisible();
  } else {
    await page.getByRole('button', { name: 'Admin', exact: true }).click();
    await expect(app.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
    const section = app.getByRole('combobox', { name: 'Admin section' });
    if (await section.isVisible()) await section.selectOption('Slack');
    else await app.getByRole('button', { name: 'Slack', exact: true }).click();
    await expect(app.getByRole('heading', { name: 'Slack', exact: true })).toBeVisible();
  }
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
    const app = await openSlack(page, '/?seat=member&slack=connected', true);
    await expect(app.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
    await app.getByRole('button', { name: 'Create link command' }).click();
    await expect(app.getByText('link hmx_fixture_only_not_a_credential')).toBeVisible();
  });
});
