import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';
import type { SampleRunView } from '../src/app/onboarding/FirstRunSampleRun.js';

let fixture = '';
let styles = '';

test.beforeAll(async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [result, baseStyles, setupStyles] = await Promise.all([
    build({
      entryPoints: [fileURLToPath(new URL('./sample-run-fixture.tsx', import.meta.url))],
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

const start: SampleRunView = { phase: 'starting', snapshot: null, message: null };
const run = (applications: NonNullable<SampleRunView['snapshot']>['applications'], phase: SampleRunView['phase'] = 'running'): SampleRunView => ({
  phase,
  message: null,
  snapshot: { runId: 'sample-run', status: phase === 'complete' ? 'completed' : 'running', applications, events: [], cursor: '1', error: null, nextPollMs: 1_200 },
});

const received = { id: 'owen', requestId: null, name: 'Owen Reilly', detail: 'Developer educator', status: 'received' as const, summary: null, evidence: [], sources: [] };
const researching = { id: 'leah', requestId: null, name: 'Leah Martinez', detail: 'Community operator', status: 'researching' as const, summary: null, evidence: [], sources: [] };
const ready = {
  ...received,
  status: 'needs_review' as const,
  summary: 'Created a sample FDE bootcamp and documented repeatable onboarding.',
  evidence: [{ id: 'e1', claim: 'Sample materials show a structured operator curriculum.', sourceIds: ['github'] }],
  sources: [{ id: 'github', label: 'GitHub', url: null }],
};

async function mount(page: Page, view: SampleRunView = start, reduceMotion = false) {
  await page.route('https://sample-run.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head><body><div id="root"></div></body></html>`,
  }));
  await page.goto('https://sample-run.test/');
  await page.addScriptTag({ content: fixture });
  await page.evaluate(({ state, reduced }) => window.sampleRunFixture.mount(state, reduced), { state: view, reduced: reduceMotion });
  await expect(page.getByRole('region', { name: 'Sample Partner Program applications' })).toBeVisible();
}

test('the Inbox count follows persisted review state rather than discovery', async ({ page }) => {
  await mount(page);
  await expect(page.getByText('Looking for sample applications')).toBeVisible();
  await expect(page.getByLabel('0 applications need review')).toBeVisible();

  await page.evaluate((view) => window.sampleRunFixture.setView(view), run([received]));
  await expect(page.getByText('Owen Reilly', { exact: true })).toBeVisible();
  await expect(page.getByText('Received', { exact: true })).toBeVisible();
  await expect(page.getByLabel('0 applications need review')).toBeVisible();

  await page.evaluate((view) => window.sampleRunFixture.setView(view), run([received, researching]));
  await expect(page.getByText('Iris is reviewing sample evidence.')).toBeVisible();
  await expect(page.getByLabel('0 applications need review')).toBeVisible();

  await page.evaluate((view) => window.sampleRunFixture.setView(view), run([ready, researching]));
  await expect(page.getByLabel('1 applications need review')).toBeVisible();
  await expect(page.getByText('Created a sample FDE bootcamp')).toBeVisible();
  await expect(page.getByText('Sample · GitHub')).toBeVisible();

  await page.evaluate((view) => window.sampleRunFixture.setView(view), run([ready, { ...researching, status: 'needs_review', summary: 'Built a sample community program.' }], 'complete'));
  await expect(page.getByLabel('2 applications need review')).toBeVisible();
  await page.getByRole('button', { name: /Review in Inbox/ }).click();
  expect(await page.evaluate(() => window.sampleRunFixture.calls)).toEqual(['open-inbox']);
});

for (const width of [1440, 900]) {
  test(`the live application surface remains readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mount(page, run([ready, researching]), true);
    await expect(page.getByText('no provider, web search, outreach, or decisions')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
    const cards = await page.locator('.first-run-application').all();
    expect(cards).toHaveLength(2);
  });
}
