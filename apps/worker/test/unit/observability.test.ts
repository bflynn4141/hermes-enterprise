// Observability: what Sentry is allowed to carry, what Analytics Engine is
// allowed to carry, and what the weekly audit CSV is allowed to carry.
//
// All three are exports of the same rule — "nothing logs a key, a token, a
// presigned URL or applicant text" (CONVENTIONS) — applied to three places that
// send data somewhere we do not control. The redaction test in
// `redaction.test.ts` covers the log path; this file covers the other three,
// because a rule enforced in one of four places is a rule with three holes.
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { scrubEvent, sentryOptions, type SentryEventLike } from '../../src/ops/sentry.js';
import {
  METRICS,
  analyticsAvailable,
  recordHermesLatency,
  recordProviderLatency,
  recordStopLatency,
  writePoint,
} from '../../src/ops/analytics.js';
import { EVENT_CSV_COLUMNS, eventsExportObjectKey, toCsv } from '../../src/ops/events-export.js';
import { CONNECTION_ALARM, CONNECTION_CEILING, describeConnections } from '../../src/ops/connections.js';
import { isoWeek } from '../../src/ops/nightly.js';
import { redactString } from '../../src/keys/redact.js';

const env = (overrides: Partial<Env> = {}): Env => ({ ENVIRONMENT: 'test', ENGINE_VERSION: '3', ...overrides }) as Env;

describe('Sentry', () => {
  it('is a no-op with no DSN, which is the whole local and test story', () => {
    // `withSentry`'s options callback returning undefined is the documented way
    // to disable the SDK, so there is one code path rather than two.
    expect(sentryOptions(env())).toBeUndefined();
    expect(sentryOptions(env({ SENTRY_DSN: '   ' }))).toBeUndefined();
  });

  it('turns PII off, groups by engine version, and traces nothing', () => {
    const options = sentryOptions(env({ SENTRY_DSN: 'https://abc@example.ingest.sentry.io/1' }));
    expect(options).toBeDefined();
    expect(options?.sendDefaultPii).toBe(false);
    // The engine version is the number the rollback procedure moves and the
    // number a `runs` row carries; a build hash would group errors by something
    // nothing else records.
    expect(options?.release).toBe('hermes@3');
    expect(options?.environment).toBe('test');
    expect(options?.tracesSampleRate).toBe(0);
  });

  it('drops cookies, headers, bodies and the query string from the request', () => {
    const event: SentryEventLike = {
      request: {
        url: 'https://app.example/w/abc/attachments/1?X-Amz-Signature=deadbeefdeadbeefdeadbeef&x=1',
        method: 'POST',
        headers: { authorization: 'Bearer sk-ant-abc123456789', cookie: 'hermes_session=sealed' },
        cookies: { hermes_session: 'sealed' },
        data: { applicant: 'Leah Martinez', note: 'rejected for cause' },
        query_string: 'X-Amz-Signature=deadbeefdeadbeef',
      },
    };
    const scrubbed = scrubEvent(event);
    const text = JSON.stringify(scrubbed);

    expect(scrubbed.request?.method).toBe('POST');
    expect(scrubbed.request?.url).toBe('https://app.example/w/abc/attachments/1');
    expect(scrubbed.request?.headers).toBeUndefined();
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.query_string).toBeUndefined();

    expect(text).not.toContain('sk-ant-');
    expect(text).not.toContain('sealed');
    expect(text).not.toContain('Leah Martinez');
    expect(text).not.toContain('X-Amz-Signature');
  });

  it('keeps the user id and nothing else about the user', () => {
    const scrubbed = scrubEvent({
      user: { id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', email: 'maya@example.com', username: 'maya', ip_address: '203.0.113.7' },
    });
    expect(scrubbed.user).toEqual({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' });
  });

  it('redacts breadcrumbs, extra, tags and the message by the same rules as the logs', () => {
    const scrubbed = scrubEvent({
      message: 'provider refused Bearer sk-proj-abcdef123456',
      extra: { authorization: 'Bearer abcdefghijklmn', note: 'key sk-ant-9876543210 was rejected' },
      tags: { 'cf-aig-authorization': 'Bearer gatewaytoken123456' },
      breadcrumbs: [{ message: 'GET https://r2.example/o?X-Amz-Signature=abc123', data: { 'x-api-key': 'secret' } }],
    });
    const text = JSON.stringify(scrubbed);
    expect(text).not.toContain('sk-proj-');
    expect(text).not.toContain('sk-ant-');
    expect(text).not.toContain('gatewaytoken');
    expect(text).not.toContain('abcdefghijklmn');
    expect(text).not.toContain('X-Amz-Signature=abc123');
  });

  it('does not throw on the shapes an error path actually produces', () => {
    expect(() => scrubEvent({})).not.toThrow();
    expect(() => scrubEvent({ user: {} })).not.toThrow();
    expect(() => scrubEvent({ request: {} })).not.toThrow();
  });
});

describe('the redaction rules the gateway and R2 need', () => {
  // Named separately from `redaction.test.ts` because these two are the ones
  // plan section 5 calls out by name, and a reader looking for them should find
  // an assertion with their name on it.
  it('redacts a `cf-aig-authorization` value wherever it appears', () => {
    expect(redactString('cf-aig-authorization: Bearer gw_live_abcdefghijklmnop')).not.toContain('gw_live_');
    const scrubbed = scrubEvent({ extra: { 'cf-aig-authorization': 'gw_live_abcdefghijklmnop' } });
    expect(JSON.stringify(scrubbed)).not.toContain('gw_live_');
  });

  it('redacts a presigned URL signature, which is the part that grants access', () => {
    const url =
      'https://bucket.accountid.r2.cloudflarestorage.com/w/ws/uploads/a1?' +
      'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=9f8e7d6c5b4a39281706';
    const redacted = redactString(url);
    expect(redacted).not.toContain('9f8e7d6c5b4a39281706');
    expect(redacted).toContain('[redacted]');
    // The rest of the URL survives: knowing which object was fetched is how an
    // incident is located, and it grants nothing without the signature.
    expect(redacted).toContain('uploads/a1');
  });
});

describe('Analytics Engine', () => {
  it('is a no-op without the binding, and says so rather than throwing', () => {
    expect(analyticsAvailable(env())).toBe(false);
    expect(writePoint(env(), 'run.duration', 'ws', { doubles: [1] })).toBe(false);
  });

  it('writes the metric name and the workspace as blobs, and indexes by workspace', () => {
    const written: Record<string, unknown>[] = [];
    const e = env({
      ANALYTICS: { writeDataPoint: (point: Record<string, unknown>) => written.push(point) },
    } as unknown as Partial<Env>);

    recordProviderLatency(e, 'ws-1', { provider: 'deepseek', modelId: 'deepseek-flash', ms: 1234, status: 'ok' });
    expect(written).toHaveLength(1);
    expect(written[0]?.blobs).toEqual(['provider.latency', 'ws-1', 'deepseek', 'deepseek-flash', 'ok']);
    expect(written[0]?.doubles).toEqual([1234]);
    // The index is the sampling key, so a query can ask about one tenant
    // without the dataset holding anything else about them.
    expect(written[0]?.indexes).toEqual(['ws-1']);
  });

  it('swallows a failing dataset rather than failing the run', () => {
    const e = env({
      ANALYTICS: {
        writeDataPoint: () => {
          throw new Error('dataset is misconfigured');
        },
      },
    } as unknown as Partial<Env>);
    // Observability tooling must never be the cause of the outage it exists to
    // explain.
    expect(() => recordStopLatency(e, 'ws', { runId: 'r', ms: 12, honouredAt: 'delta' })).not.toThrow();
    expect(recordStopLatency(e, 'ws', { runId: 'r', ms: 12, honouredAt: 'delta' })).toBe(false);
  });

  it('covers every metric plan section 5 names', () => {
    for (const metric of [
      'run.duration',
      'tool.result',
      'provider.latency',
      'socket.reconnect',
      'stop.latency',
      'instance.subrequests',
      'spend.daily',
      'hermes.stream',
      'hermes.latency',
      'hermes.terminal_failure',
    ]) {
      expect(METRICS).toContain(metric);
    }
  });
});

describe('Hermes startup latency', () => {
  it('keeps startup latency separate from stream timing and represents unavailable turn time explicitly', () => {
    const written: Record<string, unknown>[] = [];
    const e = env({
      ANALYTICS: { writeDataPoint: (point: Record<string, unknown>) => written.push(point) },
    } as unknown as Partial<Env>);
    recordHermesLatency(e, 'ws-1', {
      runId: 'run-1', modelId: 'nous:example/model', releaseRing: 'stable',
      phase: 'first_delta', duration_ms: 750, elapsed_ms: 750, turn_elapsed_ms: null,
    });
    expect(written[0]?.blobs).toEqual(['hermes.latency', 'ws-1', 'run-1', 'nous:example/model', 'first_delta']);
    expect(written[0]?.doubles).toEqual([750, 750, -1]);
  });
});

describe('the connection metric', () => {
  it('reports the denominator, because a bare count means nothing', () => {
    const text = describeConnections({
      total: 152,
      active: 10,
      idle: 140,
      idleInTransaction: 2,
      ceiling: CONNECTION_CEILING,
      alarm: CONNECTION_ALARM,
      alarming: true,
    });
    expect(text).toContain('152 of 209');
    expect(text).toContain('2 idle in transaction');
    expect(text).toContain('alarm at 150');
  });

  it('alarms at the number plan section 5 fixed', () => {
    expect(CONNECTION_ALARM).toBe(150);
    expect(CONNECTION_CEILING).toBe(209);
  });
});

describe('the weekly audit CSV', () => {
  it('carries ids and enum kinds only, never a payload', () => {
    // Widening this list turns an audit export into a data export, and the
    // erasure inventory does not cover one.
    expect(EVENT_CSV_COLUMNS).not.toContain('payload');
    for (const column of EVENT_CSV_COLUMNS) {
      expect(['id', 'created_at', 'actor_type', 'kind'].includes(column) || column.endsWith('_id')).toBe(true);
    }
  });

  it('quotes to RFC 4180, so a kind containing a comma cannot shift a column', () => {
    const csv = toCsv([
      { id: '1', created_at: '2026-09-15T00:00:00.000Z', actor_type: 'user', kind: 'decision.recorded' },
      { id: '2', kind: 'a "quoted", comma' },
    ]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe(EVENT_CSV_COLUMNS.join(','));
    expect(lines[2]).toContain('"a ""quoted"", comma"');
    // A null id column is empty, not the string "null".
    expect(lines[2]).toContain('""');
  });

  it('writes under the workspace prefix, so a deletion takes it too', () => {
    const key = eventsExportObjectKey('ws-1', '2026-W07');
    expect(key.startsWith('w/ws-1/')).toBe(true);
    expect(key).toContain('2026-W07');
  });

  it('numbers ISO weeks by the Thursday rule', () => {
    // 2026-01-01 is a Thursday, so it belongs to week 1 of 2026.
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    // 2027-01-01 is a Friday, so it belongs to week 53 of 2026 — the three days
    // each January that a naive "year plus week number" gets wrong.
    expect(isoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
    expect(isoWeek(new Date('2026-09-15T00:00:00Z'))).toMatch(/^2026-W\d\d$/);
  });
});
