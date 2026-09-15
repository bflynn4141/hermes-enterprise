// The Iris panel and the sessions list, against the live stack.
//
// Same stack as `live.spec.ts` — Docker Postgres, the migrations, `wrangler dev
// --local` with `AUTH_MODE=fake` and `MODEL_SCRIPTED=1`. These scenarios are
// here rather than in the mock suite because each one is about something the
// mock cannot prove: a real run finishing while the panel is collapsed, a
// PATCHed title surviving a reload, a width surviving a reload.
//
//   N1  ⌘L toggles, and reopening returns focus to the composer
//   N2  the drag persists across a reload, and the handle's keyboard range
//   N3  a run that completes while collapsed badges the rail, and opening clears it
//   N4  every page renders in the rail state
//   N5  New session twice is one session, not two identical rows
//   N6  the first turn names the session, and the run renames it to its object
//   N7  a manual rename wins, and stops auto-titling for good
//   N8  the navigation keeps its own column at 900 and 1100, in all three states
import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { freshWorkspace } from '../scripts/live-fixture.mjs';
import { expectNoNavOverlap, type Panel } from './panel-helpers.js';

const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8788';

const pane = (page: Page): Locator => page.getByRole('region', { name: 'Application' });
const shell = (page: Page): Locator => page.locator('.shell');
const sidebar = (page: Page): Locator => page.locator('.sidebar');
/** The app header's reopen button. The rail's mark carries the same name on purpose. */
const reopen = (page: Page): Locator => page.locator('.pane-app').getByRole('button', { name: /^Open Iris/ });
const hide = (page: Page): Locator => page.locator('.pane-iris').getByRole('button', { name: /^Hide Iris/ });

async function asUser(browser: Browser, devUser: string): Promise<BrowserContext> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-dev-user': devUser } });
  await context.addInitScript((id) => {
    try {
      window.localStorage.setItem('hermes:dev-user', id as string);
    } catch {
      /* a context with storage disabled still has the header */
    }
  }, devUser);
  return context;
}

async function openShell(page: Page, workspaceId: string): Promise<void> {
  await page.goto(`/workspace/${workspaceId}`);
  await expect(sidebar(page).getByRole('button', { name: 'Agents', exact: true })).toBeVisible({ timeout: 20_000 });
}

async function newSession(page: Page, workspaceId: string, title = 'Panel'): Promise<string> {
  const response = await page.request.post(`/w/${workspaceId}/sessions`, { data: { title, mode: 'work' }, headers: { origin: ORIGIN } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return (await response.json()).id as string;
}

async function turn(page: Page, workspaceId: string, sessionId: string, text: string): Promise<void> {
  const response = await page.request.post(`/w/${workspaceId}/sessions/${sessionId}/turns`, {
    // No `model_id`: the session carries the workspace default (decision R13).
    data: { text, client_turn_id: randomUUID(), attachments: [], mode: 'work', effort: null },
    headers: { origin: ORIGIN },
  });
  expect(response.status(), await response.text()).toBeLessThan(300);
}

async function settle(page: Page, workspaceId: string, sessionId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(`/w/${workspaceId}/traces?session=${sessionId}`);
        return (await response.json()).items[0]?.status ?? 'none';
      },
      { timeout: 45_000, intervals: [500] },
    )
    .not.toBe('working');
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/**
 * The composer, once it is usable.
 *
 * A fresh workspace's provider-key rows arrive a beat after the shell does, and
 * until they do the composer is greyed with "Add your OpenRouter key in Settings to
 * start" — which is correct behaviour and a race for anything that wants to
 * type. Every test that types waits here first.
 */
async function composer(page: Page): Promise<Locator> {
  const el = page.locator('textarea[data-composer="true"]');
  await expect(el).toBeEnabled({ timeout: 20_000 });
  return el;
}

// ---------------------------------------------------------------------------
// N1 · the shortcut
// ---------------------------------------------------------------------------

test('N1 · ⌘L collapses to the rail and reopens, and reopening focuses the composer', async ({ browser }) => {
  const fixture = freshWorkspace('Panel shortcut');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1840, height: 1000 });
  await openShell(page, fixture.workspaceId);
  await newSession(page, fixture.workspaceId, 'N1 shortcut');
  await page.reload();
  await expect(shell(page)).toHaveAttribute('data-iris', 'open');

  // From anywhere in the shell.
  await pane(page).click({ position: { x: 40, y: 200 } });
  await page.keyboard.press(`${MOD}+l`);
  await expect(shell(page)).toHaveAttribute('data-iris', 'rail');
  await expect(page.locator('.iris-rail')).toBeVisible();

  await page.keyboard.press(`${MOD}+l`);
  await expect(shell(page)).toHaveAttribute('data-iris', 'open');
  // Reopening puts the cursor back where the person was typing.
  await expect(await composer(page)).toBeFocused();

  // And from inside the composer it still collapses — the one input the
  // shortcut is allowed to fire in — handing focus to the app.
  await (await composer(page)).fill('half a sentence');
  await page.keyboard.press(`${MOD}+l`);
  await expect(shell(page)).toHaveAttribute('data-iris', 'rail');
  await expect(pane(page)).toBeFocused();

  // The draft is not lost by collapsing.
  await reopen(page).click();
  await expect(page.locator('textarea[data-composer="true"]')).toHaveValue('half a sentence');

  // "Hide completely" takes the rail away too, and the app header brings it back.
  await page.getByRole('button', { name: 'Session options' }).click();
  await page.getByRole('menuitem', { name: 'Hide completely' }).click();
  await expect(shell(page)).toHaveAttribute('data-iris', 'hidden');
  await expect(page.locator('.iris-rail')).toHaveCount(0);
  await reopen(page).click();
  await expect(shell(page)).toHaveAttribute('data-iris', 'open');
  await context.close();
});

// ---------------------------------------------------------------------------
// N2 · the drag handle
// ---------------------------------------------------------------------------

test('N2 · the boundary drags, clamps, resets, and the width survives a reload', async ({ browser }) => {
  const fixture = freshWorkspace('Panel resize');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1840, height: 1000 });
  await openShell(page, fixture.workspaceId);
  await newSession(page, fixture.workspaceId, 'N2 resize');
  await page.reload();

  const handle = page.getByRole('separator', { name: /Resize the Iris panel/ });
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  // 1840 = 240 nav + 800 + 800, so the default is the demo's own layout.
  await expect(handle).toHaveAttribute('aria-valuenow', '800');
  await expect(handle).toHaveAttribute('aria-valuemin', '420');
  // 60 percent of the 1600 px work area.
  await expect(handle).toHaveAttribute('aria-valuemax', '960');

  // The handle moves with the boundary, so its box is re-read before each drag.
  const dragTo = async (x: number): Promise<void> => {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, 500);
    await page.mouse.down();
    await page.mouse.move(x, 500, { steps: 8 });
    await page.mouse.up();
  };

  await dragTo(700);
  await expect(handle).toHaveAttribute('aria-valuenow', '460');

  // The keyboard has the same range as the pointer.
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '484');
  await page.keyboard.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', '420');
  await page.keyboard.press('End');
  await expect(handle).toHaveAttribute('aria-valuenow', '960');
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '960');

  // A width somebody set survives a reload; Enter puts it back to the default,
  // and *that* survives too, as "nothing remembered" rather than as 800.
  await dragTo(900);
  await expect(handle).toHaveAttribute('aria-valuenow', '660');
  await page.reload();
  const after = page.getByRole('separator', { name: /Resize the Iris panel/ });
  await expect(after).toHaveAttribute('aria-valuenow', '660');

  await after.focus();
  await page.keyboard.press('Enter');
  await expect(after).toHaveAttribute('aria-valuenow', '800');
  await page.reload();
  await expect(page.getByRole('separator', { name: /Resize the Iris panel/ })).toHaveAttribute('aria-valuenow', '800');
  await context.close();
});

// ---------------------------------------------------------------------------
// N3 · a run that finishes behind the rail
// ---------------------------------------------------------------------------

test('N3 · a run completing while collapsed badges the rail, and opening clears it', async ({ browser }) => {
  const fixture = freshWorkspace('Panel badge');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1840, height: 1000 });
  await openShell(page, fixture.workspaceId);
  const sessionId = await newSession(page, fixture.workspaceId, 'N3 badge');
  await page.reload();
  await sidebar(page).getByRole('button', { name: /N3 badge/ }).click();

  await hide(page).click();
  await expect(page.locator('.iris-rail')).toBeVisible();

  // The run starts behind the rail and is never interrupted by the collapse.
  await turn(page, fixture.workspaceId, sessionId, 'Screen the applicant.');
  // The mark reports the live state rather than going grey.
  await expect(page.locator('.iris-rail .iris-motion')).toHaveAttribute('data-state', /reading|comparing/, { timeout: 20_000 });
  await settle(page, fixture.workspaceId, sessionId);

  const badge = page.locator('.rail-badge');
  await expect(badge).toBeVisible({ timeout: 20_000 });
  await expect(badge).not.toHaveText('0');
  // The rail's label says the same thing to a screen reader.
  await expect(page.locator('.iris-rail').getByRole('button', { name: /Open Iris .*unread/ })).toBeVisible();

  await page.locator('.iris-rail').getByRole('button', { name: /^Open Iris/ }).click();
  await expect(shell(page)).toHaveAttribute('data-iris', 'open');
  await expect(page.locator('.rail-badge')).toHaveCount(0);
  // And the transcript the badge was counting is there.
  await expect(page.locator('.pane-iris .msg-iris').first()).toBeVisible();
  await context.close();
});

// ---------------------------------------------------------------------------
// N4 · every page, collapsed
// ---------------------------------------------------------------------------

test('N4 · every page in the navigation renders with the panel collapsed to the rail', async ({ browser }) => {
  const fixture = freshWorkspace('Panel pages');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1840, height: 1000 });
  await openShell(page, fixture.workspaceId);
  await newSession(page, fixture.workspaceId, 'N4 pages');
  await page.reload();
  await hide(page).click();
  await expect(page.locator('.iris-rail')).toBeVisible();

  for (const [label, heading] of [
    ['Agents', 'Iris'],
    ['Inbox', 'Inbox'],
    ['Members', 'Members'],
    ['History', 'History'],
    ['Library', 'Library'],
    ['Settings', 'Settings'],
  ] as const) {
    await sidebar(page).getByRole('button', { name: new RegExp(`^${label}`) }).click();
    await expect(pane(page).getByRole('heading', { name: heading }).first()).toBeVisible({ timeout: 15_000 });
    // The rail survives every navigation: collapsing is not undone by moving.
    await expect(shell(page)).toHaveAttribute('data-iris', 'rail');
    // Nothing scrolls sideways at full width.
    const overflow = await page.evaluate(() => {
      const el = document.querySelector('.pane-app');
      return el ? el.scrollWidth - el.clientWidth : 0;
    });
    expect(overflow, `${label} overflows its pane`).toBeLessThanOrEqual(1);
  }
  await context.close();
});

// ---------------------------------------------------------------------------
// N5–N7 · the sessions list
// ---------------------------------------------------------------------------

test('N5 · New session twice is one session, and blank sessions are not listed twice', async ({ browser }) => {
  const fixture = freshWorkspace('Sessions reuse');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1840, height: 1000 });
  await openShell(page, fixture.workspaceId);

  const newButton = sidebar(page).getByRole('button', { name: 'New session' });
  await newButton.click();
  await expect(shell(page)).toHaveAttribute('data-iris', 'open');
  await expect(await composer(page)).toBeFocused();
  // The rows, not the action: `[data-row]` is what `SidebarNav` marks a recent
  // with, and the action button beside it carries the same accessible name.
  const rows = sidebar(page).locator('[data-row]').filter({ hasText: 'New session' });

  await newButton.click();
  await newButton.click();
  // One blank session in the list — the one you are in — however many times the
  // control is pressed. The row that says "New session" is the action itself.
  await expect(rows).toHaveCount(1);
  // On the server too, which is the half that was actually broken: the second
  // click used to create a twin because the first one's row was still pending.
  // Waited for rather than read once — the create POST is in flight — and then
  // read again after it has settled, so a late second row still fails this.
  const count = async (): Promise<number> => ((await (await page.request.get(`/w/${fixture.workspaceId}/sessions`)).json()).items as unknown[]).length;
  await expect.poll(count, { timeout: 20_000, intervals: [250] }).toBe(1);
  await page.waitForTimeout(1500);
  expect(await count()).toBe(1);

  // Collapsed, the same control is on the rail, and it opens the panel too.
  await hide(page).click();
  await page.locator('.iris-rail').getByRole('button', { name: 'New session' }).click();
  await expect(shell(page)).toHaveAttribute('data-iris', 'open');
  await context.close();
});

test('N6 · the first turn names the session, and a finished run renames it to its object', async ({ browser }) => {
  const fixture = freshWorkspace('Sessions titles');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();

  // The two titles are recorded from the PATCHes themselves rather than polled
  // from `GET /sessions`. They have to be: the whole sequence — first turn,
  // run, refinement — finishes in about eight seconds, so a poll that asks
  // "does the server say 'Screen the applicant'?" is racing the rename that
  // replaces it, and would pass or fail depending on the machine.
  const titles: string[] = [];
  page.on('response', async (response) => {
    const request = response.request();
    if (request.method() !== 'PATCH' || !/\/sessions\/[0-9a-f-]+$/.test(new URL(response.url()).pathname)) return;
    try {
      titles.push((await response.json()).title as string);
    } catch {
      /* a body that is not JSON is not a title */
    }
  });

  await page.setViewportSize({ width: 1840, height: 1000 });
  await openShell(page, fixture.workspaceId);
  await sidebar(page).getByRole('button', { name: 'New session' }).click();
  const box = await composer(page);
  await expect(box).toBeFocused();

  await box.fill('Screen the applicant and say what is missing');
  await page.keyboard.press('Enter');

  // Six words, immediately — not after the run, and not after a round trip.
  await expect(sidebar(page).getByRole('button', { name: /Screen the applicant and say what/ })).toBeVisible({ timeout: 10_000 });
  await expect(sidebar(page).locator('[data-row]').filter({ hasText: 'Untitled session' })).toHaveCount(0);
  await expect.poll(() => titles[0] ?? '', { timeout: 20_000, intervals: [250] }).toBe('Screen the applicant and say what');

  // And once the run has produced a request, the object names the session —
  // "Ada Ling · application" rather than the question that started it.
  await expect.poll(() => titles[titles.length - 1] ?? '', { timeout: 60_000, intervals: [500] }).toMatch(/^\S.* · \w+$/);
  const final = titles[titles.length - 1]!;

  // It is the server's row now, so it survives a reload rather than living in
  // this tab, and it is not re-derived as something the client may overwrite.
  await page.reload();
  await expect(sidebar(page).getByRole('button', { name: new RegExp(final.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeVisible({ timeout: 20_000 });
  await context.close();
});

test('N7 · a manual rename wins, and later runs never overwrite it', async ({ browser }) => {
  const fixture = freshWorkspace('Sessions rename');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1840, height: 1000 });
  await openShell(page, fixture.workspaceId);
  const sessionId = await newSession(page, fixture.workspaceId, 'N7 rename');
  await page.reload();
  await sidebar(page).getByRole('button', { name: /N7 rename/ }).click();

  await page.getByRole('button', { name: 'Session options' }).click();
  await page.getByRole('menuitem', { name: 'Rename session' }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename session' });
  await dialog.getByRole('textbox').fill('Q4 partners');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(sidebar(page).getByRole('button', { name: /Q4 partners/ })).toBeVisible();

  // A turn and a whole run, both of which would otherwise have renamed it.
  await turn(page, fixture.workspaceId, sessionId, 'Screen the applicant.');
  await settle(page, fixture.workspaceId, sessionId);

  await expect(sidebar(page).getByRole('button', { name: /Q4 partners/ })).toBeVisible();
  const response = await page.request.get(`/w/${fixture.workspaceId}/sessions`);
  expect(((await response.json()).items as { title: string }[])[0]!.title).toBe('Q4 partners');
  // And it is still theirs after a reload, not re-derived as "auto".
  await page.reload();
  await expect(sidebar(page).getByRole('button', { name: /Q4 partners/ })).toBeVisible();
  await context.close();
});

// ---------------------------------------------------------------------------
// N8 · the navigation's column at narrow widths
// ---------------------------------------------------------------------------

test('N8 · the navigation keeps its own column at 900 and 1100, in all three states', async ({ browser }) => {
  const fixture = freshWorkspace('Panel narrow');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1840, height: 1000 });
  await openShell(page, fixture.workspaceId);
  await newSession(page, fixture.workspaceId, 'N8 narrow');
  await page.reload();

  for (const [width, height] of [
    [900, 700],
    [1100, 800],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const panel of ['open', 'rail', 'hidden'] as Panel[]) {
      // Driven through the controls rather than the helper's, because at 900 a
      // collapsed panel leaves no rail and the helper's route through "Hide
      // completely" needs the chat header, which is only there when open.
      if (panel === 'open') {
        if ((await shell(page).getAttribute('data-iris')) !== 'open') await reopen(page).click();
      } else {
        if ((await shell(page).getAttribute('data-iris')) !== 'open') await reopen(page).click();
        await hide(page).click();
        if (panel === 'hidden') {
          await reopen(page).click();
          await page.getByRole('button', { name: 'Session options' }).click();
          await page.getByRole('menuitem', { name: 'Hide completely' }).click();
        }
      }
      await expect(shell(page)).toHaveAttribute('data-iris', panel);
      await expectNoNavOverlap(page, `live ${width} ${panel}`);

      // The rail needs room beside a usable app pane, so it is only shown at
      // or above the pane-switch breakpoint.
      await expect(page.locator('.iris-rail')).toHaveCount(width >= 1000 && panel === 'rail' ? 1 : 0);
      // And the shell never scrolls, in either direction.
      const scrolled = await page.evaluate(() => {
        const outer = document.querySelector('.shell-outer');
        return { top: outer?.scrollTop ?? 0, left: outer?.scrollLeft ?? 0 };
      });
      expect(scrolled, `${width} ${panel}: the shell scrolled`).toEqual({ top: 0, left: 0 });
    }
  }
  await context.close();
});
