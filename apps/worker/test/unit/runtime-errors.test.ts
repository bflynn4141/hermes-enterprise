import { describe, expect, it } from 'vitest';
import { classifyHermesFailure } from '../../src/runtime/errors.js';

describe('native Hermes failure classification', () => {
  it.each([
    ['Provider authentication failed: OAuth token expired', 'auth', false, 'hermes_provider_auth'],
    ['HTTP 402: insufficient credits', 'quota', false, 'hermes_provider_quota'],
    ['HTTP 429: too many requests', 'rate_limit', true, 'hermes_provider_rate_limited'],
    ['HTTP 400: maximum context length exceeded', 'rejected', false, 'hermes_provider_rejected'],
    ['HTTP 503: provider temporarily unavailable', 'unavailable', true, 'hermes_provider_unavailable'],
    ['gateway restarted before this run settled', 'interrupted', true, 'hermes_runtime_interrupted'],
  ] as const)('maps %s to %s without persisting provider text', (native, code, retryable, reason) => {
    const classified = classifyHermesFailure({ status: 'failed', error: native });
    expect(classified).toMatchObject({ code, nativeErrorPresent: true, error: { retryable, reason, step_id: 'hermes' } });
    expect(JSON.stringify(classified)).not.toContain(native);
  });

  it('treats a native interrupted status as retryable even without error text', () => {
    expect(classifyHermesFailure({ status: 'interrupted' })).toMatchObject({
      code: 'interrupted', nativeErrorPresent: false,
      error: { class: 'transient', retryable: true, reason: 'hermes_runtime_interrupted' },
    });
  });

  it('keeps unknown failures generic and never retains their text', () => {
    const secret = 'private-provider-request-and-key';
    const classified = classifyHermesFailure({ status: 'failed', error: secret });
    expect(classified).toMatchObject({
      code: 'unknown', nativeErrorPresent: true,
      error: { class: 'transient', retryable: true, reason: 'hermes_run_failed' },
    });
    expect(JSON.stringify(classified)).not.toContain(secret);
  });
});
