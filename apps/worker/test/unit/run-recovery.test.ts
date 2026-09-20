import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import type { EngineRunRow, RunErrorInput } from '../../src/engine/agent-db.js';
import type { RuntimeBinding } from '../../src/runtime/config.js';
import { automaticRecoveryAuthBlocked, automaticRetryAt, MAX_AUTOMATIC_ATTEMPTS } from '../../src/runs/recovery.js';
import { prepareAutomaticRecoveryExecution } from '../../src/runs/workflow.js';

const endedAt = new Date('2026-09-18T17:00:00.000Z');
const outage = {
  attempt: 1, ended_at: endedAt, recovery_cancelled: false,
  error: { reason: 'hermes_provider_unavailable', retryable: true },
};

describe('bounded automatic retry timing', () => {
  it('allows automatic recovery only on an exact token-digest runtime identity', () => {
    expect(automaticRecoveryAuthBlocked(true, 'legacy_hmac')).toBe(true);
    expect(automaticRecoveryAuthBlocked(true, 'token_digest')).toBe(false);
    expect(automaticRecoveryAuthBlocked(false, 'legacy_hmac')).toBe(false);
  });

  it('waits one minute after the first outage and five after the second', () => {
    expect(automaticRetryAt(outage)?.toISOString()).toBe('2026-09-18T17:01:00.000Z');
    expect(automaticRetryAt({ ...outage, attempt: 2 })?.toISOString()).toBe('2026-09-18T17:05:00.000Z');
    expect(MAX_AUTOMATIC_ATTEMPTS).toBe(3);
  });

  it('honors the stored provider deadline without shortening local backoff or capping long waits', () => {
    const rateLimited = { reason: 'hermes_provider_rate_limited', retryable: true };
    expect(automaticRetryAt({ ...outage, error: rateLimited, recovery_not_before: new Date('2026-09-18T17:02:00.000Z') })?.toISOString())
      .toBe('2026-09-18T17:02:00.000Z');
    expect(automaticRetryAt({ ...outage, attempt: 2, error: rateLimited, recovery_not_before: new Date('2026-09-18T17:00:10.000Z') })?.toISOString())
      .toBe('2026-09-18T17:05:00.000Z');
    expect(automaticRetryAt({ ...outage, error: rateLimited, recovery_not_before: new Date('2026-09-18T19:30:00.000Z') })?.toISOString())
      .toBe('2026-09-18T19:30:00.000Z');
  });

  it.each([3, 4, 100])('does not retry after attempt %i', (attempt) => {
    expect(automaticRetryAt({ ...outage, attempt })).toBeNull();
  });

  it('honors cancellation and requires a completed failing attempt', () => {
    expect(automaticRetryAt({ ...outage, recovery_cancelled: true })).toBeNull();
    expect(automaticRetryAt({ ...outage, ended_at: null })).toBeNull();
    expect(automaticRetryAt({ ...outage, error: null })).toBeNull();
    expect(automaticRetryAt({ ...outage, error: { ...outage.error, retryable: false } })).toBeNull();
  });

  it.each(['hermes_provider_auth', 'hermes_provider_quota', 'hermes_provider_rejected',
    'hermes_runtime_interrupted', 'hermes_unavailable', 'hermes_run_failed', 'unknown_future_error'])(
    'does not turn %s into an automatic replay', (reason) => {
      expect(automaticRetryAt({ ...outage, error: { reason, retryable: true } })).toBeNull();
    },
  );
});

const automaticRun = (): EngineRunRow => ({
  id: 'run-1', workspaceId: 'workspace-1', sessionId: 'session-1', status: 'working',
  stopRequested: false, attempt: 2, engineVersion: 1, maxTurns: 8, modelId: 'model-1',
  effort: null, traceId: 'trace-1', activeMs: 0, waitingFor: null, mode: 'work',
  agentId: 'agent-1', clientTurnId: 'turn-1', recoveryInput: 'response-only',
  automaticRecovery: true,
});

const tokenDigestBinding = (runtimeAuthMode: RuntimeBinding['runtimeAuthMode']): RuntimeBinding => ({
  workspaceId: 'workspace-1', agentId: 'agent-1', profile: 'agent-agent-1',
  baseUrl: 'https://runtime.example.test', apiKey: 'test-key', transport: 'native',
  assignment: 'provisioned', agentCash: false, runtimeAuthMode,
  runtimeCredentialDigest: runtimeAuthMode === 'token_digest' ? new Uint8Array([1]) : null,
});

function executionDb(run: EngineRunRow) {
  const terminal: { status?: string; error?: RunErrorInput | null } = {};
  return {
    terminal,
    db: {
      loadRun: vi.fn(async () => run),
      setRunStatus: vi.fn(async (_runId: string, status: string, detail?: { error?: RunErrorInput | null }) => {
        terminal.status = status;
        terminal.error = detail?.error;
      }),
      withRuntimeTransaction: <T>(work: () => Promise<T>) => work(),
      runtimeQuery: vi.fn(async () => ({ rows: [] })),
    },
  };
}

describe('automatic recovery execution fence', () => {
  it.each([undefined, 'legacy' as const])(
    'fails closed before binding resolution when deployment runtime becomes %s',
    async (runtime) => {
      const { db, terminal } = executionDb(automaticRun());
      const resolve = vi.fn(async () => tokenDigestBinding('token_digest'));
      await expect(prepareAutomaticRecoveryExecution(
        { AGENT_RUNTIME: runtime, MODEL_SCRIPTED: '0' } as Env,
        db,
        { runId: 'run-1', workspaceId: 'workspace-1', attempt: 2 },
        resolve,
      )).rejects.toThrow('managed runtime changed');
      expect(resolve).not.toHaveBeenCalled();
      expect(terminal).toMatchObject({
        status: 'error', error: { reason: 'automatic_recovery_runtime_drift', retryable: false },
      });
    },
  );

  it('fails closed when a previously admitted binding drifts from token-digest to legacy auth', async () => {
    const { db, terminal } = executionDb(automaticRun());
    const resolve = vi.fn(async () => tokenDigestBinding('legacy_hmac'));
    await expect(prepareAutomaticRecoveryExecution(
      { AGENT_RUNTIME: 'hermes', MODEL_SCRIPTED: '0' } as Env,
      db,
      { runId: 'run-1', workspaceId: 'workspace-1', attempt: 2 },
      resolve,
    )).rejects.toThrow('managed runtime changed');
    expect(resolve).toHaveBeenCalledOnce();
    expect(terminal.error?.reason).toBe('automatic_recovery_runtime_drift');
  });

  it('returns the exact token-digest binding and leaves the run working before engine selection', async () => {
    const { db, terminal } = executionDb(automaticRun());
    const binding = tokenDigestBinding('token_digest');
    await expect(prepareAutomaticRecoveryExecution(
      { AGENT_RUNTIME: 'hermes', MODEL_SCRIPTED: '0' } as Env,
      db,
      { runId: 'run-1', workspaceId: 'workspace-1', attempt: 2 },
      async () => binding,
    )).resolves.toMatchObject({ binding });
    expect(terminal).toEqual({});
  });

  it('does not apply the managed-runtime gate to a human retry', async () => {
    const { db, terminal } = executionDb({ ...automaticRun(), automaticRecovery: false });
    const resolve = vi.fn(async () => tokenDigestBinding('legacy_hmac'));
    await expect(prepareAutomaticRecoveryExecution(
      { AGENT_RUNTIME: 'legacy', MODEL_SCRIPTED: '0' } as Env,
      db,
      { runId: 'run-1', workspaceId: 'workspace-1', attempt: 2 },
      resolve,
    )).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(terminal).toEqual({});
  });
});
