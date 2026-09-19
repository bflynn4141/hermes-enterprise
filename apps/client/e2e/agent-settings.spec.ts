import { expect, test, type Page } from '@playwright/test';

async function openTab(page: Page, name: string) {
  await expect(page.locator('.agent-tabs-navigation')).toBeVisible();
  const mobile = page.getByRole('combobox', { name: 'Agent view' });
  if (await mobile.isVisible()) await mobile.selectOption(name.toLowerCase());
  else await page.getByRole('tab', { name, exact: true }).click();
}

test('confirmed context can be added, edited, revisited and removed', async ({ page }) => {
  await page.goto('/?agentSettings=1');
  await openTab(page, 'Context');
  await page.getByRole('button', { name: '+ Add context', exact: true }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Program focus');
  await page.getByRole('textbox', { name: 'Context', exact: true }).fill('Infrastructure teams building with open models.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Note saved' })).toBeVisible();
  await openTab(page, 'Permissions');
  await openTab(page, 'Context');
  await expect(page.getByText('Infrastructure teams building with open models.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit →', exact: true }).click();
  await page.getByRole('textbox', { name: 'Context', exact: true }).fill('Developer infrastructure teams.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByText('Confirmed by Brian · Revision 2')).toBeVisible();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Remove note', exact: true }).click();
  await expect(page.getByText('No confirmed notes yet.')).toBeVisible();
});

test('approval settings contain only supported actions and persist between tabs', async ({ page }) => {
  await page.goto('/?agentSettings=1');
  await openTab(page, 'Permissions');
  const toggle = page.getByRole('switch', { name: 'Require human approval: Save review notes' });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toBeVisible();
  await expect(page.getByText(/Pay invoices|Sign agreements|Grant access/)).toHaveCount(0);
  await openTab(page, 'Context');
  await openTab(page, 'Permissions');
  await expect(toggle).toBeChecked();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
});

for (const failure of ['fail', 'conflict']) test(`failed ${failure} approval save never displays false confirmation`, async ({ page }) => {
  await page.goto(`/?agentSettings=${failure}`);
  await openTab(page, 'Permissions');
  const toggle = page.getByRole('switch', { name: 'Require human approval: Save review notes' });
  await toggle.click();
  await expect(page.getByRole('alert')).toContainText(failure === 'conflict' ? 'changed elsewhere' : 'Could not save');
  await expect(toggle).not.toBeChecked();
  await expect(page.getByRole('status').filter({ hasText: /^Saved$/ })).toHaveCount(0);
});

test('a failed note write preserves input and does not add a note', async ({ page }) => {
  await page.goto('/?agentSettings=fail');
  await openTab(page, 'Context');
  await page.getByRole('button', { name: '+ Add context', exact: true }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Keep my draft');
  await page.getByRole('textbox', { name: 'Context', exact: true }).fill('Draft context');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Your text is still here');
  await expect(page.getByRole('textbox', { name: 'Context', exact: true })).toHaveValue('Draft context');
  await expect(page.getByText('No confirmed notes yet.')).toBeVisible();
});

test('members can inspect context and permissions but cannot change them', async ({ page }) => {
  await page.goto('/?agentSettings=1&seat=member&workflowRole=partnerships');
  await openTab(page, 'Context');
  await expect(page.getByRole('button', { name: '+ Add context', exact: true })).toHaveCount(0);
  await openTab(page, 'Permissions');
  await expect(page.getByRole('switch').first()).toBeDisabled();
});

test('standing instructions save for the selected agent and survive navigation', async ({ page }) => {
  await page.goto('/?agentSettings=1');
  await openTab(page, 'Skills');
  await expect(page.getByRole('heading', { name: 'How Iris works' })).toBeVisible();
  await page.getByRole('button', { name: 'Review & edit' }).click();
  await page.getByRole('textbox', { name: 'Standing instructions' }).fill('Cite the evidence and lead with missing information.');
  await openTab(page, 'Context');
  await openTab(page, 'Skills');
  await expect(page.getByRole('textbox', { name: 'Standing instructions' })).toHaveValue('Cite the evidence and lead with missing information.');
  await page.getByRole('button', { name: 'Save instructions' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await openTab(page, 'Context');
  await openTab(page, 'Skills');
  await expect(page.getByRole('region', { name: 'Instructions for Iris', exact: true }).getByText('Cite the evidence and lead with missing information.', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'qa/agent-skills-settings-desktop.png', fullPage: true });
});

test('only extracted sources can be selected, and selection does not send a turn', async ({ page }) => {
  await page.goto('/?agentSettings=1');
  await openTab(page, 'Context');
  await expect(page.getByRole('button', { name: 'Use in conversation', exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Use in conversation', exact: true }).first().click();
  await expect(page.getByRole('status').filter({ hasText: 'Nothing has been sent' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove Partner criteria.md' })).toBeVisible();
});

test('mobile sections and reduced-motion approval switch stay usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?agentSettings=1');
  // The app pane may start behind the conversation on narrow screens.
  const appButton = page.getByRole('button', { name: 'App', exact: true });
  await expect(appButton).toBeVisible();
  await appButton.click();
  await openTab(page, 'Permissions');
  const toggle = page.getByRole('switch', { name: 'Require human approval: Save review notes' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(await toggle.locator('span').evaluate((element) => getComputedStyle(element).transitionDuration)).toBe('0s');
  expect(await page.locator('.pane-app').evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: 'qa/agent-permissions-mobile.png', fullPage: true });
});
