// Redaction, for logs and for error messages.
//
// The rule in CONVENTIONS.md is "nothing logs a key, a token, a presigned URL
// or applicant text". A rule is only worth what enforces it, so every log line
// this milestone writes goes through `logEvent`, every error that could have
// touched a provider response goes through `redactMessage`, and a test asserts
// that `Authorization`, `x-api-key` and `cf-aig-authorization` headers and
// key-shaped strings survive neither.
//
// Two defences, because either alone fails:
//
//   by name   a header or field called `authorization`, `x-api-key`,
//             `cf-aig-authorization`, `api_key`, `credential`, `plaintext` is
//             replaced whatever it holds. Catches a key we did not recognise.
//   by shape  a string that looks like a provider key is replaced wherever it
//             appears, including in the middle of prose. Catches a key that
//             arrived under a field name nobody predicted.

export const REDACTED = '[redacted]';

/** Field and header names whose value is never printable, case-insensitively. */
export const SECRET_FIELD_NAMES: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-goog-api-key',
  'cf-aig-authorization',
  'api_key',
  'apikey',
  'credential',
  'key',
  'secret',
  'plaintext',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'kek',
  'kek_v1',
  'dek',
];

const SECRET_NAMES = new Set(SECRET_FIELD_NAMES.map((n) => n.toLowerCase()));

/**
 * Shapes that are a credential wherever they appear.
 *
 * `sk-ant-` first, so an Anthropic key is matched by the specific rule and not
 * cut short by the general one. The tail classes are deliberately wide
 * (base64url plus `-` and `_`): a provider that adds a character class should
 * still be caught, and over-redacting a log line costs nothing.
 */
const KEY_SHAPES: readonly RegExp[] = [
  /apikey_[A-Za-z0-9_-]{12,}/g,
  /sk-ant-[A-Za-z0-9_-]{6,}/g,
  /sk-proj-[A-Za-z0-9_-]{6,}/g,
  /sk-or-[A-Za-z0-9_-]{6,}/g,
  /sk-[A-Za-z0-9_-]{12,}/g,
  // `Bearer <anything long>` — the header value even when the header name was
  // lost, for example because it was interpolated into a message.
  /[Bb]earer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  // R2 presigned URLs: the signature is the part that grants access.
  /[?&][Xx]-[Aa]mz-[Ss]ignature=[A-Za-z0-9%]+/g,
];

/** Replace every credential-shaped substring. Safe to call on any string. */
export function redactString(value: string): string {
  let out = value;
  for (const shape of KEY_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

const MAX_DEPTH = 6;

/**
 * Is this field name one whose *value* is a secret whatever it looks like?
 *
 * The version suffix is matched by pattern rather than listed, because the
 * list used to name `kek_v1` literally: the first rotation this system exists
 * to support would have introduced a `KEK_V2` that no name rule matched and no
 * value pattern could catch either — raw AES material is base64 with none of
 * the provider prefixes `KEY_SHAPES` looks for. A redactor that stops working
 * at exactly the moment the thing it protects is being handled is worse than
 * none, because the tests still pass.
 */
function isSecretName(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_NAMES.has(lower) || /^kek(_v\d+)?$/.test(lower);
}

/**
 * Deep-redact a value for logging: secret-named fields by name, every string by
 * shape. Cycles and depth are bounded, because a log helper that throws turns
 * an incident into two incidents.
 */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1, seen));

  if (value instanceof Headers) {
    const out: Record<string, unknown> = {};
    value.forEach((v, k) => {
      out[k] = isSecretName(k) ? REDACTED : redactString(v);
    });
    return out;
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return `[bytes ${value.byteLength}]`;
  }

  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
    out[name] = isSecretName(name) ? REDACTED : redact(item, depth + 1, seen);
  }
  return out;
}

/** The message an error may carry outward, past every provider response. */
export function redactMessage(error: unknown): string {
  if (error instanceof Error) return redactString(error.message);
  if (typeof error === 'string') return redactString(error);
  return 'unknown error';
}

export interface LogFields {
  readonly at: string;
  readonly [field: string]: unknown;
}

/**
 * The only way this milestone's code writes a log line.
 *
 * One JSON object per line, redacted. Nothing calls `console.log` with an
 * interpolated string: a template literal is exactly how a key reaches a log,
 * because the redactor never sees the parts separately.
 */
export function logEvent(fields: LogFields): void {
  console.log(JSON.stringify(redact(fields)));
}

export function logError(fields: LogFields & { error: unknown }): void {
  const { error, ...rest } = fields;
  console.error(JSON.stringify(redact({ ...rest, error: redactMessage(error) })));
}
