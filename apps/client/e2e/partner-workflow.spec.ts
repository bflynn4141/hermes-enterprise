import { expect, test } from '@playwright/test';

test('renders the two employee role templates and scoped Finance evidence', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&seat=member#inbox/request/00000000-0000-4000-8000-00000000000d');
  const app = page.getByRole('region', { name: 'Application' });

  await expect(app.getByText('0 of 1 Finance review', { exact: true })).toBeVisible();
  await expect(app.getByRole('button', { name: 'Approve invoice draft', exact: true })).toBeVisible();
  await expect(app.getByText('Workflow evidence (2 sources)', { exact: true })).toBeVisible();
  await expect(app.getByText('Illustrative approved engagement excerpt only.')).toBeVisible();
  await expect(app.getByText('Full Partnerships session remains private.')).toBeVisible();
  await expect(app.getByRole('link', { name: 'Open Finance review session' })).toHaveAttribute('href', /\/s\//);
  await expect(app.getByText('Simulated', { exact: true })).toHaveCount(2);

  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(app.getByText('Partnerships + Finance', { exact: true })).toBeVisible();
  await expect(app.getByText(/Partnerships · Maya Chen/)).toBeVisible();
  await expect(app.getByText(/Finance · Alex Rivera/)).toBeVisible();
  await expect(app.getByText('Server-enforced · private by team', { exact: true })).toBeVisible();
  await expect(app.getByText('completed', { exact: true })).toBeVisible();
});
