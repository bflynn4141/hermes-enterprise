// The panel walk: every page, in all three panel states, at 1840 and 1440.
//
// This is the artefact the panel work is checked against. It is a rendering
// sweep rather than an assertion suite — what it proves is that no screen
// breaks when the app pane is handed the whole work area, which is the failure
// the three states introduce and the one nothing else would catch.
//
//     npx playwright test e2e/panel-screens.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { expectNoNavOverlap, setPanel, type Panel } from './panel-helpers.js';

const shot = (name: string) => ({ path: `qa/panel/${name}.png`, fullPage: false });

/** Every page in the shell, and how to get there and know it arrived. */
const PAGES: { key: string; go: (page: Page) => Promise<void>; ready: (page: Page) => Promise<void> }[] = [
  {
    key: 'overview',
    go: async (page) => void (await nav(page, 'Agents').click()),
    ready: async (page) => void (await expect(app(page).getByRole('heading', { name: 'Iris' })).toBeVisible()),
  },
  {
    key: 'context',
    go: async (page) => {
      await nav(page, 'Agents').click();
      await app(page).getByRole('tab', { name: 'Context' }).click();
    },
    ready: async (page) => void (await expect(app(page).getByText('Program sources')).toBeVisible()),
  },
  {
    key: 'skills',
    go: async (page) => {
      await nav(page, 'Agents').click();
      await app(page).getByRole('tab', { name: 'Skills' }).click();
    },
    ready: async (page) => void (await expect(app(page).getByText('Screening instructions')).toBeVisible()),
  },
  {
    key: 'traces',
    go: async (page) => {
      await nav(page, 'Agents').click();
      await app(page).getByRole('tab', { name: 'Traces' }).click();
    },
    ready: async (page) => void (await expect(app(page).getByRole('heading', { name: 'Runs' })).toBeVisible()),
  },
  {
    key: 'trace-detail',
    go: async (page) => {
      await nav(page, 'Agents').click();
      await app(page).getByRole('tab', { name: 'Traces' }).click();
      // Scoped to the view rather than the region: the app *header* carries an
      // "Open Iris" button in two of the three states, and it sorts first.
      await view(page).getByRole('button', { name: /^Open/ }).first().click();
    },
    ready: async (page) => void (await expect(app(page).getByText('Allowed tools')).toBeVisible()),
  },
  {
    key: 'inbox',
    go: async (page) => void (await nav(page, /^Inbox/).click()),
    ready: async (page) => void (await expect(app(page).getByRole('list', { name: 'Requests needing review' })).toBeVisible()),
  },
  {
    key: 'request-review',
    go: async (page) => {
      await nav(page, /^Inbox/).click();
      await app(page).getByRole('list', { name: 'Requests needing review' }).getByRole('listitem').first().click();
    },
    ready: async (page) => void (await expect(app(page).getByText('Missing evidence')).toBeVisible()),
  },
  {
    key: 'document-viewer',
    go: async (page) => {
      await nav(page, /^Inbox/).click();
      await app(page).getByRole('list', { name: 'Requests needing review' }).getByRole('listitem').nth(2).click();
    },
    ready: async (page) => void (await expect(app(page).getByText('Services delivered')).toBeVisible()),
  },
  {
    key: 'receipt',
    go: async (page) => {
      await nav(page, /^Inbox/).click();
      await app(page).getByRole('list', { name: 'Requests needing review' }).getByRole('listitem').nth(2).click();
      await app(page).getByRole('button', { name: 'Approve invoice' }).click();
    },
    ready: async (page) => void (await expect(app(page).getByText('What this implies')).toBeVisible()),
  },
  {
    key: 'history',
    go: async (page) => void (await nav(page, 'History').click()),
    ready: async (page) => void (await expect(app(page).getByRole('heading', { name: 'History' })).toBeVisible()),
  },
  {
    key: 'members',
    go: async (page) => void (await nav(page, 'Members').click()),
    ready: async (page) => void (await expect(app(page).getByRole('heading', { name: 'Members' })).toBeVisible()),
  },
  {
    key: 'library-skills',
    go: async (page) => void (await nav(page, 'Library').click()),
    ready: async (page) => void (await expect(app(page).getByRole('heading', { name: 'Library' })).toBeVisible()),
  },
  {
    key: 'library-documents',
    go: async (page) => {
      await nav(page, 'Library').click();
      await app(page).getByRole('tab', { name: 'Documents' }).click();
    },
    ready: async (page) => void (await expect(app(page).getByText('Saved documents')).toBeVisible()),
  },
  {
    key: 'library-connections',
    go: async (page) => {
      await nav(page, 'Library').click();
      await app(page).getByRole('tab', { name: 'Connections' }).click();
    },
    ready: async (page) => void (await expect(app(page).getByText(/Not available yet/).first()).toBeVisible()),
  },
  {
    key: 'library-intelligence',
    go: async (page) => {
      await nav(page, 'Library').click();
      await app(page).getByRole('tab', { name: 'Shared Intelligence' }).click();
    },
    ready: async (page) => void (await expect(app(page).getByText(/Not available yet/).first()).toBeVisible()),
  },
  {
    key: 'settings-notifications',
    go: async (page) => void (await nav(page, 'Settings').click()),
    ready: async (page) => void (await expect(app(page).getByRole('heading', { name: 'Settings' })).toBeVisible()),
  },
  {
    key: 'settings-provider-keys',
    go: async (page) => {
      await nav(page, 'Settings').click();
      await app(page).getByRole('tab', { name: 'Provider keys' }).click();
    },
    ready: async (page) => void (await expect(app(page).getByRole('heading', { name: 'Provider keys' })).toBeVisible()),
  },
  {
    key: 'settings-usage',
    go: async (page) => {
      await nav(page, 'Settings').click();
      await app(page).getByRole('tab', { name: 'Usage' }).click();
    },
    ready: async (page) => void (await expect(app(page).getByText(/Estimated, billed by your provider/)).toBeVisible()),
  },
  {
    key: 'settings-agents',
    go: async (page) => {
      await nav(page, 'Settings').click();
      await app(page).getByRole('tab', { name: 'Agents' }).click();
    },
    ready: async (page) => void (await expect(app(page).getByText('Model defaults')).toBeVisible()),
  },
  {
    key: 'settings-privacy',
    go: async (page) => {
      await nav(page, 'Settings').click();
      await app(page).getByRole('tab', { name: 'Data and privacy' }).click();
    },
    ready: async (page) => void (await expect(app(page).getByText('Processors')).toBeVisible()),
  },
];

const app = (page: Page) => page.getByRole('region', { name: 'Application' });
/** The app pane's content, below its header and subheader. */
const view = (page: Page) => page.locator('.pane-app .object-view');
/** Nav clicks are scoped: "History" is also a button inside the app pane. */
const nav = (page: Page, name: string | RegExp) => page.locator('.sidebar').getByRole('button', { name, exact: typeof name === 'string' });

test.describe.configure({ mode: 'serial' });

for (const width of [1840, 1440]) {
  for (const panel of ['open', 'rail', 'hidden'] as Panel[]) {
    test(`every page in ${panel} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto('/');
      await expect(page.locator('.shell')).toBeVisible();
      await setPanel(page, panel);
      for (const entry of PAGES) {
        await entry.go(page);
        await entry.ready(page);
        // Nothing may scroll sideways: a table wider than its pane belongs in
        // its own `.table-host`, not in the document's scroll.
        const overflow = await page.evaluate(() => {
          const pane = document.querySelector('.pane-app');
          return pane ? pane.scrollWidth - pane.clientWidth : 0;
        });
        expect(overflow, `${entry.key} overflows its pane horizontally`).toBeLessThanOrEqual(1);
        // And the navigation keeps its own column, on every page (decision C36).
        await expectNoNavOverlap(page, `${width} ${panel} ${entry.key}`);
        await page.screenshot(shot(`${width}-${panel}-${entry.key}`));
      }
    });
  }
}

test('onboarding and the shared viewer, which have no panel', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/onboarding/create');
  await expect(page.getByRole('heading', { name: 'Name your workspace' })).toBeVisible();
  await page.screenshot(shot('1840-none-onboarding-create'));
  await page.goto('/onboarding/join?token=inv_demo');
  await expect(page.getByRole('heading', { name: 'Join a workspace' })).toBeVisible();
  await page.screenshot(shot('1840-none-onboarding-join'));
  await page.goto('/shared/mock-share-token');
  await expect(page.getByText(/This is a read-only view/)).toBeVisible();
  await page.screenshot(shot('1840-none-shared-viewer'));
});

test('the rail is not shown below the pane-switch breakpoint', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/');
  await setPanel(page, 'rail');
  await expect(page.locator('.iris-rail')).toBeVisible();
  await page.setViewportSize({ width: 900, height: 1000 });
  await expect(page.locator('.iris-rail')).toHaveCount(0);
  await expectNoNavOverlap(page, '900 rail');
  // And the way back is still there.
  await expect(page.locator('.pane-app').getByRole('button', { name: /^Open Iris/ })).toBeVisible();
  await page.screenshot(shot('900-rail-narrow'));
});
