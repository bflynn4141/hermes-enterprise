// The sidebar's session list, before and after decision C34.
//
// Three clicks on New session, and a picture of what the list says. It is
// written so it runs against *either* codebase — the control's name and the
// sidebar's class are the same before and after — so the "before" shot is the
// real old behaviour rather than a mock-up of it:
//
//     git stash push -- apps/client/src
//     MOCK=1 pnpm --filter client build
//     QA_LABEL=before npx playwright test e2e/panel-sidebar.spec.ts
//     git stash pop && MOCK=1 pnpm --filter client build
//     QA_LABEL=after  npx playwright test e2e/panel-sidebar.spec.ts
import { expect, test } from '@playwright/test';

const label = process.env.QA_LABEL ?? 'after';

test('three clicks on New session', async ({ page }) => {
  await page.setViewportSize({ width: 1840, height: 1000 });
  await page.goto('/');
  const sidebar = page.locator('.sidebar');
  await expect(sidebar.getByRole('button', { name: 'Agents', exact: true })).toBeVisible({ timeout: 20_000 });

  const create = sidebar.getByRole('button', { name: 'New session' }).first();
  for (let i = 0; i < 3; i += 1) {
    await create.click();
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(800);
  await sidebar.screenshot({ path: `qa/panel/sidebar-${label}.png` });
  await page.screenshot({ path: `qa/panel/sidebar-${label}-shell.png` });
});
