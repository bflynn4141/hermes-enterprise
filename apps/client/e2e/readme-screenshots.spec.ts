import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test.skip(!process.env.UPDATE_README_SCREENSHOTS, 'Run pnpm screenshots:readme to refresh the README images.');
test.use({ viewport: { width: 1680, height: 1000 } });

const app = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Application' });
const asset = (name: string) => fileURLToPath(new URL(`../../../docs/assets/${name}`, import.meta.url));

test('capture the two-role Partnerships and Finance workflow in the Inbox', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });

  await page.goto('/?partnerWorkflow=1&workflowRole=partnerships&seat=admin');
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(page.getByText('Scout sessions', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Partner applications' })).toBeVisible();
  await expect(page.getByText('Two partner applicants are ready for review', { exact: true })).toBeVisible();
  await page.locator('.chat-card').filter({ hasText: 'Leah Martinez' }).getByRole('button', { name: 'Open request' }).click();
  await expect(app(page).getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(app(page).getByText('Leah Martinez', { exact: true }).first()).toBeVisible();
  await expect(app(page).getByLabel('82 out of 100')).toBeVisible();
  await expect(app(page).getByRole('heading', { name: 'Library', exact: true })).toHaveCount(0);
  await page.screenshot({ path: asset('readme-partnerships.png'), animations: 'disabled' });

  await page.goto('/?partnerWorkflow=1&workflowRole=finance&seat=member');
  await expect(page.getByText('Ledger sessions', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Robin Studio · Finance review' })).toBeVisible();
  await expect(page.getByText('Ready for Alex’s decision', { exact: true })).toBeVisible();
  await page.locator('.chat-card').filter({ hasText: 'INV-SAMPLE-014' }).getByRole('button', { name: 'Open request' }).click();
  await expect(app(page).getByRole('heading', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(app(page).getByRole('heading', { name: 'Your decision' })).toBeVisible();
  await expect(app(page).getByText('Authorized workflow evidence (4 checks)', { exact: true })).toBeVisible();
  await expect(app(page).getByRole('heading', { name: 'Library', exact: true })).toHaveCount(0);
  await page.screenshot({ path: asset('readme-finance-decision.png'), animations: 'disabled' });

  await app(page).getByRole('button', { name: 'Approve invoice draft', exact: true }).click();
  await expect(app(page).getByRole('heading', { name: 'Saved in Library' })).toBeVisible();
  await app(page).getByRole('button', { name: 'Back to Inbox' }).click();
  await app(page).getByRole('tab', { name: 'Resolved', exact: true }).click();
  await expect(app(page).getByRole('tab', { name: 'Resolved', exact: true })).toHaveAttribute('aria-selected', 'true');
  const resolvedInvoice = app(page).locator('.inbox-item').filter({ hasText: 'Robin Studio' });
  await expect(resolvedInvoice.getByText('Invoice draft created · Not sent · No money moved', { exact: true })).toBeVisible();
  await expect(app(page).getByRole('heading', { name: 'Library', exact: true })).toHaveCount(0);
  await page.screenshot({ path: asset('readme-finance-receipt.png'), animations: 'disabled' });
});
