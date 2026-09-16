// The scenarios the Worker's "Server findings" fixes unblocked.
//
// Each of these was impossible to drive from the client before: the shell's own
// URL answered JSON, `POST /workspaces` never reached the Worker, an invitation
// could only be accepted through an identity provider that does not exist in
// `AUTH_MODE=fake`, and `MODEL_SCRIPTED=1` was one fixed script with no failure
// path. They run against the same live stack as `live.spec.ts`; see the header
// there for what "live" means.
//
// Server-side decisions F1, F2, F3 and F6.
import { expect, test, type Browser, type BrowserContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { freshWorkspace, psql } from '../scripts/live-fixture.mjs';

const ORIGIN = process.env.E2E_BASE_URL ?? 'http://localhost:8788';
const SEED_WORKSPACE = '11111111-1111-4111-8111-111111111111';
const SEED_ADMIN = 'maya@nous.example';

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

const rows = (sql: string): string[] => psql(sql).split('\n').filter(Boolean);
const q = (value: string): string => `'${value.replace(/'/g, "''")}'`;

// ---------------------------------------------------------------------------
// F1 · the shell's own URL
// ---------------------------------------------------------------------------

test('F1 · a navigation to /w/:ws boots the app instead of answering JSON', async ({ browser }) => {
  const context = await asUser(browser, SEED_ADMIN);
  const page = await context.newPage();
  await page.goto(`/w/${SEED_WORKSPACE}`);
  // The shell, not `{"reason":"unknown_route"}`: the client already parsed
  // `/w/:ws` (routes.ts), it was the server that answered the wrong thing.
  await expect(page.getByRole('button', { name: 'Inbox', exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('body')).not.toContainText('unknown_route');

  // A deep link too, fragment and all.
  await page.goto(`/w/${SEED_WORKSPACE}#inbox/list`);
  await expect(page.getByRole('button', { name: 'Inbox', exact: true }).first()).toBeVisible();

  // And a `fetch()` for data still gets JSON, which is the half that must not
  // regress: a client asking for data is never handed HTML.
  const json = await page.request.get(`/w/${SEED_WORKSPACE}/no-such-route`, {
    headers: { accept: 'application/json' },
  });
  expect(json.status()).toBe(404);
  expect((await json.json()).reason).toBe('unknown_route');
  await context.close();
});

// ---------------------------------------------------------------------------
// F2 · create a workspace, and accept an invitation into one
// ---------------------------------------------------------------------------

test('F2 · POST /workspaces creates a workspace the creator can open', async ({ browser }) => {
  // A fresh Admin, because creating a workspace is rate-limited to three a day
  // per person (`LIMITS.createWorkspace`). Reusing the seeded Admin makes the
  // suite fail on its fourth run of the day for a reason that has nothing to do
  // with the code — the same trap P11 avoids for key verification.
  const seed = freshWorkspace('Creator seat');
  const context = await asUser(browser, seed.adminEmail);
  const page = await context.newPage();
  await page.goto(`/w/${seed.workspaceId}`);

  const name = `Created ${new Date().toISOString().slice(11, 19)}`;
  const created = await page.request.post('/workspaces', {
    data: {
      name,
      agent: { name: 'Iris', instructions: 'Help me define one repeatable workflow and its review boundaries.' },
    },
    headers: { origin: ORIGIN },
  });
  // 405 was the old answer: the assets binding replied before the Worker saw
  // it, because `/workspaces` was not in `run_worker_first`.
  expect(created.status(), await created.text()).toBe(201);
  const body = await created.json();
  expect(body.workspace.name).toBe(name);

  // The creator is its first Admin, and the workspace opens.
  expect(rows(`SELECT role FROM members WHERE workspace_id = ${q(body.workspace.id)};`)).toEqual(['admin']);
  await page.goto(`/w/${body.workspace.id}`);
  await expect(page.getByText('Let’s set up the work you want me to repeat. What do you own?')).toBeVisible({
    timeout: 15_000,
  });
  await context.close();
});

test('F2 · an invited person accepts and lands in the workspace', async ({ browser }) => {
  const fixture = freshWorkspace('Invite target');
  const joinerId = randomUUID();
  const joinerEmail = `joiner-${joinerId.slice(0, 8)}@nous.example`;
  psql(
    `INSERT INTO users (id, email, email_verified, name) VALUES (${q(joinerId)}, ${q(joinerEmail)}, true, 'Jo Iner');`,
  );

  const admin = await asUser(browser, fixture.adminEmail);
  const adminPage = await admin.newPage();
  await adminPage.goto(`/w/${fixture.workspaceId}`);
  const invited = await adminPage.request.post(`/w/${fixture.workspaceId}/invitations`, {
    data: { email: joinerEmail, role: 'member' },
    headers: { origin: ORIGIN },
  });
  expect(invited.status(), await invited.text()).toBe(201);
  const token = (await invited.json()).id as string;

  // Before accepting, the joiner is in no workspace at all — which is now an
  // answer rather than a 404 with no information in it (F7).
  const joiner = await asUser(browser, joinerEmail);
  const joinerPage = await joiner.newPage();
  const before = await joinerPage.request.get('/auth/session');
  expect(before.status()).toBe(404);

  const accepted = await joinerPage.request.post(`/invitations/${token}/accept`, {
    data: {},
    headers: { origin: ORIGIN },
  });
  expect(accepted.status(), await accepted.text()).toBe(200);
  expect((await accepted.json()).workspace.id).toBe(fixture.workspaceId);

  // The mirror, the invitation's status, and the workspace switcher all agree.
  expect(
    rows(`SELECT role FROM members WHERE workspace_id = ${q(fixture.workspaceId)} AND user_id = ${q(joinerId)};`),
  ).toEqual(['member']);
  expect(rows(`SELECT status FROM invitations WHERE id = ${q(token)};`)).toEqual(['accepted']);

  const after = await joinerPage.request.get('/auth/session');
  expect(after.status()).toBe(200);
  expect((await after.json()).workspaces.map((w: { id: string }) => w.id)).toContain(fixture.workspaceId);

  // And the shell opens for them.
  await joinerPage.goto(`/w/${fixture.workspaceId}`);
  await expect(joinerPage.getByRole('button', { name: 'Inbox', exact: true }).first()).toBeVisible({
    timeout: 15_000,
  });
  await admin.close();
  await joiner.close();
});

// ---------------------------------------------------------------------------
// F3 · a proposal reaches a member who is not on the proposing session
// ---------------------------------------------------------------------------

test('F3 · propose_request publishes request.created on the workspace stream', async ({ browser }) => {
  const context = await asUser(browser, SEED_ADMIN);
  const page = await context.newPage();
  const session = await page.request.post(`/w/${SEED_WORKSPACE}/sessions`, {
    data: { title: 'F3 proposal' },
    headers: { origin: ORIGIN },
  });
  const sessionId = (await session.json()).id as string;
  await page.goto(`/workspace/${SEED_WORKSPACE}/s/${sessionId}`);

  await page.getByRole('textbox', { name: /^Message/ }).fill('Screen the applicant.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 25_000 });

  const runId = rows(`SELECT id::text FROM runs WHERE session_id = ${q(sessionId)} ORDER BY started_at DESC LIMIT 1;`)[0]!;
  const requestId = rows(`SELECT id::text FROM requests WHERE run_id = ${q(runId)};`)[0]!;

  // The event exists, exactly once, and it is on the *workspace* stream —
  // `session_id IS NULL` is what the workspace hub and the replay route both
  // key on, and it is what makes the proposal visible to a member who is not
  // on this session's socket.
  const published = rows(
    `SELECT id::text FROM stream_events
      WHERE workspace_id = ${q(SEED_WORKSPACE)} AND kind = 'request.created'
        AND session_id IS NULL AND payload ->> 'request_id' = ${q(requestId)};`,
  );
  expect(published).toHaveLength(1);
  await context.close();
});

// ---------------------------------------------------------------------------
// F6 · the scripted failure paths, driven from the composer
// ---------------------------------------------------------------------------

test('P9 · a stream that tears mid-answer recovers and shows the answer once', async ({ browser }) => {
  const context = await asUser(browser, SEED_ADMIN);
  const page = await context.newPage();
  const session = await page.request.post(`/w/${SEED_WORKSPACE}/sessions`, {
    data: { title: 'P9 partial stream' },
    headers: { origin: ORIGIN },
  });
  const sessionId = (await session.json()).id as string;
  await page.goto(`/workspace/${SEED_WORKSPACE}/s/${sessionId}`);

  // The scenario is named in the turn itself: `MODEL_SCRIPTED=1` now reads the
  // text (or an `x-scripted-script` header) and picks the script, so P9 is
  // drivable from the composer a person types into.
  await page.getByRole('textbox', { name: /^Message/ }).fill('Screen the applicant (partial_stream).');
  await page.getByRole('button', { name: 'Send message' }).click();

  // The tear is a transient provider error, so the step retries and the run
  // reaches its ordinary ending. What must not happen is the partial text
  // being left behind next to the complete answer.
  await expect(page.getByText(/pending your decision in the Inbox/)).toBeVisible({ timeout: 40_000 });
  const runId = rows(`SELECT id::text FROM runs WHERE session_id = ${q(sessionId)} ORDER BY started_at DESC LIMIT 1;`)[0]!;
  const perTurn = rows(
    `SELECT count(*)::text FROM messages WHERE run_id = ${q(runId)} AND role = 'iris' AND status = 'complete' GROUP BY turn;`,
  );
  expect(perTurn.every((n) => n === '1')).toBe(true);

  const renderedIds = await page.locator('[data-message-id]').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('data-message-id') ?? ''),
  );
  expect(new Set(renderedIds).size).toBe(renderedIds.length);
  await context.close();
});

test('P8 · a provider 5xx on the first attempt, then a Retry that completes', async ({ browser }) => {
  const context = await asUser(browser, SEED_ADMIN);
  const page = await context.newPage();
  const session = await page.request.post(`/w/${SEED_WORKSPACE}/sessions`, {
    data: { title: 'P8 transient' },
    headers: { origin: ORIGIN },
  });
  const sessionId = (await session.json()).id as string;
  await page.goto(`/workspace/${SEED_WORKSPACE}/s/${sessionId}`);

  // The header form, which is what a scripted harness would use.
  const turn = await page.request.post(`/w/${SEED_WORKSPACE}/sessions/${sessionId}/turns`, {
    data: { client_turn_id: randomUUID(), text: 'Screen the applicant.' },
    headers: { origin: ORIGIN, 'x-scripted-script': 'transient_5xx' },
  });
  expect(turn.status(), await turn.text()).toBe(201);
  const runId = (await turn.json()).run_id as string;

  // The run finishes one way or the other — the 503 is retried by the step —
  // and the answer is shown once rather than twice, which is the assertion the
  // scenario is really about.
  await expect
    .poll(() => rows(`SELECT status FROM runs WHERE id = ${q(runId)};`)[0], { timeout: 40_000 })
    .toMatch(/completed|error/);
  const perTurn = rows(
    `SELECT count(*)::text FROM messages WHERE run_id = ${q(runId)} AND role = 'iris' AND status = 'complete' GROUP BY turn;`,
  );
  expect(perTurn.every((n) => n === '1')).toBe(true);
  await context.close();
});

// ---------------------------------------------------------------------------
// F8 · the read routes the Agent tab needs
// ---------------------------------------------------------------------------

test('F8 · Traces lists the run and opens it', async ({ browser }) => {
  const context = await asUser(browser, SEED_ADMIN);
  const page = await context.newPage();
  await page.goto(`/w/${SEED_WORKSPACE}`);

  const listed = await page.request.get(`/w/${SEED_WORKSPACE}/traces`);
  expect(listed.status()).toBe(200);
  const items = (await listed.json()).items as { id: string; status: string; steps: unknown[] }[];
  expect(items.length).toBeGreaterThan(0);

  const detail = await page.request.get(`/w/${SEED_WORKSPACE}/traces/${items[0]!.id}`);
  expect(detail.status()).toBe(200);
  const trace = await detail.json();
  expect(trace.id).toBe(items[0]!.id);
  expect(Array.isArray(trace.tool_calls)).toBe(true);
  expect(Array.isArray(trace.allowed_tools)).toBe(true);

  // A trace in another workspace is not readable from this one: the route is
  // `inWorkspace` like every other tenant read.
  const fixture = freshWorkspace('Trace isolation');
  const other = await asUser(browser, fixture.adminEmail);
  const otherPage = await other.newPage();
  await otherPage.goto(`/w/${fixture.workspaceId}`);
  const refused = await otherPage.request.get(`/w/${fixture.workspaceId}/traces/${items[0]!.id}`);
  expect(refused.status()).toBe(404);
  await other.close();
  await context.close();
});

// ---------------------------------------------------------------------------
// G1 · a share link is a share with the link holder, and with nobody else
// ---------------------------------------------------------------------------

test('G1 · the /shared/:token viewer renders the snapshot, read-only, with no session', async ({ browser }) => {
  // Before this, `createShare` minted a token, stored its hash and returned a
  // `/shared/` URL that no route consumed — while the *predicate* it stood in
  // for handed the session to every member of the workspace. Both halves are
  // asserted here: what the link holder gets, and what the Member still does
  // not (security review O1).
  const fixture = freshWorkspace('Share link');
  const admin = await asUser(browser, fixture.adminEmail);
  const page = await admin.newPage();
  await page.goto(`/workspace/${fixture.workspaceId}`);

  const created = await page.request.post(`/w/${fixture.workspaceId}/sessions`, {
    data: { title: 'G1 shared', mode: 'work' },
    headers: { origin: ORIGIN },
  });
  const sessionId = (await created.json()).id as string;
  const turn = await page.request.post(`/w/${fixture.workspaceId}/sessions/${sessionId}/turns`, {
    data: { text: 'Screen the applicant.', client_turn_id: randomUUID() },
    headers: { origin: ORIGIN },
  });
  expect(turn.status(), await turn.text()).toBeLessThan(300);
  await expect
    .poll(
      () => rows(`SELECT count(*)::text FROM messages WHERE session_id = ${q(sessionId)};`)[0],
      { timeout: 45_000, intervals: [500] },
    )
    .not.toBe('0');

  const share = await page.request.post(`/w/${fixture.workspaceId}/sessions/${sessionId}/shares`, {
    data: { audience: 'Finance' },
    headers: { origin: ORIGIN },
  });
  expect(share.status(), await share.text()).toBe(201);
  const { url, message_cutoff_seq: cutoff } = (await share.json()) as { url: string; message_cutoff_seq: number };
  const token = url.split('/').pop() ?? '';
  expect(token).toHaveLength(64);

  // A browser with no identity of any kind: no `x-dev-user`, no cookie.
  const anonymous = await browser.newContext();
  const viewer = await anonymous.newPage();
  await viewer.goto(`/shared/${token}`);
  await expect(viewer.getByText('G1 shared')).toBeVisible({ timeout: 20_000 });
  await expect(viewer.getByText(/Read only/)).toBeVisible();
  await expect(viewer.getByText('This is a read-only view. Referenced objects open only for signed-in members.')).toBeVisible();
  // Read-only means the controls are absent, not disabled.
  await expect(viewer.getByRole('button', { name: 'Send' })).toHaveCount(0);
  await expect(viewer.getByRole('button', { name: 'Stop' })).toHaveCount(0);

  // The JSON behind it, so the cap is asserted on the wire rather than on a
  // rendering.
  const data = await viewer.request.get(`/shared/${token}`, { headers: { accept: 'application/json' } });
  expect(data.status()).toBe(200);
  const body = (await data.json()) as { messages: { seq: number; blocks: unknown[] }[]; message_cutoff_seq: number };
  expect(body.message_cutoff_seq).toBe(cutoff);
  expect(Math.max(...body.messages.map((m) => m.seq))).toBeLessThanOrEqual(cutoff);
  for (const message of body.messages) expect(message.blocks).toEqual([]);

  // And the Member of the same workspace, who does not hold the link, sees
  // nothing of it. This is the half that used to be backwards.
  const member = await asUser(browser, fixture.memberEmail);
  const memberPage = await member.newPage();
  await memberPage.goto(`/workspace/${fixture.workspaceId}`);
  expect((await memberPage.request.get(`/w/${fixture.workspaceId}/sessions/${sessionId}`)).status()).toBe(404);
  expect((await memberPage.request.get(`/w/${fixture.workspaceId}/sessions/${sessionId}/messages`)).status()).toBe(404);
  const listed = await memberPage.request.get(`/w/${fixture.workspaceId}/sessions`);
  expect(((await listed.json()).items as { id: string }[]).map((s) => s.id)).not.toContain(sessionId);

  // Revoking it takes the link away.
  const shareId = rows(`SELECT id FROM session_shares WHERE session_id = ${q(sessionId)};`)[0] ?? '';
  const revoked = await page.request.delete(`/w/${fixture.workspaceId}/sessions/${sessionId}/shares/${shareId}`, {
    headers: { origin: ORIGIN },
  });
  expect(revoked.status()).toBe(204);
  // The isolate memo is five seconds; the directory row is already gone.
  await expect
    .poll(
      async () => (await viewer.request.get(`/shared/${token}`, { headers: { accept: 'application/json' } })).status(),
      { timeout: 20_000, intervals: [1000] },
    )
    .toBe(404);

  await member.close();
  await anonymous.close();
  await admin.close();
});

// ---------------------------------------------------------------------------
// G6 · the parked-run scenario, driven from a turn
// ---------------------------------------------------------------------------

test('G6 · the waiting script parks a run on a context field, and answering it resumes the run', async ({ browser }) => {
  // M3 in `live-m5a.spec.ts` inserts the parked run and its empty field with
  // `psql`, because no scripted scenario called `ask_for_context` (client
  // finding 14). This is the same screen with nothing inserted: the run parks
  // because the model asked, and the Context tab has a row to render because
  // the engine now writes the placeholder the question needs.
  const fixture = freshWorkspace('Waiting from a turn');
  const context = await asUser(browser, fixture.adminEmail);
  const page = await context.newPage();
  await page.goto(`/workspace/${fixture.workspaceId}`);

  const created = await page.request.post(`/w/${fixture.workspaceId}/sessions`, {
    data: { title: 'G6 waiting', mode: 'work' },
    headers: { origin: ORIGIN },
  });
  const sessionId = (await created.json()).id as string;
  const turn = await page.request.post(`/w/${fixture.workspaceId}/sessions/${sessionId}/turns`, {
    data: { text: 'Draft the reply.', client_turn_id: randomUUID() },
    headers: { origin: ORIGIN, 'x-scripted-script': 'waiting' },
  });
  expect(turn.status(), await turn.text()).toBeLessThan(300);
  const runId = (await turn.json()).run_id as string;

  await expect
    .poll(() => rows(`SELECT status FROM runs WHERE id = ${q(runId)};`)[0], { timeout: 45_000, intervals: [500] })
    .toBe('waiting');
  expect(rows(`SELECT waiting_for FROM runs WHERE id = ${q(runId)};`)[0]).toBe('destination');
  // The placeholder row, with no value in it: this is what the Context tab
  // lists, and what the run used to park without writing.
  expect(
    rows(`SELECT coalesce(value, '(null)') FROM agent_context_fields WHERE workspace_id = ${q(fixture.workspaceId)} AND key = 'destination';`)[0],
  ).toBe('(null)');

  // The same screen M3 drives, reached without a single inserted row.
  await page.reload();
  await page.getByRole('button', { name: 'Agents', exact: true }).first().click();
  const app = page.getByRole('region', { name: 'Application' });
  await expect(app.getByText('Missing · A reply is paused').first()).toBeVisible({ timeout: 20_000 });
  await app.getByRole('button', { name: 'Add context' }).first().click();
  const field = app.getByPlaceholder('Add a channel, email or link…');
  await field.fill('#partner-feedback');
  await app.getByRole('button', { name: 'Save & resume' }).click();

  // The answer is stored and the run is woken: the scripted scenario's second
  // half then runs, so the run reaches a terminal state on its own.
  await expect
    .poll(
      () => rows(`SELECT value FROM agent_context_fields WHERE workspace_id = ${q(fixture.workspaceId)} AND key = 'destination';`)[0],
      { timeout: 20_000 },
    )
    .toBe('#partner-feedback');
  await expect
    .poll(() => rows(`SELECT status FROM runs WHERE id = ${q(runId)};`)[0], { timeout: 60_000, intervals: [1000] })
    .toMatch(/completed|error/);
  expect(rows(`SELECT status FROM runs WHERE id = ${q(runId)};`)[0]).toBe('completed');

  await context.close();
});
