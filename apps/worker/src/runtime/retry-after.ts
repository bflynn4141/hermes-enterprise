// Provider backoff is a deadline, never untrusted text in a persisted error.
// Excessive values disable automatic recovery rather than silently shortening
// the provider's requested wait or creating an unbounded timer.
export const MAX_PROVIDER_RETRY_SECONDS = 7 * 24 * 60 * 60;
export interface ProviderRetryAfter {
  readonly notBefore: Date | null;
  readonly blockedReason: 'provider_retry_after_excessive' | null;
  readonly header: string | null;
}

export function parseProviderRetryAfter(raw: string | null, now = Date.now()): ProviderRetryAfter | null {
  if (raw === null || !Number.isFinite(now)) return null;
  const value = raw.trim();
  if (!value) return null;
  const excessive: ProviderRetryAfter = { notBefore: null, blockedReason: 'provider_retry_after_excessive', header: null };
  if (value.length > 128) return excessive;
  let deadline: number;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds > MAX_PROVIDER_RETRY_SECONDS) return excessive;
    deadline = now + seconds * 1000;
  } else {
    // Accept the canonical HTTP date form, not JavaScript's permissive parsing
    // of strings such as "1", "-5", local dates, or floating-point seconds.
    if (!/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return null;
    deadline = Date.parse(value);
    if (!Number.isFinite(deadline)) return null;
    if (deadline - now > MAX_PROVIDER_RETRY_SECONDS * 1000) return excessive;
    deadline = Math.max(now, deadline);
  }
  if (!Number.isFinite(deadline) || Number.isNaN(new Date(deadline).getTime())) return excessive;
  return {
    notBefore: new Date(deadline), blockedReason: null,
    header: String(Math.ceil(Math.max(0, deadline - now) / 1000)),
  };
}
