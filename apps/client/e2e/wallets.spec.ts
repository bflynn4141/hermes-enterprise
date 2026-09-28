import { expect, test } from '@playwright/test';

test('wallet enrollment is a saved request, never a connected wallet or payment', async ({ page }, testInfo) => {
  await page.goto('/?wallets=enabled#admin/Wallets');
  const card = page.getByRole('region', { name: 'Workspace wallets', exact: true });
  await card.getByRole('button', { name: 'Request wallet setup', exact: true }).click();
  await expect(card.getByText('Setup requested · Needs owner setup')).toBeVisible();
  await expect(card.getByText('Payments and signing are not enabled.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Request wallet setup', exact: true })).toHaveCount(0);
  const agents = page.getByRole('region', { name: 'Agent wallets', exact: true });
  await agents.getByRole('button', { name: 'Request wallet setup for Iris', exact: true }).click();
  await expect(agents.getByText('Needs owner setup', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('wallets-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  const wallet = page.getByLabel('Maya Chen wallet', { exact: true });
  await wallet.getByRole('button', { name: 'Request wallet setup for Maya Chen', exact: true }).click();
  await expect(wallet.getByText('Wallet · Needs owner setup')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('wallet-members-narrow.png'), fullPage: true });
  await expect(wallet).toBeVisible();
});

test('failed enrollment keeps the wallet unconfigured and offers status refresh', async ({ page }) => {
  await page.goto('/?wallets=fail#admin/Wallets');
  const card = page.getByRole('region', { name: 'Workspace wallets', exact: true });
  await card.getByRole('button', { name: 'Request wallet setup', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('could not be confirmed');
  await expect(card.getByText('Not set up', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Refresh status' })).toBeVisible();
});

test('disabled deployments expose no wallet enrollment action', async ({ page }) => {
  await page.goto('/#admin/Wallets');
  await expect(page.getByText('Wallet setup is not enabled for this deployment.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request wallet setup', exact: true })).toHaveCount(0);
});


test('members see only their own wallet status and no enrollment action', async ({ page }) => {
  await page.goto('/?wallets=enabled&seat=member#members');
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await expect(page.getByLabel('Alex Rivera wallet', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Maya Chen wallet', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Request wallet setup/ })).toHaveCount(0);
});


test('a stale sign-in offers the existing identity confirmation flow', async ({ page }) => {
  await page.goto('/?wallets=reauth#admin/Wallets');
  const card = page.getByRole('region', { name: 'Workspace wallets', exact: true });
  await card.getByRole('button', { name: 'Request wallet setup', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('recent sign-in');
  await expect(card.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await expect(card.getByText('Not set up', { exact: true })).toBeVisible();
});
