import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

test.skip(!process.env.UPDATE_README_SCREENSHOTS, 'Run pnpm screenshots:readme to refresh the README images.');
test.use({ viewport: { width: 1680, height: 1000 } });

const app = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Application' });
const asset = (name: string) => fileURLToPath(new URL(`../../../docs/assets/${name}`, import.meta.url));

test('capture the two-role Partnerships and Finance workflow', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });

  await page.goto('/?partnerWorkflow=1&workflowRole=partnerships&seat=admin');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByText('Scout sessions', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Robin Studio · invoice source' })).toBeVisible();
  await expect(page.getByText('Robin Studio is ready for human review', { exact: true })).toBeVisible();
  await expect(app(page).getByText('Maya Chen · Scout', { exact: true })).toBeVisible();
  await expect(app(page).getByText('Alex Rivera · Ledger', { exact: true })).toBeVisible();
  await page.screenshot({ path: asset('readme-partnerships.png'), animations: 'disabled' });

  await page.goto('/?partnerWorkflow=1&workflowRole=finance&seat=member');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByText('Ledger sessions', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Robin Studio · Finance review' })).toBeVisible();
  await expect(page.getByText('Ready for Alex’s decision', { exact: true })).toBeVisible();
  const handoff = app(page).locator('.partner-handoff-card').filter({ hasText: 'INV-SAMPLE-014' });
  await handoff.getByRole('button', { name: 'View checks and evidence' }).click();
  await expect(handoff.getByText('Sample engagement terms.txt', { exact: true })).toBeVisible();
  await page.screenshot({ path: asset('readme-finance-handoff.png'), animations: 'disabled' });

  await handoff.getByRole('button', { name: 'Open Finance decision' }).click();
  await expect(app(page).getByRole('heading', { name: 'Your decision' })).toBeVisible();
  await expect(page.getByText('Ledger sessions', { exact: true })).toBeVisible();
  await page.screenshot({ path: asset('readme-finance-decision.png'), animations: 'disabled' });

  await app(page).getByRole('button', { name: 'Approve invoice draft', exact: true }).click();
  await expect(app(page).getByRole('heading', { name: 'Saved in Library' })).toBeVisible();
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const decided = app(page).locator('.partner-handoff-card').filter({ hasText: 'INV-SAMPLE-014' });
  await expect(decided.getByText('Finance saved the invoice draft', { exact: true })).toBeVisible();
  await expect(page.getByText('Ledger sessions', { exact: true })).toBeVisible();
  await decided.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: asset('readme-finance-receipt.png'), animations: 'disabled' });
});
