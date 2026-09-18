import { describe, expect, it } from 'vitest';
import {
  exportRaindropRun,
  loadRaindropRunSnapshot,
  type RaindropSnapshotDb,
} from '../../src/ops/raindrop.js';

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const AGENT_ID = '44444444-4444-4444-8444-444444444444';
const TRACE_ID = 'trace-private-55555555-5555-4555-8555-555555555555';
const WRITE_KEY = 'test-write-key-never-log';

const completedRow = {
  id: RUN_ID,
  workspace_id: WORKSPACE_ID,
  session_id: SESSION_ID,
  agent_id: AGENT_ID,
  runtime_kind: 'hermes',
  status: 'completed',
  model_id: 'nous:stepfun/step-3.7-flash',
  mode: 'work',
  active_ms: 12_345,
  attempt: 1,
  trace_id: TRACE_ID,
  ended_at: new Date('2026-09-18T12:00:00.000Z'),
  error: null,
  output_present: true,
  output_characters: 418,
  tools: [
    { name: 'list_requests', state: 'done' },
    { name: 'propose_request', state: 'done' },
  ],
};

function fakeDb(row: Record<string, unknown> | null = completedRow) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const db: RaindropSnapshotDb = {
    async runtimeQuery<T>(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      return { rows: row ? [row as T] : [] };
    },
  };
  return { ...db, calls };
}

function fakeFetch(
  responder: (url: string, init: RequestInit | undefined) => Promise<Response> = async () => new Response(null, { status: 200 }),
) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher = (async (...args: Parameters<typeof fetch>): Promise<Response> => {
    const [input, init] = args;
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return responder(url, init);
  }) as typeof fetch;
  return { calls, fetcher };
}

function env(overrides: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: 'staging',
    RAINDROP_OBSERVABILITY_MODE: 'active' as const,
    RAINDROP_WRITE_KEY: WRITE_KEY,
    RAINDROP_PROJECT_ID: 'project-hermes-staging',
    ...overrides,
  };
}

describe('Raindrop terminal run observability', () => {
  it('loads counts and tool lifecycle metadata without selecting message or tool contents', async () => {
    const db = fakeDb();
    const snapshot = await loadRaindropRunSnapshot(db, RUN_ID);
    expect(snapshot).toMatchObject({
      id: RUN_ID,
      status: 'completed',
      outputPresent: true,
      outputCharacters: 418,
      tools: completedRow.tools,
    });
    const sql = db.calls[0]?.text ?? '';
    expect(sql).not.toMatch(/SELECT\s+(?:m\.)?text\b/i);
    expect(sql).not.toContain('provider_message');
    expect(sql).not.toContain('runtime_request');
  });

  it('posts one pseudonymous metadata-only AI event for a completed Hermes run', async () => {
    const db = fakeDb();
    const { fetcher, calls } = fakeFetch(async () => new Response(null, { status: 202 }));
    const result = await exportRaindropRun(env(), db, RUN_ID, fetcher);

    expect(result).toMatchObject({ status: 'sent', signal: null });
    expect(calls).toHaveLength(1);
    const request = calls[0]!;
    expect(request.url).toBe('https://api.raindrop.ai/v1/events/track');
    expect(request.init?.headers).toMatchObject({
      Authorization: `Bearer ${WRITE_KEY}`,
      'X-Raindrop-Project-Id': 'project-hermes-staging',
    });
    const [event] = JSON.parse(String(request.init?.body)) as Array<Record<string, unknown>>;
    expect(event).toMatchObject({
      event: 'hermes.run',
      event_id: expect.stringMatching(/^hermes-[a-f0-9]{32}$/),
      user_id: expect.stringMatching(/^agent-[a-f0-9]{32}$/),
      ai_data: {
        model: completedRow.model_id,
        convo_id: expect.stringMatching(/^session-[a-f0-9]{32}$/),
      },
      properties: {
        runtime: 'hermes',
        status: 'completed',
        output_present: true,
        output_characters: 418,
        tool_names: ['list_requests', 'propose_request'],
      },
    });
    const serialized = JSON.stringify(event);
    for (const privateValue of [RUN_ID, WORKSPACE_ID, SESSION_ID, AGENT_ID, TRACE_ID, WRITE_KEY]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serialized).not.toContain('arguments');
    expect(serialized).not.toContain('result');
  });

  it('adds an explicit negative signal when tools ran but no final response exists', async () => {
    const db = fakeDb({ ...completedRow, output_present: false, output_characters: 0 });
    const { fetcher, calls } = fakeFetch();
    const result = await exportRaindropRun(env(), db, RUN_ID, fetcher);

    expect(result).toMatchObject({
      status: 'sent',
      signal: 'Hermes used tools without a final response',
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe('https://api.raindrop.ai/v1/signals/track');
    const [signal] = JSON.parse(String(calls[1]?.init?.body)) as Array<Record<string, unknown>>;
    expect(signal).toMatchObject({
      signal_name: 'Hermes used tools without a final response',
      sentiment: 'NEGATIVE',
      signal_type: 'agent',
      properties: { category: 'missing_final_response', tool_count: 2 },
    });
  });

  it('classifies terminal runtime errors without exporting the provider message', async () => {
    const db = fakeDb({
      ...completedRow,
      status: 'error',
      output_present: false,
      output_characters: 0,
      error: {
        class: 'provider',
        reason: 'runtime_provider_rate_limited',
        retryable: true,
        message: 'Applicant alice@example.com triggered apikey_private-value-never-send',
      },
    });
    const { fetcher, calls } = fakeFetch();
    const result = await exportRaindropRun(env(), db, RUN_ID, fetcher);

    expect(result).toMatchObject({ status: 'sent', signal: 'Hermes run ended with an error' });
    const allBodies = calls.map((call) => String(call.init?.body)).join('\n');
    expect(allBodies).toContain('runtime_provider_rate_limited');
    expect(allBodies).not.toContain('alice@example.com');
    expect(allBodies).not.toContain('private-value-never-send');
  });

  it('does no database or network work while disabled or missing a key', async () => {
    for (const disabledEnv of [
      env({ RAINDROP_OBSERVABILITY_MODE: 'off' }),
      env({ RAINDROP_WRITE_KEY: '' }),
    ]) {
      const db = fakeDb();
      const { fetcher, calls } = fakeFetch();
      const result = await exportRaindropRun(disabledEnv, db, RUN_ID, fetcher);
      expect(result.status).toBe('disabled');
      expect(db.calls).toHaveLength(0);
      expect(calls).toHaveLength(0);
    }
  });

  it('contains vendor failures and leaves the terminal Hermes result untouched', async () => {
    const db = fakeDb();
    const { fetcher } = fakeFetch(async () => { throw new Error(`request failed with ${WRITE_KEY}`); });
    await expect(exportRaindropRun(env(), db, RUN_ID, fetcher)).resolves.toMatchObject({
      status: 'failed',
      httpStatus: null,
    });
  });

  it('skips nonterminal and legacy runs', async () => {
    const { fetcher, calls } = fakeFetch();
    await expect(exportRaindropRun(env(), fakeDb({ ...completedRow, status: 'working' }), RUN_ID, fetcher))
      .resolves.toEqual({ status: 'skipped', reason: 'run_not_terminal' });
    await expect(exportRaindropRun(env(), fakeDb({ ...completedRow, runtime_kind: 'legacy' }), RUN_ID, fetcher))
      .resolves.toEqual({ status: 'skipped', reason: 'not_hermes' });
    expect(calls).toHaveLength(0);
  });
});
