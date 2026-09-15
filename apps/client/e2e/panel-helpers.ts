// Shared assertions for the panel suites.
//
// `expectNoNavOverlap` lives here rather than in a spec file because both the
// mock walk (`panel-narrow.spec.ts`) and the live suite (`live-panel.spec.ts`
// N8) make the same claim about the same pixels, and a claim that is stated
// twice is a claim that drifts.
import { expect, type Page } from '@playwright/test';

export type Panel = 'open' | 'rail' | 'hidden';

/**
 * Nothing the navigation draws may appear outside its column, and nothing else
 * may appear inside it.
 *
 * Measured by hit-testing the pixels rather than by comparing boxes, and that
 * is the point: `getBoundingClientRect()` reports an element's full box even
 * where an ancestor's `overflow: hidden` clips it, so a box comparison both
 * misses real overlap (a grid item's own box is always its column, whatever its
 * contents do — which is how this shipped) and invents false ones (a control
 * correctly clipped at the edge). `elementFromPoint` answers the only question
 * worth asking: at this pixel, what does a person see?
 */
export async function expectNoNavOverlap(page: Page, label: string): Promise<void> {
  const report = await page.evaluate(() => {
    const nav = document.querySelector('.sidebar');
    const shell = document.querySelector('.shell');
    if (!nav || !shell) return { navWidth: 0, outside: [], inside: [] };
    const navWidth = nav.getBoundingClientRect().width;
    const height = shell.getBoundingClientRect().height;
    const describe = (el: Element | null, x: number, y: number): string => {
      if (!el) return `nothing at ${x},${y}`;
      const cls = (el.getAttribute('class') ?? '').split(' ')[0];
      return `${el.tagName.toLowerCase()}.${cls} at ${x},${y} "${(el.textContent ?? '').trim().slice(0, 24)}"`;
    };
    const outside: string[] = [];
    const inside: string[] = [];
    // Two pixels of slack at the seam, where the column's own 1 px border lives.
    for (let y = 4; y < height - 4; y += 6) {
      const right = document.elementFromPoint(navWidth + 3, y);
      if (right && nav.contains(right)) outside.push(describe(right, navWidth + 3, y));
      const left = document.elementFromPoint(navWidth - 6, y);
      if (left && !nav.contains(left) && left.closest('.pane, .iris-rail')) inside.push(describe(left, navWidth - 6, y));
    }
    return { navWidth, outside: outside.slice(0, 6), inside: inside.slice(0, 6) };
  });
  expect(report.outside, `${label}: the navigation paints outside its ${report.navWidth}px column`).toEqual([]);
  expect(report.inside, `${label}: a pane paints inside the ${report.navWidth}px navigation column`).toEqual([]);
}

/** The panel state, driven through the controls a person would use. */
export async function setPanel(page: Page, panel: Panel): Promise<void> {
  const shell = page.locator('.shell');
  if ((await shell.getAttribute('data-iris')) === panel) return;
  const reopen = page.locator('.pane-app').getByRole('button', { name: /^Open Iris/ });
  if (panel === 'open') {
    await reopen.click();
  } else {
    if ((await shell.getAttribute('data-iris')) !== 'open') await reopen.click();
    await page.locator('.pane-iris').getByRole('button', { name: /^Hide Iris/ }).click();
    if (panel === 'hidden') {
      await reopen.click();
      await page.getByRole('button', { name: 'Session options' }).click();
      await page.getByRole('menuitem', { name: 'Hide completely' }).click();
    }
  }
  await expect(shell).toHaveAttribute('data-iris', panel);
}
