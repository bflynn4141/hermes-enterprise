import { expect, test, type Locator, type Page } from '@playwright/test';

const recipient = `0x${'12'.repeat(20)}`;
async function openRole(page: Page, query = '') {
  await page.goto(`/?${query}#admin/Roles`);
  await page.getByRole('list', { name: 'Roles' }).getByRole('button', { name: /^Finance/ }).click();
  const card = page.getByRole('region', { name: 'Spending limits', exact: true });
  await card.getByRole('button', { name: 'Create draft' }).click();
  return { card, dialog: page.getByRole('dialog', { name: 'Finance spending draft' }) };
}
async function fillDraft(dialog: Locator, value = '100.000001') {
  await dialog.getByLabel('Per transfer · USDC').fill(value);
  await dialog.getByLabel('Allowed recipients').fill(recipient);
  await dialog.getByLabel('Human approvals').fill('2');
}

test('a saved spending draft stays inactive and reopens with exact amounts', async ({ page }, info) => {
  await page.setViewportSize({ width: 1680, height: 1000 });
  const { card, dialog } = await openRole(page);
  await fillDraft(dialog, '9007199254740993.123456');
  await expect(dialog.getByText('USDC on Base · Saving does not activate payments or limits.')).toBeVisible();
  await dialog.getByText('Future period limits', { exact: true }).click();
  await expect(dialog.getByText('Planned only; daily and monthly limits are not implemented.')).toBeVisible();
  await dialog.getByLabel('Daily · USDC, optional').fill('1000');
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole('status')).toHaveText('Draft saved · Not active');
  await expect(card).toContainText('9007199254740993.123456 USDC');
  await expect(card).toContainText('Planned · Not enforced');
  await expect(page.getByRole('button', { name: /^Activate/ })).toHaveCount(0);
  await card.screenshot({ path: info.outputPath('spending-draft-desktop.png') });
  await card.getByRole('button', { name: 'Edit draft' }).click();
  await expect(dialog.getByLabel('Per transfer · USDC')).toHaveValue('9007199254740993.123456');
  await expect(dialog.getByLabel('Allowed recipients')).toHaveValue(recipient);
  await dialog.getByText('Future period limits', { exact: true }).click();
  await expect(dialog.getByLabel('Daily · USDC, optional')).toHaveValue('1000');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.getByRole('button', { name: 'Edit draft' })).toBeFocused();
});

test('invalid precision does not submit or discard a draft', async ({ page }) => {
  const { card, dialog } = await openRole(page);
  await fillDraft(dialog, '0.0000001');
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('up to 6 decimal places');
  await expect(dialog.getByLabel('Per transfer · USDC')).toHaveValue('0.0000001');
  await expect(dialog.getByLabel('Allowed recipients')).toHaveValue(recipient);
  await dialog.getByLabel('Per transfer · USDC').fill('0.000001');
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(card.getByRole('status')).toHaveText('Draft saved · Not active');
  await expect(card).toContainText('0.000001 USDC');
});

test('a stale sign-in retains the draft and offers sign-in', async ({ page }) => {
  const { dialog } = await openRole(page, 'roles=stepup');
  await fillDraft(dialog);
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Saving a draft needs a recent sign-in.');
  await expect(dialog.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await expect(dialog.getByLabel('Per transfer · USDC')).toHaveValue('100.000001');
  await expect(dialog.getByLabel('Allowed recipients')).toHaveValue(recipient);
});

test('a concurrent revision keeps local edits until an explicit reload', async ({ page }) => {
  const { card, dialog } = await openRole(page, 'spending=conflict');
  await fillDraft(dialog, '125');
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('This draft changed elsewhere.');
  await expect(dialog.getByLabel('Per transfer · USDC')).toHaveValue('125');
  await expect(dialog.getByLabel('Allowed recipients')).toHaveValue(recipient);
  await expect(dialog.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Reload saved draft' }).click();
  await expect(dialog.getByLabel('Per transfer · USDC')).toHaveValue('75');
  await expect(dialog.getByRole('status')).toHaveText('Latest saved draft loaded.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(card).toContainText('75 USDC');
  await card.getByRole('button', { name: 'Edit draft' }).click();
  await expect(dialog.getByLabel('Per transfer · USDC')).toHaveValue('75');
  await dialog.getByLabel('Per transfer · USDC').fill('80');
  await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toContainText('80 USDC');
  await expect(card.getByRole('status')).toHaveText('Draft saved · Not active');
});

test('the narrow reduced-motion editor remains usable and cancel never saves', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { card, dialog } = await openRole(page);
  await fillDraft(dialog);
  await expect(dialog.getByRole('button', { name: 'Save draft', exact: true })).toBeVisible();
  await expect(page.locator('.dialog')).toHaveCSS('opacity', '1');
  await dialog.screenshot({ path: info.outputPath('spending-draft-phone.png') });
  const width = await dialog.evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
  expect(width.scroll).toBeLessThanOrEqual(width.client);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Create draft' })).toBeVisible();
  await card.getByRole('button', { name: 'Create draft' }).click();
  await expect(dialog.getByLabel('Per transfer · USDC')).toHaveValue('');
});
