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
    build({
      entryPoints: [fileURLToPath(new URL('./first-run-fixture.tsx', import.meta.url))],
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      define: { __AUTH_MODE__: '"workos"', __MOCK__: 'false', 'process.env.NODE_ENV': '"production"' },
    }),
    fs.readFile(`${root}/src/styles.css`, 'utf8'),
    fs.readFile(`${root}/src/app/onboarding/FirstRunSetup.css`, 'utf8'),
  ]);
  fixture = result.outputFiles[0]!.text;
  styles = `${baseStyles}\n${setupStyles}`;
});

async function mount(page: Page, options: FirstRunFixtureOptions = {}) {
  await page.route('https://first-run.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto('https://first-run.test/');
  await page.addScriptTag({ content: fixture });
  await page.evaluate((value) => window.firstRunFixture.mount(value), options);
  await expect(page.getByRole('heading', { name: 'Set up Iris' })).toBeVisible();
}

async function reachTest(page: Page) {
  await page.getByRole('button', { name: 'Partner Program' }).click();
  await page.getByRole('button', { name: 'Screen partner applications' }).click();
  await page.getByRole('button', { name: 'Use this loop' }).click();
  await page.getByRole('button', { name: 'Yes' }).click();
  await expect(page.getByRole('listitem').filter({ hasText: 'Test' })).toHaveAttribute('aria-current', 'step');
}

test('Iris speaks first and the Partner Program answers build a truthful agreement', async ({ page }) => {
  await mount(page);
  await expect(page.getByText('Let’s set up the work you want me to repeat. What do you own?')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Working agreement' }).getByText('Set after you answer')).toHaveCount(4);

  await page.getByRole('button', { name: 'Partner Program' }).click();
  await expect(page.getByText('Which loop should I run first?')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Working agreement' }).getByText('Support Partner Program')).toBeVisible();

  await page.getByRole('button', { name: 'Screen partner applications' }).click();
  await expect(page.getByLabel('Proposed work loop')).toContainText('Evidence brief');
  await expect(page.getByRole('complementary', { name: 'Working agreement' }).getByText('Find strong Hermes partners')).toBeVisible();

  await page.getByRole('button', { name: 'Use this loop' }).click();
  await expect(page.getByLabel('Review boundaries')).toContainText('Sign an agreement or pay an invoice');
  await expect(page.getByText('Program criteria and financial terms stay unset')).toBeVisible();

  await page.getByRole('button', { name: 'Change reviewers' }).click();
  await page.getByLabel('Reviewer for Send an external message').selectOption('Workspace admin');
  await page.getByRole('button', { name: 'Save boundaries' }).click();

  const agreement = page.getByRole('complementary', { name: 'Working agreement' });
  await expect(agreement.getByText('A person, company, or profile URL is submitted')).toBeVisible();
  await expect(agreement.getByText('Program criteria are not added yet')).toBeVisible();
  await expect(page.getByTestId('first-run-provider-slot')).toBeVisible();
  await expect(page.getByRole('link', { name: /Open Nous Portal/ })).toHaveAttribute('href', 'https://portal.nousresearch.com/api-keys');

  const ready = await page.evaluate(() => window.firstRunFixture.calls.findLast((call) => call.method === 'ready'));
  expect(ready).toMatchObject({ step: 'test', agreement: { readyForTest: true } });
  expect(ready?.agreement?.reviews.find((boundary) => boundary.id === 'external-message')?.reviewer).toBe('Workspace admin');
});

test('provider and sample states only move when their external source moves', async ({ page }) => {
  await mount(page);
  await reachTest(page);

  await page.evaluate(() => window.firstRunFixture.setProviderStatus('ready'));
  const run = page.getByRole('button', { name: /Run simulated applications/ });
  await expect(run).toBeVisible();
  await run.click();
  expect(await page.evaluate(() => window.firstRunFixture.calls.at(-1)?.method)).toBe('run-sample');
  await expect(page.getByText('Running safe sample')).toHaveCount(0);

  await page.evaluate(() => window.firstRunFixture.setSampleStatus('running', ['Application', 'Research']));
  await expect(page.getByText('Screening sample applications')).toBeVisible();
  await expect(page.getByLabel('Sample progress').locator('li.is-complete')).toHaveCount(2);

  await page.evaluate(() => window.firstRunFixture.setSampleStatus('complete'));
  await expect(page.getByText('Sample briefs are ready')).toBeVisible();
  await page.getByRole('button', { name: 'Open sample' }).click();
  expect(await page.evaluate(() => window.firstRunFixture.calls.at(-1)?.method)).toBe('open-sample');
});

for (const width of [1440, 900]) {
  test(`the split setup remains usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, { reduceMotion: true });
    await page.getByRole('button', { name: 'Partner Program' }).click();
    await page.getByRole('button', { name: 'Screen partner applications' }).click();

    const [conversation, agreement, overflow] = await Promise.all([
      page.getByRole('region', { name: 'Conversation with Iris' }).boundingBox(),
      page.getByRole('complementary', { name: 'Working agreement' }).boundingBox(),
      page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    ]);
    expect(conversation).not.toBeNull();
    expect(agreement).not.toBeNull();
    expect(conversation!.x + conversation!.width).toBeLessThanOrEqual(agreement!.x + 1);
    expect(overflow).toBe(false);
    await expect(page.getByText('Evidence brief').first()).toBeVisible();
  });
}
