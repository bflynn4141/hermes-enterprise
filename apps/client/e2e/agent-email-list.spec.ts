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
  await expect(list.getByRole('listitem').first().locator('.time-full')).toHaveText(/^(Just now|\d+m ago)$/);
  // Status dots and times line up down the list.
  const columns = await page.locator('.email-row').evaluateAll((rows) => rows.map((row) => [
    Math.round(row.querySelector('.email-row-status .status-dot-mark')!.getBoundingClientRect().left),
    Math.round(row.querySelector('time')!.getBoundingClientRect().right),
  ].join()));
  expect(new Set(columns).size).toBe(1);

  // A failed read is its own Try again.
  await page.getByRole('button', { name: /^Couldn’t read it\. Try again: Partner program question$/ }).hover();
  await expect(page.locator('.email-status-action .when-active').first()).toHaveCSS('opacity', '1');

  await page.getByRole('button', { name: 'Priority' }).click();
  await expect(list.getByRole('listitem').first()).toContainText('Check the sender');
  await expect(list.getByRole('listitem').nth(1)).toContainText('Ready for review');

  await page.getByRole('searchbox', { name: /Search Iris/ }).fill('referral');
  await expect(page.getByText('10 of 23')).toBeVisible();
  await expect(list.getByRole('listitem').first()).toContainText('Referral agreement');
  await page.getByRole('searchbox', { name: /Search Iris/ }).fill('no such thing');
  await expect(page.getByText('No matching email')).toBeVisible();

  await page.getByRole('searchbox', { name: /Search Iris/ }).fill('');
  // The address is a copy button beside the name: it opens on hover and says when it has copied.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const copy = page.getByRole('button', { name: /^Copy Iris’s email address, iris-/ });
  await copy.hover();
  await expect(copy.locator('.snippet-chip-value')).toHaveCSS('opacity', '1');
  await copy.click();
  await expect(copy.locator('.snippet-chip-done')).toHaveText('Copied email address');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^iris-[a-z0-9]+@/);
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(page.getByText('35 of 184')).toBeVisible();
});
