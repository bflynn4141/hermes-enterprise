// T1–T6: the transcript's scroll model and the run surface's order, against
// the live stack and the scripted provider (decisions C38 and C40).
//
// Everything here is measured from the browser's own boxes rather than from a
// class name, because every one of these defects was invisible in the DOM and
// obvious on screen: the markup was right and the rectangle was wrong.
//
// Run with `pnpm e2e:live`, or against a stack you already have:
//
//   E2E_BASE_URL=http://localhost:8788 pnpm --filter client e2e live-transcript
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8788';
const SEED_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SEED_ADMIN = 'maya@nous.example';

async function asUser(browser: Browser, devUser: string): Promise<BrowserContext> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-dev-user': devUser } });
  await context.addInitScript((id) => {
    try {
      window.localStorage.setItem('hermes:dev-user', id as string);
    } catch {
      /* the header still carries it */
    }
  }, devUser);
  return context;
}

async function newSession(page: Page, title: string): Promise<string> {
  const response = await page.request.post(`/w/${SEED_WORKSPACE}/sessions`, { data: { title }, headers: { origin: ORIGIN } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()).id as string;
}

async function openSession(browser: Browser, title: string): Promise<Page> {
  const context = await asUser(browser, SEED_ADMIN);
  const page = await context.newPage();
  const id = await newSession(await context.newPage(), title);
  await page.goto(`/workspace/${SEED_WORKSPACE}/s/${id}`);
  await expect(page.getByRole('textbox', { name: /^Message/ })).toBeVisible();
  return page;
}

/**
 * Record the last user message's top offset on every frame.
 *
 * Sampling from the test process is too slow to catch the send-scroll: by the
 * time a round trip returns, the reply has already grown past the viewport and
 * a pinned reader has quite correctly followed it down. The claim being tested
 * is about the *first* position after the message lands, so the recorder runs
 * in the page and the assertion reads the first frame it saw.
 */
async function recordTops(page: Page, expected: number): Promise<void> {
  await page.evaluate((count) => {
    const store: number[] = [];
    (window as unknown as { __tops: number[] }).__tops = store;
    const tick = (): void => {
      const scroll = document.querySelector('.pane-iris .scroll');
      const transcript = document.querySelector('.pane-iris .transcript');
      const messages = document.querySelectorAll('.pane-iris .msg-user');
      const last = messages[messages.length - 1];
      // Only the frames on which the message being sent actually exists: a
      // recorder started before the send would otherwise open its log with the
      // *previous* question's position.
      if (scroll && transcript && last && messages.length === count) {
        // Measured against the transcript's own top inset rather than the
        // container's border edge. The padding is the layout's, not the scroll
        // position's: a message flush against the border would be the bug on
        // the other side (decision C38).
        const inset = Number.parseFloat(getComputedStyle(transcript).paddingTop) || 0;
        store.push(Math.round(last.getBoundingClientRect().top - scroll.getBoundingClientRect().top - inset));
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, expected);
}

const firstTop = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __tops: number[] }).__tops[0] ?? NaN);

const send = async (page: Page, text: string): Promise<void> => {
  await page.getByRole('textbox', { name: /^Message/ }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
};

/** `scrollHeight - scrollTop - clientHeight`: 0 is pinned to the bottom. */
const gap = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const el = document.querySelector('.pane-iris .scroll');
    if (!el) return -1;
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
  });

// ---------------------------------------------------------------------------
// T1 · the send-scroll
// ---------------------------------------------------------------------------

test('T1 · on send the new user message sits at the top of the transcript viewport', async ({ browser }) => {
  const page = await openSession(browser, 'T1 send-scroll');
  await recordTops(page, 1);
  await send(page, 'Screen the applicant.');
  await expect(page.locator('.pane-iris .msg-user')).toHaveCount(1);
  await expect.poll(() => firstTop(page), { timeout: 10_000 }).not.toBeNaN();

  // The first frame the message existed for: its top edge is the viewport's
  // top edge. Before this change it was wherever the old bottom happened to be
  // — which at 800 px is behind the composer.
  const top = await firstTop(page);
  expect(top, `first recorded top offset ${top}`).toBeLessThanOrEqual(8);
  expect(top, `first recorded top offset ${top}`).toBeGreaterThanOrEqual(-8);

  // And that same position is the bottom of the scroll range. That is what the
  // tail spacer buys: the reader is pinned *and* reading from the top of their
  // own question, rather than having to choose.
  expect(await gap(page)).toBeLessThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// T2 · pinned while streaming
// ---------------------------------------------------------------------------

test('T2 · a reader at the bottom stays at the bottom for the whole run', async ({ browser }) => {
  const page = await openSession(browser, 'T2 pinned');
  await send(page, 'Screen the applicant.');

  const samples: number[] = [];
  for (let i = 0; i < 12; i += 1) {
    samples.push(await gap(page));
    await page.waitForTimeout(400);
  }
  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 25_000 });
  samples.push(await gap(page));

  // One pixel of tolerance for sub-pixel layout; anything more is a jump.
  expect(Math.max(...samples), `gaps: ${samples.join(', ')}`).toBeLessThanOrEqual(1);
  // And nothing put the chip up while the reader never moved.
  await expect(page.locator('.jump-latest')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// T3 · a reader who scrolls up keeps their place
// ---------------------------------------------------------------------------

test('T3 · scrolling up mid-run holds the position and offers Jump to latest', async ({ browser }) => {
  const page = await openSession(browser, 'T3 scrolled away');
  // One completed turn first, so there is something above to scroll up *to*.
  // Without it the transcript is shorter than the viewport and "scrolled away"
  // is not a position the reader can be in.
  await send(page, 'Screen the applicant.');
  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 25_000 });
  await send(page, 'And now the second one.');
  await expect(page.locator('.pane-iris .msg-user')).toHaveCount(2);

  await page.evaluate(() => {
    const el = document.querySelector('.pane-iris .scroll')!;
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });

  await expect(page.locator('.jump-latest')).toBeVisible();
  const held = await page.evaluate(() => Math.round(document.querySelector('.pane-iris .scroll')!.scrollTop));

  // The run keeps producing events the whole time; none of them may move it.
  await page.waitForTimeout(2500);
  const after = await page.evaluate(() => Math.round(document.querySelector('.pane-iris .scroll')!.scrollTop));
  expect(after).toBe(held);
  await expect(page.locator('.jump-latest')).toBeVisible();

  // And the chip is the way back.
  await page.getByRole('button', { name: /Jump to latest/ }).click();
  await expect.poll(() => gap(page), { timeout: 5_000 }).toBeLessThanOrEqual(1);
  await expect(page.locator('.jump-latest')).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// T4 · nothing is drawn underneath the composer or the header
// ---------------------------------------------------------------------------

test('T4 · no transcript content is hidden behind the composer, at any composer height', async ({ browser }) => {
  const page = await openSession(browser, 'T4 clearance');

  const clearance = async (): Promise<{ scrollTop: number; scrollBottom: number; composerTop: number; headerBottom: number }> =>
    page.evaluate(() => {
      const scroll = document.querySelector('.pane-iris .scroll')!.getBoundingClientRect();
      const composer = document.querySelector('.pane-iris .composer-wrap')!.getBoundingClientRect();
      const header = document.querySelector('.pane-iris .pane-subheader')!.getBoundingClientRect();
      return {
        scrollTop: Math.round(scroll.top),
        scrollBottom: Math.round(scroll.bottom),
        composerTop: Math.round(composer.top),
        headerBottom: Math.round(header.bottom),
      };
    });

  // Empty composer.
  let boxes = await clearance();
  expect(boxes.scrollBottom).toBeLessThanOrEqual(boxes.composerTop + 1);
  expect(boxes.scrollTop).toBeGreaterThanOrEqual(boxes.headerBottom - 1);

  await send(page, 'Screen the applicant.');
  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 25_000 });

  // The composer autosizes to 208 px; a tall draft is the worst case for the
  // clearance, and it is a state a person reaches by typing.
  await page.getByRole('textbox', { name: /^Message/ }).fill('line\n'.repeat(14));
  await page.waitForTimeout(300);
  boxes = await clearance();
  expect(boxes.scrollBottom).toBeLessThanOrEqual(boxes.composerTop + 1);
  expect(boxes.scrollTop).toBeGreaterThanOrEqual(boxes.headerBottom - 1);

  // And the message a send just anchored is wholly inside that band — not
  // clipped by the subheader, which is the screenshot this began with.
  await recordTops(page, 2);
  await send(page, 'One more, with the composer tall.');
  await expect(page.locator('.pane-iris .msg-user')).toHaveCount(2);
  const box = await page.evaluate(() => {
    const scroll = document.querySelector('.pane-iris .scroll')!.getBoundingClientRect();
    const messages = document.querySelectorAll('.pane-iris .msg-user');
    const last = messages[messages.length - 1]!.getBoundingClientRect();
    return {
      above: Math.round(scroll.top - last.top),
      below: Math.round(last.bottom - scroll.bottom),
    };
  });
  expect(box.above, `${box.above} px above the top of the scroll region`).toBeLessThanOrEqual(1);
  expect(box.below, `${box.below} px below the bottom of the scroll region`).toBeLessThanOrEqual(1);
});

// ---------------------------------------------------------------------------
// T5 · the run surface's order
// ---------------------------------------------------------------------------

test('T5 · activity is one collapsed line above the reply, and only when a tool ran', async ({ browser }) => {
  const page = await openSession(browser, 'T5 order');
  await send(page, 'Screen the applicant.');
  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 25_000 });

  // One muted line, with the count. Not a step list, and not a "Thinking" row:
  // the engine emits one of those per model call and it says nothing a reader
  // can act on (decision C44).
  const summary = page.locator('.pane-iris .activity-done > summary');
  await expect(summary).toHaveCount(1);
  await expect(summary).toHaveText(/^Done · \d+ steps?$/);
  await expect(page.locator('.pane-iris .run-surface').getByText('Thinking', { exact: true })).toHaveCount(0);

  // Measured across the whole transcript rather than inside one element: the
  // activity and the answer are deliberately two blocks with the turn's
  // finished messages between them, so "above" is a comparison of tops.
  const order = await page.evaluate(() => {
    const activity = document.querySelector('.pane-iris .run-surface');
    const reply = [...document.querySelectorAll('.pane-iris .msg-iris')].pop();
    if (!activity || !reply) return null;
    return {
      activityTop: Math.round(activity.getBoundingClientRect().top),
      replyTop: Math.round(reply.getBoundingClientRect().top),
    };
  });
  expect(order, 'the run surface and a reply are both on screen').not.toBeNull();
  expect(order!.activityTop, JSON.stringify(order)).toBeLessThan(order!.replyTop);

  // Collapsed by default; the tool rows are behind the disclosure.
  await expect(page.locator('.pane-iris .activity-done')).not.toHaveAttribute('open', /.*/);
  await summary.click();
  await expect(page.locator('.pane-iris .activity-done')).toHaveAttribute('open', /.*/);
  await expect(page.locator('.pane-iris .activity-done').getByText('propose_request')).toBeVisible();
});

// ---------------------------------------------------------------------------
// T6 · a second send re-anchors
// ---------------------------------------------------------------------------

test('T6 · the second question goes to the top too, with the first run above it', async ({ browser }) => {
  const page = await openSession(browser, 'T6 second send');
  await send(page, 'Screen the applicant.');
  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 25_000 });

  await recordTops(page, 2);
  await send(page, 'And the second one.');
  await expect(page.locator('.pane-iris .msg-user')).toHaveCount(2);
  await expect.poll(() => firstTop(page), { timeout: 10_000 }).not.toBeNaN();

  // The recorder was started after the first run finished, so its first frame
  // is the second question — and it is at the top, with the first exchange
  // scrolled above it.
  const top = await firstTop(page);
  expect(top, `first recorded top offset ${top}`).toBeLessThanOrEqual(8);
  expect(top, `first recorded top offset ${top}`).toBeGreaterThanOrEqual(-8);
});

// ---------------------------------------------------------------------------
// T7 · a refused turn says so
// ---------------------------------------------------------------------------

test('T7 · a refused turn shows the server’s sentence, keeps the draft, and does not rename the session', async ({ browser }) => {
  const page = await openSession(browser, 'T7 refusal');

  // The refusal is injected rather than provoked, and that is deliberate: the
  // scripted provider is the whole point of this stack, and `MODEL_SCRIPTED=1`
  // skips the provider-key check that produces `no_key` — so the only way to
  // drive this path here would be to turn the scripted provider off, which is
  // the one thing this suite must never do (decision C43). The body below is
  // the Worker's own, copied from the response Brian saw. Everything after the
  // interception is the real client against the real stack.
  await page.route('**/turns', async (route) => {
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Add a deepseek key in Settings to start', reason: 'no_key' }),
    });
  });

  const titleBefore = await page.locator('.pane-iris .pane-subheader .current').innerText();
  const composer = page.getByRole('textbox', { name: /^Message/ });
  await composer.fill('testing');
  await page.getByRole('button', { name: 'Send message' }).click();

  // The sentence, verbatim, and the route to the fix.
  const refusal = page.locator('.composer-refusal');
  await expect(refusal).toBeVisible();
  await expect(refusal).toContainText('Add a deepseek key in Settings to start');
  await expect(refusal.getByRole('button', { name: /Provider keys/ })).toBeVisible();

  // The draft is still there, and so is the caret.
  await expect(composer).toHaveValue('testing');
  await expect(composer).toBeFocused();

  // Nothing ran, so nothing is named after it: the session kept its title and
  // no message was added.
  await expect(page.locator('.pane-iris .pane-subheader .current')).toHaveText(titleBefore);
  await expect(page.locator('.pane-iris .msg-user')).toHaveCount(0);

  // Corrected — here by removing the refusal, as switching to a model with a
  // key would — the same draft sends, and the refusal goes with it.
  await page.unroute('**/turns');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.pane-iris .msg-user')).toHaveCount(1);
  await expect(refusal).toHaveCount(0);
  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 25_000 });
});
