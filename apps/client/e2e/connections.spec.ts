import { expect, test } from '@playwright/test';

const application = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'Application' });

test('Connections keeps Gmail read evidence separate from the outbound sender', async ({ page }) => {
  await page.goto('/?email=connected&agentSettings=ok');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const pane = application(page);
  await pane.getByRole('tab', { name: 'Connections' }).click();

  await expect(pane.getByText(/Read-only Gmail · iris-evidence@example.com/)).toBeVisible();
  await expect(pane.getByText('Separate gmail.readonly consent')).toBeVisible();
  await expect(pane.getByText(/Outbound sender · iris-partners@example.com/)).toBeVisible();
  await expect(pane.getByText('Read permission is never reused as send permission.')).toBeVisible();

  await pane.getByLabel('Gmail thread ID').fill('thread_1234');
  await pane.getByRole('button', { name: 'Import evidence' }).click();
  await expect(pane.getByText('Thread imported as immutable Library evidence.')).toBeVisible();
  await expect(pane.getByText(/Sent 0 messages/)).toBeVisible();
  await expect(pane.getByText('1', { exact: true }).first()).toBeVisible();
});
