// Exercise the production RuntimeDb transaction boundaries with an in-memory
// pg transport. No database, provider, key store or hosted runtime is contacted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import * as database from '../../src/db/client.js';
import * as keys from '../../src/keys/store.js';
import type { Env } from '../../src/env.js';
import { SYSTEM_USER_ID } from '../../src/jobs.js';
import { proxyRuntimeModel } from '../../src/runtime/bridge.js';
import { RuntimeDb } from '../../src/runtime/store.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const agentId = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const modelId = 'nous:nousresearch/hermes-4';
const env = { ENVIRONMENT: 'development' } as Env;
const body = { model: 'nousresearch/hermes-4', messages: [] };

afterEach(() => vi.restoreAllMocks());

function fixture(options: {
  budget?: boolean; quarantine?: boolean; foreign?: boolean; budgetExpired?: boolean;
  beforeCommit?: (transaction: number) => Promise<void>;
} = {}) {
  const statements: Array<{ sql: string; values?: readonly unknown[]; transaction: number }> = [];
  let transaction = 0;
  let active = false;
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql === 'BEGIN') {
      expect(active).toBe(false);
      active = true;
      transaction += 1;
    } else {
      expect(active).toBe(true);
    }
    statements.push({ sql, values, transaction });
    if (sql === 'COMMIT') await options.beforeCommit?.(transaction);
    if (sql === 'COMMIT' || sql === 'ROLLBACK') active = false;
    if (sql.includes('SELECT id FROM runs WHERE agent_id')) return { rows: [{ id: runId }] };
    if (sql.includes('FROM runs r JOIN sessions')) return { rows: [{
      id: runId, workspace_id: options.foreign ? 'other-workspace' : workspaceId,
      session_id: '22222222-2222-4222-8222-222222222222', agent_id: agentId,
      status: 'working', stop_requested: false, attempt: 1, engine_version: 1,
      max_turns: 8, model_id: modelId, effort: null, trace_id: 'test-trace',
      active_ms: 0, waiting_for: null, mode: 'work', client_turn_id: 'test-turn',
    }] };
    if (sql.includes('FROM catalog')) return { rows: [{ model_id: modelId, provider: 'nous_portal', context_length: 32000 }] };
    if (sql.includes('FROM approval_continuations')) return { rows: options.budget ? [{
      authorization_state: 'admitted', expires_at: new Date(Date.now() + (options.budgetExpired ? -1000 : 60_000)),
      budget_id: 'budget-1', budget_state: 'active', model_id: modelId,
      max_output_tokens_per_call: 500, context_length: 32000, pricing_verified_on: '2026-09-15',
      input_price: '1', output_price: '2', cached_input_price: '0.25',
    }] : [] };
    if (sql.includes('FROM reserve_approval_model_budget')) return { rows: [{ reservation_id: 'reservation-1', budget_id: 'budget-1' }] };
    return { rows: [] };
  });
  vi.spyOn(database, 'connect').mockResolvedValue({ query, end: vi.fn() } as unknown as Client);
  const credential = vi.spyOn(keys, 'resolveKey').mockImplementation(async (tx, _env, workspace, provider) => {
    expect(workspace).toBe(workspaceId);
    expect(provider).toBe('nous_portal');
    await tx.query(options.quarantine
      ? "UPDATE workspace_provider_keys SET status='invalid' WHERE id=$1"
      : 'SELECT proxy_test_credential', ['key-1']);
    return { keyId: 'key-1', provider, apiKey: options.quarantine ? '' : 'test-only-secret', status: options.quarantine ? 'invalid' : 'verified' };
  });
  const store = new RuntimeDb(env, workspaceId, 'test-trace');
  vi.spyOn(store, 'settleRuntimeModelCall').mockResolvedValue();
  const fetcher = vi.fn<typeof fetch>(async () => {
    expect(active).toBe(false);
    return Response.json({ usage: { prompt_tokens: 2, completion_tokens: 1 } });
  });
  return { store, statements, credential, fetcher, active: () => active };
}

describe('model proxy preparation transaction boundaries', () => {
  it.each([false, true])('batches tenant context reads but commits credentials and budget separately (budget=%s)', async (budget) => {
    const h = fixture({ budget });
    const response = await proxyRuntimeModel(env, h.store, workspaceId, agentId, body, h.fetcher);
    expect(response.status).toBe(200);
    const begins = h.statements.filter((statement) => statement.sql === 'BEGIN');
    expect(begins).toHaveLength(budget ? 3 : 2);
    expect(h.statements).toHaveLength(budget ? 15 : 11);
    const groupedReads = h.statements.filter((statement) =>
      statement.sql.includes('FROM runs') || statement.sql.includes('FROM catalog') || statement.sql.includes('FROM approval_continuations'));
    expect(groupedReads).toHaveLength(4);
    expect(new Set(groupedReads.map((statement) => statement.transaction))).toEqual(new Set([1]));
    expect(h.statements.find((statement) => statement.sql === 'SELECT proxy_test_credential')?.transaction).toBe(2);
    if (budget) expect(h.statements.find((statement) => statement.sql.includes('FROM reserve_approval_model_budget'))?.transaction).toBe(3);
    for (const begin of begins) {
      const context = h.statements.filter((statement) => statement.transaction === begin.transaction && statement.sql.startsWith('SELECT set_config'));
      expect(context.map((statement) => statement.values)).toEqual([
        ['app.workspace_id', workspaceId, 'app.user_id', SYSTEM_USER_ID],
      ]);
    }
    expect(h.statements.at(-1)?.sql).toBe('COMMIT');
    expect(h.fetcher).toHaveBeenCalledOnce();
    await response.text();
    await h.store.close();
  });

  it.each([false, true])('waits for the last preparation commit before provider fetch (budget=%s)', async (budget) => {
    let release!: () => void;
    let blocked!: () => void;
    const committed = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { blocked = resolve; });
    const h = fixture({ budget, beforeCommit: async (transaction) => {
      if (transaction !== (budget ? 3 : 2)) return;
      blocked();
      await committed;
    } });
    const task = proxyRuntimeModel(env, h.store, workspaceId, agentId, body, h.fetcher);
    try {
      await waiting;
      expect(h.active()).toBe(true);
      expect(h.fetcher).not.toHaveBeenCalled();
    } finally { release(); }
    const response = await task;
    expect(h.fetcher).toHaveBeenCalledOnce();
    await response.text();
    await h.store.close();
  });

  it('commits a credential quarantine before refusing the call', async () => {
    const h = fixture({ quarantine: true });
    await expect(proxyRuntimeModel(env, h.store, workspaceId, agentId, body, h.fetcher))
      .rejects.toMatchObject({ reason: 'key_invalid' });
    expect(h.statements.at(-2)?.sql).toContain("SET status='invalid'");
    expect(h.statements.at(-1)?.sql).toBe('COMMIT');
    expect(h.statements.some((statement) => statement.sql === 'ROLLBACK')).toBe(false);
    expect(h.fetcher).not.toHaveBeenCalled();
    await h.store.close();
  });

  it.each(['foreign', 'budgetExpired'] as const)('refuses %s context before credential resolution or provider fetch', async (failure) => {
    const h = fixture({ budget: true, [failure]: true });
    const response = await proxyRuntimeModel(env, h.store, workspaceId, agentId, body, h.fetcher);
    expect(response.status).toBe(409);
    expect(h.credential).not.toHaveBeenCalled();
    expect(h.fetcher).not.toHaveBeenCalled();
    expect(h.statements.at(-1)?.sql).toBe(failure === 'foreign' ? 'COMMIT' : 'ROLLBACK');
    expect(h.active()).toBe(false);
    await h.store.close();
  });
});

describe('runtime tenant context initialization', () => {
  it('sets both transaction-local identities before nested work without another transaction', async () => {
    const h = fixture();
    await h.store.withRuntimeTransaction(async () => {
      await h.store.runtimeQuery('SELECT outer_read');
      await h.store.withRuntimeTransaction(() => h.store.runtimeQuery('SELECT nested_read'));
      await h.store.runtimeQuery('SELECT trailing_read');
    });
    expect(h.statements.map((row) => row.sql)).toEqual([
      'BEGIN', 'SELECT set_config($1, $2, true), set_config($3, $4, true)',
      'SELECT outer_read', 'SELECT nested_read', 'SELECT trailing_read', 'COMMIT',
    ]);
    expect(h.statements[1]?.values).toEqual(['app.workspace_id', workspaceId, 'app.user_id', SYSTEM_USER_ID]);
    expect(h.active()).toBe(false);
    await h.store.close();
  });

  it('rolls back nested failures and resets context for the next transaction', async () => {
    const h = fixture();
    await expect(h.store.withRuntimeTransaction(async () => {
      await h.store.withRuntimeTransaction(async () => { throw new Error('read failed'); });
    })).rejects.toThrow('read failed');
    expect(h.statements.at(-1)?.sql).toBe('ROLLBACK');
    await h.store.runtimeQuery('SELECT fresh_read');
    expect(h.statements.filter((row) => row.sql === 'BEGIN')).toHaveLength(2);
    expect(h.statements.filter((row) => row.sql.startsWith('SELECT set_config')).map((row) => row.values))
      .toEqual(Array.from({ length: 2 }, () => ['app.workspace_id', workspaceId, 'app.user_id', SYSTEM_USER_ID]));
    expect(h.statements.at(-1)?.sql).toBe('COMMIT');
    await h.store.close();
  });

  it('never invokes work if tenant initialization fails', async () => {
    const calls: string[] = [];
    vi.spyOn(database, 'connect').mockResolvedValue({
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.startsWith('SELECT set_config')) throw new Error('context unavailable');
        return { rows: [] };
      }, end: vi.fn(),
    } as unknown as Client);
    const db = new RuntimeDb(env, workspaceId, 'test-trace');
    const work = vi.fn();
    await expect(db.withRuntimeTransaction(work)).rejects.toThrow('context unavailable');
    expect(work).not.toHaveBeenCalled();
    expect(calls).toEqual(['BEGIN', 'SELECT set_config($1, $2, true), set_config($3, $4, true)', 'ROLLBACK']);
    await db.close();
  });
});
