// The one place a provider HTTP response becomes a `ProviderError`.
//
// The status-to-class mapping is the table in section 4 of the production plan,
// and it is written once so that all three adapters agree: a 401 is the key's
// problem and marks it invalid, a 429 is the provider's limit and is retried, a
// 5xx is transient, a 4xx we caused is permanent.
//
// The response body is *not* included in the message. A provider that echoes
// the offending request back — some do, on a malformed auth header — would put
// the key in our error string, and an error string ends up in a log, a Sentry
// event and a run's `error` column. The status and a constant are enough.
import { redactString } from '../keys/redact.js';
import { ProviderError, type FailureClass } from './types.js';

export function classifyStatus(status: number): FailureClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'transient';
  if (status === 408) return 'transient';
  return 'permanent';
}

/**
 * Turn a non-2xx response into an error.
 *
 * The body is read and discarded except for a provider-supplied `type` or
 * `code` field, which is a short enum and is redacted anyway before it is used.
 */
export async function errorFromResponse(response: Response, provider: string): Promise<ProviderError> {
  let code = '';
  try {
    const text = await response.text();
    const parsed = JSON.parse(text) as { error?: { type?: unknown; code?: unknown } };
    const raw = parsed.error?.type ?? parsed.error?.code ?? '';
    // A string, and only a string. OpenRouter's `error.code` is the HTTP status
    // as a *number*, and the regular expression below happily coerced it — so
    // `redactString` was handed a number and threw a TypeError from inside the
    // error path, turning every non-2xx from that provider into a crash rather
    // than a classified ProviderError.
    const candidate = typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : '';
    // Enum-shaped only: anything else is prose we do not want to carry.
    if (/^[a-z0-9_.-]{1,64}$/i.test(candidate)) code = candidate;
  } catch {
    // A body that is not JSON tells us nothing we are allowed to repeat.
  }
  const suffix = code === '' ? '' : ` (${redactString(code)})`;
  return new ProviderError(
    `${provider} responded ${response.status}${suffix}`,
    classifyStatus(response.status),
    response.status,
    provider,
  );
}

/** An aborted fetch is Stop or a step timeout, not a provider failure. */
export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/** Wrap a network-level throw so a caller only ever sees a `ProviderError`. */
export function networkError(error: unknown, provider: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? redactString(error.message) : 'unknown transport failure';
  return new ProviderError(`${provider} transport failed: ${message}`, 'transient', undefined, provider);
}
