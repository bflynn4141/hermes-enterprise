import { describe, expect, it } from 'vitest';
import type { HermesTerminalError } from '../../src/runtime/client.js';
import { classifyHermesFailure } from '../../src/runtime/errors.js';

const terminal = (
  code: HermesTerminalError['code'],
  category: HermesTerminalError['category'],
  retryable: boolean,
  source: HermesTerminalError['source'],
): HermesTerminalError => ({ schema_version: 1, code, category, retryable, source });

describe('versioned Hermes failure classification', () => {
  it.each([
    [terminal('provider_auth', 'auth', false, 'provider'), 'auth', false, 'hermes_provider_auth'],
    [terminal('provider_quota', 'quota', false, 'provider'), 'quota', false, 'hermes_provider_quota'],
    [terminal('provider_rate_limited', 'rate_limit', true, 'provider'), 'rate_limit', true, 'hermes_provider_rate_limited'],
    [terminal('request_rejected', 'rejected', false, 'request'), 'rejected', false, 'hermes_provider_rejected'],
    [terminal('provider_unavailable', 'unavailable', true, 'provider'), 'unavailable', true, 'hermes_provider_unavailable'],
    [terminal('runtime_interrupted', 'interrupted', true, 'runtime'), 'interrupted', true, 'hermes_runtime_interrupted'],
    [terminal('runtime_unknown', 'unknown', true, 'runtime'), 'unknown', true, 'hermes_run_failed'],
  ] as const)('maps $code without retaining provider text', (detail, code, retryable, reason) => {
    const native = 'private provider body SECRET_NATIVE';
    const classified = classifyHermesFailure({ status: 'failed', error: native, terminal_error: detail });
    expect(classified).toMatchObject({
      code, nativeCode: detail.code, structured: true, contractVersion: 1,
      nativeErrorPresent: true, error: { retryable, reason, step_id: 'hermes' },
    });
    expect(JSON.stringify(classified)).not.toContain(native);
    expect(JSON.stringify(classified)).not.toContain('SECRET_NATIVE');
  });

  it('uses the structured code even when native prose contradicts it', () => {
    const classified = classifyHermesFailure({
      status: 'failed',
      error: 'HTTP 401 unauthorized',
      terminal_error: terminal('provider_rate_limited', 'rate_limit', true, 'provider'),
    });
    expect(classified).toMatchObject({ code: 'rate_limit', error: { retryable: true } });
  });

  it('treats a missing envelope as a generic protocol failure without parsing prose', () => {
    const secret = 'HTTP 401 private-provider-request-and-key';
    const classified = classifyHermesFailure({ status: 'failed', error: secret });
    expect(classified).toMatchObject({
      code: 'unknown', nativeCode: null, source: 'contract', structured: false, contractVersion: null,
      nativeErrorPresent: true, error: { class: 'transient', retryable: true, reason: 'hermes_run_failed' },
    });
    expect(JSON.stringify(classified)).not.toContain(secret);
  });
});
