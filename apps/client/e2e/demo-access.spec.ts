import { expect, test } from '@playwright/test';

test('the demo request-access page invites with email and passcode on one form', async ({ page }) => {
  await page.goto('/demo');
  await expect(page.getByRole('banner').getByText('Hermes Teams Demo')).toBeVisible();
  await expect(page.getByRole('heading', { name: /See how a named team runs Iris/ })).toBeVisible();

  await page.getByPlaceholder('you@company.com').fill('guest@nous.example');
  await page.getByPlaceholder('Passcode').fill('demo-pass');
  await page.getByRole('button', { name: 'Request access' }).click();

  await expect(page.getByRole('status')).toContainText('Check your inbox');
  await expect(page.getByRole('status')).toContainText('guest@nous.example');
});

test('a wrong demo passcode stays on the form with a clear refusal', async ({ page }) => {
  await page.goto('/demo');
  await page.getByPlaceholder('you@company.com').fill('guest@nous.example');
  await page.getByPlaceholder('Passcode').fill('wrong');
  await page.getByRole('button', { name: 'Request access' }).click();

  await expect(page.getByRole('alert')).toContainText('That passcode is not right');
  await expect(page.getByRole('button', { name: 'Request access' })).toBeVisible();
});
