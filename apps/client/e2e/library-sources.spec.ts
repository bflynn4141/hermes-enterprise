import { expect, test } from '@playwright/test';

test('a team member can open the shared Partner Program Guide and select its exact version for Iris', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&workflowRole=partnerships&seat=member&agentSettings=ok');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const pane = page.getByRole('region', { name: 'Application' });
  await pane.getByRole('tab', { name: 'Documents' }).click();

  const source = pane.locator('.list-row').filter({ hasText: 'Partner Program Guide' });
  await expect(source.getByText('0.1 draft', { exact: false })).toBeVisible();
  await expect(source.getByText('Finance + Partnerships', { exact: false })).toBeVisible();
  await source.getByRole('button', { name: 'Open' }).click();

  const dialog = page.getByRole('dialog', { name: 'Partner Program Guide' });
  await expect(dialog.getByRole('heading', { name: 'From prospect to invoice' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Use with Iris' }).click();
  await expect(dialog).toBeHidden();
  await expect(pane.getByText('Partner Program Guide selected for your next message. Nothing has been sent.')).toBeVisible();
  await expect(source.getByRole('button', { name: 'Selected' })).toBeDisabled();
});
