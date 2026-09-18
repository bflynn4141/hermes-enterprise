import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { agentRecoveryViewSchema, mockUuid, type AgentRecoveryView, type AgentWakeInput } from '@hermes/shared';
import { AgentRecoveryControls, createRecoverySubmitter, refreshRecoveryContext, retryCountdown } from './AgentRecovery.js';
import { createRest } from '../../model/rest.js';
import { createAuth } from '../../model/auth.js';
import { createStore, initialState } from '../../model/store.js';
import type { Adapter } from '../../model/adapter.js';

const failed: AgentRecoveryView = {
  state: 'retryable', run_id: mockUuid(3), session_id: mockUuid(2), attempt: 1,
  model_id: 'nous:deepseek/deepseek-v4.1-flash',
  message: 'The selected model is temporarily unavailable. Your completed work is saved.',
  next_retry_at: null, can_retry: true, can_run_now: false, can_cancel: false,
};
const queued: AgentRecoveryView = { ...failed, state: 'queued', attempt: 2, can_retry: false, message: 'Retry queued.' };

function render(view: AgentRecoveryView, extra: Partial<Parameters<typeof AgentRecoveryControls>[0]> = {}) {
  return renderToStaticMarkup(<AgentRecoveryControls view={view} error={null} busy={null} loading={false}
    now={Date.parse('2026-09-18T17:00:00Z')} onAction={() => undefined} onRefresh={() => undefined} onTrace={() => undefined}
    modelLabel="DeepSeek V4.1 Flash" {...extra} />);
}

describe('task recovery controls', () => {
  it('offers retry without a message, tool step or chat output', () => {
    const html = render(failed);
    expect(html).toContain('Retry task');
    expect(html).toContain('DeepSeek V4.1 Flash');
    expect(html).toContain('Attempt 1');
    expect(html).not.toContain('Run now');
  });

  it('keeps blocked and human-review states actionable through their explanation, without a wake', () => {
    for (const state of ['blocked', 'waiting'] as const) {
      const html = render({ ...failed, state, can_retry: false, message: 'Review the pending authorization before continuing.' });
      expect(html).toContain('Review the pending authorization');
      expect(html).not.toContain('<button');
    }
  });

  it('disables recovery controls during admission and never claims the task has started', () => {
    const html = render({ ...failed, can_cancel: true }, { busy: 'retry' });
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain('Requesting retry…');
    expect(html).not.toContain('Working now');
    expect(html).toContain('aria-busy="true"');
  });

  it('shows a bounded countdown and cancel for a scheduled retry', () => {
    const html = render({ ...failed, state: 'retry_scheduled', next_retry_at: '2026-09-18T17:01:30Z', can_cancel: true });
    expect(html).toContain('Retrying in 1m 30s');
    expect(html).toContain('Attempt 1 of 3');
    expect(html).toContain('Cancel retry');
    expect(retryCountdown('2026-09-18T16:59:00Z', Date.parse('2026-09-18T17:00:00Z'))).toBe('Retry due · Waiting for the scheduler');
  });

  it('never offers Run now for a historical trace even if an older server supplies the capability', () => {
    const view = { ...failed, state: 'idle' as const, can_retry: false, can_run_now: true };
    expect(render(view)).toContain('Run now');
    expect(render(view, { historical: true })).not.toContain('Run now');
  });

  it('links to the current task after admission and exposes refresh on errors', () => {
    const html = render(queued, { error: 'Could not refresh task details.' });
    expect(html).toContain('Open current task');
    expect(html).not.toContain('Retry task');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Refresh status');
  });
});

describe('recovery admission requests', () => {
  it('coalesces rapid clicks into one request with the expected attempt', async () => {
    let resolve!: (value: AgentRecoveryView) => void;
    const send = vi.fn(() => new Promise<AgentRecoveryView>((done) => { resolve = done; }));
    const sender = createRecoverySubmitter(send);
    const first = sender.submit('retry', failed);
    const repeated = sender.submit('retry', failed);
    await Promise.resolve();
    expect(first).toBe(repeated);
    expect(sender.pending).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'retry', run_id: failed.run_id, expected_attempt: 1 }));
    resolve(queued);
    await first;
    expect(sender.pending).toBe(false);
  });

  it('reuses the idempotency key when a failed response may already have been admitted', async () => {
    const inputs: AgentWakeInput[] = [];
    const sender = createRecoverySubmitter(async (input) => {
      inputs.push(input);
      if (inputs.length === 1) throw new TypeError('Network request lost');
      return queued;
    });
    await expect(sender.submit('retry', failed)).rejects.toThrow('Network request lost');
    await sender.submit('retry', failed);
    expect(inputs[0]?.idempotency_key).toBe(inputs[1]?.idempotency_key);
    await sender.submit('retry', { ...failed, attempt: 2 });
    expect(inputs[2]?.idempotency_key).not.toBe(inputs[1]?.idempotency_key);
  });

  it('keeps a fresh-work check separate from retrying a run', async () => {
    const send = vi.fn(async (_input: AgentWakeInput) => queued);
    await createRecoverySubmitter(send).submit('run_now', failed);
    expect(send.mock.calls[0]?.[0]).toEqual({ action: 'run_now', idempotency_key: expect.any(String) });
  });

  it('uses run-scoped reads and validates server recovery responses', async () => {
    const calls: string[] = [];
    const rest = createRest({ auth: createAuth('fake'), fetchImpl: async (input) => {
      calls.push(String(input));
      return Response.json(failed);
    } });
    await expect(rest.agentRecovery(mockUuid(1), mockUuid(4), mockUuid(3))).resolves.toEqual(failed);
    expect(calls[0]).toBe(`/w/${mockUuid(1)}/agents/${mockUuid(4)}/recovery?run_id=${mockUuid(3)}`);
    expect(agentRecoveryViewSchema.safeParse({ ...failed, state: 'pretend_working' }).success).toBe(false);
  });
});


describe('active recovery hydration', () => {
  function setup() {
    const state = initialState();
    const workspaceId = state.workspace.id;
    const store = createStore(state);
    store.dispatch({ type: 'session/create', id: failed.session_id! });
    const run = { run_id: failed.run_id!, status: 'working' as const, attempt: 2 };
    const sessions = vi.fn(async () => ({ items: [], cursor: null, total: 0 }));
    const loadRun = vi.fn(async () => run);
    const invalidateList = vi.fn();
    const ensure = vi.fn();
    const adapter = { rest: { sessions, run: loadRun }, invalidateList, ensure } as unknown as Adapter;
    const view = { ...queued, state: 'working' as const };
    const hydrate = () => refreshRecoveryContext(adapter, store, workspaceId, mockUuid(4), view, true);
    const start = (id: string, attempt = 2) => store.dispatch({ type: 'run/start', sessionId: failed.session_id!, run: {
      id, session_id: failed.session_id!, agent_id: mockUuid(4), status: 'working', attempt, title: null, steps: [], queue: [],
    } });
    return { store, loadRun, sessions, invalidateList, ensure, hydrate, start };
  }

  it('restores the active attempt once without invalidating and remounting Overview', async () => {
    const f = setup();
    await f.hydrate();
    expect(f.store.getState().sessions[failed.session_id!]?.run).toMatchObject({ id: failed.run_id, status: 'working', attempt: 2 });
    await f.hydrate();
    expect(f.loadRun).toHaveBeenCalledOnce();
    expect(f.sessions).toHaveBeenCalledOnce();
    expect(f.invalidateList).not.toHaveBeenCalled();
    expect(f.ensure).not.toHaveBeenCalled();
  });

  it('keeps a different current run when the recovery read is already stale', async () => {
    const f = setup();
    const newerId = mockUuid(900);
    f.start(newerId);
    await f.hydrate();
    expect(f.loadRun).not.toHaveBeenCalled();
    expect(f.store.getState().sessions[failed.session_id!]?.run?.id).toBe(newerId);
  });

  it('keeps a newer run that arrives while initial hydration is fetching', async () => {
    const f = setup();
    const newerId = mockUuid(900);
    f.loadRun.mockImplementationOnce(async () => {
      f.start(newerId);
      return { run_id: failed.run_id!, status: 'working', attempt: 2 };
    });
    await f.hydrate();
    expect(f.store.getState().sessions[failed.session_id!]?.run?.id).toBe(newerId);
  });
});
