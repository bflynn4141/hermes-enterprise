import { expect, test, type Page } from '@playwright/test';
import { mockUuid } from '@hermes/shared';
import { APPROVAL_REVISION_DRAFT_KEY } from '../src/model/approval-revision-draft.js';

const APPROVALS = '/?scenario=approvals';

const APPROVAL_CASES = [
  { type: 'run_plan', subject: 'Launch partner research sprint', label: 'Plan and budget', marker: 'Enforced run limits', action: 'Approve plan', effect: null, work: null },
  { type: 'team_commitment', subject: 'Assign the onboarding synthesis', label: 'Team commitment', marker: 'Bounded task', action: 'Accept task', effect: 'not required', work: 'admitted' },
  { type: 'access', subject: 'Read-only access to partner feedback', label: 'Temporary access', marker: 'Access recipient', action: 'Allow access', effect: 'unavailable', work: 'completed' },
  { type: 'communication', subject: 'Send pilot invitation', label: 'Communication', marker: 'Illustrative pilot outline.pdf', action: 'Approve send', effect: 'unavailable', work: 'completed' },
  { type: 'shared_learning', subject: 'Publish partner evidence checklist', label: 'Shared learning', marker: 'Skill changes', action: 'Approve publication', effect: 'unavailable', work: 'completed' },
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

// The reviewer segments carry a count after the label ("For me 13"), so match
// on the leading words rather than the exact accessible name.
async function pickReviewer(app: ReturnType<Page['getByRole']>, label: 'For me' | 'Waiting on others' | 'All') {
  await app.getByLabel('Reviewer').getByRole('button', { name: new RegExp(`^${label}`) }).click();
}

async function openRequest(app: ReturnType<Page['getByRole']>, name: RegExp) {
  await app.locator('.inbox-item').filter({ hasText: name }).click();
}

test.describe('enterprise approval inbox', () => {
  test('step-up restores an exact email rewrite to the editor and waits for explicit save', async ({ page }) => {
    await page.addInitScript(({ key, viewerId, workspaceId, requestId }) => {
      sessionStorage.setItem(key, JSON.stringify({
        scope: { viewerId, workspaceId, requestId, revision: 1, hash: `sha256:${'4'.padStart(64, '0')}`, authorizationExpiresAt: '2026-10-19T12:00:00Z', canRevise: true },
        draft: { subject: 'Restored subject', body: 'Restored unsaved email wording.', summary: 'Restored review summary.', changeNote: 'Shortened the message.' },
        expiresAt: Date.now() + 60_000,
      }));
    }, { key: APPROVAL_REVISION_DRAFT_KEY, viewerId: mockUuid(100), workspaceId: mockUuid(1), requestId: mockUuid(1004) });
    await page.goto(`${APPROVALS}&communicationDraft=1`);
    await page.getByRole('button', { name: /^Inbox/ }).click();
    const app = page.getByRole('region', { name: 'Application' });
    await openRequest(app, /Review the partner pilot outreach draft/);
    await expect(app.getByLabel('Revised email subject')).toHaveValue('Restored subject');
    await expect(app.getByLabel('Revised email body')).toHaveValue('Restored unsaved email wording.');
    await expect(app.getByLabel('Revised proposal summary')).toHaveValue('Restored review summary.');
    await expect(app.getByLabel('What changed', { exact: true })).toHaveValue('Shortened the message.');
    await expect(app.locator('.approval-message-body')).not.toContainText('Restored unsaved email wording.');
    await expect(app.getByRole('button', { name: 'Approve draft' })).toHaveCount(0);
    await expect(app.getByRole('button', { name: 'Submit v2' })).toBeEnabled();
    await app.getByRole('button', { name: 'Submit v2' }).click();
    await expect(app.locator('.approval-message-body')).toContainText('Restored unsaved email wording.');
    await expect(app.getByRole('button', { name: 'Approve draft' })).toBeVisible();
  });

  test('a long outreach draft leads with the decision and readable copy, then records no send', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 900, height: 850 });
    await page.goto(`${APPROVALS}&communicationDraft=1`);
    await page.getByRole('button', { name: /^Inbox/ }).click();
    const app = page.getByRole('region', { name: 'Application' });
    await openRequest(app, /Review the partner pilot outreach draft/);
    await expect(app.getByRole('heading', { name: 'Your decision' })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Approve draft' })).toBeVisible();
    await expect(app.getByText('Taylor Brooks · email address needed')).toBeVisible();
    await expect(app.getByText('Review copy only · Nothing is sent')).toBeVisible();
    await expect(app.locator('.approval-message-body')).toContainText('Hi Taylor,');
    const body = await app.locator('.approval-message-body').boundingBox();
    const footer = await app.locator('.approval-footer').boundingBox();
    expect(body!.y).toBeLessThan(footer!.y - 80);
    await expect(app.locator('details').filter({ hasText: 'Request details' }).first()).not.toHaveAttribute('open');
    await app.locator('summary').filter({ hasText: /^Evidence/ }).click();
    await app.locator('summary').filter({ hasText: 'Illustrative partner source' }).click();
    await expect(app.getByText('Stored source facts')).toBeVisible();
    await expect(app.getByText('Fictional Partner Cooperative')).toBeVisible();
    await expect(app.getByRole('link', { name: 'Open original source' })).toHaveAttribute('href', 'https://example.invalid/illustrative-pilot');
    await app.getByRole('button', { name: 'Approve draft' }).click();
    await expect(app.locator('.approval-result-track').getByText('not required', { exact: true })).toBeVisible();
    await expect(app.locator('.approval-result-track').getByText('approved', { exact: true })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Approve draft' })).toHaveCount(0);
  });

  test('revising a draft changes the actual email and requires a fresh decision', async ({ page }) => {
    await page.goto(`${APPROVALS}&communicationDraft=1`);
    await page.getByRole('button', { name: /^Inbox/ }).click();
    const app = page.getByRole('region', { name: 'Application' });
    await openRequest(app, /Review the partner pilot outreach draft/);
    await app.getByRole('button', { name: 'Request changes' }).click();
    await app.getByLabel('What needs to change').fill('Make the invitation more concise.');
    await app.getByRole('button', { name: 'Send back for changes' }).click();
    await app.getByRole('button', { name: 'Revise draft' }).click();
    await app.getByLabel('Revised email subject').fill('A smaller partner pilot');
    await app.getByLabel('Revised email body').fill('Hi Taylor,\n\nWould a one-week pilot fit your team?\n\nMaya');
    await app.getByLabel('Revised proposal summary').fill('A concise invitation to a one-week partner pilot.');
    await app.getByLabel('What changed', { exact: true }).fill('Shortened the invitation and reduced its scope.');
    await app.getByRole('button', { name: 'Submit v2' }).click();
    await expect(app.locator('.approval-message')).toContainText('A smaller partner pilot');
    await expect(app.locator('.approval-message-body')).toContainText('Would a one-week pilot fit your team?');
    await expect(app.getByLabel('Required approvals')).toContainText('0/1 approved');
    await expect(app.getByRole('button', { name: 'Approve draft' })).toBeVisible();
    await app.getByRole('button', { name: 'Approve draft' }).click();
    await expect(app.locator('.approval-footer')).toContainText('authorization v2');
    await expect(app.locator('.approval-result-track')).toContainText('not required');
  });

  test('an authorized pending draft can be revised at phone width without approving old text', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${APPROVALS}&communicationDraft=1`);
    // Phone layouts use the workspace selector instead of a collapsible rail.
    await page.getByRole('combobox', { name: 'Workspace section' }).selectOption('inbox');
    const app = page.getByRole('region', { name: 'Application' });
    await openRequest(app, /Review the partner pilot outreach draft/);
    await app.getByRole('button', { name: 'More approval actions' }).click();
    await page.getByRole('menuitem', { name: 'Revise draft' }).click();
    await expect(app.getByLabel('Revised email body')).toBeVisible();
    await expect(app.getByRole('button', { name: 'Approve draft' })).toHaveCount(0);
    await app.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(app.getByRole('button', { name: 'Approve draft' })).toBeVisible();
    const bounds = await app.locator('.pane-switch').boundingBox();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  });

  test('the opt-in fixture exposes every approval type while preserving legacy requests', async ({ page }) => {
    const app = await openInbox(page);
    await expect(app.getByText('Illustrative demo')).toBeVisible();
    await expect(app.getByRole('button', { name: 'Priority' })).toHaveAttribute('aria-pressed', 'true');
    await expect(app.getByText('urgent', { exact: true })).toBeVisible();
    await expect(app.getByText('0/1 Workspace owner').first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Inbox/ })).toContainText('13');

    for (const approval of APPROVAL_CASES.filter((item) => item.type !== 'agent_governance')) {
      await expect(app.getByText(approval.subject)).toBeVisible();
      await expect(app.getByText(approval.label).first()).toBeVisible();
    }
    await expect(app.getByText('Leah Martinez')).toBeVisible();
    await expect(app.locator('.inbox-item').filter({ hasText: /Invoice/ })).toBeVisible();
    await expect(app.locator('.inbox-item').filter({ hasText: /Signature/ })).toBeVisible();

    await pickReviewer(app, 'Waiting on others');
    await expect(app.getByText('Change Rowan’s schedule and tools')).toBeVisible();
    await expect(app.getByText('Waiting for Alex Rivera')).toBeVisible();
    await expect(app.getByText('Launch partner research sprint')).toHaveCount(0);

    await pickReviewer(app, 'All');
    await expect(app.getByText('Launch partner research sprint')).toBeVisible();
    await expect(app.getByText('Change Rowan’s schedule and tools')).toBeVisible();
  });

  test('origin filters and personal hiding stay visible, reversible, and reviewer-safe', async ({ page }) => {
    const app = await openInbox(page);
    await expect(app.getByLabel('Request origin')).toHaveValue('all');
    await expect(app.getByText('Sample', { exact: true }).first()).toBeVisible();
    await app.getByLabel('Request origin').selectOption('sample');
    await expect(app.getByText('Launch partner research sprint')).toBeVisible();

    await pickReviewer(app, 'Waiting on others');
    await openRequest(app, /Change Rowan’s schedule and tools/);
    await expect(app.getByRole('button', { name: 'Hide', exact: true })).toBeEnabled();
    await app.getByRole('button', { name: 'Hide', exact: true }).click();
    await expect(app.getByRole('dialog')).toContainText('Only your Inbox view changes');
    await app.getByLabel('Reason').fill('Waiting for the assigned agent administrator.');
    await app.getByRole('button', { name: 'Hide from my Inbox' }).click();
    await expect(app.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
    // The sidebar badge is "For me" work. Organizing a row assigned to Alex
    // must not change Maya's thirteen required reviews.
    await expect(page.getByRole('button', { name: /^Inbox/ })).toContainText('13');

    await app.getByRole('button', { name: 'Back to Inbox' }).click();
    await expect(app.getByText('Change Rowan’s schedule and tools')).toHaveCount(0);
    await app.getByLabel('Inbox visibility').selectOption('hidden');
    await expect(app.getByText('Change Rowan’s schedule and tools')).toBeVisible();
    await openRequest(app, /Change Rowan’s schedule and tools/);
    await app.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Inbox/ })).toContainText('13');
  });

  test('origin and visibility controls remain usable at phone width', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(APPROVALS);
    await page.getByRole('combobox', { name: 'Workspace section' }).selectOption('inbox');
    const app = page.getByRole('region', { name: 'Application' });
    await expect(app.getByLabel('Request origin')).toBeVisible();
    await expect(app.getByLabel('Inbox visibility')).toBeVisible();
    await app.getByLabel('Request origin').selectOption('sample');
    await expect(app.getByText('Launch partner research sprint')).toBeVisible();
    const bounds = await app.locator('.inbox-topbar').evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
    }));
    expect(bounds.scrollWidth).toBeLessThanOrEqual(bounds.clientWidth);
  });

  test('all ten specialized approval previews are traversable through one review shell', async ({ page }) => {
    const app = await openInbox(page);
    await pickReviewer(app, 'All');
    for (const approval of APPROVAL_CASES) {
      await openRequest(app, new RegExp(approval.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await expect(app.getByRole('heading', { name: 'Your decision' })).toBeVisible();
      await expect(app.getByText(approval.marker).or(app.getByLabel(approval.marker)).first()).toBeVisible();
      await app.getByRole('button', { name: 'Back to Inbox' }).click();
    }
  });

  for (const approval of APPROVAL_CASES.filter((item) => item.action !== null)) {
    test(`${approval.type} records the configured action and result states`, async ({ page }) => {
      const app = await openInbox(page);
      await pickReviewer(app, 'All');
      await openRequest(app, new RegExp(approval.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      await app.getByRole('button', { name: approval.action }).click();

      if (approval.type === 'run_plan') {
        await expect(app.locator('.approval-decision-header')).toContainText('Waiting for Alex Rivera');
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
      await pickReviewer(app, 'All');

      for (const approval of APPROVAL_CASES) {
        await openRequest(app, new RegExp(approval.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        await expect(app.getByRole('heading', { name: 'Your decision' })).toBeVisible();
        await expect(app.getByText(approval.marker).or(app.getByLabel(approval.marker)).first()).toBeVisible();
        if (approval.action) {
          await expect(app.getByRole('button', { name: 'Request changes' })).toBeVisible();
          await expect(app.getByRole('button', { name: approval.action })).toBeVisible();
          await expect(app.getByRole('button', { name: 'More approval actions' })).toBeVisible();
        } else {
          await expect(app.locator('.approval-decision-header')).toContainText('Waiting for Alex Rivera');
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

    await expect(app.getByRole('heading', { name: 'Your decision' })).toBeVisible();
    const limits = app.getByLabel('Enforced run limits');
    await expect(limits.getByText('25,000')).toBeVisible();
    await expect(limits.getByText('8', { exact: true })).toBeVisible();
    await expect(limits.getByText('5,000', { exact: true })).toBeVisible();
    await expect(limits.getByText('2', { exact: true })).toBeVisible();
    await expect(app.getByText('Illustrative scenario. Names, prices, sources and effects shown here are fictional')).toBeVisible();
    await expect(app.getByLabel('Required approvals').getByText('Workspace owner', { exact: true })).toBeVisible();
    await expect(app.getByLabel('Required approvals').getByText('Budget reviewer', { exact: true })).toBeVisible();

    await app.getByRole('button', { name: 'Approve plan' }).click();
    await expect(app.getByText('Waiting for Alex Rivera').first()).toBeVisible();
    await expect(app.getByText('Human authorization')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Inbox/ })).toContainText('12');

    await app.getByRole('button', { name: 'Back to Inbox' }).click();
    await pickReviewer(app, 'Waiting on others');
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
    await expect(app.locator('summary').filter({ hasText: 'Temporary access · v2' })).toBeVisible();
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
    await page.locator('.chat-card').filter({ hasText: 'Research sprint plan' }).getByRole('button', { name: 'Review in Inbox' }).click();
    await expect(app.getByRole('heading', { name: 'Your decision' })).toBeVisible();

    await app.getByRole('button', { name: 'Back to Inbox' }).click();
    await openRequest(app, /Leah Martinez/);
    await expect(app.getByLabel('82 out of 100')).toBeVisible();
    await app.getByRole('button', { name: 'Back to Inbox' }).click();
    await openRequest(app, /Invoice/);
    await expect(app.getByText('Partner workshop · Oct 8', { exact: true })).toBeVisible();
    await app.getByRole('button', { name: 'Back to Inbox' }).click();
    await openRequest(app, /Signature/);
    await expect(app.locator('.legacy-context').getByText('One partner workshop on Oct 22–23')).toBeVisible();
  });

  test('the review flow remains keyboard reachable and contained on a narrow reduced-motion viewport', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 900, height: 760 });
    const app = await openInbox(page);
    await app.locator('.inbox-item').filter({ hasText: /Accept onboarding recommendation/ }).focus();
    await page.keyboard.press('Enter');
    await expect(app.getByRole('heading', { name: 'Your decision' })).toBeVisible();
    await expect(app.getByRole('button', { name: 'Accept result' })).toBeVisible();
    const layout = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      activeLabel: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim(),
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  });
});
