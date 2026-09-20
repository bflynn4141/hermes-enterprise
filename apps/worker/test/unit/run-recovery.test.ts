import { describe, expect, it } from 'vitest';
import { automaticRecoveryAuthBlocked, automaticRetryAt, MAX_AUTOMATIC_ATTEMPTS } from '../../src/runs/recovery.js';

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
