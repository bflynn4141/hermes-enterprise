import { expect, test } from '@playwright/test';

const app = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Application' });

async function openHandoffs(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const pane = app(page);
  await pane.getByRole('tab', { name: 'Handoffs' }).click();
  return pane;
}

test('Finance sees the chain and only admitted partners', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&workflowRole=finance&seat=member');
  const pane = await openHandoffs(page);
  await expect(pane.getByRole('heading', { name: 'Contractor agreements', exact: true })).toBeVisible();
  await expect(pane.getByText('Partnerships · Maya Chen · Iris')).toBeVisible();
  await expect(pane.getByText('Finance · Alex Rivera · Ledger')).toBeVisible();
  await expect(pane.getByText('Live', { exact: true })).toBeVisible();
  await expect(pane.getByRole('switch')).toHaveCount(0);
  await expect(pane.getByText('Priya Nair', { exact: true })).toBeVisible();
  await expect(pane.getByText('Waiting on you')).toBeVisible();
  await expect(pane.getByRole('list', { name: 'Priya Nair: Decide' })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Review' })).toBeVisible();
  // Applicants Partnerships has not admitted are not handoffs yet.
  await expect(pane.getByText('Leah Martinez', { exact: true })).toHaveCount(0);
  await expect(pane.getByRole('button', { name: 'Admit' })).toHaveCount(0);
  await expect(pane.getByRole('button', { name: 'Submit an invoice' })).toHaveCount(0);
});

test('Partnerships sees admitted partners waiting on Finance', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?partnerWorkflow=1&workflowRole=partnerships&seat=admin');
  await page.getByRole('combobox', { name: 'Workspace section' }).selectOption('library');
  const pane = app(page);
  await pane.getByRole('tab', { name: 'Handoffs' }).click();
  await expect(pane.getByText('Partnerships · Maya Chen · Iris')).toBeVisible();
  await expect(pane.getByText('Priya Nair', { exact: true })).toBeVisible();
  await expect(pane.getByText('Waiting on Finance')).toBeVisible();
  await expect(pane.getByText('Leah Martinez', { exact: true })).toHaveCount(0);
  await expect(pane.getByRole('button', { name: 'Submit an invoice' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('admitting an applicant in Inbox adds them to Handoffs', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&workflowRole=partnerships&seat=admin');
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  const pane = app(page);
  await pane.getByText('Leah Martinez', { exact: true }).first().click();
  await pane.getByRole('button', { name: 'Admit Leah' }).click();
  await expect(pane.getByRole('button', { name: 'Admit Leah' })).toHaveCount(0, { timeout: 10_000 });
  // The receipt shows the baton passing to Finance.
  const handed = pane.getByRole('status', { name: 'Handed to Finance' });
  await expect(handed).toContainText("Ledger is preparing Leah's contractor agreement for Alex Rivera.");
  await expect(handed.getByRole('list', { name: /^Leah Martinez:/ })).toBeVisible();
  await handed.getByRole('button', { name: 'Open Handoffs' }).click();
  const handoffs = app(page);
  await expect(handoffs.getByText('Leah Martinez', { exact: true })).toBeVisible();
  await expect(handoffs.getByText('Owen Reilly', { exact: true })).toHaveCount(0);
});

test('Finance sees where an agreement came from', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&workflowRole=finance&seat=member');
  const pane = await openHandoffs(page);
  await pane.getByRole('button', { name: 'Review' }).click();
  await expect(pane.getByRole('heading', { name: /^Agreement AGR-PRIYA-001/ })).toBeVisible();
  await expect(pane.getByText(/^Admitted by Maya Chen · via Iris/)).toBeVisible();
  await pane.getByRole('button', { name: 'Open application' }).click();
  await expect(pane.getByRole('heading', { name: 'Priya Nair' })).toBeVisible();
});

test('an unrelated member receives no private workflow content', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&workflowRole=unrelated&seat=member');
  const pane = await openHandoffs(page);
  await expect(pane.getByText('No access', { exact: true })).toBeVisible();
  await expect(pane.getByText('Priya Nair', { exact: true })).toHaveCount(0);
});

test('an admin configures and toggles the handoff', async ({ page }) => {
  await page.goto('/?workflowRole=admin&seat=admin');
  const pane = await openHandoffs(page);
  await pane.getByRole('button', { name: 'Configure roles' }).click();
  await expect(pane.getByRole('form', { name: 'Configure employee roles' })).toBeVisible();

  await page.goto('/?partnerWorkflow=1&workflowRole=admin&seat=admin');
  const configuredPane = await openHandoffs(page);
  const live = configuredPane.getByRole('switch', { name: 'Handoff live' });
  await expect(live).toBeChecked();
  await live.click();
  await expect(live).not.toBeChecked();
  await expect(configuredPane.getByText('Handoff disabled.', { exact: true })).toBeVisible();
  await live.click();
  await expect(live).toBeChecked();
});

test('enable succeeds and shows a short notice', async ({ page }) => {
  await page.goto('/?workflowRole=admin&seat=admin&workflowActivation=success');
  const pane = await openHandoffs(page);
  const live = pane.getByRole('switch', { name: 'Handoff live' });
  await expect(live).not.toBeChecked();
  await expect(pane.getByText('Not ready', { exact: true })).toBeVisible();
  await live.click();
  await expect(live).toBeChecked();
  await expect(pane.getByText('Handoff enabled.', { exact: true })).toBeVisible();
});

for (const fixture of [
  { scenario: 'native-mismatch', label: 'native profile mismatch' },
  { scenario: 'binding-drift', label: 'post-probe role binding drift' },
] as const) {
  test(`${fixture.label} leaves activation disabled`, async ({ page }) => {
    await page.goto(`/?workflowRole=admin&seat=admin&workflowActivation=${fixture.scenario}`);
    const pane = await openHandoffs(page);
    const live = pane.getByRole('switch', { name: 'Handoff live' });
    await expect(live).not.toBeChecked();
    await live.click();
    await expect(pane.getByRole('alert')).toHaveText('The native profiles did not match. The handoff remains disabled.');
    await expect(live).not.toBeChecked();
  });
}
