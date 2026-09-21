import { expect, test } from '@playwright/test';

const app = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Application' });

async function openHandoffs(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const pane = app(page);
  await pane.getByRole('tab', { name: 'Handoffs' }).click();
  return pane;
}

test('Finance sees contractor handoff and linked in-motion work', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&workflowRole=finance&seat=member');
  const pane = await openHandoffs(page);
  await expect(pane.getByRole('heading', { name: 'Contractor agreements', exact: true })).toBeVisible();
  await expect(pane.getByText('Finance', { exact: true }).first()).toBeVisible();
  await expect(pane.getByText('Maya Chen')).toBeVisible();
  await expect(pane.getByText('Alex Rivera')).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Open Inbox' })).toBeVisible();
  await expect(pane.getByText('Leah Martinez', { exact: true })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Admit' }).first()).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Submit an invoice' })).toHaveCount(0);
});

test('Partnerships sees admit actions without invoice forms', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?partnerWorkflow=1&workflowRole=partnerships&seat=admin');
  await page.getByRole('combobox', { name: 'Workspace section' }).selectOption('library');
  const pane = app(page);
  await pane.getByRole('tab', { name: 'Handoffs' }).click();
  await expect(pane.getByText('Partnerships', { exact: true }).first()).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Admit' }).first()).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Submit an invoice' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('an unrelated member receives no private workflow content', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&workflowRole=unrelated&seat=member');
  const pane = await openHandoffs(page);
  await expect(pane.getByText('No access', { exact: true })).toBeVisible();
  await expect(pane.getByText('Leah Martinez', { exact: true })).toHaveCount(0);
});

test('an admin configures and toggles the handoff', async ({ page }) => {
  await page.goto('/?workflowRole=admin&seat=admin');
  const pane = await openHandoffs(page);
  await pane.getByRole('button', { name: 'Configure roles' }).click();
  await expect(pane.getByRole('form', { name: 'Configure employee roles' })).toBeVisible();

  await page.goto('/?partnerWorkflow=1&workflowRole=admin&seat=admin');
  const configuredPane = await openHandoffs(page);
  await expect(configuredPane.getByRole('button', { name: 'Disable' })).toBeEnabled();
  await configuredPane.getByRole('button', { name: 'Disable' }).click();
  await expect(configuredPane.getByText('Not admitted', { exact: true })).toBeVisible();
  await expect(configuredPane.getByRole('button', { name: 'Enable' })).toBeEnabled();
  await configuredPane.getByRole('button', { name: 'Enable' }).click();
  await expect(configuredPane.getByText(/^Live/)).toBeVisible();
});

test('enable succeeds and shows a short notice', async ({ page }) => {
  await page.goto('/?workflowRole=admin&seat=admin&workflowActivation=success');
  const pane = await openHandoffs(page);
  await expect(pane.getByText('Not admitted', { exact: true })).toBeVisible();
  const enable = pane.getByRole('button', { name: 'Enable' });
  await expect(enable).toBeEnabled();
  await enable.click();
  await expect(pane.getByText(/^Live/)).toBeVisible();
  await expect(pane.getByText('Handoff enabled.', { exact: true })).toBeVisible();
});

for (const fixture of [
  { scenario: 'native-mismatch', label: 'native profile mismatch' },
  { scenario: 'binding-drift', label: 'post-probe role binding drift' },
] as const) {
  test(`${fixture.label} leaves activation disabled`, async ({ page }) => {
    await page.goto(`/?workflowRole=admin&seat=admin&workflowActivation=${fixture.scenario}`);
    const pane = await openHandoffs(page);
    const enable = pane.getByRole('button', { name: 'Enable' });
    await expect(enable).toBeEnabled();
    await enable.click();
    await expect(pane.getByRole('alert')).toHaveText('The native profiles did not match. The handoff remains disabled.');
    await expect(pane.getByText('Not admitted', { exact: true })).toBeVisible();
  });
}
