import { expect, test, type Page, type TestInfo } from '@playwright/test';

/** Passkeys need a domain, not an IP, so these tests open the mock app on localhost with a virtual authenticator. */
async function withPasskey(page: Page, testInfo: TestInfo, query: string) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  const base = new URL(String(testInfo.project.use.baseURL));
  base.hostname = 'localhost';
  await page.goto(new URL(`/?${query}#admin/Wallets`, base).toString());
  return { credentials: async () => (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials };
}

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
  await page.getByRole('listitem').filter({ hasText: 'Maya Chen' }).getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('tab', { name: 'Wallet access' }).click();
  const wallet = page.getByRole('region', { name: 'Wallet access', exact: true });
  await expect(wallet.getByText('Not created', { exact: true })).toBeVisible();
  await expect(wallet.getByRole('button', { name: 'Set up wallet owner' })).toBeVisible();
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
  await expect(page.getByRole('listitem').filter({ hasText: 'Maya Chen' }).getByRole('button', { name: 'Manage' })).toHaveCount(0);
  await page.getByRole('listitem').filter({ hasText: 'Alex Rivera' }).getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('tab', { name: 'Wallet access' }).click();
  await expect(page.getByRole('region', { name: 'Wallet access', exact: true })).toBeVisible();
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


test('an Admin makes their passkey the wallet owner', async ({ page }, testInfo) => {
  const passkey = await withPasskey(page, testInfo, 'wallets=enabled');
  const owner = page.getByRole('region', { name: 'Wallet owner', exact: true });
  await expect(owner.getByText('No owner yet', { exact: true })).toBeVisible();
  await expect(owner.getByText(/no email recovery/)).toBeVisible();
  await owner.screenshot({ path: testInfo.outputPath('wallet-owner-before.png') });
  await owner.getByRole('button', { name: 'Create owner passkey', exact: true }).click();
  await page.getByRole('dialog', { name: 'Set up the wallet owner' }).getByRole('button', { name: 'Create passkey', exact: true }).click();
  await expect(owner.getByText('Owner verified', { exact: true })).toBeVisible();
  await expect(owner.getByText('Maya Chen', { exact: true })).toBeVisible();
  await expect(owner.getByText(/Verified with Turnkey on/)).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Create owner passkey' })).toHaveCount(0);
  expect(await passkey.credentials()).toHaveLength(1);
  await expect(page.getByText('The wallet owner is verified; wallet addresses come next.')).toBeVisible();
  await owner.screenshot({ path: testInfo.outputPath('wallet-owner-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(owner.getByText('Owner verified', { exact: true })).toBeVisible();
  await owner.screenshot({ path: testInfo.outputPath('wallet-owner-narrow.png') });
});

test('an unconfirmed owner setup is checked, never started over', async ({ page }, testInfo) => {
  await withPasskey(page, testInfo, 'wallets=enabled&walletRoot=ambiguous');
  const owner = page.getByRole('region', { name: 'Wallet owner', exact: true });
  await owner.getByRole('button', { name: 'Create owner passkey', exact: true }).click();
  await page.getByRole('dialog', { name: 'Set up the wallet owner' }).getByRole('button', { name: 'Create passkey', exact: true }).click();
  await expect(owner.getByText('Setup not confirmed', { exact: true })).toBeVisible();
  await expect(owner.getByText(/don't start over/)).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Create owner passkey' })).toHaveCount(0);
  await owner.getByRole('button', { name: 'Check setup', exact: true }).click();
  await expect(owner.getByText('Owner verified', { exact: true })).toBeVisible();
});

test('members see the owner status but cannot set it up', async ({ page }) => {
  await page.goto('/?wallets=enabled&seat=member#admin/Wallets');
  await expect(page.getByRole('button', { name: 'Create owner passkey' })).toHaveCount(0);
});

test('a setup that stalls offers Check setup instead of waiting forever', async ({ page }, testInfo) => {
  await withPasskey(page, testInfo, 'wallets=enabled&walletRoot=stalled');
  const owner = page.getByRole('region', { name: 'Wallet owner', exact: true });
  await owner.getByRole('button', { name: 'Create owner passkey', exact: true }).click();
  await page.getByRole('dialog', { name: 'Set up the wallet owner' }).getByRole('button', { name: 'Create passkey', exact: true }).click();
  await expect(owner.getByText('Setting up with Turnkey…', { exact: true })).toBeVisible();
  await owner.getByRole('button', { name: 'Check setup', exact: true }).click();
  await expect(owner.getByText('Owner verified', { exact: true })).toBeVisible();
});

test('member wallet creation requires a reviewed owner passkey and keeps payment authority separate', async ({ page }, testInfo) => {
  await withPasskey(page, testInfo, 'wallets=enabled');
  await page.getByRole('button', { name: 'Create owner passkey', exact: true }).click();
  const ownerReview = page.getByRole('dialog', { name: 'Set up the wallet owner' });
  await expect(ownerReview).toContainText('Maya Chen');
  await ownerReview.getByRole('button', { name: 'Create passkey', exact: true }).click();
  await expect(page.getByText('Owner verified', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await page.getByRole('listitem').filter({ hasText: 'Alex Rivera' }).getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('tab', { name: 'Wallet access', exact: true }).click();
  const card = page.getByRole('region', { name: 'Wallet access', exact: true });
  await card.getByRole('button', { name: 'Create wallet', exact: true }).click();
  await expect(card.getByText('Awaiting owner review', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Review request' }).click();
  let review = page.getByRole('dialog', { name: 'Create a wallet for Alex Rivera?' });
  await expect(review).toContainText('Maya Chen');
  await review.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(card.getByText('Awaiting owner review', { exact: true })).toBeVisible();
  // Leaving the page does not discard a server-owned proposal.
  await page.getByRole('tab', { name: 'Overview', exact: true }).click();
  await page.getByRole('tab', { name: 'Wallet access', exact: true }).click();
  await card.getByRole('button', { name: 'Review request' }).click();
  review = page.getByRole('dialog', { name: 'Create a wallet for Alex Rivera?' });
  await review.getByRole('button', { name: 'Confirm with passkey' }).click();
  await expect(card.getByText('Ready', { exact: true })).toBeVisible();
  await expect(card.getByText('Not verified', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Create wallet', exact: true })).toHaveCount(0);
  await card.screenshot({ path: testInfo.outputPath('member-wallet-ready.png') });
});

test('an uncertain member wallet outcome reconciles without another owner signature', async ({ page }, testInfo) => {
  const passkey = await withPasskey(page, testInfo, 'wallets=enabled&walletRoot=ambiguous');
  await page.getByRole('button', { name: 'Create owner passkey', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Create passkey', exact: true }).click();
  await page.getByRole('button', { name: 'Check setup', exact: true }).click();
  await expect(page.getByText('Owner verified', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await page.getByRole('listitem').filter({ hasText: 'Alex Rivera' }).getByRole('button', { name: 'Manage' }).click();
  await page.getByRole('tab', { name: 'Wallet access', exact: true }).click();
  const card = page.getByRole('region', { name: 'Wallet access', exact: true });
  await card.getByRole('button', { name: 'Create wallet', exact: true }).click();
  await card.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm with passkey' }).click();
  await expect(card.getByText('We’re checking whether this change finished.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Review request' })).toHaveCount(0);
  const before = await passkey.credentials();
  await card.getByRole('button', { name: 'Check status' }).click();
  await expect(card.getByText('Ready', { exact: true })).toBeVisible();
  expect((await passkey.credentials())[0]?.signCount).toBe(before[0]?.signCount);
});
