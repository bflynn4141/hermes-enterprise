import { expect, test, type Page } from '@playwright/test';
import { expectAdminPage, openAdminPage } from './admin-nav.js';

// Admin → Roles against the mock backend. The mock mirrors the server: five
// built-in roles, membership kept as role slugs on members, agents taken from
// the Partnerships and Finance bindings, and the signed-in Admin unable to add
// or remove themself.
const app = (page: Page) => page.getByRole('region', { name: 'Application' });
const shots = process.env.ADMIN_ROLES_SCREENSHOTS;

test('an Admin sees the built-in roles with who holds them and which agents work in them', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/?workflowActivation=success#admin/Roles');
  const pane = app(page);
  await expectAdminPage(page, 'Roles');
  await expect(pane.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();

  const list = pane.getByRole('list', { name: 'Roles' });
  await expect(list.getByRole('listitem')).toHaveCount(5);
  await expect(list.getByRole('button').nth(0)).toContainText('Partnerships');
  await expect(list.getByRole('button').nth(1)).toContainText('Finance');
  const partnerships = list.getByRole('button', { name: /^Partnerships/ });
  await expect(partnerships).toContainText('People Maya Chen');
  await expect(partnerships).toContainText('Agents Iris · Maya Chen');
  const finance = list.getByRole('button', { name: /^Finance/ });
  await expect(finance).toContainText('Reviews invoices and agreements handed over from Partnerships, and confirms payments.');
  await expect(finance).toContainText('People Alex Rivera');
  await expect(finance).toContainText('Agents Ledger · Alex Rivera');
  await expect(list.getByRole('button', { name: /^Legal/ })).toContainText('People No one yet');
  if (shots) await page.screenshot({ path: `${shots}/admin-roles-list.png`, fullPage: true });

  // A built-in keeps its name; its description can change.
  await finance.click();
  await expect(page).toHaveURL(/#admin\/Roles\/[0-9a-f-]+$/);
  await expect(pane.getByRole('heading', { name: 'Finance', exact: true })).toBeVisible();
  const details = pane.getByRole('region', { name: 'Details' });
  await expect(details.getByLabel('Name')).toHaveCount(0);
  await details.getByLabel('Description').fill('Reviews invoices from Partnerships and confirms payments.');
  await details.getByRole('button', { name: 'Save' }).click();
  await expect(details.getByRole('status')).toHaveText('Saved.');
  await expect(pane.getByRole('region', { name: 'Agents' })).toContainText('Ledger');
  await expect(pane.getByRole('region', { name: 'Agents' })).toContainText('Works for Alex Rivera');
  await expect(pane.getByRole('region', { name: 'Delete role' })).toHaveCount(0);
  if (shots) await page.screenshot({ path: `${shots}/admin-roles-builtin.png`, fullPage: true });

  // Narrow: the rows and the checklist still read at phone width.
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(pane.getByRole('region', { name: 'People' }).getByRole('checkbox', { name: 'Alex Rivera' })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/admin-roles-narrow.png` });
});

test('an Admin creates a role, gives it to someone, and deletes it once it is empty', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/#admin/Roles');
  const pane = app(page);
  await pane.getByRole('button', { name: 'New role' }).click();
  const dialog = page.getByRole('dialog', { name: 'New role' });
  await dialog.getByLabel('Name').fill('Vendor review');
  await dialog.getByLabel('Description').fill('Checks new vendors before their first order.');
  await dialog.getByRole('button', { name: 'Create role' }).click();

  await expect(pane.getByRole('heading', { name: 'Vendor review', exact: true })).toBeVisible();
  const people = pane.getByRole('region', { name: 'People' });
  const you = people.getByRole('checkbox', { name: /Maya Chen/ });
  await expect(you).toBeDisabled();
  await expect(people).toContainText('Another Admin changes your own roles.');
  await people.getByRole('checkbox', { name: 'Alex Rivera' }).check();
  await people.getByRole('button', { name: 'Save' }).click();
  await expect(people.getByRole('status')).toHaveText('Saved.');
  const remove = pane.getByRole('region', { name: 'Delete role' });
  await expect(remove.getByRole('button', { name: 'Delete role' })).toBeDisabled();
  if (shots) await page.screenshot({ path: `${shots}/admin-roles-detail.png`, fullPage: true });

  await pane.getByRole('button', { name: '← Roles' }).click();
  const list = pane.getByRole('list', { name: 'Roles' });
  await expect(list.getByRole('button').last()).toContainText('Vendor review');
  await expect(list.getByRole('button', { name: /^Vendor review/ })).toContainText('People Alex Rivera');

  // Members shows each person's roles by name.
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  const alex = pane.getByRole('listitem').filter({ hasText: 'Alex Rivera' });
  await expect(alex).toContainText('Finance, Vendor review');
  await expect(pane.getByRole('listitem').filter({ hasText: 'Maya Chen' })).toContainText('Partnerships, Access reviewer');
  if (shots) await page.screenshot({ path: `${shots}/members-roles.png` });

  // Back through the app, not a reload: the mock's state lives in the page.
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await openAdminPage(page, 'Roles');
  await pane.getByRole('list', { name: 'Roles' }).getByRole('button', { name: /^Vendor review/ }).click();
  await people.getByRole('checkbox', { name: 'Alex Rivera' }).uncheck();
  await people.getByRole('button', { name: 'Save' }).click();
  await expect(people.getByRole('status')).toHaveText('Saved.');
  await remove.getByRole('button', { name: 'Delete role' }).click();
  await expect(remove).toContainText('Delete Vendor review?');
  await remove.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(pane.getByRole('heading', { name: 'Roles', exact: true })).toBeVisible();
  await expect(pane.getByRole('list', { name: 'Roles' }).getByRole('listitem')).toHaveCount(5);
});

test('a role change without a recent sign-in offers one and keeps the draft', async ({ page }) => {
  await page.goto('/?roles=stepup#admin/Roles');
  const pane = app(page);
  await pane.getByRole('list', { name: 'Roles' }).getByRole('button', { name: /^Legal/ }).click();
  const people = pane.getByRole('region', { name: 'People' });
  await people.getByRole('checkbox', { name: 'Alex Rivera' }).check();
  await people.getByRole('button', { name: 'Save' }).click();
  await expect(people.getByRole('alert')).toContainText('Changing roles needs a recent sign-in.');
  await expect(people.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await expect(people.getByRole('checkbox', { name: 'Alex Rivera' })).toBeChecked();
});

test('a Member has no Roles page and sees no role names on member cards', async ({ page }) => {
  await page.goto('/?seat=member#admin/Roles');
  const pane = app(page);
  await expect(pane.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(pane.getByRole('list', { name: 'Roles' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await expect(pane.getByRole('listitem').filter({ hasText: 'Alex Rivera' })).toBeVisible();
  await expect(pane.locator('.member-card-roles')).toHaveCount(0);
});
