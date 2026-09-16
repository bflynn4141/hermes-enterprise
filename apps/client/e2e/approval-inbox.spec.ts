import { expect, test, type Page } from '@playwright/test';

const APPROVALS = '/?scenario=approvals';

async function openInbox(page: Page) {
  await page.goto(APPROVALS);
  await page.getByRole('button', { name: /^Inbox/ }).click();
  const app = page.getByRole('region', { name: 'Application' });
  await expect(app.getByRole('tab', { name: 'Needs review' })).toBeVisible();
  return app;
}

async function openRequest(app: ReturnType<Page['getByRole']>, name: RegExp) {
  await app.locator('.inbox-item').filter({ hasText: name }).click();
}

test.describe('enterprise approval inbox', () => {
  test('the opt-in fixture exposes every approval type while preserving legacy requests', async ({ page }) => {
    const app = await openInbox(page);
    await expect(app.getByText('Illustrative demo')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Inbox/ })).toContainText('13');

    const expected = [
      ['Launch partner research sprint', 'Plan and budget'],
      ['Assign the onboarding synthesis', 'Team commitment'],
      ['Read-only access to partner feedback', 'Temporary access'],
      ['Send pilot invitation', 'Communication'],
      ['Publish partner evidence checklist', 'Shared learning'],
      ['Accept onboarding recommendation', 'Deliverable'],
      ['Share redacted pilot summary', 'Data disclosure'],
      ['Update pilot readiness records', 'Record change'],
      ['Allow a 24-hour review extension', 'Exception'],
    ] as const;
    for (const [subject, type] of expected) {
      await expect(app.getByText(subject)).toBeVisible();
      await expect(app.getByText(type).first()).toBeVisible();
    }
    await expect(app.getByText('Leah Martinez')).toBeVisible();
    await expect(app.locator('.inbox-item').filter({ hasText: /Invoice/ })).toBeVisible();
    await expect(app.locator('.inbox-item').filter({ hasText: /Signature/ })).toBeVisible();

    await app.getByRole('button', { name: 'Waiting on others' }).click();
    await expect(app.getByText('Change Rowan’s schedule and tools')).toBeVisible();
    await expect(app.getByText('Waiting for Alex Rivera')).toBeVisible();
    await expect(app.getByText('Launch partner research sprint')).toHaveCount(0);

    await app.getByRole('button', { name: 'All' }).click();
    await expect(app.getByText('Launch partner research sprint')).toBeVisible();
    await expect(app.getByText('Change Rowan’s schedule and tools')).toBeVisible();
  });

  test('all ten specialized approval previews are traversable through one review shell', async ({ page }) => {
    const app = await openInbox(page);
    await app.getByRole('button', { name: 'All' }).click();
    const previews = [
      ['Launch partner research sprint', 'Enforced run limits'],
      ['Assign the onboarding synthesis', 'Bounded task'],
      ['Read-only access to partner feedback', 'Access recipient'],
      ['Send pilot invitation', 'Illustrative pilot outline.pdf'],
      ['Publish partner evidence checklist', 'Skill changes'],
      ['Accept onboarding recommendation', 'Smallest credible onboarding pilot'],
      ['Share redacted pilot summary', 'Example Research Cooperative'],
      ['Update pilot readiness records', 'Record changes'],
      ['Allow a 24-hour review extension', 'Rule remains in force'],
      ['Change Rowan’s schedule and tools', 'Current schedule'],
    ] as const;
    for (const [subject, marker] of previews) {
      await openRequest(app, new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await expect(app.getByRole('heading', { name: subject })).toBeVisible();
      await expect(app.getByText(marker).or(app.getByLabel(marker)).first()).toBeVisible();
      await app.getByRole('button', { name: 'Back to Inbox' }).click();
    }
  });

  test('a version-bound plan advances to the second reviewer without starting work', async ({ page }) => {
    const app = await openInbox(page);
    await openRequest(app, /Launch partner research sprint/);

    await expect(app.getByRole('heading', { name: 'Launch partner research sprint' })).toBeVisible();
    const limits = app.getByLabel('Enforced run limits');
    await expect(limits.getByText('25,000')).toBeVisible();
    await expect(limits.getByText('8', { exact: true })).toBeVisible();
    await expect(limits.getByText('5,000', { exact: true })).toBeVisible();
    await expect(limits.getByText('2', { exact: true })).toBeVisible();
    await expect(app.getByText('Illustrative scenario. Names, prices, sources and effects shown here are fictional')).toBeVisible();
    await expect(app.getByText('Workspace owner')).toBeVisible();
    await expect(app.getByText('Budget reviewer')).toBeVisible();

    await app.getByRole('button', { name: 'Approve plan' }).click();
    await expect(app.getByText('Waiting for Alex Rivera').first()).toBeVisible();
    await expect(app.getByText('Human authorization')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Inbox/ })).toContainText('12');

    await app.getByRole('button', { name: 'Back to Inbox' }).click();
    await app.getByRole('button', { name: 'Waiting on others' }).click();
    await expect(app.getByText('Launch partner research sprint')).toBeVisible();
    await expect(app.getByText('Change Rowan’s schedule and tools')).toBeVisible();

    await app.getByRole('button', { name: 'Reset approval demo' }).click();
    await expect(page.getByRole('button', { name: /^Inbox/ })).toContainText('13');
  });

  test('authorization completion stays distinct from unavailable external effects', async ({ page }) => {
    const app = await openInbox(page);
    await openRequest(app, /Send pilot invitation/);
    await app.getByRole('button', { name: 'Approve send' }).click();
    const result = app.locator('.approval-result-track');
    await expect(result.getByText('Human authorization')).toBeVisible();
    await expect(result.getByText('approved', { exact: true })).toBeVisible();
    await expect(result.getByText('unavailable', { exact: true })).toBeVisible();
    await expect(result.getByText('Illustrative demo only; no external provider is connected and no effect occurred.')).toBeVisible();
  });

  test('request changes, revision, routing, chat cards and legacy details remain usable', async ({ page }) => {
    const app = await openInbox(page);
    await openRequest(app, /Read-only access to partner feedback/);
    await app.getByRole('button', { name: 'Request changes' }).click();
    await app.getByLabel('What needs to change').fill('Limit the grant to the source index rather than the whole folder.');
    await app.getByRole('button', { name: 'Send back for changes' }).click();
    await expect(app.getByRole('button', { name: 'Revise proposal' })).toBeVisible();
    await app.getByRole('button', { name: 'Revise proposal' }).click();
    await app.getByLabel('Revised proposal summary').fill('Grant Rowan read-only access to the illustrative source index for 24 hours.');
    await app.getByLabel('What changed').fill('Narrowed the named resource in the reviewed summary.');
    await app.getByRole('button', { name: 'Submit v2' }).click();
    await expect(app.getByText('v2', { exact: true })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Allow access' })).toBeVisible();

    await app.getByRole('button', { name: 'Back to Inbox' }).click();
    await openRequest(app, /Send pilot invitation/);
    await app.getByRole('button', { name: 'More approval actions' }).click();
    await page.getByRole('menuitem', { name: 'Route reviewer' }).click();
    await app.getByLabel('Eligible reviewer').selectOption({ label: 'Alex Rivera · finance, agent_admin' });
    await app.getByLabel('Routing reason').fill('Alex owns review of this illustrative recipient group.');
    await app.getByRole('button', { name: 'Route review' }).click();
    await expect(app.getByText('Waiting for Alex Rivera').first()).toBeVisible();

    // Approval receipt cards resolve the same request id as Inbox rows.
    await expect(page.getByText('Research sprint plan')).toBeVisible();
    await page.getByRole('button', { name: 'Approve plan' }).click();
    await expect(app.getByRole('heading', { name: 'Launch partner research sprint' })).toBeVisible();

    await app.getByRole('button', { name: 'Back to Inbox' }).click();
    await openRequest(app, /Leah Martinez/);
    await expect(app.getByLabel('82 out of 100')).toBeVisible();
    await app.getByRole('button', { name: 'Back to Inbox' }).click();
    await openRequest(app, /Invoice/);
    await expect(app.getByText('Partner workshop · Oct 8')).toBeVisible();
    await app.getByRole('button', { name: 'Back to Inbox' }).click();
    await openRequest(app, /Signature/);
    await expect(app.getByText('One partner workshop on Oct 22–23')).toBeVisible();
  });

  test('the review flow remains keyboard reachable and contained on a narrow reduced-motion viewport', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 900, height: 760 });
    const app = await openInbox(page);
    await app.locator('.inbox-item').filter({ hasText: /Accept onboarding recommendation/ }).focus();
    await page.keyboard.press('Enter');
    await expect(app.getByRole('heading', { name: 'Accept onboarding recommendation' })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Accept result' })).toBeVisible();
    const layout = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      activeLabel: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim(),
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  });
});
