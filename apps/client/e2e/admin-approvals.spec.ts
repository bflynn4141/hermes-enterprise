import { expect, test, type Page } from '@playwright/test';

// Admin → Approvals against the mock backend, which mirrors the server's
// approval routes: seven rules at their defaults, the same refusals, member
// roles kept on members, and invitations that carry the roles a person gets
// when they join. Run on its own port: E2E_PORT=4231.
const app = (page: Page) => page.getByRole('region', { name: 'Application' });
const shots = process.env.ADMIN_APPROVALS_SCREENSHOTS;

/** The app pane scrolls on its own, so a tall viewport is what gets a whole page into one shot. */
async function shoot(page: Page, name: string, height = 1900): Promise<void> {
  if (!shots) return;
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${shots}/${name}.png` });
  await page.setViewportSize(size);
}

test('an Admin reads who approves what, changes Payment to three Finance people, and resets it', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/#admin/Approvals');
  const pane = app(page);
  await expect(pane.getByRole('navigation', { name: 'Admin settings' }).getByRole('button', { name: 'Approvals', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(pane.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
  await expect(pane.getByText('Who approves business decisions and the actions that follow them. This is separate from the command safety checks Hermes agents ask for.')).toBeVisible();
  await expect(pane.getByText('Changes apply to work already waiting as well as new work.')).toBeVisible();

  const decisions = pane.getByRole('list', { name: 'Decisions' });
  const actions = pane.getByRole('list', { name: 'Actions after approval' });
  await expect(decisions.getByRole('listitem')).toHaveCount(3);
  await expect(actions.getByRole('listitem')).toHaveCount(4);
  await expect(decisions.getByRole('button', { name: /^Approve an invoice draft/ })).toContainText('Invoices handed over from Partnerships also go to the Finance person on that handoff.');
  const payment = actions.getByRole('button', { name: /^Pay an approved invoice/ });
  await expect(payment).toContainText('Finance · 2 different people · Default');
  await expect(actions.getByRole('button', { name: /^Grant access/ })).toContainText('Access reviewer · Default');
  // Workflow-raised approvals are listed so nothing is hidden, and have no controls.
  const workflow = pane.getByRole('list', { name: 'Set by the workflow' });
  await expect(workflow.getByRole('listitem')).toHaveCount(4);
  await expect(workflow.getByRole('button')).toHaveCount(0);
  await expect(workflow.getByRole('listitem').filter({ hasText: 'Partner engagement record changes' })).toContainText('Reviewed by the Finance person on the handoff');
  await expect(pane.getByText('These reviewers come from the workflow that raises them and cannot be changed here yet.')).toBeVisible();
  await shoot(page, 'approvals-list');

  await payment.click();
  await expect(page).toHaveURL(/#admin\/Approvals\/payment$/);
  await expect(pane.getByRole('heading', { name: 'Pay an approved invoice', exact: true })).toBeVisible();
  const who = pane.getByRole('region', { name: 'Who can approve' });
  // A payment has an amount, so the page's one Save sits in the last card.
  const above = pane.getByRole('region', { name: 'Above an amount' });
  await expect(who.getByRole('checkbox', { name: /^Finance/ })).toBeChecked();
  await expect(who.getByRole('checkbox', { name: /^Finance/ })).toHaveAccessibleName(/Alex Rivera/);
  await expect(who.getByRole('checkbox', { name: /^Admins/ })).not.toBeChecked();
  await expect(above.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);
  await expect(above.getByRole('button', { name: 'Save' })).toBeDisabled();
  await who.getByRole('combobox', { name: 'How many different people' }).selectOption('3');
  // One Finance group: "One from each group" has nothing to choose between.
  await expect(who.getByRole('switch', { name: 'One from each group' })).toHaveCount(0);
  await expect(who.getByRole('switch', { name: 'Can the person who approved the request also do this?' })).toHaveAttribute('aria-checked', 'true');
  await above.getByRole('button', { name: 'Save' }).click();
  await expect(above.getByRole('status')).toHaveText('Saved.');
  await expect(above.getByRole('button', { name: 'Reset to default' })).toBeVisible();
  await shoot(page, 'approvals-action-rule', 1300);

  await pane.getByRole('button', { name: '← Approvals' }).click();
  await expect(payment).toContainText('Finance · 3 different people');
  await expect(payment).not.toContainText('Default');

  await payment.click();
  await above.getByRole('button', { name: 'Reset to default' }).click();
  await expect(above.getByRole('status')).toHaveText('Back to the default.');
  await expect(who.getByRole('combobox', { name: 'How many different people' })).toHaveValue('2');
  await expect(above.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);
  await pane.getByRole('button', { name: '← Approvals' }).click();
  await expect(payment).toContainText('Finance · 2 different people · Default');

  // Roles and approvals read as one system.
  await pane.getByRole('navigation', { name: 'Admin settings' }).getByRole('button', { name: 'Roles', exact: true }).click();
  await expect(pane.getByRole('list', { name: 'Roles' }).getByRole('button', { name: /^Finance/ })).toContainText('Approves Pay an approved invoice');
});

test('a decision can take two people, one from each group, needs someone to approve it, and warns about a role nobody holds', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  // An old link to the page it replaced still lands here.
  await page.goto('/#admin/Inbox%20rules');
  const pane = app(page);
  await expect(pane.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
  await pane.getByRole('list', { name: 'Decisions' }).getByRole('button', { name: /^Approve an invoice draft/ }).click();
  await expect(page).toHaveURL(/#admin\/Approvals\/invoice$/);
  const who = pane.getByRole('region', { name: 'Who can approve' });
  const above = pane.getByRole('region', { name: 'Above an amount' });
  const count = who.getByRole('combobox', { name: 'How many different people' });
  await expect(count).toHaveValue('1');
  const requester = who.getByRole('switch', { name: 'Can the person whose agent prepared this approve it?' });
  await expect(requester).toHaveAttribute('aria-checked', 'true');

  await who.getByRole('checkbox', { name: /^Admins/ }).uncheck();
  await expect(above.getByRole('alert')).toHaveText('Choose at least one group who can approve.');
  await expect(above.getByRole('button', { name: 'Save' })).toBeDisabled();

  await who.getByRole('checkbox', { name: /^Legal/ }).check();
  await expect(who).toContainText('Nobody holds Legal yet, so this will wait until someone does.');
  await who.getByRole('checkbox', { name: /^Finance/ }).check();
  await requester.click();
  await expect(requester).toHaveAttribute('aria-checked', 'false');
  // Two groups and two people: now one from each can be asked for.
  await expect(who.getByRole('switch', { name: 'One from each group' })).toHaveCount(0);
  await count.selectOption('2');
  const each = who.getByRole('switch', { name: 'One from each group' });
  await each.click();
  await expect(each).toHaveAttribute('aria-checked', 'true');
  await expect(above.getByRole('button', { name: 'Save' })).toBeEnabled();
  await shoot(page, 'approvals-decision-rule', 1300);
  await above.getByRole('button', { name: 'Save' }).click();
  await expect(above.getByRole('status')).toHaveText('Saved.');
  await pane.getByRole('button', { name: '← Approvals' }).click();
  await expect(pane.getByRole('list', { name: 'Decisions' }).getByRole('button', { name: /^Approve an invoice draft/ }))
    .toContainText('Finance and Legal · one of each · the person whose agent prepared it can’t approve it');

  // Narrow: the rule still reads at phone width.
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(pane.getByRole('list', { name: 'Decisions' })).toBeVisible();
  const overflow = await pane.locator('.admin-settings-page').evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shoot(page, 'approvals-list-narrow', 2400);
});

test('an invoice over an amount goes to Admins and Finance, one of each, and resets', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/#admin/Approvals/invoice');
  const pane = app(page);
  const above = pane.getByRole('region', { name: 'Above an amount' });
  const use = above.getByRole('switch', { name: 'Use a different rule above an amount' });
  await expect(use).toHaveAttribute('aria-checked', 'false');
  await expect(above.getByRole('spinbutton', { name: 'Above' })).toHaveCount(0);
  await use.click();

  const amount = above.getByRole('spinbutton', { name: 'Above' });
  const currency = above.getByRole('textbox', { name: 'Currency' });
  await expect(currency).toHaveValue('USD');
  await expect(above).toContainText('Amounts in another currency use this rule too.');
  await expect(above.getByRole('alert')).toHaveText('Enter an amount above zero, like 5000.');
  await expect(above.getByRole('button', { name: 'Save' })).toBeDisabled();
  await amount.fill('5000');
  await currency.fill('usd');
  await expect(currency).toHaveValue('USD');

  // The band starts as a copy of the base rule: Admins. Add Finance, two people, one of each.
  await expect(above.getByRole('checkbox', { name: /^Admins/ })).toBeChecked();
  await above.getByRole('checkbox', { name: /^Finance/ }).check();
  await above.getByRole('combobox', { name: 'How many different people' }).selectOption('2');
  await above.getByRole('switch', { name: 'One from each group' }).click();
  await shoot(page, 'approvals-threshold', 1700);
  await above.getByRole('button', { name: 'Save' }).click();
  await expect(above.getByRole('status')).toHaveText('Saved.');
  await expect(above.getByRole('button', { name: 'Save' })).toBeDisabled();

  // Narrow: the band's fields stack and nothing scrolls sideways.
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(amount).toBeVisible();
  const overflow = await pane.locator('.admin-settings-page').evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await shoot(page, 'approvals-threshold-narrow', 2400);
  await page.setViewportSize({ width: 1840, height: 1000 });

  await pane.getByRole('button', { name: '← Approvals' }).click();
  const invoice = pane.getByRole('list', { name: 'Decisions' }).getByRole('button', { name: /^Approve an invoice draft/ });
  await expect(invoice).toContainText('Admins · over 5,000.00 USD: Admins and Finance, one of each');

  await invoice.click();
  await expect(amount).toHaveValue('5000');
  await above.getByRole('button', { name: 'Reset to default' }).click();
  await expect(above.getByRole('status')).toHaveText('Back to the default.');
  await expect(use).toHaveAttribute('aria-checked', 'false');
  await pane.getByRole('button', { name: '← Approvals' }).click();
  await expect(invoice).toContainText('Admins · Default');
  await expect(invoice).not.toContainText('over 5,000');
});

test('inviting a member with Finance shows what they will be able to approve', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  const pane = app(page);
  await pane.getByRole('button', { name: 'Invite member' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite member' });
  await expect(invite.getByText('Can approve: Nothing yet')).toBeVisible();
  await invite.getByRole('textbox', { name: 'Work email' }).fill('robin@example.com');
  await invite.getByRole('checkbox', { name: 'Finance' }).check();
  await expect(invite.getByText('Can approve: Pay an approved invoice')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/invite-with-roles.png` });
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await expect(invite).toHaveCount(0);
  const card = pane.getByRole('listitem').filter({ hasText: 'robin@example.com' });
  await expect(card).toContainText('Gets Finance when they join');
});

test('an Admin changes a member’s roles in Manage and sees what they can approve update', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  const pane = app(page);

  await pane.getByRole('listitem').filter({ hasText: 'Alex Rivera' }).getByRole('button', { name: 'Manage' }).click();
  const manage = page.getByRole('dialog', { name: 'Alex Rivera' });
  const line = manage.getByText(/^Can approve:/);
  await expect(manage.getByRole('checkbox', { name: 'Finance' })).toBeChecked();
  await expect(line).toContainText('Pay an approved invoice');
  await expect(manage.getByRole('button', { name: 'Save roles' })).toBeDisabled();
  await manage.getByRole('checkbox', { name: 'Finance' }).uncheck();
  await manage.getByRole('checkbox', { name: 'Access reviewer' }).check();
  await expect(line).not.toContainText('Pay an approved invoice');
  await expect(line).toContainText('Grant access to an admitted partner');
  if (shots) await page.screenshot({ path: `${shots}/manage-with-roles.png` });
  await manage.getByRole('button', { name: 'Save roles' }).click();
  await expect(manage.getByRole('status')).toHaveText('Roles updated.');
  await manage.getByRole('button', { name: 'Done' }).click();
  await expect(pane.getByRole('listitem').filter({ hasText: 'Alex Rivera' })).toContainText('Access reviewer');

  // Your own roles are read-only here.
  await pane.getByRole('listitem').filter({ hasText: 'Maya Chen' }).getByRole('button', { name: 'Manage' }).click();
  const you = page.getByRole('dialog', { name: 'Maya Chen' });
  await expect(you).toContainText('Roles: Partnerships, Access reviewer. Another Admin changes your own roles.');
  await expect(you.getByRole('checkbox')).toHaveCount(0);
  await expect(you.getByText(/^Can approve:/)).toContainText('Admit a partner applicant');
});

test('a rule change without a recent sign-in offers one and keeps the draft', async ({ page }) => {
  await page.goto('/?approvals=stepup#admin/Approvals/signature');
  const who = app(page).getByRole('region', { name: 'Who can approve' });
  await who.getByRole('checkbox', { name: /^Legal/ }).check();
  await who.getByRole('button', { name: 'Save' }).click();
  await expect(who.getByRole('alert')).toContainText('Changing who approves needs a recent sign-in.');
  await expect(who.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await expect(who.getByRole('checkbox', { name: /^Legal/ })).toBeChecked();
});

test('Manage without a recent sign-in offers one for the role switch and Remove, and changes nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?approvals=stepup');
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  const pane = app(page);
  const alex = pane.getByRole('listitem').filter({ hasText: 'Alex Rivera' });
  await alex.getByRole('button', { name: 'Manage' }).click();
  const manage = page.getByRole('dialog', { name: 'Alex Rivera' });
  const roleGroup = manage.getByRole('radiogroup', { name: 'Role' });
  // Alex is an Admin in the fixture; the switch tries to make them a Member.
  await expect(roleGroup.getByRole('radio', { name: /^Admin/ })).toHaveAttribute('aria-checked', 'true');

  await roleGroup.getByRole('radio', { name: /^Member/ }).click();
  await expect(manage.getByRole('alert')).toContainText('Changing someone’s role needs a recent sign-in.');
  await expect(manage.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await expect(roleGroup.getByRole('radio', { name: /^Admin/ })).toHaveAttribute('aria-checked', 'true');
  await expect(manage.getByRole('status')).toHaveCount(0);

  await manage.getByRole('button', { name: 'Remove…' }).click();
  await manage.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(manage.getByRole('alert')).toContainText('Removing a member needs a recent sign-in.');
  await expect(manage.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await manage.getByRole('button', { name: 'Keep' }).click();
  await expect(manage.getByRole('alert')).toHaveCount(0);
  await manage.getByRole('button', { name: 'Done' }).click();
  await expect(alex).toContainText('Admin');
});

test('a Member has no Approvals page', async ({ page }) => {
  await page.goto('/?seat=member#admin/Approvals');
  const pane = app(page);
  await expect(pane.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(pane.getByRole('list', { name: 'Decisions' })).toHaveCount(0);
});

test('an invitation with roles needs a recent sign-in; a plain one does not', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?approvals=stepup');
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  const pane = app(page);
  await pane.getByRole('button', { name: 'Invite member' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite member' });
  await invite.getByRole('textbox', { name: 'Work email' }).fill('sam@example.com');
  await invite.getByRole('checkbox', { name: 'Finance' }).check();
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await expect(invite.getByRole('alert')).toContainText('Inviting someone with roles needs a recent sign-in.');
  await expect(invite.getByRole('button', { name: 'Sign in again' })).toBeVisible();
  await invite.getByRole('checkbox', { name: 'Finance' }).uncheck();
  await invite.getByRole('button', { name: 'Send invitation' }).click();
  await expect(invite).toHaveCount(0);
});

test('the Invite dialog ticks the job’s own role and keeps the Admin’s ticks when the job changes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?memberSetup=finance');
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await app(page).getByRole('button', { name: 'Invite member' }).click();
  const invite = page.getByRole('dialog', { name: 'Invite member' });
  const job = invite.getByRole('combobox', { name: 'Job role' });
  const partnerships = invite.getByRole('checkbox', { name: 'Partnerships', exact: true });
  const finance = invite.getByRole('checkbox', { name: 'Finance', exact: true });
  const legal = invite.getByRole('checkbox', { name: 'Legal', exact: true });

  // Partnerships is the first job, and its role comes with it.
  await expect(partnerships).toBeChecked();
  await expect(partnerships).toBeDisabled();
  await expect(partnerships).toHaveAccessibleDescription('Comes with the Partnerships job');
  await legal.check();

  await job.selectOption({ label: 'Finance' });
  await expect(finance).toBeChecked();
  await expect(finance).toBeDisabled();
  await expect(finance).toHaveAccessibleDescription('Comes with the Finance job');
  await expect(partnerships).not.toBeChecked();
  await expect(partnerships).toBeEnabled();
  await expect(legal).toBeChecked();
  await expect(invite.getByText(/^Can approve:/)).toContainText('Pay an approved invoice');

  await job.selectOption({ label: 'Partnerships' });
  await expect(partnerships).toBeChecked();
  await expect(finance).not.toBeChecked();
  await expect(finance).toBeEnabled();
  await expect(legal).toBeChecked();
  if (shots) await page.screenshot({ path: `${shots}/invite-job-role.png` });

  await page.setViewportSize({ width: 430, height: 900 });
  const overflow = await invite.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
