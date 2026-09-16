import { expect, test } from '@playwright/test';

const FRESH_WORKSPACE = '/?data=empty&key=none';

async function openProviderConnect(page: import('@playwright/test').Page) {
  await page.goto(FRESH_WORKSPACE);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const app = page.getByRole('region', { name: 'Application' });
  await app.getByRole('tab', { name: 'Provider keys' }).click();
  await app.getByRole('button', { name: 'Connect Nous Portal' }).click();
  return page.getByRole('dialog', { name: 'Connect Nous Portal' });
}

test.describe('Nous Portal connection', () => {
  test('guides the Admin to Nous, labels the secret, and connects without a name field', async ({ page }) => {
    const dialog = await openProviderConnect(page);
    await expect(dialog).toBeVisible();

    const portal = dialog.getByRole('link', { name: 'Continue with Nous' });
    await expect(portal).toHaveAttribute('href', 'https://portal.nousresearch.com/api-keys');
    await expect(portal).toHaveAttribute('target', '_blank');
    await expect(portal).toBeFocused();
    await expect(dialog.getByText(/opens the official API key page in a new tab/)).toBeVisible();
    await expect(dialog.getByText(/No Nous account access is granted to Hermes/)).toBeVisible();

    const key = dialog.getByLabel('Nous Portal API key');
    await expect(key).toHaveAttribute('type', 'password');
    await expect(key).toHaveAttribute('autocomplete', 'new-password');
    await expect(dialog.getByText(/Paste the secret key you copied from Nous Portal/)).toBeVisible();
    await expect(dialog.getByText(/Connection name/)).toHaveCount(0);
    await expect(dialog.getByPlaceholder(/Program key/)).toHaveCount(0);

    const connect = dialog.getByRole('button', { name: 'Connect and continue' });
    await expect(connect).toBeDisabled();
    await key.fill('nous-browser-fixture-key-0001');
    await expect(connect).toBeEnabled();
    await connect.click();

    await expect(dialog.getByText('Nous Portal connected')).toBeVisible();
    await expect(dialog.getByText('3 models are ready for Iris.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);

    const app = page.getByRole('region', { name: 'Application' });
    const connectedRow = app.locator('.list-row').filter({ hasText: 'Nous Portal' });
    await expect(connectedRow).toBeVisible();
    await expect(connectedRow).toContainText('3 models synced');
  });

  test('keeps a rejected key visible as an actionable saved-key state', async ({ page }) => {
    const dialog = await openProviderConnect(page);
    await dialog.getByLabel('Nous Portal API key').fill('nous-invalid-test-key-0000');
    await dialog.getByRole('button', { name: 'Connect and continue' }).click();

    await expect(dialog.getByRole('alert')).toContainText('Nous Portal did not accept this key');
    await expect(dialog.getByLabel('Nous Portal API key')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Try verification again' }).click();
    await expect(dialog.getByText('Nous Portal connected')).toBeVisible();
  });

  test('does not expose the connection controls to a Member', async ({ page }) => {
    await page.goto('/?seat=member&data=empty&key=none');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const app = page.getByRole('region', { name: 'Application' });
    await app.getByRole('tab', { name: 'Provider keys' }).click();

    await expect(app.getByText('Admin decision required')).toBeVisible();
    await expect(app.getByRole('button', { name: 'Connect Nous Portal' })).toHaveCount(0);
  });
});
