// `pnpm --filter @hermes/client email-intake:record` — records the email
// intake happy path (decision C98) as an MP4 against a real local stack.
//
// Unlike the product walkthrough, this does not use the mock build. It starts
// the Worker, a private Postgres and the fake-auth client (email-intake-stack.mjs),
// and every step goes through real routes and the database:
//
//   1. Maya, an Admin, gives Partnerships a role inbox address.
//   2. A partner's email is delivered to that address through the Worker's
//      email() handler, exactly as Cloudflare Email Routing hands it over in
//      development (POST /cdn-cgi/handler/email).
//   3. The intake job hands it to Iris, who suggests a reply and hands the
//      invoice to Finance. Iris's words come from the scripted development
//      model (MODEL_SCRIPTED=1); the tools, policies and approvals are real.
//   4. Maya reads the sanitized email and approves the reply, which is
//      threaded and, in development, simulated rather than sent.
//   5. Dana, who holds Finance, reads the hand-off and marks it handled.
//
//   pnpm --filter @hermes/client email-intake:record -- --out ~/Desktop/email-intake.mp4
//
// Options: `--out <file>`, `--port <n>` (default 8796), `--headed`, and
// `--size 1920x1080`. Requires Docker (colima) and ffmpeg.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { deliverEmail, SEED, startEmailIntakeStack } from './email-intake-stack.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const client = resolve(here, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(option('port', '8796'));
const out = resolve(option('out', resolve(client, 'walkthrough/email-intake.mp4')).replace(/^~/, process.env.HOME ?? '~'));
const [outWidth, outHeight] = option('size', '1920x1080').split('x').map(Number);
const headed = args.includes('--headed');
const FPS = 30;
const VIEWPORT = { width: 1600, height: 900 };

// ---------------------------------------------------------------------------
// The partner's email, as raw MIME. The Authentication-Results header stands in
// for the one Cloudflare's receiver adds in production (mx.cloudflare.net).
// ---------------------------------------------------------------------------

/** A one-page invoice PDF with a real text layer, so the agent reads it. */
function invoicePdf() {
  const lines = [
    'Northwind Analytics - Invoice NW-2026-09',
    'Bill to: Nous Research, Partnerships',
    'Co-hosted workshop series, September 2026: 3 sessions',
    'Total due: 4,800.00 USD, net 30, per the partner terms',
  ];
  const content = lines.map((line, index) => `BT /F1 12 Tf 40 ${150 - index * 24} Td (${line}) Tj ET`).join('\n');
  const objects = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 480 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${content.length}>>stream\n${content}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => { offsets.push(body.length); body += `${index + 1} 0 obj${object}endobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

function partnerEmail(to) {
  const pdf = invoicePdf().toString('base64').replace(/(.{76})/g, '$1\r\n');
  const html = [
    '<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">',
    '<img src="https://cdn.northwind.example/brand/logo.png" alt="Northwind Analytics" width="140">',
    '<p>Hi team,</p>',
    '<p>Thanks again for a great quarter together. I\'ve attached our September partnership invoice (NW-2026-09) for the co-hosted workshop series. It covers the three sessions we ran in September, as agreed in our partner terms.</p>',
    '<p>Could you also let me know if you have time for a co-marketing call next week? We\'d love to plan the November webinar with you.</p>',
    '<p>The workshop recap is here: <a href="https://northwind.example/recaps/september-workshops">northwind.example/recaps/september-workshops</a></p>',
    '<p>Best,<br>Priya Raman<br>Partner Programs, Northwind Analytics</p>',
    '<img src="https://t.northwind-mail.example/open.gif?u=8812" width="1" height="1">',
    '</div>',
  ].join('\r\n');
  const boundary = '----=_Part_7';
  return [
    'Authentication-Results: mx.cloudflare.net;',
    '\tdkim=pass header.d=northwind.example header.s=s1;',
    '\tspf=pass smtp.mailfrom=priya@northwind.example;',
    '\tdmarc=pass header.from=northwind.example',
    `Message-ID: <sept-invoice-${Date.now()}@northwind.example>`,
    `Date: ${new Date().toUTCString()}`,
    'From: Priya Raman <priya@northwind.example>',
    `To: ${to}`,
    'Subject: September partnership invoice + co-marketing call',
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    html,
    `--${boundary}`,
    'Content-Type: application/pdf; name="Northwind-invoice-NW-2026-09.pdf"',
    'Content-Disposition: attachment; filename="Northwind-invoice-NW-2026-09.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    pdf,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

// ---------------------------------------------------------------------------
// Frames → ffmpeg, a visible cursor and captions. The encoder and cursor are
// the ones record-walkthrough.mjs uses.
// ---------------------------------------------------------------------------

function encoder() {
  mkdirSync(dirname(out), { recursive: true });
  const ffmpeg = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-vf', `scale=${outWidth}:${outHeight}:flags=lanczos:in_range=full:out_range=tv,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '24',
    '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-tag:v', 'avc1',
    '-movflags', '+faststart', out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((ok, fail) => ffmpeg.on('close', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}`)))));
  let started = null;
  let written = 0;
  let last = null;
  const fill = (until) => {
    while (last && written < until) { ffmpeg.stdin.write(last); written += 1; }
  };
  return {
    frame(buffer, timestamp) { started ??= timestamp; fill(Math.floor((timestamp - started) * FPS)); last = buffer; },
    seconds: () => written / FPS,
    elapsed: () => (started === null ? 0 : Date.now() / 1000 - started),
    // A still screen paints nothing; pad to the real clock before the hold.
    async finish(hold = 1) {
      if (started !== null) fill(Math.floor((Date.now() / 1000 - started) * FPS));
      fill(written + Math.round(hold * FPS));
      ffmpeg.stdin.end();
      await done;
    },
  };
}

const OVERLAY = () => {
  const install = () => {
    if (document.getElementById('walkthrough-cursor')) return;
    const cursor = document.createElement('div');
    cursor.id = 'walkthrough-cursor';
    cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 3l14 8.5-6.2 1.3L10 19z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-100px,-100px)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.45))' });
    const ring = document.createElement('div');
    Object.assign(ring.style, { position: 'fixed', left: '0', top: '0', width: '34px', height: '34px', margin: '-17px 0 0 -17px', borderRadius: '50%', border: '2px solid rgba(255,255,255,.85)', zIndex: '2147483646', pointerEvents: 'none', opacity: '0' });
    const caption = document.createElement('div');
    caption.id = 'walkthrough-caption';
    Object.assign(caption.style, {
      position: 'fixed', left: '50%', top: '14px', transform: 'translateX(-50%)', zIndex: '2147483645', pointerEvents: 'none',
      maxWidth: '1000px', padding: '12px 20px', borderRadius: '12px', background: 'rgba(8,4,22,.88)', color: '#fff',
      font: '500 19px/1.45 Inter, system-ui, sans-serif', textAlign: 'center', boxShadow: '0 8px 30px rgba(0,0,0,.35)',
      border: '1px solid rgba(223,223,255,.22)', opacity: '0', transition: 'opacity 200ms ease',
    });
    document.body.append(ring, cursor, caption);
    const saved = sessionStorage.getItem('walkthrough-caption');
    if (saved) { caption.textContent = saved; caption.style.opacity = '1'; }
    addEventListener('mousemove', (event) => { cursor.style.transform = `translate(${event.clientX - 5}px,${event.clientY - 3}px)`; }, true);
    addEventListener('mousedown', (event) => {
      ring.animate([{ opacity: 1, transform: `translate(${event.clientX}px,${event.clientY}px) scale(.5)` }, { opacity: 0, transform: `translate(${event.clientX}px,${event.clientY}px) scale(1.3)` }], { duration: 450, easing: 'ease-out' });
    }, true);
  };
  if (document.body) install(); else addEventListener('DOMContentLoaded', install);
};

async function caption(page, text) {
  await page.evaluate((value) => {
    sessionStorage.setItem('walkthrough-caption', value);
    const element = document.getElementById('walkthrough-caption');
    if (!element) return;
    element.style.opacity = '0';
    setTimeout(() => { element.textContent = value; element.style.opacity = '1'; }, 180);
  }, text);
}

const pause = (page, ms) => page.waitForTimeout(ms);
const jitter = (min, max) => min + Math.random() * (max - min);
let mouse = { x: VIEWPORT.width * 0.55, y: VIEWPORT.height * 0.6 };

async function moveTo(page, locator, { dx = 0, dy = 0 } = {}) {
  await locator.waitFor({ state: 'visible', timeout: 30_000 });
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error('Target has no box');
  const target = { x: box.x + box.width / 2 + dx, y: box.y + box.height / 2 + dy };
  const steps = Math.max(12, Math.min(45, Math.round(Math.hypot(target.x - mouse.x, target.y - mouse.y) / 22)));
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

/** Scroll the nearest scrolling ancestor until the target reaches the top or bottom. */
async function scrollTo(page, locator, { block = 'start', speed = 12 } = {}) {
  await locator.waitFor({ state: 'attached', timeout: 30_000 });
  const handle = await locator.elementHandle();
  for (let guard = 0; guard < 600; guard += 1) {
    const moved = await handle.evaluate((element, { block, speed }) => {
      let box = element.parentElement;
      while (box && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement;
      if (!box) return 0;
      const target = element.getBoundingClientRect();
      const view = box.getBoundingClientRect();
      const gap = block === 'end' ? target.bottom + 24 - view.bottom : target.top - 90 - view.top;
      if (Math.abs(gap) < 2) return 0;
      const before = box.scrollTop;
      box.scrollTop += Math.sign(gap) * Math.min(Math.abs(gap), speed);
      return box.scrollTop - before;
    }, { block, speed });
    if (!moved) return;
    await pause(page, 16);
  }
}

// ---------------------------------------------------------------------------
// The story.
// ---------------------------------------------------------------------------

/** Open one Inbox item and wait until its email has rendered; a click during a list refresh can land before the entity. */
async function openItem(page, text) {
  const app = page.getByRole('region', { name: 'Application' });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await click(page, app.getByText(text).first());
    const ready = await app.locator('.email-message').first().waitFor({ state: 'visible', timeout: 8_000 }).then(() => true, () => false);
    if (ready) return;
  }
  throw new Error(`the item ${String(text)} did not open`);
}

/**
 * Press an action guarded by step-up. If the server asks for a recent sign-in,
 * go through the real step-up redirect, come back, and press it again: the
 * product never submits on its own after a sign-in.
 */
/** Move the visible cursor to a button, then let Playwright press it (its actionability checks wait out footer motion). */
async function press(page, locator) {
  await moveTo(page, locator);
  await pause(page, jitter(180, 320));
  await locator.click();
}

async function pressGuarded(page, name, onSignIn) {
  const app = page.getByRole('region', { name: 'Application' });
  await press(page, app.getByRole('button', { name }).last());
  const signIn = app.getByRole('button', { name: 'Sign in again' });
  const needed = await signIn.waitFor({ state: 'visible', timeout: 12_000 }).then(() => true, () => false);
  if (!needed) return;
  await onSignIn();
  await pause(page, 2_500);
  await press(page, signIn);
  await page.waitForLoadState('load');
  await page.getByRole('region', { name: 'Application' }).getByRole('button', { name }).last().waitFor({ timeout: 30_000 });
  await page.mouse.move(mouse.x, mouse.y);
  await pause(page, 1_500);
  await press(page, page.getByRole('region', { name: 'Application' }).getByRole('button', { name }).last());
}

async function story(page, base, chapter) {
  const app = page.getByRole('region', { name: 'Application' });
  const say = async (title, text) => { chapter(title); await caption(page, text); };

  await say('Maya sets up a role inbox', 'Maya is an Admin. She gives the Partnerships team an email address its agent can read.');
  await pause(page, 2_500);
  await click(page, page.getByRole('button', { name: 'Admin', exact: true }));
  await pause(page, 1_200);
  await click(page, page.getByRole('button', { name: 'Role inboxes' }));
  await pause(page, 1_000);
  await pause(page, 600);
  await click(page, app.getByRole('button', { name: 'Add inbox' }).first());
  await pause(page, 2_000);
  await say('Partnerships, read by Iris', 'The inbox belongs to the Partnerships role. Iris, Maya’s agent, reads what arrives. Iris can only suggest.');
  await pause(page, 2_600);
  await click(page, page.getByRole('dialog').getByRole('button', { name: 'Add inbox' }));
  await pause(page, 1_800);
  const address = (await app.locator('.email-inbox-address code').first().textContent())?.trim();
  if (!address) throw new Error('no inbox address on screen');
  await moveTo(page, app.locator('.email-inbox-address code').first());
  await say('A private forwarding address', 'Hermes creates a private address. The team forwards or copies partner email to it.');
  await pause(page, 3_200);

  await say('A partner emails the team', 'Priya at Northwind emails that address: her September invoice and a request for a call.');
  const delivered = await deliverEmail(base, { from: 'priya@northwind.example', to: address, raw: partnerEmail(address) });
  if (delivered.status !== 200) throw new Error(`email delivery failed: ${delivered.status} ${delivered.body}`);
  await pause(page, 3_500);

  await say('Iris reads it and suggests', 'Hermes cleans and checks the email first. Iris then suggests a reply and hands the invoice to Finance.');
  await click(page, page.getByRole('button', { name: /^Inbox/ }).first());
  await pause(page, 2_000);
  await openItem(page, 'Reply to Priya Raman');
  await pause(page, 2_500);

  await say('What Hermes checked', 'The server’s checks come first: the domain verified the sender, and the tracking pixel and remote logo never loaded.');
  await moveTo(page, app.locator('.email-message-checks').first());
  await pause(page, 5_500);
  await say('The email, rendered safely', 'The email renders in a locked-down frame: no scripts, no remote loads. Every link shows where it really goes.');
  await scrollTo(page, app.locator('.email-frame').first(), { block: 'start' });
  await pause(page, 3_000);
  await scrollTo(page, app.locator('.email-message-extras').first(), { block: 'end' });
  await say('The attachment, read as text', 'Iris read the invoice PDF’s text as untrusted data. Maya can open exactly what Iris read.');
  await click(page, app.locator('.email-attachment-text summary').first());
  await pause(page, 1_000);
  await scrollTo(page, app.locator('.email-attachment-text pre').first(), { block: 'end' });
  await pause(page, 3_500);

  await say('Iris’s suggested reply', 'The reply goes only to the address that sent the email, threaded under it. Iris cannot change who receives it.');
  await scrollTo(page, app.locator('.email-reply-draft').first(), { block: 'start' });
  await pause(page, 2_500);
  await scrollTo(page, app.locator('.approval-message-body').first(), { block: 'end' });
  await pause(page, 4_000);

  await say('Maya approves the reply', 'Nothing is sent until a person approves. Maya approves this exact reply.');
  await pressGuarded(page, 'Approve and send reply', () => say('A recent sign-in first', 'Approving needs a sign-in from the last five minutes, so Maya confirms it is her, then approves.'));
  await pause(page, 3_000);
  await scrollTo(page, app.getByRole('heading', { name: 'Decision and result' }), { block: 'start' });
  await say('Delivered, here simulated', 'Approved and queued. This development build simulates delivery, so nothing actually left the machine.');
  await pause(page, 5_000);

  await say('Dana holds the Finance role', 'Now Dana, who holds the Finance role. Iris handed her the invoice.');
  await page.evaluate((user) => localStorage.setItem('hermes:dev-user', user), SEED.dana);
  await page.reload();
  await page.getByRole('button', { name: /^Inbox/ }).first().waitFor({ timeout: 30_000 });
  await page.mouse.move(mouse.x, mouse.y);
  await pause(page, 2_000);
  await click(page, page.getByRole('button', { name: /^Inbox/ }).first());
  await pause(page, 2_000);
  await openItem(page, /^Finance: September/);
  await pause(page, 3_000);
  await say('The hand-off to Finance', 'Dana sees Iris’s note and the same checked email. The hand-off cannot pay, sign or reply.');
  await scrollTo(page, app.locator('.email-message-checks').first(), { block: 'start' });
  await pause(page, 3_000);
  await scrollTo(page, app.locator('.email-message-extras').first(), { block: 'end' });
  await pause(page, 2_500);
  await say('Dana marks it handled', 'When Finance has checked the invoice, Dana closes the hand-off.');
  await pressGuarded(page, 'Mark handled', () => say('A recent sign-in first', 'Closing a hand-off is guarded like a decision: Dana confirms her sign-in first.'));
  await pause(page, 3_500);
  await say('Done', 'Suggested by the agent, checked by the server, decided by people.');
  await pause(page, 6_000);
}

// ---------------------------------------------------------------------------

const stack = await startEmailIntakeStack({ port });
const browser = await chromium.launch({ headless: !headed });
const video = encoder();
const chapters = [];
try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  await context.addInitScript((user) => { if (!localStorage.getItem('hermes:dev-user')) localStorage.setItem('hermes:dev-user', user); }, SEED.maya);
  await context.addInitScript(OVERLAY);
  const page = await context.newPage();
  await page.goto(`${stack.base}/`);
  await page.getByRole('button', { name: 'Open Nous' }).click();
  await page.getByRole('button', { name: 'Admin', exact: true }).waitFor({ timeout: 30_000 });
  await pause(page, 1_000);

  const cdp = await context.newCDPSession(page);
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    video.frame(Buffer.from(data, 'base64'), metadata.timestamp ?? Date.now() / 1000);
    void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => undefined);
  });
  page.on('load', () => void cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 }).catch(() => undefined));
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, everyNthFrame: 1 });
  await page.mouse.move(mouse.x, mouse.y);

  try {
    await story(page, stack.base, (title) => {
      chapters.push({ at: video.elapsed(), title });
      console.log(`${new Date(video.elapsed() * 1000).toISOString().slice(14, 19)}  ${title}`);
    });
  } catch (error) {
    // The one frame that explains a failed take.
    const shot = `${out.replace(/\.mp4$/, '')}.failed.png`;
    await page.screenshot({ path: shot }).catch(() => undefined);
    console.error(`the story stopped; last screen saved to ${shot}`);
    throw error;
  }
  await cdp.send('Page.stopScreencast');
} finally {
  await browser.close();
  stack.stop();
}
await video.finish(1.5);

const stamp = (seconds) => new Date(seconds * 1000).toISOString().slice(14, 19);
const chapterFile = `${out.replace(/\.mp4$/, '')}.chapters.txt`;
writeFileSync(chapterFile, chapters.map((item) => `${stamp(item.at)}  ${item.title}`).join('\n') + '\n');
console.log(`\n${out}\n${chapterFile}\nLength ${stamp(video.seconds())}`);
