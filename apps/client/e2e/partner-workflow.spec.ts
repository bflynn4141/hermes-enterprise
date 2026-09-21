import { expect, test } from '@playwright/test';

const RECORD_CHANGE_REQUEST = '00000000-0000-4000-8000-0000000003f0';
const app = (page: import('@playwright/test').Page) => page.getByRole('region', { name: 'Application' });
const HANDOFF_TITLE = 'Partner invoices · Partnerships → Finance';

async function openHandoffs(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const pane = app(page);
  await pane.getByRole('tab', { name: 'Handoffs' }).click();
  return pane;
}

test('Finance reviews authorized evidence, records the decision, and returns a safe acknowledgment', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&workflowRole=finance&seat=member');
  const pane = await openHandoffs(page);
  await expect(pane.getByRole('heading', { name: HANDOFF_TITLE, exact: true })).toBeVisible();
  await expect(pane.getByText('You are Finance', { exact: true })).toBeVisible();
  await expect(pane.getByText('Maya Chen', { exact: true })).toBeVisible();
  await expect(pane.getByText('Iris', { exact: true })).toBeVisible();
  await expect(pane.getByText('Alex Rivera', { exact: true })).toBeVisible();
  await expect(pane.getByText('Ledger', { exact: true })).toBeVisible();
  await expect(pane.getByText('Ready', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Robin Studio · invoice source' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Robin Studio · Finance review' })).toBeVisible();
  await expect(pane.getByRole('link', { name: 'Open source session' })).toHaveCount(0);

  const handoff = pane.locator('.handoffs-motion-row').filter({ hasText: 'ENG-SAMPLE-42' });
  await handoff.getByRole('button', { name: 'View evidence' }).click();
  await expect(handoff.getByText('Sample engagement terms.txt', { exact: true })).toBeVisible();
  await expect(handoff.getByText('INV-SAMPLE-014.pdf', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'qa/multi-party-finance-desktop.png', fullPage: true });

  await handoff.getByRole('button', { name: 'Open Finance decision' }).click();
  await expect(pane.getByRole('heading', { name: 'Your decision' })).toBeVisible();
  await expect(pane.getByText('0 of 1 Finance review', { exact: true })).toBeVisible();
  await expect(pane.getByText('Sample data', { exact: true })).toBeVisible();
  await expect(pane.getByText('Use this decision for demonstration only.', { exact: true })).toBeVisible();
  await expect(pane.getByText('Authorized workflow evidence (4 checks)', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'qa/multi-party-finance-decision.png', fullPage: true });
  await pane.getByText('Authorized workflow evidence (4 checks)', { exact: true }).click();
  await expect(pane.getByText('Sample engagement terms.txt', { exact: true })).toBeVisible();
  await expect(pane.getByText('INV-SAMPLE-014.pdf', { exact: true })).toBeVisible();
  await pane.getByRole('button', { name: 'Approve invoice draft', exact: true }).click();
  await expect(pane.getByRole('heading', { name: 'Saved in Library' })).toBeVisible();
  await expect(pane.getByText('1 of 1 Finance review', { exact: true })).toBeVisible();

  await openHandoffs(page);
  const decided = pane.locator('.handoffs-motion-row').filter({ hasText: 'ENG-SAMPLE-42' });
  await decided.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'qa/multi-party-finance-receipt.png', fullPage: true });
});

test('Partnerships corrects a mismatch from stored source and keeps the original in history', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?partnerWorkflow=1&workflowRole=partnerships&seat=admin');
  await page.getByRole('combobox', { name: 'Workspace section' }).selectOption('library');
  const pane = app(page);
  await pane.getByRole('tab', { name: 'Handoffs' }).click();
  await expect(pane.getByText('You are Partnerships', { exact: true })).toBeVisible();
  const mismatch = pane.locator('.handoffs-motion-row').filter({ hasText: 'ENG-SAMPLE-43' });
  await mismatch.getByRole('button', { name: 'Correct invoice' }).click();
  const form = pane.getByRole('form', { name: 'Correct invoice' });
  await expect(form.getByRole('radio', { name: /Sample data/ })).toBeChecked();
  await expect(form.getByRole('radio', { name: /Customer data/ })).toBeDisabled();
  await form.getByRole('spinbutton', { name: 'Amount', exact: true }).fill('800.00');
  await form.locator('input[type="file"]').setInputFiles({ name: 'corrected-invoice.txt', mimeType: 'text/plain', buffer: Buffer.from('Sample corrected invoice INV-SAMPLE-013 for USD 800.00') });
  await expect(form.getByText('corrected-invoice.txt', { exact: true })).toHaveText('corrected-invoice.txt');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Submit correction' }).click();
  await expect(pane.getByText('Correction submitted. The original review remains in history.')).toBeVisible();
  await expect(form).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'qa/multi-party-partnerships-narrow.png', fullPage: true });
});

test('Partnerships confirms invoice fields and submits the first intake without authorizing payment', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?partnerWorkflow=1&workflowRole=partnerships&seat=admin');
  const pane = await openHandoffs(page);
  await expect(pane.getByText('You are Partnerships', { exact: true })).toBeVisible();
  await pane.getByRole('button', { name: 'Submit an invoice' }).click();
  const form = pane.getByRole('form', { name: 'Submit invoice to Finance' });
  await expect(form.getByRole('radio', { name: /Sample data/ })).toBeChecked();
  await expect(form.getByRole('radio', { name: /Customer data/ })).toBeDisabled();
  await form.getByRole('textbox', { name: 'Invoice number', exact: true }).fill('INV-SAMPLE-015');
  await form.getByRole('spinbutton', { name: 'Amount', exact: true }).fill('1200.00');
  await form.locator('input[type="file"]').setInputFiles({ name: 'sample-invoice-015.txt', mimeType: 'text/plain', buffer: Buffer.from('Sample invoice INV-SAMPLE-015 for USD 1,200.00') });
  await form.getByText('sample-invoice-015.txt', { exact: true }).scrollIntoViewIfNeeded();
  await expect(form.getByText('sample-invoice-015.txt', { exact: true })).toBeVisible();
  await form.getByRole('checkbox').check();
  await expect(form.getByRole('button', { name: 'Submit invoice to Finance' })).toBeEnabled();
  await expect(form.getByText('Finance sees the confirmed fields and authorized evidence. No payment or email is sent.', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'qa/multi-party-invoice-intake.png', fullPage: true });
  await form.getByRole('button', { name: 'Submit invoice to Finance' }).click();
  await expect(pane.getByText('Invoice received. Partnerships and Finance activity will update here.')).toBeVisible();
  await expect(pane.getByText('INV-SAMPLE-015', { exact: true })).toBeVisible();
});

test('Partnerships proposes verified terms and the named Finance principal can approve the exact record change', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&workflowRole=partnerships&seat=admin&scenario=approvals');
  const pane = await openHandoffs(page);
  await pane.getByRole('button', { name: 'Record agreed terms' }).click();
  const form = pane.getByRole('form', { name: 'Record agreed engagement terms' });
  await expect(form.getByText('For demonstration only. This does not confirm an external agreement. This does not sign an agreement or authorize payment.', { exact: true })).toBeVisible();
  await expect(form.getByRole('radio', { name: /Sample data/ })).toBeChecked();
  await form.getByRole('radio', { name: /Customer data/ }).check();
  await expect(form.getByRole('button', { name: 'Send to Finance for authorization' })).toBeVisible();
  await form.getByRole('radio', { name: /Sample data/ }).check();
  await form.getByLabel('Partner').selectOption({ label: 'Robin Studio · engagement' });
  await form.getByLabel('Reference').fill('ENG-SAMPLE-42');
  await form.getByLabel('Purpose').fill('Partner enablement workshop');
  await form.getByLabel('Authorized total').fill('1200.00');
  await form.getByLabel('Permitted evidence excerpt').fill('Sample terms: one partner enablement workshop for USD 1,200.');
  await form.locator('input[type="file"]').setInputFiles({ name: 'sample-engagement-terms.txt', mimeType: 'text/plain', buffer: Buffer.from('Sample externally agreed terms for one workshop at USD 1,200.') });
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Send sample terms to Finance' }).click();
  await expect(pane.getByText('Waiting for Alex Rivera.')).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Approve change' })).toHaveCount(0);

  await page.goto(`/?partnerWorkflow=1&workflowRole=finance&seat=member&scenario=approvals#inbox/request/${RECORD_CHANGE_REQUEST}`);
  await expect(pane.getByText('Enterprise partner records', { exact: true })).toBeVisible();
  await expect(pane.getByText('Sample data', { exact: true })).toBeVisible();
  await expect(pane.getByText('For demonstration only. Approval does not confirm an external agreement.', { exact: true })).toBeVisible();
  await expect(pane.getByText('4 proposed changes', { exact: true })).toBeVisible();
  await pane.locator('details.approval-disclosure').first().locator('summary').click();
  await expect(pane.locator('p').getByText('Authorize sample Robin Studio terms for an invoice-checking demonstration.', { exact: true })).toBeVisible();
  await pane.getByRole('button', { name: 'Approve change' }).click();
  await expect(pane.getByText('approved · authorization v1', { exact: true })).toBeVisible();
});

test('native Finance execution keeps sample input provenance distinct from execution state', async ({ page }) => {
  await page.goto('/?partnerWorkflow=1&workflowRole=finance&seat=member&workflowExecution=native');
  const pane = await openHandoffs(page);
  const handoff = pane.locator('.handoffs-motion-row').filter({ hasText: 'ENG-SAMPLE-42' });
  await expect(handoff.getByText(/Sample/)).toBeVisible();
  await handoff.getByRole('button', { name: 'View evidence' }).click();
  await expect(handoff.getByText('Sample engagement terms.txt', { exact: true })).toBeVisible();
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
  await expect(pane.getByText('Partner invoices is enabled for new governed work.', { exact: true })).toBeVisible();
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
