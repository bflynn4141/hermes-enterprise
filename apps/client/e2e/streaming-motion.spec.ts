import { expect, test } from '@playwright/test';

const finalAnswer = 'Leah scores 82 of 100. Customer impact is unverified.';

test('a real stream reveals fluidly while exact tool activity remains visible', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Message Iris' }).fill('Review the newest partner application');
  await page.getByRole('button', { name: 'Send message' }).click();

  const liveTools = page.getByRole('list', { name: 'Tool activity' });
  await expect(liveTools.getByText('get_document_text', { exact: true })).toBeVisible();
  await expect(liveTools).toContainText('Reading a source document');

  const text = page.locator('.stream-text .lead-text');
  await expect(text).toBeVisible();
  const samples = await text.evaluate((element) => new Promise<string[]>((resolve) => {
    const seen: string[] = [];
    const started = performance.now();
    const sample = () => {
      const value = element.textContent ?? '';
      if (value && value !== seen.at(-1)) seen.push(value);
      if (seen.length >= 3 || performance.now() - started > 1_200) resolve(seen);
      else requestAnimationFrame(sample);
    };
    sample();
  }));
  expect(samples.length).toBeGreaterThanOrEqual(3);
  expect(samples.every((sample) => finalAnswer.startsWith(sample))).toBe(true);
  expect(samples.some((sample) => sample.length < finalAnswer.length)).toBe(true);

  await expect(page.getByText(finalAnswer, { exact: true })).toHaveCount(1);
  await expect(page.locator('.stream-text')).toHaveCount(0);
  await expect(page.getByText(/Done · 2 steps/)).toBeVisible();
});

test('reduced motion presents received text without a character loop', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Your account' }).click();
  await page.getByRole('switch', { name: 'Reduce motion' }).click();
  await page.keyboard.press('Escape');

  await page.getByRole('textbox', { name: 'Message Iris' }).fill('Review the newest partner application');
  await page.getByRole('button', { name: 'Send message' }).click();
  const stream = page.locator('.stream-text');
  await expect(stream).toContainText('Leah scores 82 of 100.');
  expect(await stream.locator('.stream-caret').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
});
