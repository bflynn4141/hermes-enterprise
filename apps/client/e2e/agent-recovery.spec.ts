import { expect, test } from '@playwright/test';

test('an explicit session model does not override the DeepSeek company default', async ({ page }) => {
  await page.goto('/?data=empty&key=verified');
  await page.getByRole('button', { name: 'Model: DeepSeek V4.1 Flash', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'low', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.menu-item').filter({ hasText: 'DeepSeek V4.1 Flash' })).toContainText('Company default');
  await page.locator('.menu-item').filter({ hasText: 'Anthropic: Claude Sonnet 5' }).click();
  await page.getByRole('button', { name: 'Model: Anthropic: Claude Sonnet 5', exact: true }).click();
  await expect(page.locator('.menu-item').filter({ hasText: 'DeepSeek V4.1 Flash' })).toContainText('Company default');
  await expect(page.locator('.menu-item').filter({ hasText: 'Anthropic: Claude Sonnet 5' })).not.toContainText('Company default');

  await page.goto('/?recovery=retryable');
  await page.getByRole('button', { name: 'Model: DeepSeek V4.1 Flash', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'low', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'max', exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'medium', exact: true })).toHaveCount(0);
  await expect(page.locator('.menu-item').filter({ hasText: 'DeepSeek V4.1 Flash' })).toContainText('Company default');
});

test('a no-output failure can be retried from Overview without using chat', async ({ page }) => {
  await page.goto('/?recovery=retryable');
  const card = page.getByRole('region', { name: 'Agent activity' });
  await expect(card.getByRole('button', { name: 'Retry task', exact: true })).toBeVisible();
  await expect(card.getByRole('status')).toHaveText('Needs attention');
  await card.getByRole('button', { name: 'Retry task', exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect(card.getByRole('button', { name: 'Requesting retry…' })).toBeDisabled();
  await expect(card.getByRole('status')).toHaveText('Queued');
  await expect(card).toContainText('Attempt 2');
  await expect(card).toContainText('DeepSeek V4.1 Flash');
  await expect(card.getByRole('button', { name: 'Retry task', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message Iris' })).toBeEmpty();
  await card.getByRole('button', { name: 'Open current task →' }).click();
  await expect(page.getByRole('heading', { name: 'Automated partner screening · Hermes Agent · work' })).toBeVisible();
  await expect(page.getByText('This run called no tools.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toHaveCount(0);
});

test('trace controls load after navigation for a failure with no tool output', async ({ page }) => {
  await page.goto('/?recovery=retryable');
  await page.getByRole('button', { name: 'View trace →', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry task', exact: true })).toBeVisible();
  await expect(page.getByText('This run called no tools.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry task', exact: true })).toBeVisible();
});

test('scheduled recovery shows its countdown and allows cancellation', async ({ page }) => {
  await page.goto('/?recovery=retry_scheduled');
  const card = page.getByRole('region', { name: 'Agent activity' });
  await expect(card).toContainText('Retrying in 1m');
  await expect(card).toContainText('Attempt 1 of 3');
  await card.getByRole('button', { name: 'Cancel retry', exact: true }).click();
  await expect(card.getByRole('status')).toHaveText('Stopped');
  await expect(card).toContainText('Automatic retry cancelled');
  await expect(card.getByRole('button', { name: 'Cancel retry', exact: true })).toHaveCount(0);
});

test('a blocked model connection explains the next action without starting work', async ({ page }) => {
  await page.goto('/?recovery=blocked');
  const card = page.getByRole('region', { name: 'Agent activity' });
  await expect(card).toContainText('Reconnect Nous Portal in Settings before retrying.');
  await expect(card.getByRole('button', { name: 'Retry task', exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Run now', exact: true })).toHaveCount(0);
});

test('Run now can report no eligible work and stays absent on a completed trace', async ({ page }) => {
  await page.goto('/?recovery=idle');
  const card = page.getByRole('region', { name: 'Agent activity' });
  await card.getByRole('button', { name: 'Run now', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Checking work…' })).toBeDisabled();
  await expect(card.getByRole('status')).toHaveText('Idle');
  await expect(card).toContainText('No eligible pending work right now.');
  await card.getByRole('button', { name: 'View trace →', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Automated partner screening · Hermes Agent · work' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run now', exact: true })).toHaveCount(0);
});

test('recovery controls fit a narrow pane and stay still with reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?recovery=retry_scheduled');
  await page.getByRole('button', { name: /Hide Iris/ }).first().click();
  const card = page.getByRole('region', { name: 'Agent activity' });
  await expect(card.getByRole('button', { name: 'Retry task', exact: true })).toBeVisible();
  expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await card.locator('.agent-recovery').evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length)).toBe(0);
  await page.screenshot({ path: 'qa/agent-recovery-narrow.png', fullPage: false });
});
