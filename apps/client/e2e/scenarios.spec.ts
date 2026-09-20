// The first three scenarios from the client-port spec's §11 table, runnable
// against the mock bundle:
//
//   P1  Onboarding, both routes
//   P2  Triage: what needs me before the partner work can move forward?
//   P3  Review a request and admit it in the Inbox pane
//
// P4 onwards (two contexts deciding the same request, the Member seat's
// decision route, guidance mid-run, Stop, the provider 5xx retries, the dropped
// socket, the share viewer, the empty-state sweep and the injection fixture)
// need the worker: they assert what the *server* does. They are listed in the
// spec and land with the M2 routes; `E2E_BASE_URL` points this config at them.
import { expect, test } from '@playwright/test';
import { mockUuid } from '@hermes/shared';

const EMPTY_WORKSPACE = '/?data=empty&key=none';
const SEEDED = '/';

test.describe('P1 · onboarding', () => {
  test('the create-workspace route walks its steps and can go back', async ({ page }) => {
    await page.goto('/onboarding/create');
    await expect(page.getByRole('heading', { name: 'Name your workspace' })).toBeVisible();

    const name = page.getByLabel('Workspace name');
    await name.fill('Partner Program');
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: /Make .* yours/ })).toBeVisible();
    await page.getByRole('button', { name: 'Add context' }).click();
    await expect(page.getByRole('heading', { name: 'Add context' })).toBeVisible();
    await page.getByRole('button', { name: 'Set approvals' }).click();

    // The approval boundary is a policy preview, not a set of switches.
    await expect(page.getByRole('heading', { name: 'Review boundaries' })).toBeVisible();
    await expect(page.getByText('Iris prepares')).toBeVisible();
    await expect(page.locator('article.onboarding-approval-card')).toHaveCount(6);
    await expect(page.getByText('Admin + Finance')).toBeVisible();

    // Back keeps the typed value: nothing is thrown away between steps.
    await page.getByRole('button', { name: 'Back' }).click();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: /Make .* yours/ })).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(name).toHaveValue('Partner Program');
  });

  test('the join route needs a token and says so without one', async ({ page }) => {
    await page.goto('/onboarding/join');
    await expect(page.getByRole('heading', { name: 'Join a workspace' })).toBeVisible();
    // Without a token there is nothing to accept, so there is no button to
    // disable: the screen says what is missing and who can fix it. A disabled
    // "Accept invitation" would imply the link was fine and the seat was not.
    await expect(page.getByText('This link is missing its invitation token')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0);

    await page.goto('/onboarding/join?token=inv_demo');
    await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeEnabled();
    await expect(page.getByText(/only an Admin records a decision/)).toBeVisible();
  });

  test('a fresh workspace opens with Inbox 0 and every first-run empty state', async ({ page }) => {
    await page.goto(EMPTY_WORKSPACE);
    // The Inbox badge is derived from `v_inbox_count`; zero renders no badge.
    await expect(page.getByRole('button', { name: /^Inbox/ })).not.toContainText('4');
    await expect(page.getByText('What do you need help with?')).toBeVisible();
    // No verified provider key: the composer is greyed and says what to do.
    await expect(page.getByText('Connect Nous Portal in Settings to start').first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Message Iris/ })).toBeDisabled();
  });

  test('the mock create flow reaches the workspace it creates', async ({ page }) => {
    await page.goto('/onboarding/create');
    await page.getByLabel('Workspace name').fill('QA Workspace');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Add context' }).click();
    await page.getByRole('button', { name: 'Set approvals' }).click();
    await page.getByRole('button', { name: 'Create workspace' }).click();

    await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}/);
    await expect(page.getByText('QA Workspace').first()).toBeVisible();
  });

  test('the mock invitation flow accepts a known invitation', async ({ page }) => {
    await page.goto('/onboarding/join?token=inv_demo');
    await page.getByRole('button', { name: 'Accept invitation' }).click();

    await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}/);
    await expect(page.getByRole('button', { name: 'Inbox', exact: true }).first()).toBeVisible();
  });
});

test.describe('workspace picker states', () => {
  const user = { id: '00000000-0000-4000-8000-000000000100', name: 'Maya Chen', email: 'maya@nous.example' };
  const directory = (workspaces: { id: string; name: string; role: 'admin' | 'member'; members?: { id: string; name: string; avatar_url: string | null }[]; member_count?: number }[]) => ({
    user,
    workspaces,
    authenticated_at: '2026-10-12T09:49:00.000Z',
  });
  const workspace = (index: number, name: string, role: 'admin' | 'member' = 'admin') => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    name,
    role,
    members: [
      { id: user.id, name: user.name, avatar_url: null },
      { id: `00000000-0000-4000-8001-${String(index).padStart(12, '0')}`, name: index === 1 ? 'Alex Rivera' : 'Noor Patel', avatar_url: null },
    ],
    member_count: 2,
  });

  test('signed-out and no-membership responses remain distinct', async ({ page }) => {
    await page.route('**/auth/session', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Signed out', reason: 'signed_out' }) }));
    await page.goto('/?picker=1');
    await expect(page.getByRole('heading', { name: 'Sign in to Hermes' })).toBeVisible();

    await page.unroute('**/auth/session');
    await page.route('**/auth/session', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'No workspace', reason: 'not_found' }) }));
    await page.reload();
    await expect(page.getByText('You are not in a workspace yet')).toBeVisible();
  });

  test('zero, one, and multiple workspace directories render the right choices', async ({ page }) => {
    let response = directory([]);
    await page.route('**/auth/session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(response) }));
    await page.goto('/?picker=1');
    await expect(page.getByText('You are not in a workspace yet')).toBeVisible();

    response = directory([workspace(1, 'Partner Program')]);
    await page.reload();
    await expect(page.getByText('Partner Program')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open Partner Program' })).toHaveCount(1);
    await expect(page.getByLabel('Members: Maya Chen, Alex Rivera')).toBeVisible();

    response = directory([workspace(1, 'Partner Program'), workspace(2, 'Finance Review', 'member')]);
    await page.reload();
    await expect(page.getByText('Partner Program')).toBeVisible();
    await expect(page.getByText('Finance Review')).toBeVisible();
    await expect(page.getByRole('button', { name: /Open (Partner Program|Finance Review)/ })).toHaveCount(2);
  });

  test('a network failure offers an explicit retry', async ({ page }) => {
    await page.route('**/auth/session', (route) => route.abort('failed'));
    await page.goto('/?picker=1');
    await expect(page.getByText('Could not load your workspaces')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test.describe('members write feedback', () => {
  test('failed writes stay visible and preserve the pending form', async ({ page }) => {
    await page.goto('/?memberWrites=fail');
    await page.getByRole('button', { name: 'Members', exact: true }).click();
    const app = page.getByRole('region', { name: 'Application' });

    await app.getByRole('tab', { name: 'Invitations' }).click();
    await app.getByRole('button', { name: 'Resend' }).click();
    await expect(app.getByRole('alert')).toHaveText(
      `No verified Iris profile is available. Add ready capacity, then try again. Reference: ${mockUuid(399)}.`,
    );
    await expect(app.getByText('Invitation resent')).toHaveCount(0);

    await app.getByRole('button', { name: 'Withdraw' }).click();
    await expect(app.getByRole('alert')).toHaveText('Could not withdraw that invitation. Try again.');

    await app.getByRole('button', { name: 'Invite member' }).click();
    const invite = page.getByRole('dialog', { name: 'Invite member' });
    const email = invite.getByRole('textbox', { name: 'Work email' });
    await email.fill('new.member@example.com');
    await invite.getByRole('button', { name: 'Invite' }).click();
    await expect(invite.getByRole('alert')).toHaveText(
      `No verified Iris profile is available. Add ready capacity, then try again. Reference: ${mockUuid(399)}.`,
    );
    await expect(email).toHaveValue('new.member@example.com');
    await invite.getByRole('button', { name: 'Cancel' }).click();

    await app.getByRole('tab', { name: 'All members' }).click();
    const alex = app.getByRole('listitem').filter({ hasText: 'Alex Rivera' });
    await alex.getByRole('button', { name: 'Manage' }).click();
    const manage = page.getByRole('dialog', { name: 'Alex Rivera' });
    await manage.getByRole('menuitemradio', { name: /Member/ }).click();
    await expect(manage.getByRole('alert')).toHaveText('Could not change this role. Nothing was changed. Try again.');
    await manage.getByRole('button', { name: 'Remove…' }).click();
    await manage.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(manage.getByRole('alert')).toHaveText('Could not remove this member. Their access has not changed. Try again.');
    await expect(manage).toBeVisible();
  });

  test('a successful invite appears in the Invitations tab', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Members', exact: true }).click();
    const app = page.getByRole('region', { name: 'Application' });
    await app.getByRole('button', { name: 'Invite member' }).click();
    const invite = page.getByRole('dialog', { name: 'Invite member' });
    await invite.getByRole('textbox', { name: 'Work email' }).fill('new.member@example.com');
    await invite.getByRole('button', { name: 'Invite' }).click();

    await expect(invite).toHaveCount(0);
    await expect(app.getByText('new.member@example.com')).toBeVisible();
    await expect(app.getByText('Invitation recorded · Email delivery queued')).toBeVisible();
  });
});

test.describe('P2 · triage', () => {
  test('four request rows, the blocker card, and the app pane stays on Overview', async ({ page }) => {
    await page.goto(SEEDED);
    const appPane = page.getByRole('region', { name: 'Application' });

    // The triage answer names the four requests …
    await expect(page.getByText(/Four requests are ready/).first()).toBeVisible();
    // … and the blocker card offers context, not an approval.
    await expect(page.getByText('Unblock Noor’s reply')).toBeVisible();
    await expect(page.getByText('Add the destination; I’ll prepare the draft. Not an approval.')).toBeVisible();
    // React StrictMode intentionally starts and cancels the bootstrap once in
    // development. The canceled adapter must not prepend the message window a
    // second time or leave another hub/poller running behind this transcript.
    const messageIds = await page.locator('[role="log"] [data-message-id]').evaluateAll((messages) =>
      messages.map((message) => message.getAttribute('data-message-id')),
    );
    expect(new Set(messageIds).size).toBe(messageIds.length);

    // Four rows in the app pane's "Needs you" list.
    // Scoped to the list, because the names are also on the recommendation
    // card above it now — two places, deliberately, and one of them is the
    // list this assertion is about.
    const needsYou = appPane.getByRole('list', { name: 'Requests that need you' });
    await expect(needsYou.getByRole('button', { name: /^(Review|Approve .* draft)/ })).toHaveCount(4);
    await expect(needsYou.getByText('Leah Martinez')).toBeVisible();
    await expect(needsYou.getByText('Owen Reilly')).toBeVisible();

    // Following: nothing the agent said moved the pane off Overview. The
    // Agents surface has one header, so content begins directly below it and
    // the follow control stays with the surviving breadcrumb.
    const appHeader = appPane.locator('.pane-header');
    await expect(appHeader.getByText('Agents', { exact: true })).toBeVisible();
    await expect(appHeader.getByText('Iris', { exact: true })).toBeVisible();
    await expect(appHeader.getByRole('button', { name: 'Following Iris', exact: true })).toBeVisible();
    await expect(appPane.locator('.pane-subheader')).toHaveCount(0);
    await expect(appPane.getByText('Iris / Overview', { exact: true })).toHaveCount(0);
    const headerLayout = await appPane.evaluate((pane) => {
      const header = pane.querySelector<HTMLElement>('.pane-header')!;
      const content = pane.querySelector<HTMLElement>('.object-view')!;
      return { headerBottom: header.getBoundingClientRect().bottom, contentTop: content.getBoundingClientRect().top };
    });
    expect(Math.abs(headerLayout.contentTop - headerLayout.headerBottom)).toBeLessThanOrEqual(1);

    // The Inbox badge agrees with the list.
    await expect(page.getByRole('button', { name: /^Inbox/ })).toContainText('4');
  });

  test('a manual navigation pins the view, and Follow returns it', async ({ page }) => {
    await page.goto(SEEDED);
    const appPane = page.getByRole('region', { name: 'Application' });
    await expect(appPane.locator('.agent-tabs-navigation')).toBeVisible();
    const sections = appPane.getByRole('combobox', { name: 'Agent view' });
    if (await sections.isVisible()) await sections.selectOption('skills');
    else await appPane.getByRole('tab', { name: 'Skills' }).click();
    const appHeader = appPane.locator('.pane-header');
    await expect(appHeader.getByText('View pinned')).toBeVisible();
    await expect(appPane.locator('.pane-subheader')).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    const showApp = page.locator('.pane-iris').getByRole('button', { name: 'App', exact: true });
    if (await showApp.isVisible()) await showApp.click();
    await expect(appPane).toHaveAttribute('data-active', 'true');
    await expect(appHeader.getByText('View pinned')).toBeHidden();
    await expect(appHeader.getByRole('button', { name: 'Follow Iris', exact: true })).toBeVisible();
    const headerWidth = await appHeader.evaluate((header) => ({ client: header.clientWidth, scroll: header.scrollWidth }));
    expect(headerWidth.scroll).toBeLessThanOrEqual(headerWidth.client);

    await appHeader.getByRole('button', { name: /^Follow / }).click();
    await expect(appPane.getByRole('button', { name: /Following/ })).toBeVisible();
  });
});

test.describe('P3 · review and admit', () => {
  test('the review pane shows the evidence, and Admit records one decision', async ({ page }) => {
    await page.goto(SEEDED);
    const appPane = page.getByRole('region', { name: 'Application' });

    await appPane.getByRole('button', { name: /^Review/ }).first().click();

    // The evidence, including what is missing — which is the point of the pane.
    await expect(appPane.getByRole('heading', { name: 'Leah Martinez' })).toBeVisible();
    await expect(appPane.getByLabel('82 out of 100')).toBeVisible();
    await expect(appPane.getByText('Missing evidence')).toBeVisible();
    await expect(appPane.getByText(/Customer impact/)).toBeVisible();

    // The footer says exactly what admitting does and does not do.
    await expect(appPane.getByText('Admit Leah to the Partner Program.')).toBeVisible();
    await expect(appPane.getByText('Role and access require separate approval. No message is sent.')).toBeVisible();

    await appPane.getByRole('button', { name: 'Admit Leah' }).click();

    // The receipt replaces the review, and it is honest about what is pending.
    await expect(appPane.getByText('Recorded decision. Downstream execution — access grants, payment, signing, sending — stays separate and pending.')).toBeVisible();
    await expect(appPane.getByText('What this implies')).toBeVisible();

    // The badge came down by one, from the event rather than from a counter.
    await expect(page.getByRole('button', { name: /^Inbox/ })).toContainText('3');
  });

  test('a Member sees the request and is told who decides', async ({ page }) => {
    await page.goto('/?seat=member');
    const appPane = page.getByRole('region', { name: 'Application' });
    await appPane.getByRole('button', { name: /^Review/ }).first().click();
    await expect(appPane.getByText('Admin decision required')).toBeVisible();
    await expect(appPane.getByRole('button', { name: 'Admit' })).toHaveCount(0);
    await expect(appPane.getByText('You can read the request and its evidence. An Admin records the decision.')).toBeVisible();
  });
});


test.describe('legacy document draft decisions', () => {
  test('invoice approval saves a draft without a payment ceremony', async ({ page }) => {
    await page.goto('/#inbox/request/00000000-0000-4000-8000-00000000000d');
    const appPane = page.getByRole('region', { name: 'Application' });
    await expect(appPane.getByRole('heading', { name: 'Your decision' })).toBeVisible();
    await expect(appPane.getByText('0 of 1 Admin approval', { exact: true })).toBeVisible();
    await expect(appPane.getByText('No source messages linked.', { exact: true })).toBeVisible();
    await expect(appPane.getByRole('button', { name: 'Review payment' })).toHaveCount(0);
    await appPane.getByRole('button', { name: 'Approve invoice draft', exact: true }).click();
    await expect(appPane.getByRole('heading', { name: 'Saved in Library', exact: true })).toBeVisible();
    await expect(appPane.getByText('Invoice saved. No payment or email is sent.', { exact: true })).toBeVisible();
    await expect(appPane.getByRole('button', { name: 'Execute', exact: true })).toHaveCount(0);
  });

  test('agreement review stays unsigned and members see who can approve', async ({ page }) => {
    await page.goto('/?seat=member#inbox/request/00000000-0000-4000-8000-00000000000e');
    const appPane = page.getByRole('region', { name: 'Application' });
    await expect(appPane.getByText('0 of 1 Admin approval', { exact: true })).toBeVisible();
    await expect(appPane.getByText('Admin required', { exact: true })).toBeVisible();
    await expect(appPane.getByRole('button', { name: 'Approve agreement draft', exact: true })).toHaveCount(0);
    await expect(appPane.getByRole('textbox', { name: 'Full legal name' })).toHaveCount(0);
    await page.goto('/#inbox/request/00000000-0000-4000-8000-00000000000e');
    await appPane.getByRole('button', { name: 'Approve agreement draft', exact: true }).click();
    await expect(appPane.getByRole('heading', { name: 'Saved unsigned', exact: true })).toBeVisible();
    await expect(appPane.getByText('Agreement saved unsigned. Nothing is signed or sent.', { exact: true })).toBeVisible();
  });
});
