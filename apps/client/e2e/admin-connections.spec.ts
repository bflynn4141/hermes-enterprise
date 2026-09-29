import { expect, test, type Page } from '@playwright/test';

// Admin → Connections → Overview (docs/CONNECTORS.md): every outside
// connection on one list, with a status only when it says something.
const app = (page: Page) => page.getByRole('region', { name: 'Application' });
const row = (page: Page, label: string) => app(page).getByRole('listitem').filter({ hasText: label });

test('the overview names each account, says what it can do, and badges only trouble', async ({ page }) => {
  await page.goto('/?email=connected&slack=connected#admin/All%20connections');
  await expect(app(page).getByRole('tab', { name: 'Overview', exact: true })).toHaveAttribute('aria-selected', 'true');

  const gmail = row(page, 'Gmail sending account');
  await expect(gmail.getByText('Connected', { exact: true })).toBeVisible();
  await expect(gmail).toContainText('iris-partners@example.com');
  await expect(gmail).toContainText('Sends an email only after its reviewers approve the exact text');

  const slack = row(page, 'Slack');
  await expect(slack).toContainText('Fixture workspace');
  await expect(slack).toContainText('Replies in the same thread, by itself');

  // Not connected is said by the Connect button, never by a badge.
  const microsoft = row(page, 'Microsoft 365 sending account');
  await expect(microsoft).toContainText('Gmail is the sending account.');
  await expect(microsoft.getByText('Not connected')).toHaveCount(0);

  await expect(row(page, 'Gmail (read-only)')).toContainText('iris-evidence@example.com');

  await slack.getByRole('button', { name: 'Open' }).click();
  await expect(app(page).getByRole('tab', { name: 'Slack', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('an account the provider refused says so before an approved email fails', async ({ page }) => {
  await page.goto('/?email=connected&slack=unconfigured&connections=trouble#admin/All%20connections');
  // A service this deployment can't offer is a fact at the bottom, with no action.
  const slack = row(page, 'Slack');
  await expect(slack).toContainText('Not available on this deployment');
  await expect(slack.getByRole('button')).toHaveCount(0);
  await expect(app(page).getByRole('listitem').last()).toContainText('Slack');

  const gmail = row(page, 'Gmail sending account');
  await expect(gmail.getByText('Needs attention')).toBeVisible();
  await expect(gmail).toContainText('Reconnect the account');
  await expect(gmail).toContainText('2 approved items waiting');
  await gmail.getByRole('button', { name: 'Review' }).click();
  await expect(app(page).getByRole('tab', { name: 'Email', exact: true })).toHaveAttribute('aria-selected', 'true');
});

test('the overview fits a phone screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?email=connected&slack=connected#admin/All%20connections');
  const button = row(page, 'Slack').getByRole('button', { name: 'Open' });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('an Admin disconnects the sending account after reading what stops', async ({ page }) => {
  await page.goto('/?email=connected#admin/Email');
  await app(page).getByRole('button', { name: 'Disconnect', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Disconnect Gmail?' });
  await expect(dialog).toContainText('iris-partners@example.com');
  await expect(dialog).toContainText('will wait until a sending account is connected again');
  await expect(dialog).toContainText('remove it in that account’s security settings');
  await dialog.getByRole('button', { name: 'Disconnect' }).click();
  await expect(app(page).getByText('Gmail is disconnected. 2 approved emails are waiting for a sending account.')).toBeVisible();
  await expect(app(page).getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0);

});

test('an Admin disconnects read-only Gmail and saved conversations stay', async ({ page }) => {
  await page.goto('/?email=connected');
  await page.getByRole('button', { name: 'Library', exact: true }).first().click();
  await app(page).getByRole('tab', { name: 'Connections' }).click();
  await app(page).getByRole('button', { name: 'Disconnect', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Disconnect read-only Gmail?' });
  await expect(dialog).toContainText('Conversations already saved stay in your Library');
  await dialog.getByRole('button', { name: 'Disconnect' }).click();
  await expect(app(page).getByText('Read-only Gmail is disconnected. Saved conversations stay in your Library.')).toBeVisible();
  await expect(app(page).getByText('Connect read-only Gmail', { exact: true })).toBeVisible();
});
