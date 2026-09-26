// `pnpm walkthrough:record` — records the product walkthrough as an MP4.
//
// It serves the mock build, opens `/?walkthrough=reset` in Chromium and plays
// the story in docs/WALKTHROUGH.md the way a person would: a visible cursor
// that travels to what it clicks, prompts typed a key at a time, pauses to
// read. Frames come from Chromium's screencast at 2x and are piped straight
// into ffmpeg at a constant 30 fps, so nothing large lands on disk.
//
//   pnpm --filter @hermes/client walkthrough:record
//   pnpm --filter @hermes/client walkthrough:record -- --out ~/Desktop/hermes.mp4 --headed
//
// Options: `--out <file>` (default `walkthrough/hermes-teams-walkthrough.mp4`
// under the client), `--port <n>` (default 4395), `--headed` to watch it, and
// `--size 1920x1080` for a smaller file (default 2560x1440). A chapter file
// with the start time of every beat is written beside the video, for narration.
//
// Everything on screen is the real client; the agent replies are scripted
// (`src/model/walkthrough.ts`). Requires ffmpeg on PATH.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const client = resolve(here, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(option('port', '4395'));
const out = resolve(option('out', resolve(client, 'walkthrough/hermes-teams-walkthrough.mp4')).replace(/^~/, process.env.HOME ?? '~'));
const [outWidth, outHeight] = option('size', '2560x1440').split('x').map(Number);
const headed = args.includes('--headed');
const FPS = 30;
const VIEWPORT = { width: 1680, height: 945 };

// ---------------------------------------------------------------------------
// The mock build on its own port.
// ---------------------------------------------------------------------------

async function serve() {
  const server = spawn('node', ['build.mjs', '--serve'], { cwd: client, env: { ...process.env, MOCK: '1', PORT: String(port) }, stdio: ['ignore', 'pipe', 'inherit'] });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(base)).ok) return { base, stop: () => server.kill() };
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  server.kill();
  throw new Error(`The mock build did not start on port ${port}.`);
}

// ---------------------------------------------------------------------------
// Frames → ffmpeg at a constant frame rate.
// ---------------------------------------------------------------------------

function encoder() {
  mkdirSync(dirname(out), { recursive: true });
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    // Screencast JPEGs are full range; QuickTime and phones expect TV-range BT.709.
    '-vf', `scale=${outWidth}:${outHeight}:flags=lanczos:in_range=full:out_range=tv,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-tag:v', 'avc1',
    '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))));
  let started = null;
  let written = 0;
  let last = null;
  // A frame arrives only when something painted; hold the previous one until
  // the clock says the next is due, so the timing on screen is the real one.
  const fill = (until) => {
    while (last && written < until) {
      ffmpeg.stdin.write(last);
      written += 1;
    }
  };
  return {
    frame(buffer, timestamp) {
      started ??= timestamp;
      fill(Math.floor((timestamp - started) * FPS));
      last = buffer;
    },
    seconds: () => written / FPS,
    /** Time since the first frame, whether or not anything has painted since. */
    elapsed: () => (started === null ? 0 : Date.now() / 1000 - started),
    async finish(holdSeconds = 1) {
      fill(written + Math.round(holdSeconds * FPS));
      ffmpeg.stdin.end();
      await done;
    },
  };
}

// ---------------------------------------------------------------------------
// A visible cursor, because a screencast has none.
// ---------------------------------------------------------------------------

const CURSOR = () => {
  const install = () => {
    if (document.getElementById('walkthrough-cursor')) return;
    const cursor = document.createElement('div');
    cursor.id = 'walkthrough-cursor';
    cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 3l14 8.5-6.2 1.3L10 19z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-100px,-100px)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.45))' });
    const ring = document.createElement('div');
    Object.assign(ring.style, { position: 'fixed', left: '0', top: '0', width: '34px', height: '34px', margin: '-17px 0 0 -17px', borderRadius: '50%', border: '2px solid rgba(255,255,255,.85)', zIndex: '2147483646', pointerEvents: 'none', opacity: '0' });
    document.body.append(ring, cursor);
    addEventListener('mousemove', (event) => { cursor.style.transform = `translate(${event.clientX - 5}px,${event.clientY - 3}px)`; }, true);
    addEventListener('mousedown', (event) => {
      ring.style.transform = `translate(${event.clientX}px,${event.clientY}px) scale(.5)`;
      ring.animate([{ opacity: 1, transform: `translate(${event.clientX}px,${event.clientY}px) scale(.5)` }, { opacity: 0, transform: `translate(${event.clientX}px,${event.clientY}px) scale(1.3)` }], { duration: 450, easing: 'ease-out' });
    }, true);
  };
  if (document.body) install();
  else addEventListener('DOMContentLoaded', install);
};

// ---------------------------------------------------------------------------
// The person.
// ---------------------------------------------------------------------------

const pause = (page, ms) => page.waitForTimeout(ms);
const jitter = (min, max) => min + Math.random() * (max - min);
let mouse = { x: VIEWPORT.width * 0.55, y: VIEWPORT.height * 0.6 };

async function moveTo(page, locator, { dx = 0, dy = 0 } = {}) {
  await locator.waitFor({ state: 'visible', timeout: 30_000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Target has no box');
  const target = { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
  const distance = Math.hypot(target.x - mouse.x, target.y - mouse.y);
  const steps = Math.max(12, Math.min(45, Math.round(distance / 22)));
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    await page.mouse.move(mouse.x + (target.x - mouse.x) * eased, mouse.y + (target.y - mouse.y) * eased);
    await pause(page, 12);
  }
  mouse = target;
}

async function click(page, locator, options) {
  await moveTo(page, locator, options);
  await pause(page, jitter(180, 320));
  await page.mouse.down();
  await pause(page, 70);
  await page.mouse.up();
}

async function type(page, text) {
  for (const character of text) {
    await page.keyboard.type(character);
    // Faster inside words, a beat after punctuation, the odd hesitation.
    const base = /[,.?!]/.test(character) ? jitter(160, 280) : character === ' ' ? jitter(50, 110) : jitter(28, 70);
    await pause(page, Math.random() < 0.03 ? base + jitter(200, 420) : base);
  }
}

/**
 * Scrolls the target's own scroll container, a few pixels at a time, until
 * the target sits at the bottom (`end`) or top (`start`) of the view. Wheel
 * events stop at the first nested scroller, which is not what a reader sees.
 */
async function scrollTo(page, locator, { block = 'end', speed = 14 } = {}) {
  await locator.waitFor({ state: 'attached', timeout: 30_000 });
  const handle = await locator.elementHandle();
  for (let guard = 0; guard < 600; guard += 1) {
    const moved = await handle.evaluate((element, { block, speed }) => {
      let box = element.parentElement;
      while (box && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement;
      if (!box) return 0;
      const target = element.getBoundingClientRect();
      const view = box.getBoundingClientRect();
      const gap = block === 'end' ? target.bottom + 24 - view.bottom : target.top - 24 - view.top;
      if (Math.abs(gap) < 2) return 0;
      const before = box.scrollTop;
      box.scrollTop += Math.sign(gap) * Math.min(Math.abs(gap), speed);
      return box.scrollTop - before;
    }, { block, speed });
    if (!moved) return;
    await pause(page, 16);
  }
}

async function waitForRun(page) {
  await pause(page, 1_200);
  await page.getByRole('button', { name: 'Stop work' }).waitFor({ state: 'hidden', timeout: 90_000 });
}

async function switchTo(page, name) {
  await click(page, page.getByRole('button', { name: 'Your account' }));
  await pause(page, 900);
  await click(page, page.getByRole('button', { name: new RegExp(name) }));
  await page.waitForLoadState('load');
  await page.getByPlaceholder(/^Message /).waitFor({ timeout: 30_000 });
  await page.mouse.move(mouse.x, mouse.y);
  await pause(page, 1_800);
}

// ---------------------------------------------------------------------------
// The story. Chapter titles are the narration beats in docs/WALKTHROUGH.md.
// ---------------------------------------------------------------------------

const PROMPTS = {
  shortlist: 'Can you pull together a shortlist of partners who could run hands-on Hermes Agent workshops for our dev teams in November? Ideally people who have taught agent tooling before. Budget is around $15k.',
  handoff: 'Robin Studio looks great. Let’s go with them for Nov 18–19 at $14,500. Can you send it over to Finance so they can get the agreement started?',
  draft: 'Thanks, looks good. Can you draft the services agreement from our standard template? Net 30 after delivery, and keep the usual IP and confidentiality terms.',
};

async function story(page, chapter) {
  const app = page.getByRole('region', { name: 'Application' });
  const composer = page.getByPlaceholder(/^Message /);
  const receipts = page.locator('[aria-label="Requests prepared by this response"]');

  chapter('Maya opens Scout, the Partnerships agent');
  await pause(page, 3_000);

  chapter('Maya asks Scout for workshop partners');
  await click(page, composer);
  await pause(page, 500);
  await type(page, PROMPTS.shortlist);
  await pause(page, 700);
  await page.keyboard.press('Enter');

  chapter('Scout researches and scores candidates');
  await waitForRun(page);
  await pause(page, 1_000);

  chapter('Three scored candidates, each ready for review');
  await moveTo(page, page.locator('.msg-iris table').last(), { dx: 120 });
  await pause(page, 3_500);
  await moveTo(page, receipts.last());
  await pause(page, 1_500);

  chapter('Maya reviews Robin Studio’s evidence');
  await click(page, receipts.last().getByRole('button', { name: /Review/ }).first());
  await pause(page, 2_500);
  await moveTo(page, app.getByRole('heading', { name: 'Screening' }), { dx: 120 });
  await scrollTo(page, app.getByRole('heading', { name: 'Sources used' }), { block: 'start' });
  await pause(page, 2_500);
  await scrollTo(page, app.getByText('Scout screened this application'), { block: 'start', speed: 24 });
  await pause(page, 800);

  chapter('Maya approves Robin Studio');
  await click(page, app.getByRole('button', { name: /^Admit / }).last());
  await pause(page, 2_500);

  chapter('Maya hands the deal to Finance');
  await click(page, composer);
  await pause(page, 400);
  await type(page, PROMPTS.handoff);
  await pause(page, 600);
  await page.keyboard.press('Enter');
  await waitForRun(page);
  await pause(page, 3_500);

  chapter('Switching to Alex in Finance');
  await switchTo(page, 'Alex Rivera');

  chapter('Ledger already checked Scout’s handoff');
  await click(page, page.locator('.msg-agent-handoff summary').first());
  await pause(page, 3_500);
  await moveTo(page, page.locator('.msg-iris').first());
  await pause(page, 3_500);

  chapter('Alex asks Ledger for the services agreement');
  await click(page, composer);
  await pause(page, 400);
  await type(page, PROMPTS.draft);
  await pause(page, 600);
  await page.keyboard.press('Enter');
  await waitForRun(page);
  await pause(page, 3_000);

  chapter('Alex reviews the agreement');
  await click(page, receipts.last().getByRole('button').first());
  await pause(page, 2_500);
  await moveTo(page, app.getByRole('heading', { name: /What is this for/ }), { dx: 60 });
  await pause(page, 2_000);
  await scrollTo(page, app.locator('.legacy-agreement-section h4').first(), { block: 'start' });
  await pause(page, 2_500);
  await scrollTo(page, app.locator('.doc-foot'));
  await pause(page, 2_000);

  chapter('Alex approves the agreement draft');
  await click(page, app.getByRole('button', { name: 'Approve agreement draft', exact: true }).last());
  await pause(page, 3_000);

  chapter('Back to Maya: the agreement is ready to sign');
  await switchTo(page, 'Maya Chen');
  await click(page, page.locator('.msg-agent-handoff summary').last());
  await pause(page, 3_000);

  chapter('The signed-off agreement, ready for signature');
  await click(page, page.getByRole('button', { name: 'Open agreement' }));
  await pause(page, 2_500);
  await moveTo(page, app.locator('.legacy-document-scroll'), { dy: -120 });
  await scrollTo(page, app.locator('.doc-page'), { block: 'start' });
  await pause(page, 2_500);
  await scrollTo(page, app.locator('.doc-foot'));
  await pause(page, 4_000);
}

// ---------------------------------------------------------------------------

const { base, stop } = await serve();
const browser = await chromium.launch({ headless: !headed });
const video = encoder();
const chapters = [];
try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  await context.addInitScript(CURSOR);
  const page = await context.newPage();
  await page.goto(`${base}/?walkthrough=reset`);
  await page.getByPlaceholder(/^Message /).waitFor({ timeout: 30_000 });
  await pause(page, 800);

  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    video.frame(Buffer.from(data, 'base64'), metadata.timestamp ?? Date.now() / 1000);
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  // The person switch is a navigation; keep the screencast on the new page.
  page.on('load', () => void cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 }).catch(() => undefined));
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, everyNthFrame: 1 });
  await page.mouse.move(mouse.x, mouse.y);

  await story(page, (title) => {
    chapters.push({ at: video.elapsed(), title });
    console.log(`${new Date(video.elapsed() * 1000).toISOString().slice(14, 19)}  ${title}`);
  });
  await cdp.send('Page.stopScreencast');
} finally {
  await browser.close();
  stop();
}
await video.finish(1.5);

const stamp = (seconds) => new Date(seconds * 1000).toISOString().slice(14, 19);
const chapterFile = out.replace(/\.mp4$/, '') + '.chapters.txt';
writeFileSync(chapterFile, chapters.map((item) => `${stamp(item.at)}  ${item.title}`).join('\n') + '\n');
console.log(`\n${out}\n${chapterFile}\nLength ${stamp(video.seconds())}`);
