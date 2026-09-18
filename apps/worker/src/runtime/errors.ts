// Safe projection of native Hermes failures into the enterprise run contract.
//
// Hermes already redacts its terminal `error` field, but that field is still
// provider-controlled free text. Use it only as a classification signal and
// persist fixed copy. That keeps credentials, prompts and request fragments
// out of Postgres, stream events, traces and logs.
import type { RunErrorInput } from '../engine/agent-db.js';
import type { HermesStatus } from './client.js';

export interface ClassifiedHermesFailure {
  readonly error: RunErrorInput;
  /** Safe telemetry label; never the native provider text. */
  readonly code: 'auth' | 'quota' | 'rate_limit' | 'rejected' | 'unavailable' | 'interrupted' | 'unknown';
  readonly nativeErrorPresent: boolean;
}

const includesAny = (value: string, patterns: readonly RegExp[]): boolean =>
  patterns.some((pattern) => pattern.test(value));

const AUTH = [
  /provider authentication failed/,
  /\b(?:http\s*)?401\b/,
  /\bunauthori[sz]ed\b/,
  /\binvalid (?:api )?key\b/,
  /\bapi key (?:is )?(?:invalid|expired|missing)\b/,
  /\boauth\b.*\bexpired\b/,
  /\b(?:access |auth )?token\b.*\bexpired\b/,
  /\bcredentials?\b.*\b(?:invalid|expired|missing)\b/,
] as const;

const QUOTA = [
  /\b(?:http\s*)?402\b/,
  /\binsufficient (?:credits?|balance|funds)\b/,
  /\b(?:credits?|balance) exhausted\b/,
  /\bquota (?:exceeded|exhausted)\b/,
  /\bbilling (?:limit|disabled|required)\b/,
] as const;

const RATE_LIMIT = [
  /\b(?:http\s*)?429\b/,
  /\brate[ -]?limit(?:ed|ing)?\b/,
  /\btoo many requests\b/,
] as const;

const REJECTED = [
  /\b(?:http\s*)?(?:400|404|405|413|415|422)\b/,
  /\bbad request\b/,
  /\binvalid request\b/,
  /\bcontext (?:length|window)\b/,
  /\bmaximum context\b/,
  /\bmodel (?:not found|is not supported|unsupported)\b/,
  /\bunsupported model\b/,
] as const;

const INTERRUPTED = [
  /\bgateway restarted\b/,
  /\bruntime_run_inactive\b/,
  /\brun (?:was )?interrupted\b/,
] as const;

const UNAVAILABLE = [
  /\b(?:http\s*)?(?:500|502|503|504)\b/,
  /\binternal server error\b/,
  /\btemporar(?:y|ily) unavailable\b/,
  /\bservice unavailable\b/,
  /\boverloaded\b/,
  /\btime(?:d)? out\b/,
  /\btimeout\b/,
  /\bconnection (?:reset|closed|failed|error)\b/,
  /\bnetwork (?:error|failure)\b/,
] as const;

/**
 * Classify a terminal native status without retaining its free-text error.
 * Unknown failures remain retryable because Hermes has already ended the
 * native run; retry creates a new, attempt-guarded run rather than replaying it.
 */
export function classifyHermesFailure(
  status: Pick<HermesStatus, 'status' | 'error'>,
): ClassifiedHermesFailure {
  const signal = typeof status.error === 'string' ? status.error.toLowerCase().slice(0, 2_000) : '';
  const nativeErrorPresent = signal.length > 0;

  if (status.status === 'interrupted' || includesAny(signal, INTERRUPTED)) {
    return {
      code: 'interrupted', nativeErrorPresent,
      error: {
        class: 'transient', retryable: true, reason: 'hermes_runtime_interrupted',
        message: 'Hermes restarted before this run settled. Retry the remaining work.', step_id: 'hermes',
      },
    };
  }
  if (includesAny(signal, AUTH)) {
    return {
      code: 'auth', nativeErrorPresent,
      error: {
        class: 'auth', retryable: false, reason: 'hermes_provider_auth',
        message: 'The selected model connection needs attention. Reconnect it before retrying.', step_id: 'hermes',
      },
    };
  }
  if (includesAny(signal, QUOTA)) {
    return {
      code: 'quota', nativeErrorPresent,
      error: {
        class: 'permanent', retryable: false, reason: 'hermes_provider_quota',
        message: 'The selected model account has no available quota. Update the connection or choose another model.', step_id: 'hermes',
      },
    };
  }
  if (includesAny(signal, RATE_LIMIT)) {
    return {
      code: 'rate_limit', nativeErrorPresent,
      error: {
        class: 'transient', retryable: true, reason: 'hermes_provider_rate_limited',
        message: 'The selected model is rate limited. Wait a moment, then retry.', step_id: 'hermes',
      },
    };
  }
  if (includesAny(signal, REJECTED)) {
    return {
      code: 'rejected', nativeErrorPresent,
      error: {
        class: 'permanent', retryable: false, reason: 'hermes_provider_rejected',
        message: 'The selected model rejected this request. Change the model or request before trying again.', step_id: 'hermes',
      },
    };
  }
  if (includesAny(signal, UNAVAILABLE)) {
    return {
      code: 'unavailable', nativeErrorPresent,
      error: {
        class: 'transient', retryable: true, reason: 'hermes_provider_unavailable',
        message: 'The model provider is temporarily unavailable. Retry the remaining work.', step_id: 'hermes',
      },
    };
  }
  return {
    code: 'unknown', nativeErrorPresent,
    error: {
      class: 'transient', retryable: true, reason: 'hermes_run_failed',
      message: 'Hermes could not finish this run. Retry to continue.', step_id: 'hermes',
    },
  };
}
