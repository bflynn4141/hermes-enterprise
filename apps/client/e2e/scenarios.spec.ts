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
    await expect(page.getByText('Add your OpenRouter key in Settings to start').first()).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Message Iris/ })).toBeDisabled();
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

    // Four rows in the app pane's "Needs you" list.
    // Scoped to the list, because the names are also on the recommendation
    // card above it now — two places, deliberately, and one of them is the
    // list this assertion is about.
    const needsYou = appPane.getByRole('list', { name: 'Requests that need you' });
    await expect(needsYou.getByRole('button', { name: /^Review/ })).toHaveCount(4);
    await expect(needsYou.getByText('Leah Martinez')).toBeVisible();
    await expect(needsYou.getByText('Owen Reilly')).toBeVisible();

    // Following: nothing the agent said moved the pane off Overview.
    await expect(appPane.getByText('Iris / Overview')).toBeVisible();
    await expect(appPane.getByRole('button', { name: /Following/ })).toBeVisible();

    // The Inbox badge agrees with the list.
    await expect(page.getByRole('button', { name: /^Inbox/ })).toContainText('4');
  });

  test('a manual navigation pins the view, and Follow returns it', async ({ page }) => {
    await page.goto(SEEDED);
    const appPane = page.getByRole('region', { name: 'Application' });
    await appPane.getByRole('tab', { name: 'Skills' }).click();
    await expect(appPane.getByText('View pinned')).toBeVisible();
    await appPane.getByRole('button', { name: /^Follow / }).click();
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
