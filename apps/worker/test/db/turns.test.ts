// The turns route and the four controls, against the real database.
//
// The `RUN_ATTEMPT` binding is recorded rather than run: what is being tested
// here is the half the plan calls the idempotency record — the `runs` row is
// inserted first, a duplicate POST returns the existing run, and only then is
// the instance created, with a duplicate-id error a no-op. Whether the Workflow
// then does anything is the engine tests' subject.
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { runAttemptInstanceId } from '../../src/runs/workflow.js';
import { asUser, makeEnv, type HubCall } from './harness.js';
import { seedWorkspace, withClient, setTenant, type Fixture } from './helpers.js';

/**
 * `setTenant` uses `SET LOCAL`, which only takes effect inside a transaction —
 * the same rule the Worker's own tenant transaction relies on. A helper, so no
 * assertion in this file can accidentally read zero rows and call it a pass.
 */
async function asTenant<T>(
  workspaceId: string,
  userId: string,
  fn: (c: Parameters<Parameters<typeof withClient>[1]>[0]) => Promise<T>,
): Promise<T> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    try {
      await setTenant(c, workspaceId, userId);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

interface CreatedInstance {
  readonly id: string;
  readonly params: Record<string, unknown>;
}

function envWithWorkflow(overrides: Partial<Env> = {}): {
  env: Env;
  created: CreatedInstance[];
  hubCalls: HubCall[];
  events: { type: string; payload: unknown }[];
  hubStops: { session: string; runId: string }[];
} {
  const created: CreatedInstance[] = [];
  const events: { type: string; payload: unknown }[] = [];
  const hubStops: { session: string; runId: string }[] = [];
  const base = makeEnv({
    // Development-shaped: no provider key exists in a seeded workspace, and the
    // point of these tests is the route, not the model.
    MODEL_SCRIPTED: '1',
    // The hub is delivery, never truth: Stop is recorded here so a test can
    // assert that the row was written first and the hub told afterwards.
    SESSION_HUB: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        publish: () => ({ delivered: 0, lastId: null }),
        forward: () => ({ delivered: 0, lastId: null, stop_requested: false }),
        requestStop: (runId: string) => {
          hubStops.push({ session: id.name, runId });
          return Promise.resolve();
        },
      }),
    } as unknown as Env['SESSION_HUB'],
    RUN_ATTEMPT: {
      create: (options: { id: string; params: Record<string, unknown> }) => {
        if (created.some((c) => c.id === options.id)) {
          // What Cloudflare does: `create()` throws if the id is in use.
          throw new Error(`instance.id ${options.id} already exists`);
        }
        created.push({ id: options.id, params: options.params });
        return Promise.resolve({ id: options.id });
      },
      get: (id: string) => ({
        id,
        status: () => Promise.resolve({ status: 'running' }),
        sendEvent: (event: { type: string; payload: unknown }) => {
          events.push(event);
          return Promise.resolve();
        },
      }),
    } as unknown as Env['RUN_ATTEMPT'],
    ...overrides,
  });
  return { env: base.env, created, hubCalls: base.hubCalls, events, hubStops };
}

let fx: Fixture;
beforeAll(async () => {
  fx = await seedWorkspace();
});
afterAll(() => undefined);
afterEach(() => vi.restoreAllMocks());

const turnPath = (f: Fixture): string => `/w/${f.workspaceId}/sessions/${f.sessionId}/turns`;

describe('POST /w/:ws/sessions/:id/turns', () => {
  it('requires a client_turn_id, because it is the caller\'s idempotency key', async () => {
    const { env } = envWithWorkflow();
    const response = await asUser(env, fx.adminId, turnPath(fx), {
      method: 'POST',
      body: { text: 'Score this application.' },
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ reason: 'client_turn_id_required' });
  });

  it('rejects nonempty attachments before persisting a message or admitting a run', async () => {
    const workspace = await seedWorkspace();
    const { env, created } = envWithWorkflow();
    const clientTurnId = `turn-attachment-${randomUUID()}`;
    const response = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: {
        client_turn_id: clientTurnId,
        text: 'Review the attached application.',
        attachments: [{ id: randomUUID(), label: 'application.pdf', kind: 'file', status: 'ready' }],
      },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ reason: 'attachments_unsupported' });
    expect(created).toEqual([]);
    const count = await asTenant(workspace.workspaceId, workspace.adminId, async (c) =>
      c.query<{ count: string }>('SELECT count(*)::text AS count FROM runs WHERE client_turn_id = $1', [clientTurnId]));
    expect(count.rows[0]?.count).toBe('0');
  });

  it('refuses Hermes admission before creating a run when reservations are not durable', async () => {
    const workspace = await seedWorkspace();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      object: 'hermes.api_server.capabilities', platform: 'hermes-agent',
      auth: { type: 'bearer', required: true },
      runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
      features: {
        run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_steer: true,
        runs_idempotency: { supported: true, durable: false, retention_seconds: 86_400 },
      },
      endpoints: {
        runs: { method: 'POST', path: '/v1/runs' },
        run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
        run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
        run_steer: { method: 'POST', path: '/v1/runs/{run_id}/steer' },
        run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
      },
    }));
    const { env, created } = envWithWorkflow({
      MODEL_SCRIPTED: '0',
      AGENT_RUNTIME: 'hermes',
      HERMES_BRIDGE_SECRET: 'test-only-secret-longer-than-thirty-two-characters',
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [workspace.agentId]: {
          workspace_id: workspace.workspaceId,
          base_url: 'https://runtime.example',
          api_key: 'native-secret',
        },
      }),
    });
    const clientTurnId = `turn-nondurable-${randomUUID()}`;
    const response = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST', body: { client_turn_id: clientTurnId, text: 'Do not admit this.' },
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'runtime_unhealthy' });
    expect(created).toEqual([]);
    const count = await asTenant(workspace.workspaceId, workspace.adminId, async (c) =>
      c.query<{ count: string }>('SELECT count(*)::text AS count FROM runs WHERE client_turn_id = $1', [clientTurnId]));
    expect(count.rows[0]?.count).toBe('0');
  });

  it('uses the configured dashboard connector when admitting a Hermes Cloud turn', async () => {
    const workspace = await seedWorkspace();
    const send = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({
      object: 'hermes.api_server.capabilities', platform: 'hermes-agent',
      auth: { type: 'bearer', required: true },
      runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
      features: {
        run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_steer: true,
        runs_idempotency: { supported: true, durable: true, retention_seconds: 86_400 },
      },
      endpoints: {
        runs: { method: 'POST', path: '/v1/runs' },
        run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
        run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
        run_steer: { method: 'POST', path: '/v1/runs/{run_id}/steer' },
        run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
      },
    }));
    const { env } = envWithWorkflow({
      MODEL_SCRIPTED: '0',
      AGENT_RUNTIME: 'hermes',
      HERMES_BRIDGE_SECRET: 'test-only-secret-longer-than-thirty-two-characters',
      HERMES_RUNTIME_AGENTS: JSON.stringify({
        [workspace.agentId]: {
          workspace_id: workspace.workspaceId,
          base_url: 'https://runtime.example/control',
          api_key: 'connector-secret',
          transport: 'dashboard_connector',
        },
      }),
    });
    const response = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: `turn-connector-${randomUUID()}`, text: 'Read only.' },
    });

    // The connector was healthy, so admission reaches the next independent
    // guard (this fixture intentionally has no provider key).
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'no_key' });
    expect(send).toHaveBeenCalledWith(
      'https://runtime.example/control',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(send.mock.calls[0]?.[1]?.body))).toMatchObject({ operation: 'capabilities' });
  });

  it('creates one run, one instance, and names the instance ${run_id}-a1', async () => {
    const workspace = await seedWorkspace();
    const { env, created } = envWithWorkflow();
    const response = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: 'turn-a', text: 'Score this application.' },
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { run_id: string; status: string; attempt: number };
    expect(body.status).toBe('working');
    expect(body.attempt).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]?.id).toBe(runAttemptInstanceId(body.run_id, 1));
    expect(created[0]?.params).toMatchObject({ runId: body.run_id, attempt: 1, engineVersion: 1 });
  });

  it('returns the existing run on a duplicate POST and creates no second instance', async () => {
    const workspace = await seedWorkspace();
    const { env, created } = envWithWorkflow();
    const first = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: 'turn-dup', text: 'once' },
    });
    const second = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: 'turn-dup', text: 'twice' },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect((await first.json() as { run_id: string }).run_id).toBe((await second.json() as { run_id: string }).run_id);
    expect(created).toHaveLength(1);
  });

  it('refuses a second live run in one session', async () => {
    const workspace = await seedWorkspace();
    const { env } = envWithWorkflow();
    await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: 'turn-1', text: 'one' },
    });
    const second = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: 'turn-2', text: 'two' },
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ reason: 'run_in_flight' });
  });

  it('refuses when ENGINE_PAUSED is set, because the runbook says so', async () => {
    const workspace = await seedWorkspace();
    const { env } = envWithWorkflow({ ENGINE_PAUSED: '1' } as Partial<Env>);
    const response = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: 'turn-paused', text: 'hello' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'engine_paused' });
  });

  it('refuses when the workspace holds no verified key for the model\'s provider', async () => {
    const workspace = await seedWorkspace();
    const { env } = envWithWorkflow({ MODEL_SCRIPTED: '0' } as Partial<Env>);
    const response = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: 'turn-nokey', text: 'hello' },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'no_key' });
  });

  it('refuses at the concurrency cap rather than half way through a run', async () => {
    const workspace = await seedWorkspace();
    await asTenant(workspace.workspaceId, workspace.adminId, async (c) => {
      await c.query(`UPDATE workspace_settings SET max_concurrent_runs = 1 WHERE workspace_id = $1`, [
        workspace.workspaceId,
      ]);
      // A live run in another session, so the one-per-session index is not what
      // refuses this.
      const other = await c.query<{ id: string }>(
        `INSERT INTO sessions (workspace_id, owner_id, title, model_id)
         VALUES ($1, $2, 'Other', 'deepseek-flash') RETURNING id`,
        [workspace.workspaceId, workspace.adminId],
      );
      await c.query(
        `INSERT INTO runs (workspace_id, session_id, status, model_id, client_turn_id)
         VALUES ($1, $2, 'working', 'deepseek-flash', 'seeded')`,
        [workspace.workspaceId, other.rows[0]!.id],
      );
    });

    const { env } = envWithWorkflow();
    const response = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: 'turn-capped', text: 'hello' },
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ reason: 'max_concurrent_runs' });
  });

  it('appends the person\'s message and the run\'s first turn in the same transaction', async () => {
    const workspace = await seedWorkspace();
    const { env } = envWithWorkflow();
    const response = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: 'turn-msg', text: 'Here is the programme.' },
    });
    const { run_id } = (await response.json()) as { run_id: string };

    await asTenant(workspace.workspaceId, workspace.adminId, async (c) => {
      const messages = await c.query(`SELECT text, role, turn FROM messages WHERE run_id = $1`, [run_id]);
      expect(messages.rows).toHaveLength(1);
      expect(messages.rows[0]).toMatchObject({ role: 'user', turn: 0, text: 'Here is the programme.' });
      const turns = await c.query(`SELECT role, turn, seq FROM run_turns WHERE run_id = $1`, [run_id]);
      expect(turns.rows).toEqual([{ role: 'user', turn: 0, seq: 0 }]);
      const outbox = await c.query(`SELECT kind FROM stream_events WHERE workspace_id = $1`, [workspace.workspaceId]);
      expect(outbox.rows.map((r) => (r as { kind: string }).kind)).toContain('message.appended');
    });
  });
});

describe('the controls', () => {
  async function startRun(workspace: Fixture, env: Env): Promise<string> {
    const response = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: 'turn-control', text: 'go' },
    });
    return (await response.json() as { run_id: string }).run_id;
  }

  it('Stop writes the flag and the status in one transaction, then tells the hub', async () => {
    const workspace = await seedWorkspace();
    const { env, hubStops } = envWithWorkflow();
    const runId = await startRun(workspace, env);

    const response = await asUser(
      env,
      workspace.adminId,
      `/w/${workspace.workspaceId}/sessions/${workspace.sessionId}/runs/${runId}/stop`,
      { method: 'POST' },
    );
    expect(response.status).toBe(200);

    await asTenant(workspace.workspaceId, workspace.adminId, async (c) => {
      const { rows } = await c.query(`SELECT status, stop_requested FROM runs WHERE id = $1`, [runId]);
      expect(rows[0]).toMatchObject({ status: 'stopping', stop_requested: true });
    });
    // The hub's copy is written after the row, never instead of it.
    expect(hubStops).toEqual([{ session: workspace.sessionId, runId }]);
  });

  it('Guide records a guidance message the validator will accept as recorded', async () => {
    const workspace = await seedWorkspace();
    const { env } = envWithWorkflow();
    const runId = await startRun(workspace, env);

    const response = await asUser(
      env,
      workspace.adminId,
      `/w/${workspace.workspaceId}/sessions/${workspace.sessionId}/runs/${runId}/guide`,
      { method: 'POST', body: { text: 'Weight the references higher.' } },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { guidance_id: string; status: string };
    expect(body.status).toBe('queued');

    await asTenant(workspace.workspaceId, workspace.adminId, async (c) => {
      const { rows } = await c.query(`SELECT kind, status FROM messages WHERE id = $1`, [body.guidance_id]);
      expect(rows[0]).toMatchObject({ kind: 'guidance', status: 'streaming' });
    });
  });

  it('Queue takes an item, edits it, and marks a removal rather than deleting it', async () => {
    const workspace = await seedWorkspace();
    const { env } = envWithWorkflow();
    const runId = await startRun(workspace, env);
    const base = `/w/${workspace.workspaceId}/sessions/${workspace.sessionId}/runs/${runId}/queue`;

    const added = await asUser(env, workspace.adminId, base, { method: 'POST', body: { text: 'and then this' } });
    expect(added.status).toBe(201);
    const items = (await added.json() as { items: { id: string; status: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe('queued');

    const edited = await asUser(env, workspace.adminId, `${base}/${items[0]!.id}`, {
      method: 'PATCH',
      body: { text: 'and then that' },
    });
    expect((await edited.json() as { items: { text: string }[] }).items[0]?.text).toBe('and then that');

    const removed = await asUser(env, workspace.adminId, `${base}/${items[0]!.id}`, { method: 'DELETE' });
    expect((await removed.json() as { items: { status: string }[] }).items[0]?.status).toBe('removed');
  });

  it('Stop pauses the queue rather than dropping it', async () => {
    const workspace = await seedWorkspace();
    const { env } = envWithWorkflow();
    const runId = await startRun(workspace, env);
    const base = `/w/${workspace.workspaceId}/sessions/${workspace.sessionId}/runs/${runId}`;
    await asUser(env, workspace.adminId, `${base}/queue`, { method: 'POST', body: { text: 'later' } });
    await asUser(env, workspace.adminId, `${base}/stop`, { method: 'POST' });

    await asTenant(workspace.workspaceId, workspace.adminId, async (c) => {
      const { rows } = await c.query(`SELECT status FROM run_queue WHERE run_id = $1`, [runId]);
      expect(rows[0]).toMatchObject({ status: 'paused' });
    });
  });

  it('Retry creates ${run_id}-a2 and leaves the run row in place', async () => {
    const workspace = await seedWorkspace();
    const { env, created } = envWithWorkflow();
    const runId = await startRun(workspace, env);
    await asTenant(workspace.workspaceId, workspace.adminId, async (c) => {
      await c.query(`UPDATE runs SET status = 'error' WHERE id = $1`, [runId]);
    });

    const response = await asUser(
      env,
      workspace.adminId,
      `/w/${workspace.workspaceId}/sessions/${workspace.sessionId}/runs/${runId}/retry`,
      { method: 'POST', body: { expected_attempt: 1 } },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ run_id: runId, attempt: 2, status: 'working' });
    expect(created.map((c) => c.id)).toContain(runAttemptInstanceId(runId, 2));
  });

  it('refuses a Retry of a run that is still going', async () => {
    const workspace = await seedWorkspace();
    const { env } = envWithWorkflow();
    const runId = await startRun(workspace, env);
    const response = await asUser(
      env,
      workspace.adminId,
      `/w/${workspace.workspaceId}/sessions/${workspace.sessionId}/runs/${runId}/retry`,
      { method: 'POST', body: { expected_attempt: 1 } },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'run_active' });
  });
});

describe('the context answer', () => {
  it('writes the field and sends an ids-only event to the waiting instance', async () => {
    const workspace = await seedWorkspace();
    const { env, events } = envWithWorkflow();
    const started = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: 'turn-wait', text: 'go' },
    });
    const { run_id } = (await started.json()) as { run_id: string };

    await asTenant(workspace.workspaceId, workspace.adminId, async (c) => {
      await c.query(`UPDATE runs SET status = 'waiting', waiting_for = 'cohort_cap' WHERE id = $1`, [run_id]);
    });

    const response = await asUser(
      env,
      workspace.adminId,
      `/w/${workspace.workspaceId}/sessions/${workspace.sessionId}/runs/${run_id}/context`,
      { method: 'POST', body: { key: 'cohort_cap', value: '30' } },
    );
    expect(response.status).toBe(200);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('context-answered');
    // Ids only: Workflow instance state is retained 30 days and the erasure
    // inventory asserts it carries no free text. Asserted as the exact key set
    // rather than "does not contain the value", because a uuid that happens to
    // contain the answer's digits would make that assertion flaky.
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['key', 'run_id']);
    expect(payload.key).toBe('cohort_cap');
    expect(payload.run_id).toBe(run_id);

    await asTenant(workspace.workspaceId, workspace.adminId, async (c) => {
      const { rows } = await c.query(`SELECT value FROM agent_context_fields WHERE agent_id = $1 AND key = $2`, [
        workspace.agentId,
        'cohort_cap',
      ]);
      expect(rows[0]).toMatchObject({ value: '30' });
    });
  });

  it('refuses an answer to a key the run is not waiting on', async () => {
    const workspace = await seedWorkspace();
    const { env } = envWithWorkflow();
    const started = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: 'turn-wrongkey', text: 'go' },
    });
    const { run_id } = (await started.json()) as { run_id: string };
    const response = await asUser(
      env,
      workspace.adminId,
      `/w/${workspace.workspaceId}/sessions/${workspace.sessionId}/runs/${run_id}/context`,
      { method: 'POST', body: { key: 'something_else', value: 'x' } },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'run_not_waiting' });
  });
});

// ---------------------------------------------------------------------------
// O17 - a refused turn still costs the caller their budget
// ---------------------------------------------------------------------------

describe('O17 - turn refusals are metered', () => {
  const turnCount = async (userId: string): Promise<number> =>
    withClient('owner', async (c) => {
      const { rows } = await c.query<{ total: string }>(
        `SELECT COALESCE(sum(count), 0)::text AS total FROM rate_counters
          WHERE user_id = $1 AND action = 'run.turn'`,
        [userId],
      );
      return Number(rows[0]?.total ?? '0');
    });

  it('charges the counter for a refusal the caller can repeat', async () => {
    // `consumeRate` runs inside the tenant transaction so that a 500 of ours
    // does not spend somebody's budget. The cost was a refund on every failing
    // path, including the caller's own: a workspace with no key, or one over
    // its cap, could POST turns as fast as it liked and every attempt rolled
    // its own count back, while still costing a connection, a caps query and a
    // catalog read each time.
    const workspace = await seedWorkspace();
    const { env } = envWithWorkflow({ ENGINE_PAUSED: '1' } as Partial<Env>);
    const before = await turnCount(workspace.adminId);

    const response = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: `paused-${randomUUID()}`, text: 'go' },
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: 'engine_paused' });
    expect(await turnCount(workspace.adminId)).toBe(before + 1);
  });

  it('does not charge for an authorization answer, which would be a way to lock someone out', async () => {
    const workspace = await seedWorkspace();
    const { env } = envWithWorkflow();
    const before = await turnCount(workspace.memberId);

    // The Admin's session: a 404, not a refusal the Member can act on.
    const response = await asUser(env, workspace.memberId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: `not-mine-${randomUUID()}`, text: 'go' },
    });

    expect(response.status).toBe(404);
    expect(await turnCount(workspace.memberId)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// G7 · the Stop/Queue race
// ---------------------------------------------------------------------------

describe('G7 · Stop and Queue arriving together', () => {
  /**
   * Both orders, twenty times, and no item may be left `queued`.
   *
   * The race (client finding 15): `queueMessage` read `run.status` and inserted
   * `queued` unless the run was already stopping; `stopRun` moved every `queued`
   * row to `paused`. Nothing serialised the two, so an enqueue that read
   * `working` before Stop committed inserted its row *after* Stop's sweep had
   * run — and that row stayed `queued` forever: never sent, and not shown as
   * paused either. It is what made P7 fail about one full-suite run in three.
   *
   * `SELECT ... FOR UPDATE` on the `runs` row in both handlers is the fix, and
   * this is what makes it a regression test rather than a hope: without the
   * lock a twenty-iteration loop finds a stranded row reliably; with it there is
   * nothing to find, in either order, because the second transaction waits and
   * then reads the status the first one committed.
   */
  const startRun = async (workspace: Fixture, env: Env, clientTurnId: string): Promise<string> => {
    const response = await asUser(env, workspace.adminId, turnPath(workspace), {
      method: 'POST',
      body: { client_turn_id: clientTurnId, text: 'go' },
    });
    return (await response.json() as { run_id: string }).run_id;
  };

  it('never leaves a queue item stranded as queued, in either order', async () => {
    const workspace = await seedWorkspace();
    const { env } = envWithWorkflow();

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const runId = await startRun(workspace, env, `race-${attempt}`);
      const base = `/w/${workspace.workspaceId}/sessions/${workspace.sessionId}/runs/${runId}`;
      const stop = asUser(env, workspace.adminId, `${base}/stop`, { method: 'POST' });
      const queue = asUser(env, workspace.adminId, `${base}/queue`, {
        method: 'POST',
        body: { text: `and then this (${attempt})` },
      });
      // Started in both orders across the loop, because the interleaving that
      // loses is the one where Queue reads first and writes second.
      await Promise.all(attempt % 2 === 0 ? [stop, queue] : [queue, stop]);

      const rows = await asTenant(workspace.workspaceId, workspace.adminId, async (c) => {
        const result = await c.query<{ status: string }>(`SELECT status FROM run_queue WHERE run_id = $1`, [runId]);
        return result.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status, `attempt ${attempt} left the item ${rows[0]?.status}`).toBe('paused');

      // And the run itself is stopping, whichever way round they arrived.
      await asTenant(workspace.workspaceId, workspace.adminId, async (c) => {
        const { rows: runRows } = await c.query<{ status: string; stop_requested: boolean }>(
          `SELECT status, stop_requested FROM runs WHERE id = $1`,
          [runId],
        );
        expect(runRows[0]).toMatchObject({ status: 'stopping', stop_requested: true });
      });

      await asTenant(workspace.workspaceId, workspace.adminId, async (c) => {
        await c.query(`UPDATE runs SET status = 'stopped', ended_at = now() WHERE id = $1`, [runId]);
      });
    }
  });
});
