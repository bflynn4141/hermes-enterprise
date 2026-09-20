import { expect, test } from '@playwright/test';

test.describe('Shared Intelligence', () => {
  test('turns a sanitized discovery into a private scored proposal', async ({ page }) => {
    await page.goto('/');
    const app = page.getByRole('region', { name: 'Application' });
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await app.getByRole('tab', { name: 'Shared Intelligence' }).click();

    await expect(app.getByRole('heading', { name: 'Turn completed work into reviewed reference material' })).toBeVisible();
    await expect(app.getByText('Private until approved')).toBeVisible();
    await expect(app.getByText(/private traces, tool arguments\/results, hidden reasoning/)).toBeVisible();
    await expect(app.getByText('Review a repeatable evidence-provenance pattern')).toBeVisible();
    await expect(app.getByText('possible pattern · unassessed')).toBeVisible();
    await expect(app.getByText('Record evidence provenance before escalation')).toBeVisible();

    await app.getByRole('button', { name: 'Review draft' }).click();
    await expect(app.getByRole('heading', { name: 'Review the private draft' })).toBeVisible();
    await expect(app.getByLabel('Reusable lesson')).toHaveValue(/Separate a claim/);
    await expect(app.getByText(/Must remain a verified, redacted excerpt/)).toHaveCount(2);
    await app.getByRole('button', { name: 'Check and save private draft' }).click();

    await expect(app.getByText('Private draft scored and saved. Check the evidence before sharing it with Admin.')).toBeVisible();
    await expect(app.getByRole('heading', { name: 'Review the private draft' })).toHaveCount(0);
    await expect(app.getByText('Review a repeatable evidence-provenance pattern', { exact: true })).toHaveCount(2);
  });

  test('shares exact excerpts into the Admin queue and sends the candidate to review', async ({ page }) => {
    await page.goto('/');
    const app = page.getByRole('region', { name: 'Application' });
    await page.getByRole('button', { name: 'Library', exact: true }).click();
    await app.getByRole('tab', { name: 'Shared Intelligence' }).click();
    await app.getByRole('button', { name: 'Share with Admin' }).first().click();
    await expect(app.getByText(/Shared with Admin using only the exact approved excerpts/)).toBeVisible();

    await page.getByRole('button', { name: 'Admin', exact: true }).click();
    await expect(app.getByRole('heading', { name: 'Admin', exact: true })).toBeVisible();
    const section = app.getByRole('combobox', { name: 'Admin section' });
    if (await section.isVisible()) await section.selectOption('Shared Intelligence');
    else await app.getByRole('button', { name: 'Shared Intelligence', exact: true }).click();
    await expect(app.getByRole('heading', { name: 'Shared Intelligence', exact: true })).toBeVisible();
    await expect(app.getByRole('heading', { name: 'Record evidence provenance before escalation' })).toBeVisible();
    await expect(app.getByText('Strong goal fit')).toBeVisible();
    await expect(app.getByText(/Sending for review freezes this candidate/)).toBeVisible();
    await app.getByRole('button', { name: 'Send for review' }).click();
    await expect(app.getByText(/Sent to the independent publication review/)).toBeVisible();
    await expect(app.getByRole('button', { name: 'Open review' })).toBeVisible();
  });
});
