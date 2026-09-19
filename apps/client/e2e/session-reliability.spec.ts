import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test, type Page } from '@playwright/test';
import { mockUuid, SCHEMA_VERSION, streamEventSchema, type Message, type Session, type SessionSnapshot, type StreamEvent } from '@hermes/shared';
import type {} from './session-reliability-fixture.js';

const WS = mockUuid(1), A = mockUuid(2), B = mockUuid(20), C = mockUuid(2000), AGENT = mockUuid(102);
const DEFAULT = 'nous:anthropic/claude-sonnet-5';
const ALTERNATE = 'nous:stepfun/step-3.7-flash:free';
const origin = 'https://session-reliability.test';
const styles = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
let fixture = '';

test.beforeAll(async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./session-reliability-fixture.tsx', import.meta.url))],
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { __AUTH_MODE__: '"fake"', __MOCK__: 'false', 'process.env.NODE_ENV': '"production"' },
  });
  fixture = result.outputFiles[0]!.text;
});

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// The test owns this synthetic server outside the page, so reload cannot
// preserve client state accidentally. Actual requests traverse the real REST
// schema parser; actual live events traverse the adapter's selected hub.
class SessionServer {
  serial = 3000;
  sessions: Session[] = [A, B].map((id, index) => ({
    id, agent_id: AGENT, title: `QA Session ${index ? 'B' : 'A'}`, mode: 'work',
    model_id: DEFAULT, effort: 'medium', runtime: 'cloud', pinned: false, archived: false,
    focus_ref: null, status: 'Ready', last_activity_at: new Date().toISOString(), version: 1,
  }));
  messages = new Map<string, Message[]>([A, B].map((id) => [id, [this.message(id, 'iris', `Saved history ${id === A ? 'A' : 'B'}`)]]));
  runs = new Map<string, NonNullable<SessionSnapshot['run']>>();
  clientTurns = new Map<string, string>();
  streams = new Map<string, NonNullable<SessionSnapshot['stream']>>();
  events: StreamEvent[] = [];
  turns: { sessionId: string; model: string; effort: string | null; text: string }[] = [];
  settingsGate: ReturnType<typeof deferred> | null = null;
  creationGate: ReturnType<typeof deferred> | null = null;
  rejectSettings = false;
  settingsRequests = 0;
  active = A;

  constructor(readonly page: Page) {}
  message(sessionId: string, role: 'user' | 'iris', text: string): Message {
    return { id: mockUuid(this.serial++), session_id: sessionId, seq: 1, role, kind: null,
      text, blocks: [], status: 'complete', run_id: null, at: new Date().toISOString() };
  }
  head() { return String(this.events.length); }
  snapshot(sessionId: string): SessionSnapshot {
    return { workspace_id: WS, session: this.sessions.find((row) => row.id === sessionId)!,
      messages: { items: this.messages.get(sessionId) ?? [], cursor: null, total: null },
      run: this.runs.get(sessionId) ?? null, stream: this.streams.get(sessionId) ?? null,
      recovery: null, watermark: this.head() };
  }
  async mount() {
    await this.page.route(`${origin}/**`, async (route) => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
      if (url.pathname === '/styles.css') return route.fulfill({ contentType: 'text/css', body: styles });
      if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: fixture });
      if (url.pathname === '/fixture/config') return reply({ sessions: this.sessions, head: this.head(), activeSessionId: this.active });
      if (url.pathname.endsWith('/events')) {
        const stream = url.searchParams.get('stream') ?? 'session';
        const after = url.searchParams.get('after') ?? '0';
        return reply({ stream, after, head: stream === 'session' ? this.head() : '0', resync: false,
          events: stream === 'session' ? this.events.filter((event) => BigInt(event.id) > BigInt(after)) : [] });
      }
      const sessionId = url.pathname.match(/\/sessions\/([^/]+)/)?.[1];
      if (url.pathname.endsWith('/sessions') && method === 'GET') return reply({ items: this.sessions, cursor: null, total: this.sessions.length });
      if (url.pathname.endsWith('/sessions') && method === 'POST') {
        await this.creationGate?.promise;
        const row = { ...this.sessions[0]!, id: C, title: 'New session' };
        this.sessions.push(row); this.messages.set(C, []);
        return reply(row, 201);
      }
      if (sessionId && url.pathname.endsWith('/snapshot')) return reply(this.snapshot(sessionId));
      if (sessionId && url.pathname.endsWith('/messages')) return reply(this.snapshot(sessionId).messages);
      if (sessionId && method === 'PATCH') {
        const input = route.request().postDataJSON();
        const row = this.sessions.find((session) => session.id === sessionId)!;
        if (input.model_id !== undefined || input.effort !== undefined) {
          this.settingsRequests += 1;
          await this.settingsGate?.promise;
          if (this.rejectSettings) return reply({ reason: 'unknown_model', message: 'The selected model could not be saved.' }, 422);
        }
        for (const key of ['model_id', 'effort', 'title', 'archived'] as const) if (input[key] !== undefined) Object.assign(row, { [key]: input[key] });
        row.version = (row.version ?? 0) + 1;
        return reply(row);
      }
      if (sessionId && url.pathname.endsWith('/turns')) {
        const input = route.request().postDataJSON();
        const session = this.sessions.find((row) => row.id === sessionId)!;
        this.turns.push({ sessionId, model: session.model_id, effort: session.effort, text: input.text });
        const now = new Date().toISOString();
        const run = { id: mockUuid(this.serial++), session_id: sessionId, agent_id: AGENT,
          status: 'working' as const, attempt: 1, title: session.title, steps: [], queue: [],
          started_at: now, admitted_at: now, execution_started_at: now, ended_at: null,
          model_id: session.model_id, effort: session.effort };
        this.runs.set(sessionId, run);
        this.clientTurns.set(sessionId, input.client_turn_id);
        const message = { ...this.message(sessionId, 'user', input.text), seq: (this.messages.get(sessionId)?.length ?? 0) + 1, run_id: run.id };
        this.messages.set(sessionId, [...(this.messages.get(sessionId) ?? []), message]);
        await this.emit(sessionId, 'message.appended', { message_id: message.id, session_id: sessionId,
          seq: message.seq, role: message.role, kind: message.kind, text: message.text, blocks: [],
          status: message.status, run_id: run.id, client_turn_id: input.client_turn_id });
        return reply({ run_id: run.id, status: run.status, attempt: run.attempt }, 201);
      }
      if (sessionId && /\/runs\//.test(url.pathname)) {
        const run = this.runs.get(sessionId)!;
        return reply({ run_id: run.id, status: run.status, attempt: run.attempt });
      }
      return reply({ reason: 'not_found', message: `No synthetic route for ${method} ${url.pathname}` }, 404);
    });
    await this.page.goto(origin);
    await expect.poll(() => this.page.evaluate(() => window.sessionReliabilityFixture?.ready)).toBe(true);
  }
  async emit(sessionId: string, kind: string, payload: unknown) {
    const event = streamEventSchema.parse({ id: String(this.events.length + 1), workspace_id: WS, session_id: sessionId,
      kind, payload, at: new Date().toISOString(), schema_version: SCHEMA_VERSION, trace_id: 'session-qa' });
    this.events.push(event);
    await this.page.evaluate(({ id, event }) => window.sessionReliabilityFixture.deliver(id, { type: 'events', events: [event] }), { id: sessionId, event });
  }
  async beginText(sessionId: string, text: string) {
    const run = this.runs.get(sessionId)!;
    await this.emit(sessionId, 'run.started', { run_id: run.id, session_id: sessionId, attempt: run.attempt,
      engine_version: 2, client_turn_id: this.clientTurns.get(sessionId)!,
      mode: 'work', model_id: run.model_id, effort: run.effort, title: run.title, steps: [] });
    const stream = { run_id: run.id, attempt: run.attempt, turn: 0, step_attempt: 1,
      message_id: mockUuid(this.serial++), text, seq: 0, status: 'streaming' as const };
    this.streams.set(sessionId, stream);
    await this.emit(sessionId, 'message.reset', { run_id: run.id, attempt: run.attempt, turn: 0, step_attempt: 1, message_id: stream.message_id });
    await this.emit(sessionId, 'message.delta', { message_id: stream.message_id, run_id: run.id, attempt: run.attempt, turn: 0, step_attempt: 1, seq: 0, delta: text });
  }
  async append(sessionId: string, text: string) {
    const stream = this.streams.get(sessionId)!;
    stream.text += text; stream.seq += 1;
    await this.emit(sessionId, 'message.delta', { message_id: stream.message_id, run_id: stream.run_id,
      attempt: stream.attempt, turn: stream.turn, step_attempt: stream.step_attempt, seq: stream.seq, delta: text });
  }
  async finish(sessionId: string) {
    const run = this.runs.get(sessionId)!, stream = this.streams.get(sessionId)!;
    const message = { ...this.message(sessionId, 'iris', stream.text), id: stream.message_id!, run_id: run.id,
      seq: (this.messages.get(sessionId)?.length ?? 0) + 1, worked_ms: 1000 };
    this.messages.set(sessionId, [...this.messages.get(sessionId)!, message]);
    this.streams.set(sessionId, { ...stream, status: 'final' });
    run.status = 'completed'; run.ended_at = new Date().toISOString();
    await this.emit(sessionId, 'message.final', { message_id: message.id, session_id: sessionId, run_id: run.id, attempt: run.attempt, turn: 0, text: message.text, blocks: [], worked_ms: 1000 });
    await this.emit(sessionId, 'run.status', { run_id: run.id, attempt: run.attempt, status: 'completed' });
  }
}

async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message Iris' }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}
async function selectAlternate(page: Page) {
  await page.getByRole('button', { name: /^Model:/ }).click();
  const menu = page.getByRole('dialog', { name: 'Model', exact: true });
  await menu.getByRole('textbox', { name: 'Search models' }).fill('step-3.7-flash');
  await menu.locator(`.menu-item[title="${ALTERNATE}"]`).click();
  await page.keyboard.press('Escape');
}

test('cold sidebar selection loads history and receives the immediate follow-up', async ({ page }) => {
  const server = new SessionServer(page); await server.mount();
  await expect(page.getByText('Saved history A', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'QA Session B, Ready', exact: true }).click();
  await send(page, 'Continue B');
  await expect.poll(() => server.turns.length).toBe(1);
  await expect(page.getByText('Saved history B', { exact: true })).toBeVisible();
  await server.beginText(B, 'B prefix');
  await expect(page.locator('.stream-text')).toContainText('B prefix');
  await server.append(B, ' and final'); await server.finish(B);
  await expect(page.getByText('B prefix and final', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved history A', { exact: true })).toHaveCount(0);
});

test('full reload restores committed prefix, Stop and the original attempt clock', async ({ page }) => {
  const server = new SessionServer(page); await server.mount();
  await send(page, 'Stream across reload');
  await expect.poll(() => server.turns.length).toBe(1);
  await server.beginText(A, 'Persisted prefix');
  const run = server.runs.get(A)!;
  run.started_at = run.admitted_at = new Date(Date.now() - 15_000).toISOString();
  await page.reload();
  await expect(page.locator('.stream-text')).toContainText('Persisted prefix');
  await expect(page.getByRole('button', { name: 'Stop work', exact: true })).toBeVisible();
  await expect.poll(async () => Number.parseFloat(await page.locator('.live-run-elapsed').innerText())).toBeGreaterThanOrEqual(15);
  await server.append(A, ' plus suffix');
  await expect(page.locator('.stream-text')).toContainText('Persisted prefix plus suffix');
  await server.finish(A);
  await expect(page.getByText('Persisted prefix plus suffix', { exact: true })).toBeVisible();
  expect(server.turns).toHaveLength(1);
});

test('a no-output failed turn retains its explanation and retry after reload', async ({ page }) => {
  const server = new SessionServer(page); await server.mount();
  await send(page, 'A rate-limited request');
  await expect.poll(() => server.turns.length).toBe(1);
  const run = server.runs.get(A)!;
  run.status = 'error'; run.error = { class: 'transient', retryable: true, reason: 'provider_rate_limited', message: 'The selected model is rate limited. Try again shortly.' };
  server.messages.get(A)!.push({ ...server.message(A, 'iris', ''), run_id: run.id, seq: 3, status: 'incomplete' });
  await page.reload();
  await expect(page.getByText(/selected model is rate limited/)).toBeVisible();
  await expect(page.getByRole('button', { name: /Retry remaining step/ })).toBeVisible();
  expect(server.turns).toHaveLength(1);
});

test('authoritative reconciliation repairs late committed text without a newer replay cursor', async ({ page }) => {
  const server = new SessionServer(page); await server.mount();
  await send(page, 'Continue despite a delayed checkpoint');
  await expect.poll(() => server.turns.length).toBe(1);
  await server.beginText(A, 'Durable prefix');
  await expect(page.locator('.stream-text')).toContainText('Durable prefix');
  const unchangedHead = server.head();
  // Mirrors a lower-ID transaction committing after another publication has
  // moved the replay head. The DB suite verifies that real commit ordering;
  // here only the snapshot changes, so event-only reconciliation cannot pass.
  const stream = server.streams.get(A)!;
  stream.text += ' and a late committed suffix'; stream.seq += 1;
  await expect(page.locator('.stream-text')).toContainText('Durable prefix and a late committed suffix');
  expect(server.head()).toBe(unchangedHead);
  expect(server.turns).toHaveLength(1);
});

test('immediate Send waits for the selected model and effort to be saved', async ({ page }) => {
  const server = new SessionServer(page); await server.mount();
  server.settingsGate = deferred();
  await selectAlternate(page);
  await expect.poll(() => server.settingsRequests).toBe(1);
  await send(page, 'Use the selected model');
  await page.waitForTimeout(250);
  expect(server.turns).toHaveLength(0);
  server.settingsGate.release();
  await expect.poll(() => server.turns.length).toBe(1);
  expect(server.turns[0]).toMatchObject({ model: ALTERNATE, effort: null });
});

test('a late new-session response cannot steal the current session connection', async ({ page }) => {
  const server = new SessionServer(page); await server.mount();
  server.creationGate = deferred();
  await page.getByRole('region', { name: 'Iris conversation' }).getByRole('button', { name: 'New session', exact: true }).click();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByRole('dialog', { name: 'Sessions', exact: true }).getByRole('button', { name: /^QA Session B/ }).click();
  await expect(page.getByText('Saved history B', { exact: true })).toBeVisible();
  server.creationGate.release();
  await expect.poll(() => server.sessions.length).toBe(3);
  await send(page, 'Still B');
  await expect.poll(() => server.turns.length).toBe(1);
  expect(server.turns[0]?.sessionId).toBe(B);
  await server.beginText(B, 'The current session stayed connected.');
  await expect(page.locator('.stream-text')).toContainText('The current session stayed connected.');
  const connections = await page.evaluate(() => window.sessionReliabilityFixture.connections());
  expect(connections.filter((url) => url.includes('/hub/session/'))).toEqual([expect.stringContaining(`/hub/session/${B}`)]);
});

test('a new session stays isolated and supports a second persisted reply', async ({ page }) => {
  const server = new SessionServer(page); await server.mount();
  await page.getByRole('region', { name: 'Iris conversation' }).getByRole('button', { name: 'New session', exact: true }).click();
  await expect.poll(() => server.sessions.length).toBe(3);
  await send(page, 'Remember CEDAR');
  await expect.poll(() => server.turns.length).toBe(1);
  expect(server.turns[0]?.sessionId).toBe(C);
  await server.beginText(C, 'ACK CEDAR'); await server.finish(C);
  await expect(page.getByText('ACK CEDAR', { exact: true })).toBeVisible();
  await send(page, 'Recall the code');
  await expect.poll(() => server.turns.length).toBe(2);
  await server.beginText(C, 'CEDAR'); await server.finish(C);
  await expect(page.getByText('CEDAR', { exact: true })).toBeVisible();
  await expect(page.getByText('ACK CEDAR', { exact: true })).toBeVisible();
  await expect(page.getByText('Saved history A', { exact: true })).toHaveCount(0);
  server.active = C;
  await page.reload();
  await expect(page.getByText('ACK CEDAR', { exact: true })).toBeVisible();
  await expect(page.getByText('CEDAR', { exact: true })).toBeVisible();
});

test('a rejected model save cannot silently send through the previous model', async ({ page }) => {
  const server = new SessionServer(page); await server.mount();
  server.settingsGate = deferred(); server.rejectSettings = true;
  await selectAlternate(page);
  await expect.poll(() => server.settingsRequests).toBe(1);
  await send(page, 'Keep this draft if model selection fails');
  server.settingsGate.release();
  await expect(page.getByRole('textbox', { name: 'Message Iris' })).toHaveValue('Keep this draft if model selection fails');
  await expect(page.getByText(/model choice could not be saved/)).toBeVisible();
  expect(server.turns).toHaveLength(0);
});

test('archiving the selected session hydrates and connects its fallback conversation', async ({ page }) => {
  const server = new SessionServer(page); await server.mount();
  await page.getByRole('button', { name: 'Session options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Archive session', exact: true }).click();
  await expect(page.getByText('Saved history B', { exact: true })).toBeVisible();
  await send(page, 'Continue in the fallback session');
  await expect.poll(() => server.turns.length).toBe(1);
  expect(server.turns[0]?.sessionId).toBe(B);
  await server.beginText(B, 'Fallback is connected.');
  await expect(page.locator('.stream-text')).toContainText('Fallback is connected.');
  const connections = await page.evaluate(() => window.sessionReliabilityFixture.connections());
  expect(connections.filter((url) => url.includes('/hub/session/'))).toEqual([expect.stringContaining(`/hub/session/${B}`)]);
});
