import { expect, test, type Page } from '@playwright/test';

const APPROVALS = '/?scenario=approvals';

const APPROVAL_CASES = [
  { type: 'run_plan', subject: 'Launch partner research sprint', label: 'Plan and budget', marker: 'Enforced run limits', action: 'Approve plan', effect: null, work: null },
  { type: 'team_commitment', subject: 'Assign the onboarding synthesis', label: 'Team commitment', marker: 'Bounded task', action: 'Accept task', effect: 'not required', work: 'admitted' },
  { type: 'access', subject: 'Read-only access to partner feedback', label: 'Temporary access', marker: 'Access recipient', action: 'Allow access', effect: 'unavailable', work: 'completed' },
  { type: 'communication', subject: 'Send pilot invitation', label: 'Communication', marker: 'Illustrative pilot outline.pdf', action: 'Approve send', effect: 'unavailable', work: 'completed' },
  { type: 'shared_learning', subject: 'Publish partner evidence checklist', label: 'Shared learning', marker: 'Skill changes', action: 'Publish skill', effect: 'unavailable', work: 'completed' },
  { type: 'deliverable', subject: 'Accept onboarding recommendation', label: 'Deliverable', marker: 'Smallest credible onboarding pilot', action: 'Accept result', effect: 'not required', work: 'ready' },
  { type: 'data_disclosure', subject: 'Share redacted pilot summary', label: 'Data disclosure', marker: 'Example Research Cooperative', action: 'Allow sharing', effect: 'unavailable', work: 'completed' },
  { type: 'record_change', subject: 'Update pilot readiness records', label: 'Record change', marker: 'Record changes', action: 'Approve change', effect: 'unavailable', work: 'completed' },
  { type: 'exception', subject: 'Allow a 24-hour review extension', label: 'Exception', marker: 'Rule remains in force', action: 'Allow exception', effect: 'not required', work: 'completed' },
  { type: 'agent_governance', subject: 'Change Rowan’s schedule and tools', label: 'Agent governance', marker: 'Current schedule', action: null, effect: null, work: null },
] as const;

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

    for (const approval of APPROVAL_CASES.filter((item) => item.type !== 'agent_governance')) {
      await expect(app.getByText(approval.subject)).toBeVisible();
      await expect(app.getByText(approval.label).first()).toBeVisible();
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
    for (const approval of APPROVAL_CASES) {
      await openRequest(app, new RegExp(approval.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await expect(app.getByRole('heading', { name: approval.subject })).toBeVisible();
      await expect(app.getByText(approval.marker).or(app.getByLabel(approval.marker)).first()).toBeVisible();
      await app.getByRole('button', { name: 'Back to Inbox' }).click();
    }
  });

  for (const approval of APPROVAL_CASES.filter((item) => item.action !== null)) {
    test(`${approval.type} records the configured action and result states`, async ({ page }) => {
      const app = await openInbox(page);
      await app.getByRole('button', { name: 'All' }).click();
      await openRequest(app, new RegExp(approval.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await app.getByRole('button', { name: approval.action }).click();

      if (approval.type === 'run_plan') {
        await expect(app.locator('.approval-footer')).toContainText('Waiting for Alex Rivera');
        await expect(app.getByText('Decision and result')).toHaveCount(0);
        return;
      }

      const result = app.locator('.approval-result-track');
      await expect(result.getByText('approved', { exact: true })).toBeVisible();
      await expect(result.getByText(approval.work, { exact: true })).toBeVisible();
      await expect(result.getByText(approval.effect, { exact: true })).toBeVisible();
      if (approval.effect === 'unavailable') {
        await expect(result.getByText('Illustrative demo only; no external provider is connected and no effect occurred.')).toBeVisible();
      }
    });
  }

  for (const viewport of [{ name: 'desktop', width: 1440, height: 1100 }, { name: 'narrow', width: 900, height: 1100 }] as const) {
    test(`all ten previews remain contained in the ${viewport.name} approval shell`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      const app = await openInbox(page);
      await app.getByRole('button', { name: 'All' }).click();

      for (const approval of APPROVAL_CASES) {
        await openRequest(app, new RegExp(approval.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        await expect(app.getByRole('heading', { name: approval.subject })).toBeVisible();
        await expect(app.getByText(approval.marker).or(app.getByLabel(approval.marker)).first()).toBeVisible();
        if (approval.action) {
          await expect(app.getByRole('button', { name: 'Request changes' })).toBeVisible();
          await expect(app.getByRole('button', { name: approval.action })).toBeVisible();
          await expect(app.getByRole('button', { name: 'More approval actions' })).toBeVisible();
        } else {
          await expect(app.locator('.approval-footer')).toContainText('Waiting for Alex Rivera');
          await expect(app.getByRole('button', { name: 'Request changes' })).toHaveCount(0);
          await expect(app.getByRole('button', { name: 'More approval actions' })).toHaveCount(0);
        }

        const layout = await page.evaluate(() => {
          const scroll = document.querySelector<HTMLElement>('.request-scroll');
          const footer = document.querySelector<HTMLElement>('.approval-footer');
          const footerRect = footer?.getBoundingClientRect();
          return {
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: document.documentElement.clientWidth,
            scrollWidth: scroll?.scrollWidth ?? 0,
            scrollClientWidth: scroll?.clientWidth ?? 0,
            footerLeft: footerRect?.left ?? -1,
            footerRight: footerRect?.right ?? Number.POSITIVE_INFINITY,
          };
        });
        expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.scrollClientWidth);
        expect(layout.footerLeft).toBeGreaterThanOrEqual(0);
        expect(layout.footerRight).toBeLessThanOrEqual(viewport.width);

        const screenshotDir = process.env.APPROVAL_SCREENSHOT_DIR;
        if (screenshotDir) {
          await page.screenshot({ path: `${screenshotDir}/${viewport.name}-${approval.type}.png` });
        }
        await app.getByRole('button', { name: 'Back to Inbox' }).click();
      }
    });
  }

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
