import { expect, test, type Page } from '@playwright/test';

const app = (page: Page) => page.getByRole('region', { name: 'Application' });

test('role picker keeps Save visible after the consequence grows in a short desktop window', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await openMember(page);
  await app(page).getByRole('tab', { name: 'Roles & permissions' }).click();
  await app(page).getByRole('button', { name: 'Edit roles', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Edit roles', exact: true });
  await picker.getByRole('checkbox', { name: 'Access reviewer' }).check();
  await expect(picker.getByRole('button', { name: 'Save roles' })).toBeInViewport();
  const box = await picker.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(720);
  await picker.getByRole('button', { name: 'Save roles' }).click();
  await expect(picker).toHaveCount(0);
  await expect(app(page).getByRole('button', { name: 'Access reviewer', exact: true })).toBeVisible();
});
async function openMember(page: Page, name = 'Alex Rivera') {
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await app(page).getByRole('listitem').filter({ hasText: name }).getByRole('button', { name: 'Manage' }).click();
  await expect(app(page).getByRole('heading', { name, exact: true })).toBeVisible();
}

test('member sections retain identity and private agents expose governance without conversations', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?workflowActivation=success');
  await openMember(page);
  const pane = app(page);
  await expect(pane.getByRole('region', { name: 'Profile' })).toContainText('Active');
  await expect(pane.getByRole('tablist', { name: 'Member sections' }).getByRole('tab')).toHaveCount(4);
  await pane.getByRole('tab', { name: 'Agents', exact: true }).click();
  const agent = pane.getByRole('region', { name: 'Ledger', exact: true });
  await expect(agent).toContainText('Private to Alex Rivera');
  await expect(agent).toContainText('Conversations and waiting actions stay with Alex Rivera.');
  await expect(agent).toContainText('Finance');
  await expect(agent.getByRole('button', { name: /conversation|session|waiting action/i })).toHaveCount(0);
  await agent.getByRole('button', { name: 'Manage agent settings' }).click();
  await expect(pane.getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Human approval' })).toBeVisible();
  await expect(pane.getByRole('region', { name: 'Actions waiting for approval' })).toHaveCount(0);
});

test('role picker searches, previews consequences and discards a cancelled draft', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await openMember(page);
  const pane = app(page);
  await pane.getByRole('tab', { name: 'Roles & permissions' }).click();
  await pane.getByRole('button', { name: 'Edit roles', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Edit roles', exact: true });
  await expect(picker).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('member-roles-desktop.png') });
  await picker.getByRole('searchbox', { name: 'Search roles' }).fill('access');
  await expect(picker.getByRole('checkbox')).toHaveCount(1);
  await picker.getByRole('checkbox', { name: 'Access reviewer' }).check();
  await expect(picker).toContainText('Grant access to an admitted partner review added.');
  await picker.getByRole('button', { name: 'Cancel' }).click();
  await expect(picker).toHaveCount(0);
  await pane.getByRole('button', { name: 'Edit roles', exact: true }).click();
  await expect(picker.getByRole('searchbox', { name: 'Search roles' })).toHaveValue('');
  await expect(picker.getByRole('checkbox', { name: 'Access reviewer' })).not.toBeChecked();
  await expect(picker.getByRole('button', { name: 'Save roles' })).toBeDisabled();
  await picker.getByRole('button', { name: 'Cancel' }).click();
  await pane.getByRole('button', { name: '← Members' }).click();
  await expect(pane.getByRole('listitem').filter({ hasText: 'Alex Rivera' })).not.toContainText('Access reviewer');
});

test('phone member detail and role picker fit the viewport with usable actions', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#members');
  const pane = app(page);
  await pane.getByRole('listitem').filter({ hasText: 'Alex Rivera' }).getByRole('button', { name: 'Manage' }).click();
  await expect(pane.getByRole('heading', { name: 'Alex Rivera', exact: true })).toBeVisible();
  await expect(pane.getByRole('navigation', { name: 'Member details' })).toBeVisible();
  await pane.getByRole('navigation', { name: 'Member details' }).getByRole('button', { name: 'Roles & permissions' }).click();
  await pane.getByRole('button', { name: 'Edit roles', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Edit roles', exact: true });
  await picker.getByRole('checkbox', { name: 'Legal', exact: true }).check();
  await expect(picker.getByRole('button', { name: 'Save roles' })).toBeVisible();
  const box = await picker.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  expect(await picker.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
  await expect(picker).toHaveCSS('opacity', '1');
  await page.screenshot({ path: testInfo.outputPath('phone-role-picker.png') });
  await picker.getByRole('button', { name: 'Save roles' }).click();
  await expect(picker).toHaveCount(0);
  await expect(pane.getByRole('button', { name: 'Legal', exact: true })).toBeVisible();
});

test('a member can open their own detail but cannot administer roles or agents', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/?seat=member');
  await openMember(page);
  const pane = app(page);
  await expect(pane.getByRole('button', { name: 'Change role' })).toHaveCount(0);
  await expect(pane.getByRole('button', { name: 'Remove member', exact: true })).toHaveCount(0);
  await pane.getByRole('tab', { name: 'Roles & permissions' }).click();
  await expect(pane.getByText('An Admin manages roles and permissions', { exact: true })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Edit roles', exact: true })).toHaveCount(0);
  await pane.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(pane.getByText('An Admin manages agent access', { exact: true })).toBeVisible();
  await expect(pane.getByRole('button', { name: 'Manage agent settings' })).toHaveCount(0);
});
