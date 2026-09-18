// The redaction rule, asserted rather than promised.
//
// CONVENTIONS.md says nothing logs a key. This file is what makes that a
// property: it takes the headers and key shapes a provider call actually
// carries, pushes them through the log helper and the error path, and asserts
// none of them survives.
//
// Every credential-shaped string here is assembled at runtime from harmless
// parts, so that the test for "a key must never appear in a log" does not
// itself put a key-shaped literal in the repository.
import { describe, expect, it, vi } from 'vitest';
import { REDACTED, logError, logEvent, redact, redactMessage, redactString } from '../../src/keys/redact.js';
import { errorFromResponse } from '../../src/model/http.js';

const anthropicKey = ['sk', 'ant', 'api03', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA'].join('-');
const openaiKey = ['sk', 'proj', 'BBBBBBBBBBBBBBBBBBBBBBBB'].join('-');
const deepseekKey = ['sk', 'CCCCCCCCCCCCCCCCCCCCCCCCCCCC'].join('-');
const typesafeKey = ['apikey', 'AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB'].join('_');
const gatewayToken = 'zzzzzzzzzzzzzzzzzzzzzzzz';

/** Capture what a helper actually wrote, as the strings a log pipeline sees. */
function captureLog(fn: () => void): string[] {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    fn();
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  return lines;
}

describe('key-shaped strings', () => {
  it('are replaced wherever they appear, including inside prose', () => {
    for (const key of [anthropicKey, openaiKey, deepseekKey, typesafeKey]) {
      expect(redactString(`the provider rejected ${key} at 14:02`)).not.toContain(key);
      expect(redactString(key)).toBe(REDACTED);
    }
  });

  it('survives neither a log line nor a nested object', () => {
    const lines = captureLog(() => {
      logEvent({
        at: 'model.call',
        request: { headers: { authorization: `Bearer ${deepseekKey}`, 'x-api-key': anthropicKey } },
        note: `retrying with ${openaiKey}`,
      });
    });

    const printed = lines.join('\n');
    for (const key of [anthropicKey, openaiKey, deepseekKey, typesafeKey]) expect(printed).not.toContain(key);
    expect(printed).toContain(REDACTED);
  });
});

describe('the three header names the plan names', () => {
  it('are redacted by name whatever they hold', () => {
    const headers = new Headers({
      authorization: `Bearer ${gatewayToken}`,
      'x-api-key': anthropicKey,
      'cf-aig-authorization': `Bearer ${gatewayToken}`,
      'content-type': 'application/json',
    });
    const cleaned = redact(headers) as Record<string, unknown>;

    expect(cleaned.authorization).toBe(REDACTED);
    expect(cleaned['x-api-key']).toBe(REDACTED);
    expect(cleaned['cf-aig-authorization']).toBe(REDACTED);
    // Not everything is a secret: a log with no content type is a log nobody
    // can debug, and over-redacting is how a redactor gets turned off.
    expect(cleaned['content-type']).toBe('application/json');
  });

  it('are redacted as plain object fields too, at any depth', () => {
    const cleaned = redact({
      outer: { init: { headers: { Authorization: `Bearer ${gatewayToken}` } }, api_key: anthropicKey },
    }) as { outer: { init: { headers: Record<string, string> }; api_key: string } };

    expect(cleaned.outer.init.headers.Authorization).toBe(REDACTED);
    expect(cleaned.outer.api_key).toBe(REDACTED);
  });
});

describe('errors', () => {
  it('carry no key, even when the provider echoed the request back', async () => {
    const response = new Response(
      JSON.stringify({ error: { type: 'authentication_error', message: `invalid key ${anthropicKey}` } }),
      { status: 401 },
    );
    const error = await errorFromResponse(response, 'anthropic');

    expect(error.message).not.toContain(anthropicKey);
    expect(error.message).toContain('401');
    expect(error.failure).toBe('auth');
  });

  it('are redacted on the way into a log line', () => {
    const lines = captureLog(() => {
      logError({ at: 'model.failed', key_id: 'aaaa', error: new Error(`fetch failed for ${anthropicKey}`) });
    });
    expect(lines.join('\n')).not.toContain(anthropicKey);
  });

  it('redact a thrown string as readily as an Error', () => {
    expect(redactMessage(`upstream said ${openaiKey}`)).not.toContain(openaiKey);
    expect(redactMessage(new Error(`bearer ${gatewayToken}`))).not.toContain(gatewayToken);
  });
});

describe('the redactor itself', () => {
  it('does not throw on a cycle, a deep tree or a byte array', () => {
    const cycle: Record<string, unknown> = { at: 'x' };
    cycle.self = cycle;
    expect(() => logEvent({ at: 'cycle', cycle })).not.toThrow();

    expect(redact({ bytes: new Uint8Array([1, 2, 3]) })).toEqual({ bytes: '[bytes 3]' });
  });

  it('redacts a presigned URL signature', () => {
    const url = 'https://bucket.r2.example/object?X-Amz-Signature=abc123def456&X-Amz-Expires=900';
    expect(redactString(url)).not.toContain('abc123def456');
  });

  it('redacts a key-encryption key by name at every version, not only KEK_V1', () => {
    // Raw AES material is base64 with none of the provider prefixes the shape
    // rules look for, so the *name* is the only thing that can catch it — and
    // the name list said `kek_v1` literally. The first rotation this system
    // exists to support introduces a `KEK_V2` that no rule matched: a redactor
    // that stops working at exactly the moment the thing it protects is being
    // handled, with every test still green.
    const material = 'D'.repeat(44);
    for (const name of ['KEK', 'KEK_V1', 'KEK_V2', 'kek_v17']) {
      const line = captureLog(() => logEvent({ at: 'rotation', [name]: material })).join('\n');
      expect(line).not.toContain(material);
    }
    expect(redact({ KEK_V2: material })).toEqual({ KEK_V2: REDACTED });
    // Not so broad that it eats an ordinary field that happens to start `kek`.
    // `KEK_CURRENT` in particular names a *version number*, not key material,
    // and redacting it would hide the one value an operator reads to tell
    // where a rotation has got to.
    expect(redact({ kek_rotation_count: 3 })).toEqual({ kek_rotation_count: 3 });
    expect(redact({ KEK_CURRENT: '2' })).toEqual({ KEK_CURRENT: '2' });
  });
});
