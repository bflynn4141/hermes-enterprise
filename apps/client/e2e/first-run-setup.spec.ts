import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';
import type { FirstRunFixtureOptions } from './first-run-fixture.js';

let fixture = '';
let styles = '';

test.beforeAll(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [result, baseStyles, setupStyles] = await Promise.all([
    build({ entryPoints: [fileURLToPath(new URL('./first-run-fixture.tsx', import.meta.url))], bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { __AUTH_MODE__: '"workos"', __MOCK__: 'false', 'process.env.NODE_ENV': '"production"' } }),
    fs.readFile(`${root}/src/styles.css`, 'utf8'),
    fs.readFile(`${root}/src/app/onboarding/FirstRunSetup.css`, 'utf8'),
  ]);
  fixture = result.outputFiles[0]!.text;
  styles = `${baseStyles}\n${setupStyles}`;
});

async function mount(page: Page, options: FirstRunFixtureOptions = {}) {
  await page.route('https://first-run.test/**', (route) => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body><div id="root"></div></body></html>` }));
  await page.goto('https://first-run.test/');
  await page.addScriptTag({ content: fixture });
  await page.evaluate((value) => window.firstRunFixture.mount(value), options);
  await expect(page.getByRole('heading', { name: 'Activate Iris' })).toBeVisible();
}

async function reachReady(page: Page) {
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Partner criteria').fill('Developer-tool founders using open models in North America.');
  await page.getByRole('button', { name: 'Use these criteria' }).click();
  await page.getByRole('button', { name: 'Confirm and continue' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Inbox' })).toHaveAttribute('aria-current', 'step');
}

test('the invitee sees only Partner Program Iris and saves real criteria', async ({ page }) => {
  await mount(page);
  await expect(page.getByText('Your organization has assigned you Iris.')).toBeVisible();
  await expect(page.getByText(/choose (a )?(role|workflow)/i)).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Partner criteria').fill('Developer-tool founders using open models in North America.');
  await page.getByRole('button', { name: 'Use these criteria' }).click();
  await page.getByRole('button', { name: 'Change reviewers' }).click();
  await page.getByLabel('Reviewer for Send an external message').selectOption('Workspace admin');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  const saved = await page.evaluate(() => window.firstRunFixture.calls.findLast((call) => call.method === 'state'));
  expect(saved).toMatchObject({ step: 'ready', agreement: { readyForWork: true, inputs: 'Developer-tool founders using open models in North America.' } });
});

test('assignment progress is generic and never exposes Cloud or Admin bootstrap', async ({ page }) => {
  await mount(page, { irisStatus: 'getting_ready' });
  await reachReady(page);
  await expect(page.getByText('Getting Iris ready', { exact: true })).toBeVisible();
  await expect(page.getByText(/Cloud|Admin bootstrap|wallet/i)).toHaveCount(0);
  await page.evaluate(() => window.firstRunFixture.setIrisStatus('retrying'));
  await expect(page.getByText(/taking longer than expected/)).toBeVisible();
  await page.evaluate(() => window.firstRunFixture.setIrisStatus('ready'));
  await page.getByRole('button', { name: 'Open Inbox' }).click();
  expect(await page.evaluate(() => window.firstRunFixture.calls.at(-1)?.method)).toBe('open-inbox');
});

for (const width of [1440, 900]) {
  test(`activation remains usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, { reduceMotion: true });
    await page.getByRole('button', { name: 'Continue' }).click();
    const [conversation, agreement, overflow] = await Promise.all([
      page.getByRole('region', { name: 'Activation with Iris' }).boundingBox(),
      page.getByRole('complementary', { name: 'Working agreement' }).boundingBox(),
      page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    ]);
    expect(conversation).not.toBeNull();
    expect(agreement).not.toBeNull();
    expect(conversation!.x + conversation!.width).toBeLessThanOrEqual(agreement!.x + 1);
    expect(overflow).toBe(false);
  });
}
