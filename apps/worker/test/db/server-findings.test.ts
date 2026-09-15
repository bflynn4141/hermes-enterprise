// One test per finding in `apps/client/README.md`'s "Server findings" table.
//
// Every one of these was found by the client's live integration rather than by
// a test, which is the point of keeping them together: the file is the answer
// to "did we actually fix what the integration hit, or only what we thought it
// hit?". The fixes are recorded as decisions F1 to F8.
//
// Node rather than workerd, for the reason `routes.test.ts` gives: the real
// Hono app, the real SQL, the real transactions, an `Env` whose Hyperdrive
// bindings point at Docker Postgres.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import type { Env } from '../../src/env.js';
import { APP_URL, AGENT_URL } from '../../scripts/db-config.mjs';
import { seedWorkspace, withClient, setTenant, type Fixture } from './helpers.js';

const ORIGIN = 'https://hermes.test';

/**
 * A stub assets binding.
 *
 * It answers `/` with something recognisable and everything else with 404, so
 * a test that asserts "the SPA shell was served" is asserting that the Worker
 * asked the binding for the shell — not that some other 200 happened to come
 * back.
 */
const assets = {
  fetch: (request: Request) =>
    Promise.resolve(
      new URL(request.url).pathname === '/'
        ? new Response('<!doctype html><title>Hermes</title><div id="root"></div>', {
            headers: { 'content-type': 'text/html; charset=utf-8', etag: '"shell"' },
          })
        : new Response('not found', { status: 404 }),
    ),
} as unknown as Fetcher;

const baseEnv = {
  ENVIRONMENT: 'test',
  ENGINE_VERSION: '1',
  AUTH_MODE: 'fake',
  MODEL_GATEWAY_MODE: 'off',
  ENGINE_PAUSED: '0',
  ALLOWED_ORIGINS: ORIGIN,
  HYPERDRIVE_APP: { connectionString: APP_URL },
  HYPERDRIVE_AGENT: { connectionString: AGENT_URL },
  ASSETS: assets,
} as unknown as Env;

const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext;

const call = (
  path: string,
  init: RequestInit & { env?: Env } = {},
): Promise<Response> => {
  const { env, ...rest } = init;
  return Promise.resolve(worker.fetch(new Request(`${ORIGIN}${path}`, rest), env ?? baseEnv, ctx));
};

const asUser = (id: string): Record<string, string> => ({ 'x-dev-user': id });
/** A state-changing call needs an allowlisted Origin and a CSRF pair. */
const asWriter = (id: string): Record<string, string> => ({
  ...asUser(id),
  origin: ORIGIN,
  'content-type': 'application/json',
});

/**
 * Saving or discarding an instruction version says which screen it came from.
 * See `src/domain/guards.ts` and security review O3.
 */
const asSkillsReviewer = (id: string): Record<string, string> => ({
  ...asWriter(id),
  'x-requested-from': 'skills',
});

async function emailOf(userId: string): Promise<string> {
  return withClient('owner', async (c) => {
    const { rows } = await c.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [userId]);
    return rows[0]!.email;
  });
}

// ---------------------------------------------------------------------------
// F1 · the catch-all answers a navigation with the app and a fetch with JSON
// ---------------------------------------------------------------------------

describe('F1 · the SPA fallback', () => {
  it('serves the client bundle for a browser navigation to /w/:ws', async () => {
    const fx = await seedWorkspace();
    const response = await call(`/w/${fx.workspaceId}`, {
      headers: { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/text\/html/);
    expect(await response.text()).toContain('<div id="root">');
  });

  it('serves the bundle for a deep link the Worker has no route for', async () => {
    const fx = await seedWorkspace();
    const response = await call(`/w/${fx.workspaceId}/inbox/request/whatever`, {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });

  it('still answers a fetch() for data with unknown_route, not HTML', async () => {
    const fx = await seedWorkspace();
    const response = await call(`/w/${fx.workspaceId}/no-such-route`, {
      headers: { accept: 'application/json', 'sec-fetch-mode': 'cors' },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'unknown_route' });
  });

  it('answers /api/* with JSON even for a navigation: that prefix means data', async () => {
    const response = await call('/api/anything', {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'unknown_route' });
  });

  it('serves the bundle for an unknown non-API path', async () => {
    const response = await call('/onboarding/create', {
      headers: { accept: 'text/html', 'sec-fetch-mode': 'navigate' },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });
});

// ---------------------------------------------------------------------------
// F2 · POST /workspaces is reachable, and an invitation can be accepted
// ---------------------------------------------------------------------------

describe('F2 · the two routes with no tenant in their path', () => {
  it('reaches POST /workspaces rather than the assets binding', async () => {
    const fx = await seedWorkspace();
    const response = await call('/workspaces', {
      method: 'POST',
      headers: asWriter(fx.adminId),
      body: JSON.stringify({ name: 'A brand new workspace' }),
    });
    // The point of the test is that the Worker answered at all: before the
    // `run_worker_first` fix the assets binding answered 405 and this route
    // was unreachable. 201 is the success; anything else must at least be the
    // Worker's own JSON.
    expect(response.status).toBe(201);
    const body = (await response.json()) as { workspace: { id: string; name: string } };
    expect(body.workspace.name).toBe('A brand new workspace');
  });

  it('accepts an invitation for the signed-in user whose email matches', async () => {
    const fx = await seedWorkspace();
    const joinerId = randomUUID();
    const joinerEmail = `joiner-${joinerId.slice(0, 8)}@example.test`;
    const token = randomUUID();

    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await c.query(`INSERT INTO users (id, email, email_verified, name) VALUES ($1, $2, true, 'Jo Iner')`, [
        joinerId,
        joinerEmail,
      ]);
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO invitations (id, workspace_id, email, role, expires_at, invited_by)
         VALUES ($1, $2, $3, 'member', now() + interval '7 days', $4)`,
        [token, fx.workspaceId, joinerEmail, fx.adminId],
      );
      await c.query('COMMIT');
    });

    const response = await call(`/invitations/${token}/accept`, {
      method: 'POST',
      headers: asWriter(joinerId),
      body: '{}',
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { workspace: { id: string }; viewer: { role: string } };
    expect(body.workspace.id).toBe(fx.workspaceId);
    expect(body.viewer.role).toBe('member');

    const state = await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const member = await c.query(`SELECT role FROM members WHERE workspace_id = $1 AND user_id = $2`, [
        fx.workspaceId,
        joinerId,
      ]);
      const invite = await c.query<{ status: string }>(`SELECT status FROM invitations WHERE id = $1`, [token]);
      await c.query('COMMIT');
      return { members: member.rowCount, status: invite.rows[0]?.status };
    });
    expect(state.members).toBe(1);
    expect(state.status).toBe('accepted');
  });

  it('refuses an invitation forwarded to someone else', async () => {
    const fx = await seedWorkspace();
    const token = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO invitations (id, workspace_id, email, role, expires_at, invited_by)
         VALUES ($1, $2, 'someone-else@example.test', 'member', now() + interval '7 days', $3)`,
        [token, fx.workspaceId, fx.adminId],
      );
      await c.query('COMMIT');
    });

    const response = await call(`/invitations/${token}/accept`, {
      method: 'POST',
      headers: asWriter(fx.memberId),
      body: '{}',
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: 'invitation_email_mismatch' });
  });

  it('answers one thing for an unknown token', async () => {
    const fx = await seedWorkspace();
    const response = await call(`/invitations/${randomUUID()}/accept`, {
      method: 'POST',
      headers: asWriter(fx.adminId),
      body: '{}',
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'invitation_unavailable' });
  });
});

// ---------------------------------------------------------------------------
// F4 · the development step-up
// ---------------------------------------------------------------------------

describe('F4 · GET /auth/login?step_up=1 in fake mode', () => {
  it('re-stamps authenticated_at and redirects back', async () => {
    const fx = await seedWorkspace();
    // Touch the session once so the row exists, then push it into the past:
    // this is the state a dev workspace is in five minutes after it opens.
    await call(`/w/${fx.workspaceId}/bootstrap`, { headers: asUser(fx.adminId) });
    await withClient('owner', (c) =>
      c.query(`UPDATE auth_sessions SET authenticated_at = now() - interval '2 hours' WHERE sid = $1`, [
        `dev-${fx.adminId}`,
      ]),
    );

    const response = await call(`/auth/login?step_up=1&return_to=/workspace/${fx.workspaceId}`, {
      headers: asUser(fx.adminId),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/workspace/${fx.workspaceId}`);

    const age = await withClient('owner', async (c) => {
      const { rows } = await c.query<{ seconds: string }>(
        `SELECT extract(epoch from now() - authenticated_at)::text AS seconds FROM auth_sessions WHERE sid = $1`,
        [`dev-${fx.adminId}`],
      );
      return Number(rows[0]!.seconds);
    });
    // Fresh, and by the *five minute* rule the guards already apply — the
    // route moves the clock the rule reads, it does not widen the window.
    expect(age).toBeLessThan(60);
  });

  it('collapses an off-site return_to to /', async () => {
    const fx = await seedWorkspace();
    const response = await call('/auth/login?step_up=1&return_to=https://evil.example/', {
      headers: asUser(fx.adminId),
    });
    expect(response.headers.get('location')).toBe('/');
  });
});

// ---------------------------------------------------------------------------
// F5 · error mapping: a known condition is never a 500
// ---------------------------------------------------------------------------

describe('F5 · app.onError', () => {
  it('answers 503 kek_unavailable when no KEK secret is set', async () => {
    const fx = await seedWorkspace();
    const response = await call(`/w/${fx.workspaceId}/provider-keys`, {
      method: 'POST',
      headers: asWriter(fx.adminId),
      body: JSON.stringify({ provider: 'deepseek', label: 'test', key: 'fake-provider-key' }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'kek_unavailable' });
  });

  it('answers 409 already_revoked when a revoked key is removed again', async () => {
    const fx = await seedWorkspace();
    const keyId = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO workspace_provider_keys
           (id, workspace_id, provider, label, ciphertext, iv, wrapped_dek, wrap_iv, kek_version,
            fingerprint, last4, status, revoked_at)
         VALUES ($1, $2, 'deepseek', 'gone', '\\x00', '\\x00', '\\x00', '\\x00', 1,
                 $3, '1234', 'revoked', now())`,
        [keyId, fx.workspaceId, `fp-${keyId}`],
      );
      await c.query('COMMIT');
    });

    const response = await call(`/w/${fx.workspaceId}/provider-keys/${keyId}`, {
      method: 'DELETE',
      headers: asWriter(fx.adminId),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'already_revoked' });
  });

  it('answers 404 not_found for a key that never existed', async () => {
    const fx = await seedWorkspace();
    const response = await call(`/w/${fx.workspaceId}/provider-keys/${randomUUID()}`, {
      method: 'DELETE',
      headers: asWriter(fx.adminId),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// F7 · GET /auth/session with no ?ws
// ---------------------------------------------------------------------------

describe('F7 · GET /auth/session without ?ws', () => {
  it('lists the workspaces the member is in instead of 404', async () => {
    const fx = await seedWorkspace();
    const response = await call('/auth/session', { headers: asUser(fx.memberId) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      user: { email: string };
      workspaces: { id: string; name: string; role: string }[];
      authenticated_at: string;
    };
    expect(body.user.email).toBe(await emailOf(fx.memberId));
    expect(body.workspaces.map((w) => w.id)).toContain(fx.workspaceId);
    expect(body.workspaces.find((w) => w.id === fx.workspaceId)?.role).toBe('member');
    // Stream heads and a hub ticket are per-workspace; no workspace was named,
    // so neither is invented.
    expect(body).not.toHaveProperty('stream_heads');
    expect(body).not.toHaveProperty('hub_ticket');
  });

  it('still answers the full session shape when ?ws names one', async () => {
    const fx = await seedWorkspace();
    const response = await call(`/auth/session?ws=${fx.workspaceId}`, { headers: asUser(fx.adminId) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { workspace: { id: string }; stream_heads: unknown; hub_ticket: string };
    expect(body.workspace.id).toBe(fx.workspaceId);
    expect(body.stream_heads).toBeTruthy();
    expect(body.hub_ticket.length).toBeGreaterThan(0);
  });

  it('answers no_workspace for someone who is in none', async () => {
    const orphanId = randomUUID();
    await withClient('owner', (c) =>
      c.query(`INSERT INTO users (id, email, email_verified, name) VALUES ($1, $2, true, 'Nobody')`, [
        orphanId,
        `orphan-${orphanId.slice(0, 8)}@example.test`,
      ]),
    );
    const response = await call('/auth/session', { headers: asUser(orphanId) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ reason: 'no_workspace' });
  });
});

// ---------------------------------------------------------------------------
// F8 · the read routes the client needs
// ---------------------------------------------------------------------------

/** A finished run with a step, a tool call, its result and a focus event. */
async function seedRun(fx: Fixture): Promise<{ runId: string; requestId: string }> {
  const runId = randomUUID();
  const requestId = randomUUID();
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    await c.query(
      `INSERT INTO runs (id, workspace_id, session_id, status, mode, model_id, active_ms, client_turn_id, attempt)
       VALUES ($1, $2, $3, 'completed', 'work', 'deepseek-flash', 4200, $4, 1)`,
      [runId, fx.workspaceId, fx.sessionId, `turn-${runId.slice(0, 8)}`],
    );
    await c.query(
      `INSERT INTO requests (id, workspace_id, kind, label, payload, session_id, run_id, tool_call_id)
       VALUES ($1, $2, 'application', 'Ada Ling', '{"kind":"application"}'::jsonb, $3, $4, 'call_1')`,
      [requestId, fx.workspaceId, fx.sessionId, runId],
    );
    await c.query(
      `INSERT INTO run_steps (workspace_id, run_id, turn, step_id, label, state, tool_call_id)
       VALUES ($1, $2, 1, 'tool-call_1', 'propose_request', 'done', 'call_1')`,
      [fx.workspaceId, runId],
    );
    await c.query(
      `INSERT INTO run_turns (workspace_id, run_id, turn, seq, role, provider_message)
       VALUES ($1, $2, 1, 100, 'assistant', $3::jsonb)`,
      [
        fx.workspaceId,
        runId,
        JSON.stringify({
          role: 'assistant',
          content: 'Proposing.',
          tool_calls: [{ id: 'call_1', name: 'propose_request', arguments: '{"kind":"application"}' }],
        }),
      ],
    );
    await c.query(
      `INSERT INTO run_turns (workspace_id, run_id, turn, seq, role, provider_message, tool_call_id)
       VALUES ($1, $2, 2, 0, 'tool', $3::jsonb, 'call_1')`,
      [
        fx.workspaceId,
        runId,
        JSON.stringify({
          role: 'tool',
          tool_call_id: 'call_1',
          content: JSON.stringify({ tool: 'propose_request', data: { request_id: requestId } }),
        }),
      ],
    );
    await c.query(
      `INSERT INTO run_turns (workspace_id, run_id, turn, seq, role, provider_message, tool_call_id)
       VALUES ($1, $2, 2, 1, 'tool', $3::jsonb, 'call_2')`,
      [
        fx.workspaceId,
        runId,
        JSON.stringify({
          role: 'tool',
          tool_call_id: 'call_2',
          content: JSON.stringify({ tool: 'fetch_url', data: { url: 'https://example.test/policy' } }),
        }),
      ],
    );
    await c.query(
      `INSERT INTO stream_events (workspace_id, session_id, kind, payload)
       VALUES ($1, $2, 'run.focus', $3::jsonb)`,
      [
        fx.workspaceId,
        fx.sessionId,
        JSON.stringify({
          run_id: runId,
          session_id: fx.sessionId,
          ref: { section: 'inbox', view: 'request', id: requestId },
          entity_type: 'request',
          entity_id: requestId,
        }),
      ],
    );
    await c.query(
      `INSERT INTO agent_capabilities (workspace_id, agent_id, kind, title, tool_names)
       VALUES ($1, $2, 'can', 'Screen applications', ARRAY['list_requests','propose_request'])`,
      [fx.workspaceId, fx.agentId],
    );
    await c.query('COMMIT');
  });
  return { runId, requestId };
}

describe('F8 · traces', () => {
  it('lists runs with status, mode, model, worked time and a step count', async () => {
    const fx = await seedWorkspace();
    const { runId } = await seedRun(fx);
    const response = await call(`/w/${fx.workspaceId}/traces`, { headers: asUser(fx.adminId) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: { id: string; status: string; mode: string; model_id: string; active_ms: number; step_count: number }[];
    };
    const trace = body.items.find((item) => item.id === runId);
    expect(trace).toBeTruthy();
    expect(trace!.status).toBe('completed');
    expect(trace!.mode).toBe('work');
    expect(trace!.model_id).toBe('deepseek-flash');
    expect(trace!.active_ms).toBe(4200);
    expect(trace!.step_count).toBe(1);
  });

  it('shows one run’s steps, tool calls and results, fetched URLs, focus and allowed tools', async () => {
    const fx = await seedWorkspace();
    const { runId, requestId } = await seedRun(fx);
    const response = await call(`/w/${fx.workspaceId}/traces/${runId}`, { headers: asUser(fx.adminId) });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      steps: { id: string; label: string; state: string }[];
      tool_calls: { tool_call_id: string; name: string; arguments: string | null; result: string | null; truncated: boolean }[];
      fetched_urls: string[];
      focus: { entity_id: string }[];
      allowed_tools: string[];
    };
    expect(body.steps.map((s) => s.label)).toContain('propose_request');
    const call1 = body.tool_calls.find((t) => t.tool_call_id === 'call_1');
    expect(call1?.name).toBe('propose_request');
    expect(call1?.arguments).toContain('application');
    expect(call1?.result).toContain(requestId);
    expect(call1?.truncated).toBe(false);
    expect(body.fetched_urls).toContain('https://example.test/policy');
    expect(body.focus.map((f) => f.entity_id)).toContain(requestId);
    expect(body.allowed_tools).toEqual(['list_requests', 'propose_request']);
  });

  it('marks a result that carried the 8 KB truncation marker', async () => {
    const fx = await seedWorkspace();
    const { runId } = await seedRun(fx);
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `UPDATE run_turns SET provider_message = $3::jsonb
          WHERE run_id = $1 AND tool_call_id = 'call_1' AND role = 'tool' AND workspace_id = $2`,
        [
          runId,
          fx.workspaceId,
          JSON.stringify({
            role: 'tool',
            tool_call_id: 'call_1',
            content: 'a very long result\n[truncated: the result exceeded 8 KB]',
          }),
        ],
      );
      await c.query('COMMIT');
    });
    const response = await call(`/w/${fx.workspaceId}/traces/${runId}`, { headers: asUser(fx.adminId) });
    const body = (await response.json()) as { tool_calls: { tool_call_id: string; truncated: boolean }[] };
    expect(body.tool_calls.find((t) => t.tool_call_id === 'call_1')?.truncated).toBe(true);
  });

  it('answers 404 for a run in another workspace', async () => {
    const mine = await seedWorkspace();
    const theirs = await seedWorkspace();
    const { runId } = await seedRun(theirs);
    const response = await call(`/w/${mine.workspaceId}/traces/${runId}`, { headers: asUser(mine.adminId) });
    expect(response.status).toBe(404);
  });
});

describe('F8 · skills, instructions and context fields', () => {
  it('lists skill versions and adopts one', async () => {
    const fx = await seedWorkspace();
    const skillId = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO skill_versions (id, workspace_id, skill_key, version, name, description, body, shared_by)
         VALUES ($1, $2, 'screening', 1, 'Screening', 'How this workspace screens', 'Step one.', $3)`,
        [skillId, fx.workspaceId, fx.adminId],
      );
      await c.query('COMMIT');
    });

    const listed = await call(`/w/${fx.workspaceId}/skills`, { headers: asUser(fx.adminId) });
    expect(listed.status).toBe(200);
    const page = (await listed.json()) as { items: { id: string; version: string; adopted: boolean }[] };
    expect(page.items.find((s) => s.id === skillId)).toMatchObject({ version: 'v1', adopted: false });

    const adopted = await call(`/w/${fx.workspaceId}/skills/${skillId}/adopt`, {
      method: 'POST',
      headers: asWriter(fx.adminId),
      body: '{}',
    });
    expect(adopted.status).toBe(200);
    expect(await adopted.json()).toMatchObject({ id: skillId, adopted: true });

    // Idempotent: the primary key is (agent_id, skill_version_id).
    const again = await call(`/w/${fx.workspaceId}/skills/${skillId}/adopt`, {
      method: 'POST',
      headers: asWriter(fx.adminId),
      body: '{}',
    });
    expect(again.status).toBe(200);
  });

  it('moves a proposed instruction to active, with provenance, for an Admin only', async () => {
    const fx = await seedWorkspace();
    const versionId = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO instruction_versions (id, workspace_id, agent_id, body, status, run_id, tool_call_id)
         VALUES ($1, $2, $3, 'Screen against the published criteria.', 'proposed', $4, 'call_9')`,
        [versionId, fx.workspaceId, fx.agentId, randomUUID()],
      );
      await c.query('COMMIT');
    });

    const listed = await call(`/w/${fx.workspaceId}/instructions`, { headers: asUser(fx.memberId) });
    const page = (await listed.json()) as { items: { id: string; state: string; provenance: string | null }[] };
    const proposal = page.items.find((i) => i.id === versionId);
    expect(proposal?.state).toBe('proposed');
    expect(proposal?.provenance).toContain('run');

    // A Member may read the proposal and may not save it.
    const refused = await call(`/w/${fx.workspaceId}/instructions/${versionId}/accept`, {
      method: 'POST',
      headers: asSkillsReviewer(fx.memberId),
      body: '{}',
    });
    expect(refused.status).toBe(403);

    const accepted = await call(`/w/${fx.workspaceId}/instructions/${versionId}/accept`, {
      method: 'POST',
      headers: asSkillsReviewer(fx.adminId),
      body: '{}',
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ id: versionId, state: 'current' });

    // A second click is a 409, not a silent success.
    const twice = await call(`/w/${fx.workspaceId}/instructions/${versionId}/accept`, {
      method: 'POST',
      headers: asSkillsReviewer(fx.adminId),
      body: '{}',
    });
    expect(twice.status).toBe(409);
  });

  it('refuses to save a proposal that did not come from the Skills review pane', async () => {
    // Security review O3. `apply_prepared_proposal` is out of MODEL_COMMANDS, so
    // a model-authored button cannot carry it; this is the second lock on the
    // same door — the route itself asks which screen the call came from, which
    // also forces a CORS preflight, so no form post or link can reach it.
    const fx = await seedWorkspace();
    const versionId = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO instruction_versions (id, workspace_id, agent_id, body, status)
         VALUES ($1, $2, $3, 'Approve anything under 5,000.', 'proposed')`,
        [versionId, fx.workspaceId, fx.agentId],
      );
      await c.query('COMMIT');
    });

    for (const verb of ['accept', 'discard']) {
      const response = await call(`/w/${fx.workspaceId}/instructions/${versionId}/${verb}`, {
        method: 'POST',
        headers: asWriter(fx.adminId),
        body: '{}',
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ reason: 'wrong_surface' });
    }

    // And a header naming some other surface is not a way round it.
    const wrong = await call(`/w/${fx.workspaceId}/instructions/${versionId}/accept`, {
      method: 'POST',
      headers: { ...asWriter(fx.adminId), 'x-requested-from': 'inbox' },
      body: '{}',
    });
    expect(wrong.status).toBe(403);

    const status = await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const { rows } = await c.query<{ status: string }>(`SELECT status FROM instruction_versions WHERE id = $1`, [
        versionId,
      ]);
      await c.query('COMMIT');
      return rows[0]?.status;
    });
    expect(status).toBe('proposed');
  });

  it('discards a proposal', async () => {
    const fx = await seedWorkspace();
    const versionId = randomUUID();
    await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      await c.query(
        `INSERT INTO instruction_versions (id, workspace_id, agent_id, body, status)
         VALUES ($1, $2, $3, 'Never mind.', 'proposed')`,
        [versionId, fx.workspaceId, fx.agentId],
      );
      await c.query('COMMIT');
    });
    const response = await call(`/w/${fx.workspaceId}/instructions/${versionId}/discard`, {
      method: 'POST',
      headers: asSkillsReviewer(fx.adminId),
      body: '{}',
    });
    expect(response.status).toBe(200);
    const status = await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const { rows } = await c.query<{ status: string }>(`SELECT status FROM instruction_versions WHERE id = $1`, [
        versionId,
      ]);
      await c.query('COMMIT');
      return rows[0]?.status;
    });
    expect(status).toBe('discarded');
  });

  it('reads and writes a context field, and the write is the human answer', async () => {
    const fx = await seedWorkspace();
    const written = await call(`/w/${fx.workspaceId}/context-fields/destination`, {
      method: 'PATCH',
      headers: asWriter(fx.adminId),
      body: JSON.stringify({ value: 'the shared drive', scope: 'future' }),
    });
    expect(written.status).toBe(200);
    expect(await written.json()).toMatchObject({ field: 'destination', value: 'the shared drive', scope: 'future' });

    const listed = await call(`/w/${fx.workspaceId}/context-fields`, { headers: asUser(fx.memberId) });
    const page = (await listed.json()) as { items: { field: string; value: string | null }[] };
    expect(page.items.find((f) => f.field === 'destination')?.value).toBe('the shared drive');

    // The row the engine reads is the row that was written, under the agent.
    const stored = await withClient('owner', async (c) => {
      await c.query('BEGIN');
      await setTenant(c, fx.workspaceId, fx.adminId);
      const { rows } = await c.query<{ value: string; set_by: string }>(
        `SELECT value, set_by::text FROM agent_context_fields WHERE agent_id = $1 AND key = 'destination'`,
        [fx.agentId],
      );
      await c.query('COMMIT');
      return rows[0];
    });
    expect(stored?.value).toBe('the shared drive');
    expect(stored?.set_by).toBe(fx.adminId);
  });
});
