import { expect, test } from '@playwright/test';

// Hundreds of emails at one agent's address stay one line each, searchable,
// sortable by what needs a person, and paged (labelled sample mail, ?mail=sample).
test('an agent\'s email is searchable, sorted by priority and paged, one line per email', async ({ page }) => {
  await page.goto('/?mail=sample#admin/Email');
  const list = page.getByRole('list', { name: /^Recent email at Iris/ });
  await expect(list.getByRole('listitem')).toHaveCount(10);
  await expect(page.getByText('10 of 184')).toBeVisible();
  const heights = await page.locator('.email-row').evaluateAll((rows) => new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height))).size);
  expect(heights).toBe(1);
  await expect(list.getByRole('listitem').first().locator('time')).toHaveText(/^(Just now|\d+m ago)$/);

  await page.getByRole('button', { name: 'Priority' }).click();
  await expect(list.getByRole('listitem').first()).toContainText('Check the sender');
  await expect(list.getByRole('listitem').nth(1)).toContainText('Ready for review');

  await page.getByRole('searchbox', { name: /Search Iris/ }).fill('referral');
  await expect(page.getByText('10 of 23')).toBeVisible();
  await expect(list.getByRole('listitem').first()).toContainText('Referral agreement');
  await page.getByRole('searchbox', { name: /Search Iris/ }).fill('no such thing');
  await expect(page.getByText('No matching email')).toBeVisible();

  await page.getByRole('searchbox', { name: /Search Iris/ }).fill('');
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(page.getByText('35 of 184')).toBeVisible();
});
