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

  // A Finance agent has a switch of its own now (C96), off until someone turns it on.
  const approval = pane.getByRole('region', { name: 'Human approval' });
  const toggle = approval.getByRole('switch', { name: 'Require human approval: Read handoff results' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(approval.getByText('Actions already waiting for approval are part of Ledger’s work, so they are not shown here.')).toBeVisible();
  await expect(approval.getByRole('region', { name: 'Actions waiting for approval' })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
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

test('an Admin renames an agent and chooses the model its new conversations start with', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/#admin/All%20agents');
  const pane = app(page);
  await pane.getByRole('list', { name: 'Agents' }).getByRole('button', { name: /^Ledger/ }).click();

  const nameCard = pane.getByRole('region', { name: 'Name' });
  const save = nameCard.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();
  await nameCard.getByLabel('Name').fill('   ');
  await expect(nameCard.getByRole('alert')).toHaveText('An agent needs a name.');
  await expect(save).toBeDisabled();
  await nameCard.getByLabel('Name').fill('Ledger Finance');
  await save.click();
  await expect(nameCard.getByRole('status')).toHaveText('Saved.');
  await expect(pane.getByRole('heading', { name: 'Ledger Finance', exact: true })).toBeVisible();

  const model = pane.getByRole('region', { name: 'Model' });
  const group = model.getByRole('radiogroup', { name: 'Model for Ledger Finance' });
  await expect(group.getByRole('menuitemradio', { name: /^Workspace default \(Anthropic: Claude Sonnet 5\)/ })).toHaveAttribute('aria-checked', 'true');
  await expect(model.getByText('New conversations start with this model. People can still change it in a conversation.')).toBeVisible();
  const saveModel = model.getByRole('button', { name: 'Save' });
  await expect(saveModel).toBeDisabled();
  await group.getByRole('menuitemradio', { name: /^Google: Gemini 3 Flash/ }).click();
  await saveModel.click();
  await expect(model.getByRole('status')).toHaveText('Saved.');
  await expect(group.getByRole('menuitemradio', { name: /^Google: Gemini 3 Flash/ })).toHaveAttribute('aria-checked', 'true');
  await expect(saveModel).toBeDisabled();
  if (shots) await page.screenshot({ path: `${shots}/admin-agents-name-model.png`, fullPage: true });

  await pane.getByRole('button', { name: '← All agents' }).click();
  await expect(pane.getByRole('list', { name: 'Agents' }).getByRole('button', { name: /^Ledger Finance/ })).toBeVisible();
});

test('an Admin removes and assigns a catalog skill on an agent without a runtime', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/?partnerWorkflow=1&agentRuntime=none#admin/All%20agents');
  const pane = app(page);
  await pane.getByRole('list', { name: 'Agents' }).getByRole('button', { name: /^Scout/ }).click();
  const skills = pane.getByRole('region', { name: 'Skills' });
  await expect(skills.getByText('Partner program screening', { exact: true })).toBeVisible();
  // Nothing new to add while the role's skill is assigned.
  await expect(skills.getByLabel('Assign a skill')).toHaveCount(0);

  await skills.getByRole('button', { name: 'Remove' }).click();
  await expect(skills.getByText('Remove Partner program screening?')).toBeVisible();
  await skills.getByRole('button', { name: 'Keep' }).click();
  await expect(skills.getByText('Partner program screening', { exact: true })).toBeVisible();
  await skills.getByRole('button', { name: 'Remove' }).click();
  await skills.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(skills.getByRole('status')).toHaveText('Skill removed.');
  await expect(skills.getByText('No skills assigned.')).toBeVisible();

  const picker = skills.getByLabel('Assign a skill');
  await expect(picker.locator('option')).toHaveText(['Partner program screening · 1.8.0']);
  await skills.getByRole('button', { name: 'Add' }).click();
  await expect(skills.getByRole('status')).toHaveText('Skill assigned.');
  await expect(skills.getByText('1.8.0 · Active')).toBeVisible();
  await expect(skills.getByLabel('Assign a skill')).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/admin-agents-skills.png`, fullPage: true });

  await pane.getByRole('button', { name: '← All agents' }).click();
  await expect(pane.getByRole('list', { name: 'Agents' }).getByRole('button', { name: /^Scout/ })).toContainText('Partner program screening · No runtime yet');
});

test('an agent whose runtime attests its skill says it needs a rebuild and offers no retry', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/#admin/All%20agents');
  const pane = app(page);
  await pane.getByRole('list', { name: 'Agents' }).getByRole('button', { name: /^Ledger/ }).click();
  const skills = pane.getByRole('region', { name: 'Skills' });
  await skills.getByRole('button', { name: 'Remove' }).click();
  await skills.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(skills.getByRole('alert')).toContainText('The runtime needs a rebuild first');
  await expect(skills.getByRole('button', { name: 'Sign in again' })).toHaveCount(0);
  await expect(skills.getByRole('button', { name: /Try again|Retry/ })).toHaveCount(0);
  await expect(skills.getByText('Partner invoice review', { exact: true })).toBeVisible();
});

test('changing an agent without a recent sign-in offers one and keeps the draft', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/?agents=stepup#admin/All%20agents');
  const pane = app(page);
  await pane.getByRole('list', { name: 'Agents' }).getByRole('button', { name: /^Ledger/ }).click();
  const nameCard = pane.getByRole('region', { name: 'Name' });
  await nameCard.getByLabel('Name').fill('Ledger Two');
  await nameCard.getByRole('button', { name: 'Save' }).click();
  await expect(nameCard.getByRole('alert')).toContainText('Changing this agent’s name needs a recent sign-in.');
  await expect(nameCard.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await expect(nameCard.getByLabel('Name')).toHaveValue('Ledger Two');
  await expect(pane.getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();

  // Narrow: the cards stack and the controls stay usable.
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(nameCard.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Model' }).getByRole('button', { name: 'Save' })).toBeVisible();
  const skills = pane.getByRole('region', { name: 'Skills' });
  await skills.getByRole('button', { name: 'Remove' }).click();
  await expect(skills.getByRole('button', { name: 'Keep' })).toBeVisible();
  if (shots) {
    await nameCard.screenshot({ path: `${shots}/admin-agents-narrow-name.png` });
    await pane.getByRole('region', { name: 'Model' }).screenshot({ path: `${shots}/admin-agents-narrow-model.png` });
    await skills.screenshot({ path: `${shots}/admin-agents-narrow-skills.png` });
  }
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
