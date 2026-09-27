import { expect, test } from '@playwright/test';

const application = (page: import('@playwright/test').Page) =>
  page.getByRole('region', { name: 'Application' });

test('Connections keeps Gmail read evidence separate from the outbound sender', async ({ page }) => {
  await page.goto('/?email=connected&agentSettings=ok');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const pane = application(page);
  await pane.getByRole('tab', { name: 'Connections' }).click();

  await expect(pane.getByText(/Read-only Gmail · iris-evidence@example.com/)).toBeVisible();
  await expect(pane.getByText('Read only', { exact: true })).toBeVisible();
  await expect(pane.getByText(/Sending from iris-partners@example.com/)).toBeVisible();
  await expect(pane.getByText('Permission to read is never used to send.', { exact: false })).toBeVisible();
  await expect(pane.getByText('Saving never sends email.', { exact: false })).toBeVisible();

  await pane.getByLabel('Conversation ID').fill('thread_1234');
  await pane.getByRole('button', { name: 'Save to Library' }).click();
  await expect(pane.getByText(/Saved to your Library\./)).toBeVisible();
  await expect(pane.getByText(/Nothing was sent\./)).toBeVisible();
  await expect(pane.getByText('1', { exact: true }).first()).toBeVisible();
});
