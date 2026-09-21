// One screenshot per main screen, into `qa/`. This is a rendering check, not an
// assertion suite: it proves every screen mounts against the mock backend and
// leaves an artefact a human can look at.
//
//     npx playwright test e2e/qa-screens.spec.ts
import { expect, test } from '@playwright/test';

const shot = (name: string) => ({ path: `qa/${name}.png`, fullPage: false });

test.describe.configure({ mode: 'serial' });

test('every main screen renders', async ({ page }) => {
  const appPane = page.getByRole('region', { name: 'Application' });

  // 1. The shell: sidebar, chat pane with a transcript, app pane on Overview.
  await page.goto('/');
  await expect(page.getByText(/Four requests are ready/).first()).toBeVisible();
  await page.screenshot(shot('01-shell-overview'));

  // 2. Sessions popover.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Sessions' })).toBeVisible();
  await page.screenshot(shot('02-sessions-popover'));
  await page.keyboard.press('Escape');

  // 3. Composer model menu, with the disabled rows and their reasons.
  await page.getByRole('button', { name: /Claude Sonnet 5/ }).click();
  await expect(page.getByRole('dialog', { name: 'Model' })).toBeVisible();
  await page.screenshot(shot('03-composer-model-menu'));
  await page.keyboard.press('Escape');

  // 4. Inbox list.
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const reviewList = appPane.getByRole('list', { name: 'Requests needing review' });
  await expect(reviewList).toBeVisible();
  await page.screenshot(shot('04-inbox-list'));

  // 5. Request review (an application).
  await reviewList.getByRole('listitem').first().click();
  await expect(appPane.getByText('Missing evidence')).toBeVisible();
  await page.screenshot(shot('05-request-review'));

  // 6. The document viewer (the invoice request).
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await appPane.getByRole('list', { name: 'Requests needing review' }).getByRole('listitem').nth(2).click();
  await expect(appPane.getByRole('heading', { name: /^Invoice from/ })).toBeVisible();
  await page.screenshot(shot('06-document-viewer'));

  // 7. The receipt, after a decision. Approving saves a draft; nothing is paid or sent.
  await appPane.getByRole('button', { name: 'Approve invoice draft' }).click();
  await expect(appPane.getByRole('heading', { name: 'Saved in Library' })).toBeVisible();
  await page.screenshot(shot('07-receipt'));

  // With Iris open the app pane is narrow, so the agent tabs render as a select.
  const agentView = async (label: string) => {
    const tab = appPane.getByRole('tab', { name: label });
    if (await tab.isVisible()) await tab.click();
    else await appPane.getByRole('combobox', { name: 'Agent view' }).selectOption({ label });
  };

  // 8. Agent → Context.
  await page.getByRole('button', { name: 'Agents' }).click();
  await agentView('Context');
  await expect(appPane.getByRole('heading', { name: 'What Iris knows' })).toBeVisible();
  await page.screenshot(shot('08-agent-context'));

  // 9. Agent → Skills.
  await agentView('Skills');
  await expect(appPane.getByRole('heading', { name: 'Instructions for Iris' })).toBeVisible();
  await page.screenshot(shot('09-agent-skills'));

  // 10. Agent → Traces.
  await agentView('Traces');
  await expect(appPane.getByRole('heading', { name: 'Runs' })).toBeVisible();
  await page.screenshot(shot('10-traces'));

  // 11. Trace detail, with ThinkingState driven by the run's real steps.
  await appPane.getByRole('button', { name: /^Open/ }).first().click();
  await expect(appPane.getByText('Allowed tools')).toBeVisible();
  await page.screenshot(shot('11-trace-detail'));

  // 12. History.
  await page.getByRole('button', { name: 'History' }).click();
  await appPane.getByRole('tab', { name: 'All activity' }).click();
  await expect(appPane.getByRole('heading', { name: 'History' })).toBeVisible();
  await page.screenshot(shot('12-history'));

  // 13. Members.
  await page.getByRole('button', { name: 'Members' }).click();
  await expect(appPane.getByRole('heading', { name: 'Members' })).toBeVisible();
  await page.screenshot(shot('13-members'));

  // 14. Library → Skills.
  await page.getByRole('button', { name: 'Library' }).click();
  await expect(appPane.getByRole('heading', { name: 'Library' })).toBeVisible();
  await page.screenshot(shot('14-library-skills'));

  // 15. Library → Documents.
  await appPane.getByRole('tab', { name: 'Documents' }).click();
  await expect(appPane.getByText('Saved documents')).toBeVisible();
  await expect(appPane.getByText('Partner Program Guide', { exact: true })).toBeVisible();
  await page.screenshot(shot('15-library-documents'));

  // 16. Admin → Model providers. Admin pages live in one left rail.
  const adminPage = (label: string) => appPane.getByRole('navigation', { name: 'Admin settings' }).getByRole('button', { name: label, exact: true });
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await adminPage('Model providers').click();
  await expect(appPane.getByRole('heading', { name: 'Model providers' })).toBeVisible();
  await page.screenshot(shot('16-settings-provider-keys'));

  // 17. Admin → Usage.
  await adminPage('Usage').click();
  // The server's own sentence, which the client renders beside the total.
  await expect(appPane.getByText(/Estimated, billed by your provider/)).toBeVisible();
  await page.screenshot(shot('17-settings-usage'));

  // 18. Admin → Agent defaults.
  await adminPage('Agent defaults').click();
  await expect(appPane.getByRole('heading', { name: 'Model defaults' })).toBeVisible();
  await page.screenshot(shot('18-settings-agents'));

  // 19. Settings → Data and privacy, with the processor facts.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await appPane.getByRole('tab', { name: 'Data and privacy' }).click();
  await expect(appPane.getByText('Processors')).toBeVisible();
  await page.screenshot(shot('19-settings-privacy'));
});

test('the first-run empty states render', async ({ page }) => {
  await page.goto('/?data=empty&key=none');
  await expect(page.getByText('Nothing needs you yet. Iris works when you message it.')).toBeVisible();
  await page.screenshot(shot('20-empty-admin'));

  const appPane = page.getByRole('region', { name: 'Application' });
  await page.getByRole('button', { name: /^Inbox/ }).click();
  await expect(appPane.getByText('No reviews waiting')).toBeVisible();
  await page.screenshot(shot('21-empty-inbox'));

  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  await appPane.getByRole('navigation', { name: 'Admin settings' }).getByRole('button', { name: 'Model providers', exact: true }).click();
  await expect(appPane.getByText(/Connect Nous Portal to enable models/)).toBeVisible();
  await page.screenshot(shot('22-empty-provider-keys'));
});

test('the Member seat renders', async ({ page }) => {
  await page.goto('/?seat=member');
  const appPane = page.getByRole('region', { name: 'Application' });
  await appPane.getByRole('button', { name: /^Review/ }).first().click();
  await expect(appPane.getByText('A workspace Admin records this decision')).toBeVisible();
  await page.screenshot(shot('23-member-review'));
});

test('onboarding and the shared viewer render', async ({ page }) => {
  await page.goto('/onboarding/create');
  await expect(page.getByRole('heading', { name: 'Name your workspace' })).toBeVisible();
  await page.screenshot(shot('24-onboarding-create'));

  await page.goto('/onboarding/join?token=inv_demo');
  await expect(page.getByRole('heading', { name: 'Join a workspace' })).toBeVisible();
  await page.screenshot(shot('25-onboarding-join'));

  await page.goto('/shared/mock-share-token');
  await expect(page.getByText('This is a read-only view. Referenced objects open only for signed-in members.')).toBeVisible();
  await page.screenshot(shot('26-shared-viewer'));
});
