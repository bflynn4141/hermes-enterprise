// The nav column at narrow widths, in all three panel states.
//
// The bug this exists for: `.shell.nav-collapsed { --nav-w: 76px }` narrowed the
// grid *column* below 1180 px, but the adopted `SidebarNav` renders at its own
// width and collapses on its own control — so the navigation drew 224 px of
// itself across a 76 px column and over whatever was beside it (decision C36).
// Nothing caught it because every assertion in the panel suites was about the
// grid, and the grid was right.
//
//     npx playwright test e2e/panel-narrow.spec.ts
import { expect, test } from '@playwright/test';
import { expectNoNavOverlap, setPanel, type Panel } from './panel-helpers.js';

test.describe.configure({ mode: 'serial' });

for (const [width, height] of [
  [900, 700],
  [1100, 800],
] as const) {
  for (const panel of ['open', 'rail', 'hidden'] as Panel[]) {
    test(`the navigation keeps its column at ${width} in ${panel}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await expect(page.locator('.shell')).toBeVisible();
      await setPanel(page, panel);
      await expectNoNavOverlap(page, `${width} ${panel}`);

      // Below the pane-switch breakpoint a collapsed panel leaves no rail, and
      // the app gets the work area; at 1100 the rail is shown.
      if (panel !== 'open') {
        await expect(page.locator('.iris-rail')).toHaveCount(width >= 1000 && panel === 'rail' ? 1 : 0);
      }
      // And the shell never scrolls — in either direction.
      const scroll = await page.evaluate(() => {
        const outer = document.querySelector('.shell-outer');
        const shell = document.querySelector('.shell');
        return {
          outerTop: outer ? outer.scrollTop : 0,
          outerLeft: outer ? outer.scrollLeft : 0,
          shellTop: shell ? shell.getBoundingClientRect().top : 0,
        };
      });
      expect(scroll.outerTop, `${width} ${panel}: the shell scrolled vertically`).toBe(0);
      expect(scroll.outerLeft, `${width} ${panel}: the shell scrolled sideways`).toBe(0);
      expect(scroll.shellTop, `${width} ${panel}: the shell was pushed off the top`).toBeGreaterThanOrEqual(0);

      await page.screenshot({ path: `qa/panel/${width}-${panel}-narrow.png`, fullPage: false });
    });
  }
}
