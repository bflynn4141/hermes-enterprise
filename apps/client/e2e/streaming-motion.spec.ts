import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';
import type {} from './stream-handoff-fixture.js';

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

test('the live elapsed clock keeps the original run time after switching sessions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Message Iris' }).fill('Review the newest partner application');
  await page.getByRole('button', { name: 'Send message' }).click();

  const elapsed = page.locator('.live-run-elapsed');
  await expect(elapsed).toBeVisible();
  await expect(page.locator('.live-run-status--authoritative > [role="status"] > .font-mono')).toBeHidden();
  await expect.poll(async () => Number.parseFloat((await elapsed.textContent()) ?? '0')).toBeGreaterThanOrEqual(0.4);
  const before = Number.parseFloat((await elapsed.textContent()) ?? '0');

  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('dialog', { name: 'Sessions' }).getByRole('button', { name: /^Provider documents/ }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('dialog', { name: 'Sessions' }).getByRole('button', { name: /^Partner applications/ }).click();

  await expect(elapsed).toBeVisible();
  const after = Number.parseFloat((await elapsed.textContent()) ?? '0');
  expect(after).toBeGreaterThan(before);
});

test.describe('final handoff event ordering', () => {
  let fixture = '';
  const styles = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
  const answer = 'The first result is ready.\n\nThe second result includes all of the requested details.\n\nThe third result remains available after the response finishes.';

  test.beforeAll(async () => {
    const result = await build({
      entryPoints: [fileURLToPath(new URL('./stream-handoff-fixture.tsx', import.meta.url))],
      bundle: true, write: false, format: 'iife', jsx: 'automatic',
      define: { __AUTH_MODE__: '"workos"', __MOCK__: 'false', 'process.env.NODE_ENV': '"production"' },
    });
    fixture = result.outputFiles[0]!.text;
  });

  async function mount(page: Page, text: string, reducedMotion: boolean) {
    await page.route('https://stream-handoff.test/**', (route) => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div></body></html>',
    }));
    await page.goto('https://stream-handoff.test/');
    await page.addStyleTag({ content: styles });
    await page.addScriptTag({ content: fixture });
    await page.evaluate((options) => window.streamHandoffFixture.mount(options), { text, reducedMotion });
    await expect(page.locator('.stream-text .lead-text')).toHaveText(text.replace(/\n\n/g, ''));
  }

  for (const reducedMotion of [false, true]) {
    test(`keeps the answer visible until delayed run completion (reduced motion: ${reducedMotion})`, async ({ page }, testInfo) => {
      await mount(page, answer, reducedMotion);
      const missingFrames = await page.evaluate(async (text) => {
        window.streamHandoffFixture.finalize(text);
        let missing = 0;
        // Hold run.status back while React effects and the reveal loop finish.
        for (let frame = 0; frame < 24; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const rendered = [...document.querySelectorAll('.stream-text .lead-text, .msg-iris .lead-text')];
          if (!rendered.some((node) => node.textContent === text.replace(/\n\n/g, ''))) missing += 1;
        }
        return missing;
      }, answer);
      expect(missingFrames).toBe(0);
      expect(await page.evaluate(() => window.streamHandoffFixture.snapshot())).toEqual({ status: 'working', stream: answer, messages: ['again', answer] });
      await expect(page.locator('.msg-iris')).toHaveCount(0);
      if (!reducedMotion) await page.screenshot({ path: testInfo.outputPath('stream-handoff.png') });

      const missingHandoffFrames = await page.evaluate(async (text) => {
        window.streamHandoffFixture.terminal();
        let missing = 0;
        for (let frame = 0; frame < 12; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const rendered = [...document.querySelectorAll('.stream-text .lead-text, .msg-iris .lead-text')];
          if (!rendered.some((node) => node.textContent === text.replace(/\n\n/g, ''))) missing += 1;
        }
        return missing;
      }, answer);
      expect(missingHandoffFrames).toBe(0);
      await expect(page.locator('.stream-text')).toHaveCount(0);
      await expect(page.locator('.msg-iris .lead-text')).toHaveText(answer.replace(/\n\n/g, ''));
      await expect(page.locator('.msg-iris')).toHaveCount(1);
      if (!reducedMotion) await page.screenshot({ path: testInfo.outputPath('stream-final.png') });
    });
  }

  test('an internal provider final does not complete a tool run or become its answer', async ({ page }) => {
    const progress = 'I will check the workspace before answering.';
    await mount(page, progress, true);
    await page.evaluate((text) => window.streamHandoffFixture.finalize(text), progress);
    await expect(page.locator('.stream-text .lead-text')).toHaveText(progress);
    expect((await page.evaluate(() => window.streamHandoffFixture.snapshot())).status).toBe('working');
    await expect(page.locator('.msg-iris')).toHaveCount(0);

    await page.evaluate((text) => window.streamHandoffFixture.nextTurn(text), answer);
    await expect(page.locator('.stream-text .lead-text')).toHaveText(answer.replace(/\n\n/g, ''));
    await page.evaluate((text) => { window.streamHandoffFixture.finalize(text); window.streamHandoffFixture.terminal(); }, answer);
    await expect(page.locator('.stream-text')).toHaveCount(0);
    await expect(page.locator('.msg-iris')).toHaveCount(1);
    await expect(page.locator('.msg-iris .lead-text')).toHaveText(answer.replace(/\n\n/g, ''));
    expect((await page.evaluate(() => window.streamHandoffFixture.snapshot())).messages).toEqual(['again', progress, answer]);
  });

  test('two consecutive replies stay below their real question, with no phantom bubble after completion or remount', async ({ page }) => {
    await mount(page, 'The first reply.', true);
    await page.evaluate(() => { window.streamHandoffFixture.finalize('The first reply.'); window.streamHandoffFixture.terminal(); });
    await expect(page.locator('.stream-text')).toHaveCount(0);
    await page.evaluate((text) => window.streamHandoffFixture.sendAgain(text), answer);
    await expect(page.locator('.stream-text .lead-text')).toHaveText(answer.replace(/\n\n/g, ''));
    await expect(page.locator('.msg-user')).toHaveCount(2);
    await page.evaluate((text) => { window.streamHandoffFixture.finalize(text); window.streamHandoffFixture.terminal(); }, answer);
    await expect(page.locator('.stream-text')).toHaveCount(0);
    const expected = ['again', 'The first reply.', 'again', answer.replace(/\n\n/g, '')];
    const displayed = () => page.locator('[data-message-id]').evaluateAll((nodes) => nodes.map((node) =>
      node.classList.contains('msg-user') ? node.textContent : node.querySelector('.lead-text')?.textContent,
    ));
    expect(await displayed()).toEqual(expected);
    await expect(page.locator('.msg-iris .lead-text').last()).toBeInViewport();
    await page.evaluate(() => window.streamHandoffFixture.remount());
    expect(await displayed()).toEqual(expected);
    await expect(page.locator('.msg-iris .lead-text').last()).toBeInViewport();
  });

  test('an empty authoritative final releases its accumulator without restoring preview text', async ({ page }) => {
    await mount(page, 'An intermediate preview.', true);
    await page.evaluate(() => window.streamHandoffFixture.finalize(''));
    await expect(page.locator('.stream-text')).toHaveCount(0);
    expect((await page.evaluate(() => window.streamHandoffFixture.snapshot())).stream).toBeNull();
    await page.evaluate(() => window.streamHandoffFixture.terminal());
    await expect(page.locator('.msg-iris')).toHaveCount(0);
    await expect(page.getByText('An intermediate preview.', { exact: true })).toHaveCount(0);
  });

  test('a blocks-only final hands off to its structured answer', async ({ page }) => {
    await mount(page, 'Preparing the result.', true);
    await page.evaluate(() => window.streamHandoffFixture.finalize('', [{ type: 'note', title: 'The structured result is ready.' }]));
    await page.evaluate(() => window.streamHandoffFixture.terminal());
    await expect(page.locator('.stream-text')).toHaveCount(0);
    await expect(page.locator('.msg-iris')).toHaveCount(1);
    await expect(page.getByText('The structured result is ready.', { exact: true })).toBeVisible();
  });
});
