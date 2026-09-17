// Run only this file with E2E_BASE_URL=https://composer.test to avoid rebuilding
// the shared client dist used by a developer's live Worker.
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';
import type { ComposerFixtureOptions } from './composer-fixture.js';

let fixture = '';
const styles = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./composer-fixture.tsx', import.meta.url))],
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { __AUTH_MODE__: '"workos"', __MOCK__: 'false', 'process.env.NODE_ENV': '"production"' },
  });
  fixture = result.outputFiles[0]!.text;
});

async function mount(page: Page, options: ComposerFixtureOptions = {}) {
  await page.route('https://composer.test/**', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><html><body><div id="root"></div></body></html>',
  }));
  await page.goto('https://composer.test/');
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: fixture });
  await page.evaluate((value) => window.composerFixture.mount(value), options);
  await expect(page.getByRole('textbox', { name: 'Message Iris' })).toBeVisible();
}

test('a waiting context answer resumes the current run and clears the draft', async ({ page }) => {
  await mount(page);
  const input = page.getByRole('textbox', { name: 'Message Iris' });
  await input.fill('#partner-feedback');
  await page.locator('button.send').click();
  await expect.poll(() => page.evaluate(() => window.composerFixture.calls)).toEqual([
    { method: 'answerContext', args: ['22222222-2222-4222-8222-222222222222', 'destination', '#partner-feedback'] },
  ]);
  await expect(input).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Send context answer' })).toBeDisabled();
});

test('a refused context answer restores the draft, focuses it, and explains the refusal', async ({ page }) => {
  await mount(page, { failAnswer: true });
  const input = page.getByRole('textbox', { name: 'Message Iris' });
  await input.fill('#partner-feedback');
  await input.press('Enter');
  await expect(page.getByRole('alert')).toContainText('This question changed. Check your answer and try again.');
  await expect(input).toHaveValue('#partner-feedback');
  await expect(input).toBeFocused();
});

test('Stop remains available while a run waits for context', async ({ page }) => {
  await mount(page);
  await page.getByRole('button', { name: 'Stop work' }).click();
  await expect.poll(() => page.evaluate(() => window.composerFixture.calls)).toEqual([
    { method: 'stop', args: ['22222222-2222-4222-8222-222222222222'] },
  ]);
});

test('a waiting run without a context key receives guidance instead of a conflicting new turn', async ({ page }) => {
  await mount(page, { waitingFor: null });
  await page.getByRole('textbox', { name: 'Message Iris' }).fill('Continue with the information available.');
  await page.getByRole('button', { name: 'Send guidance' }).click();
  await expect.poll(() => page.evaluate(() => window.composerFixture.calls.map((call) => call.method))).toEqual(['guide']);
});

test('hidden provider-key details permit a server-validated turn without claiming a key is missing', async ({ page }) => {
  await mount(page, { status: 'none', keysLocked: true, keyStatus: 'none' });
  const input = page.getByRole('textbox', { name: 'Message Iris' });
  await expect(input).toBeEnabled();
  await expect(page.getByText('Connect Nous Portal in Settings to start')).toHaveCount(0);
  await input.fill('Review the application.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => page.evaluate(() => window.composerFixture.calls)).toEqual([
    { method: 'send', args: ['22222222-2222-4222-8222-222222222222', 'Review the application.'] },
  ]);
});

test('a confirmed missing key still blocks a new turn', async ({ page }) => {
  await mount(page, { status: 'none', keyStatus: 'none' });
  await expect(page.getByRole('textbox', { name: 'Message Iris' })).toBeDisabled();
  await expect(page.getByText('Connect Nous Portal in Settings to start').first()).toBeVisible();
});

test('working runs keep their guidance and follow-up controls', async ({ page }) => {
  await mount(page, { status: 'working' });
  await expect(page.getByRole('button', { name: 'Model: DeepSeek Flash' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Model: DeepSeek Flash' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Steer', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Message Iris' });
  await input.fill('Focus on references.');
  await page.getByRole('button', { name: 'Send guidance' }).click();
  await expect(input).toHaveValue('');
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await input.fill('Then summarize the evidence.');
  await page.getByRole('button', { name: 'Queue follow-up' }).click();
  await expect.poll(() => page.evaluate(() => window.composerFixture.calls.map((call) => call.method))).toEqual(['guide', 'queue']);
});

test('the send button stays at the composer bottom-right at narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 760 });
  await mount(page, { status: 'working' });
  const composer = await page.locator('.composer').boundingBox();
  const send = await page.getByRole('button', { name: 'Send guidance' }).boundingBox();
  expect(composer).not.toBeNull();
  expect(send).not.toBeNull();
  expect(Math.abs((send!.x + send!.width) - (composer!.x + composer!.width - 14))).toBeLessThanOrEqual(1);
  expect(Math.abs((send!.y + send!.height) - (composer!.y + composer!.height - 12))).toBeLessThanOrEqual(1);
});

test('the existing Local runtime selection remains intact', async ({ page }) => {
  await mount(page, { status: 'none' });
  await page.getByRole('button', { name: 'Runs on Local' }).click();
  await expect(page.getByText('Hermes Agent on this computer')).toBeVisible();
});
