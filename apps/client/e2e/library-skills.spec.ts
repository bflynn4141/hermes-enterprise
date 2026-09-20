import { expect, test, type Page } from '@playwright/test';

async function openLibrarySkills(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const pane = page.getByRole('region', { name: 'Application' });
  await expect(pane.getByRole('heading', { name: 'Library' })).toBeVisible();
  await pane.getByRole('tab', { name: 'Skills' }).click();
  return pane;
}

test('Library skill Add only acks after a successful adopt', async ({ page }) => {
  const pane = await openLibrarySkills(page);
  const row = pane.locator('.list-row').filter({ hasText: 'Feedback synthesis' });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(pane.getByText('Added', { exact: true })).toBeVisible();
  await expect(pane.getByRole('alert')).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'In use', exact: true })).toBeDisabled();
});

test('failed Library skill adopt never shows Added and surfaces an alert', async ({ page }) => {
  await page.goto('/?libraryAdopt=fail');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const pane = page.getByRole('region', { name: 'Application' });
  await pane.getByRole('tab', { name: 'Skills' }).click();
  const row = pane.locator('.list-row').filter({ hasText: 'Feedback synthesis' });
  await row.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(pane.getByRole('alert')).toContainText('Could not add that skill');
  await expect(pane.getByText('Added', { exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
});
