import { describe, expect, it } from 'vitest';
import { MAX_PROVIDER_RETRY_SECONDS, parseProviderRetryAfter } from '../../src/runtime/retry-after.js';

const now = Date.parse('2026-09-18T17:00:00.000Z');

describe('provider Retry-After parsing', () => {
  it('preserves longer provider waits as absolute deadlines', () => {
    expect(parseProviderRetryAfter('7200', now)).toEqual({ notBefore: new Date(now + 7_200_000), blockedReason: null, header: '7200' });
    expect(parseProviderRetryAfter('Fri, 18 Sep 2026 19:00:00 GMT', now)).toEqual({ notBefore: new Date(now + 7_200_000), blockedReason: null, header: '7200' });
  });

  it('normalizes past dates and zero seconds without bypassing the scheduler backoff', () => {
    for (const value of ['0', 'Thu, 17 Sep 2026 17:00:00 GMT']) {
      expect(parseProviderRetryAfter(value, now)).toEqual({ notBefore: new Date(now), blockedReason: null, header: '0' });
    }
    expect(parseProviderRetryAfter('00060', now)?.header).toBe('60');
  });

  it('blocks unreasonable waits instead of shortening them to the maximum', () => {
    for (const value of [String(MAX_PROVIDER_RETRY_SECONDS + 1), '9'.repeat(80), '9'.repeat(200), 'Fri, 25 Sep 2026 17:00:01 GMT']) {
      expect(parseProviderRetryAfter(value, now)).toEqual({ notBefore: null, blockedReason: 'provider_retry_after_excessive', header: null });
    }
    expect(parseProviderRetryAfter(String(MAX_PROVIDER_RETRY_SECONDS), now)?.notBefore).toEqual(new Date(now + MAX_PROVIDER_RETRY_SECONDS * 1000));
  });

  it.each([null, '', ' ', '-1', '1.5', '1e3', 'next Tuesday', 'Fri, 99 Xxx 2026 17:00:00 GMT', 'secret=provider-key'])('ignores malformed metadata %s without retaining the text', (value) => {
    expect(parseProviderRetryAfter(value, now)).toBeNull();
  });
});
