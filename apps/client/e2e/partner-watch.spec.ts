import { expect, test } from '@playwright/test';

const watch = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Partner watch', exact: true });

test('first check is quiet, unchanged stays quiet, a meaningful change produces a review', async ({ page }) => {
  await page.goto('/?partnerWatch=ready');
  const card = watch(page);
  await expect(card.getByText('Sample watch · Checks and reviews are simulated.')).toBeVisible();
  await card.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(card.getByText('Starting point saved. Future checks will look for changes.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Review in Inbox' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(card.getByText('No relevant changes.', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(card.getByText('A cited review is ready in your Inbox.')).toBeVisible();
  await card.getByRole('button', { name: 'Review in Inbox' }).click();
  await expect(page.getByRole('heading', { name: 'Sample partner source change', exact: true })).toBeVisible();
  await expect(page.getByText(/Sample result: the project added an integration guide/)).toBeVisible();
});

test('watch settings survive navigation and pause prevents manual checks', async ({ page }) => {
  await page.goto('/?partnerWatch=baseline');
  const card = watch(page);
  await card.getByRole('button', { name: 'Configure', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Configure partner watch' });
  await dialog.getByLabel('GitHub source').selectOption('url:1');
  await dialog.getByLabel('Check every').selectOption('1440');
  await dialog.getByLabel('Model spending per check (USD)').fill('0.05');
  await dialog.getByLabel('Model spending per day (USD)').fill('0.15');
  await dialog.getByRole('button', { name: 'Save watch' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByText('Every day · $0.15 per day · $0.05 per check')).toBeVisible();
  await card.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(card.getByRole('status')).toHaveText('Partner watch paused.');
  await expect(card.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  const mobile = page.getByRole('combobox', { name: 'Agent view' });
  if (await mobile.isVisible()) { await mobile.selectOption('skills'); await mobile.selectOption('overview'); }
  else { await page.getByRole('tab', { name: 'Skills', exact: true }).click(); await page.getByRole('tab', { name: 'Overview', exact: true }).click(); }
  await expect(card.getByText('GitHub · Another sample partner')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();
});

test('stale watch settings preserve the draft and require current settings review', async ({ page }) => {
  await page.goto('/?partnerWatch=conflict');
  await watch(page).getByRole('button', { name: 'Configure', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Configure partner watch' });
  const limit = dialog.getByLabel('Model spending per day (USD)');
  await limit.fill('0.18');
  await dialog.getByRole('button', { name: 'Save watch' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Your draft is kept');
  await expect(limit).toHaveValue('0.18');
  await dialog.getByRole('button', { name: 'Reload current settings' }).click();
  await expect(dialog.getByRole('button', { name: 'Save watch' })).toBeDisabled();
  await expect(dialog.getByText(/Every 12 hours/)).toBeVisible();
  await expect(limit).toHaveValue('0.18');
  await dialog.getByRole('button', { name: 'I’ve reviewed the current settings' }).click();
  await dialog.getByRole('button', { name: 'Save watch' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(watch(page).getByText('Every 6 hours · $0.18 per day · $0.10 per check')).toBeVisible();
});

test('unavailable and another member’s watch do not offer activation', async ({ page }) => {
  await page.goto('/?partnerWatch=unavailable');
  await expect(watch(page).getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  await expect(watch(page).getByRole('button', { name: 'Configure', exact: true })).toHaveCount(0);
  await expect(watch(page).getByText('Scheduled work is not available in this workspace yet.')).toBeVisible();
  await page.goto('/?partnerWatch=readonly');
  await expect(watch(page).getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  await expect(watch(page).getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);
});

test('failed check keeps the honest result without creating a review', async ({ page }) => {
  await page.goto('/?partnerWatch=failed');
  const card = watch(page);
  await card.getByRole('button', { name: 'Run now', exact: true }).dblclick();
  await expect(card.getByText('This check could not finish. Nothing was sent.')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Review in Inbox' })).toHaveCount(0);
});

test('rapid repeated Run now clicks perform only the first baseline check', async ({ page }) => {
  await page.goto('/?partnerWatch=ready');
  const card = watch(page);
  await card.getByRole('button', { name: 'Run now', exact: true }).dblclick();
  await expect(card.getByText('Starting point saved. Future checks will look for changes.')).toBeVisible();
  await expect(card.getByText('No relevant changes.', { exact: true })).toHaveCount(0);
});

test('an ambiguous wake response retries the same request without another source check', async ({ page }) => {
  await page.goto('/?partnerWatch=ambiguous');
  const card = watch(page);
  await card.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('Could not confirm');
  await card.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(card.getByText('Starting point saved. Future checks will look for changes.')).toBeVisible();
  await expect(card.getByText('No relevant changes.', { exact: true })).toHaveCount(0);
});

test('narrow reduced-motion watch and dialog fit and remain keyboard usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?partnerWatch=baseline');
  await page.getByRole('button', { name: 'App', exact: true }).click();
  const card = watch(page);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Configure', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Configure partner watch' });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Configure', exact: true })).toBeFocused();
  expect(await page.locator('.pane-app').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'qa/partner-watch-mobile.png', fullPage: true });
});


test('an Admin-paused skill permits saved settings but cannot be resumed by its owner', async ({ page }) => {
  await page.goto('/?partnerWatch=admin-paused');
  const card = watch(page);
  await expect(card.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await expect(card.getByText(/An Admin paused this agent/)).toBeVisible();
  await card.getByRole('button', { name: 'Configure', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Configure partner watch' });
  await expect(dialog.getByRole('checkbox', { name: 'Watch for changes while you’re away' })).toBeDisabled();
  await dialog.getByLabel('Model spending per day (USD)').fill('0.18');
  await dialog.getByRole('button', { name: 'Save watch' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(card.getByRole('status')).toContainText('An Admin must resume');
  await expect(card.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
});
