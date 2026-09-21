import { expect, test } from '@playwright/test';

const app = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Application' });
const HANDOFF_TITLE = 'Contractor agreements · Partnerships → Finance';

async function openHandoffs(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const pane = app(page);
  await pane.getByRole('tab', { name: 'Handoffs' }).click();
  return pane;
}

test('Finance opens the contractor-agreements handoff and reviews agreements from Inbox', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&workflowRole=finance&seat=member');
  const pane = await openHandoffs(page);
  await expect(pane.getByRole('heading', { name: HANDOFF_TITLE, exact: true })).toBeVisible();
  await expect(pane.getByText('You are Finance', { exact: true })).toBeVisible();
  await expect(pane.getByText('Maya Chen', { exact: true })).toBeVisible();
  await expect(pane.getByText('Iris', { exact: true })).toBeVisible();
  await expect(pane.getByText('Alex Rivera', { exact: true })).toBeVisible();
  await expect(pane.getByText('Ledger', { exact: true })).toBeVisible();
  await expect(pane.getByText('Ready', { exact: true })).toHaveCount(2);
  await expect(pane.getByText('Admitted partner', { exact: true })).toBeVisible();
  await expect(pane.getByText('Contractor agreement draft', { exact: true })).toBeVisible();
  await expect(pane.getByRole('heading', { name: 'How one contractor agreement moves', exact: true })).toBeVisible();
  await expect(pane.getByText('Nothing in motion yet', { exact: true })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Review agreements in Inbox' })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Submit an invoice' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Robin Studio · invoice source' })).toHaveCount(0);
  await page.screenshot({ path: 'qa/multi-party-finance-desktop.png', fullPage: true });
});

test('Partnerships opens the handoff and reviews applicants from Inbox', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?partnerWorkflow=1&workflowRole=partnerships&seat=admin');
  await page.getByRole('combobox', { name: 'Workspace section' }).selectOption('library');
  const pane = app(page);
  await pane.getByRole('tab', { name: 'Handoffs' }).click();
  await expect(pane.getByText('You are Partnerships', { exact: true })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Review applicants in Inbox' })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Open agreements' })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Submit an invoice' })).toHaveCount(0);
  await expect(pane.getByRole('button', { name: 'Correct invoice' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'qa/multi-party-partnerships-narrow.png', fullPage: true });
});

test('an unrelated member receives no private workflow ids or content', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&workflowRole=unrelated&seat=member');
  const pane = await openHandoffs(page);
  await expect(pane.getByText('No handoff access', { exact: true })).toBeVisible();
  await expect(pane.getByText('No Partnerships or Finance work assigned', { exact: true })).toBeVisible();
  await expect(pane.getByText('INV-SAMPLE-014', { exact: true })).toHaveCount(0);
  await expect(pane.getByText('Robin Studio', { exact: true })).toHaveCount(0);
});

test('an admin sees actionable native profile setup without a fake role switch', async ({ page }) => {
  await page.goto('/?workflowRole=admin&seat=admin');
  const pane = await openHandoffs(page);
  await expect(pane.getByText('Configure both employee role templates to create this handoff.', { exact: true })).toBeVisible();
  await pane.getByRole('button', { name: 'Configure roles' }).click();
  await expect(pane.getByRole('form', { name: 'Configure employee roles' })).toBeVisible();

  await page.goto('/?partnerWorkflow=1&workflowRole=admin&seat=admin');
  const configuredPane = await openHandoffs(page);
  await expect(configuredPane.getByRole('button', { name: 'Disable handoff' })).toBeEnabled();
  await configuredPane.getByRole('button', { name: 'Disable handoff' }).click();
  await expect(configuredPane.getByText(/Not admitted/)).toBeVisible();
  await expect(configuredPane.getByRole('button', { name: 'Verify and enable' })).toBeEnabled();
  await configuredPane.getByRole('button', { name: 'Verify and enable' }).click();
  await expect(configuredPane.getByText(/Live · admitted/)).toBeVisible();
});

test('an admin can verify and enable configured roles before readiness has been saved', async ({ page }) => {
  await page.goto('/?workflowRole=admin&seat=admin&workflowActivation=success');
  const pane = await openHandoffs(page);
  await expect(pane.getByText(/Not admitted/)).toBeVisible();
  const enable = pane.getByRole('button', { name: 'Verify and enable' });
  await expect(enable).toBeEnabled();
  await enable.click();
  await expect(pane.getByText(/Live · admitted/)).toBeVisible();
  await expect(pane.getByText('Contractor agreements is enabled for new governed work.', { exact: true })).toBeVisible();
});

for (const fixture of [
  { scenario: 'native-mismatch', label: 'native profile mismatch' },
  { scenario: 'binding-drift', label: 'post-probe role binding drift' },
] as const) {
  test(`${fixture.label} leaves first activation safely disabled`, async ({ page }) => {
    await page.goto(`/?workflowRole=admin&seat=admin&workflowActivation=${fixture.scenario}`);
    const pane = await openHandoffs(page);
    const enable = pane.getByRole('button', { name: 'Verify and enable' });
    await expect(enable).toBeEnabled();
    await enable.click();
    await expect(pane.getByRole('alert')).toHaveText('The native profiles did not match the reviewed role bindings, versions, tools, and provider attestations. The workflow remains disabled.');
    await expect(pane.getByText(/Not admitted/)).toBeVisible();
    await expect(enable).toBeEnabled();
  });
}
