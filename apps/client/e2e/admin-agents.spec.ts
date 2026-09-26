import { expect, test, type Page } from '@playwright/test';

// Admin → Agents against the mock backend. The mock mirrors the server's
// boundary: an Admin can change a member agent's skills and approval switches,
// and sees none of that agent's conversations or waiting actions.
const app = (page: Page) => page.getByRole('region', { name: 'Application' });
const shots = process.env.ADMIN_AGENTS_SCREENSHOTS;

test('an Admin sees every agent and governs a member agent without its conversations', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/#admin/All%20agents');
  const pane = app(page);
  const adminNav = pane.getByRole('navigation', { name: 'Admin settings' });
  await expect(adminNav.getByRole('button', { name: 'All agents', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(pane.getByRole('heading', { name: 'Agents', exact: true })).toBeVisible();

  const list = pane.getByRole('list', { name: 'Agents' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('button', { name: /^Iris/ })).toContainText('Maya Chen · No role · Partner program screening · Hermes Cloud · hermes-pool-03');
  const ledgerRow = list.getByRole('button', { name: /^Ledger/ });
  await expect(ledgerRow).toContainText('Alex Rivera · No role · Partner invoice review · Hermes Cloud · hermes-pool-04');
  await expect(ledgerRow).toContainText('Active');
  if (shots) await page.screenshot({ path: `${shots}/admin-agents-list.png`, fullPage: true });

  await ledgerRow.click();
  await expect(page).toHaveURL(/#admin\/All%20agents\/[0-9a-f-]+$/);
  await expect(pane.getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();
  await expect(pane.getByText('Its conversations and waiting actions stay with Alex Rivera.')).toBeVisible();
  await expect(pane.getByText('Private to Alex Rivera', { exact: true })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/admin-agents-detail-top.png` });

  const approval = pane.getByRole('region', { name: 'Human approval' });
  const toggle = approval.getByRole('switch', { name: 'Require human approval: Prepare drafts' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(approval.getByText('Actions already waiting for approval are part of Ledger’s work, so they are not shown here.')).toBeVisible();
  await expect(approval.getByRole('region', { name: 'Actions waiting for approval' })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(approval.getByRole('status')).toHaveText('Saved');

  const skills = pane.getByRole('region', { name: 'Skills' });
  await skills.getByRole('button', { name: 'Configure' }).click();
  await skills.getByLabel('Status').selectOption('paused');
  await skills.getByRole('button', { name: 'Save revision' }).click();
  await expect(pane.getByText('Skill saved.')).toBeVisible();
  await expect(skills.getByText('Finance · 1.0.1 · Paused')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/admin-agents-detail.png`, fullPage: true });

  await pane.getByRole('button', { name: '← All agents' }).click();
  await expect(list.getByRole('button', { name: /^Ledger/ })).toContainText('Partner invoice review (paused)');

  // Narrow: the rows stack instead of squeezing the facts.
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(list.getByRole('button', { name: /^Ledger/ })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/admin-agents-narrow.png` });
});

test('a Member has no Agents directory', async ({ page }) => {
  await page.goto('/?seat=member#admin/All%20agents');
  const pane = app(page);
  await expect(pane.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(pane.getByRole('list', { name: 'Agents' })).toHaveCount(0);
});

test('roles are chosen by name, one person and one agent per team', async ({ page }) => {
  await page.goto('/?workflowRole=admin&seat=admin');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const pane = app(page);
  await pane.getByRole('tab', { name: 'Handoffs' }).click();
  await pane.getByRole('button', { name: 'Configure roles' }).click();
  const form = pane.getByRole('form', { name: 'Configure employee roles' });
  await expect(form.getByRole('textbox')).toHaveCount(0);
  const partnershipsPerson = form.getByLabel('Partnerships person');
  await expect(partnershipsPerson.locator('option:checked')).toHaveText('Maya Chen');
  await expect(form.getByLabel('Partnerships agent').locator('option:checked')).toHaveText('Iris · Maya Chen');

  const save = form.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();
  await form.getByLabel('Finance person').selectOption({ label: 'Maya Chen' });
  await form.getByLabel('Finance agent').selectOption({ label: 'Ledger · Alex Rivera' });
  await expect(form.getByRole('alert')).toHaveText('Partnerships and Finance need different people.');
  await expect(save).toBeDisabled();
  await form.getByLabel('Finance person').selectOption({ label: 'Alex Rivera' });
  await expect(form.getByRole('alert')).toHaveCount(0);
  if (shots) await form.screenshot({ path: `${shots}/role-pickers.png` });
  await save.click();
  await expect(pane.getByText('Roles saved.')).toBeVisible();
});
