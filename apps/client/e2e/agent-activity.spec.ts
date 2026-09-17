import { expect, test, type Page } from '@playwright/test';

const activity = (page: Page) => page.getByRole('region', { name: 'Agent activity' });

test('the overview stays live after Iris is collapsed', async ({ page }) => {
  await page.goto('/');
  const card = activity(page);

  await expect(card.getByRole('status')).toHaveText('Waiting for you');
  await expect(card.getByText('Last tool', { exact: true })).toBeVisible();
  await expect(card.getByText('propose_request', { exact: true })).toBeVisible();
  await expect(card.getByText('Prepared a review request', { exact: true })).toBeVisible();

  await page.getByRole('textbox', { name: 'Message Iris' }).fill('Review the newest partner application');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: /Hide Iris/ }).first().click();

  await expect(page.locator('.iris-rail')).toBeVisible();
  await expect(card).toHaveAttribute('data-activity-state', 'working');
  await expect(card.getByRole('status')).toHaveText('Working now');
  // Read the pair atomically: the tool can finish between two locator checks.
  await expect(card).toContainText(/get_request\s*→\s*Review(?:ing|ed) a request/);

  const animation = await card.locator('.agent-activity-status i').evaluate((element) => getComputedStyle(element).animationName);
  expect(animation).toBe('activity-pulse');
});

test('idle and reduced-motion states remain still', async ({ page }) => {
  await page.goto('/?data=empty&key=verified');
  const card = activity(page);

  await expect(card).toHaveAttribute('data-activity-state', 'idle');
  await expect(card.getByRole('status')).toHaveText('Idle');
  await expect(card.getByText('No active work right now', { exact: true })).toBeVisible();
  await expect(card.locator('.agent-tool-pair')).toHaveCount(0);
  expect(await card.locator('.agent-activity-status i').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');

  await page.getByRole('button', { name: 'Your account' }).click();
  await page.getByRole('switch', { name: 'Reduce motion' }).click();
  await page.keyboard.press('Escape');

  await page.getByRole('textbox', { name: 'Message Iris' }).fill('Review the newest partner application');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(card).toHaveAttribute('data-activity-state', 'working');

  expect(await card.locator('.agent-activity-status i').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  expect(await card.locator('.orbit').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await expect(card.locator('.agent-tool-pair i')).toBeVisible();
  expect(await card.locator('.agent-tool-pair i').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
});

test('a completed no-tool Hermes run never looks like it is still thinking', async ({ page }) => {
  await page.goto('/?activity=completed');
  const card = activity(page);
  await expect(card.getByRole('status')).toHaveText('Idle');
  await expect(card.getByText('Explain partner screening', { exact: true })).toBeVisible();
  await expect(card.getByText('Response completed · No tool calls', { exact: true })).toBeVisible();
  await expect(card.getByText('Thinking', { exact: true })).toHaveCount(0);
  await expect(card.locator('.agent-tool-pair')).toHaveCount(0);
  expect(await card.locator('.agent-activity-status i').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
});

test('a completed run keeps its last tool visible when the pane is narrow', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto('/?activity=completed-tool');
  const card = activity(page);
  await expect(card.getByRole('status')).toHaveText('Idle');
  await expect(card.getByText('Last tool', { exact: true })).toBeVisible();
  await expect(card).toContainText(/get_document_text\s*→\s*Read a source document/);
  await expect(card.locator('.agent-tool-pair')).toHaveAttribute('data-tool-state', 'complete');
  expect(await card.locator('.agent-tool-pair i').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
