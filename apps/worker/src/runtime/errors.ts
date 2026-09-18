// Safe projection of the versioned native Hermes failure contract into the
// Enterprise run contract. Runtime/provider prose is deliberately ignored.
import type { RunErrorInput } from '../engine/agent-db.js';
import type { HermesStatus, HermesTerminalError, HermesTerminalErrorCode } from './client.js';

export interface ClassifiedHermesFailure {
  readonly error: RunErrorInput;
  readonly code: 'auth' | 'quota' | 'rate_limit' | 'rejected' | 'unavailable' | 'interrupted' | 'unknown';
  readonly nativeCode: HermesTerminalErrorCode | null;
  readonly source: HermesTerminalError['source'] | 'contract';
  readonly structured: boolean;
  readonly contractVersion: 1 | null;
  readonly nativeErrorPresent: boolean;
}

const FIXED_ERRORS = {
  provider_auth: {
    code: 'auth', class: 'auth', retryable: false, reason: 'hermes_provider_auth',
    message: 'The selected model connection needs attention. Reconnect it before retrying.',
  },
  provider_quota: {
    code: 'quota', class: 'permanent', retryable: false, reason: 'hermes_provider_quota',
    message: 'The selected model account has no available quota. Update the connection or choose another model.',
  },
  provider_rate_limited: {
    code: 'rate_limit', class: 'transient', retryable: true, reason: 'hermes_provider_rate_limited',
    message: 'The selected model is rate limited. Wait a moment, then retry.',
  },
  request_rejected: {
    code: 'rejected', class: 'permanent', retryable: false, reason: 'hermes_provider_rejected',
    message: 'The selected model rejected this request. Change the model or request before trying again.',
  },
  provider_unavailable: {
    code: 'unavailable', class: 'transient', retryable: true, reason: 'hermes_provider_unavailable',
    message: 'The model provider is temporarily unavailable. Retry the remaining work.',
  },
  runtime_interrupted: {
    code: 'interrupted', class: 'transient', retryable: true, reason: 'hermes_runtime_interrupted',
    message: 'Hermes restarted before this run settled. Retry the remaining work.',
  },
  runtime_unknown: {
    code: 'unknown', class: 'transient', retryable: true, reason: 'hermes_run_failed',
    message: 'Hermes could not finish this run. Retry to continue.',
  },
} as const satisfies Record<HermesTerminalErrorCode, {
  readonly code: ClassifiedHermesFailure['code'];
  readonly class: RunErrorInput['class'];
  readonly retryable: boolean;
  readonly reason: string;
  readonly message: string;
}>;

/**
 * Interpret only the negotiated machine-readable terminal error. A missing
 * envelope is a protocol violation and stays generic; provider prose never
 * decides retryability or user copy.
 */
export function classifyHermesFailure(
  status: Pick<HermesStatus, 'status' | 'error' | 'terminal_error'>,
): ClassifiedHermesFailure {
  const nativeErrorPresent = typeof status.error === 'string' && status.error.length > 0;
  const detail = status.terminal_error;
  if (detail) {
    const fixed = FIXED_ERRORS[detail.code];
    return {
      code: fixed.code,
      nativeCode: detail.code,
      source: detail.source,
      structured: true,
      contractVersion: detail.schema_version,
      nativeErrorPresent,
      error: {
        class: fixed.class,
        retryable: fixed.retryable,
        reason: fixed.reason,
        message: fixed.message,
        step_id: 'hermes',
      },
    };
  }
  return {
    code: 'unknown',
    nativeCode: null,
    source: 'contract',
    structured: false,
    contractVersion: null,
    nativeErrorPresent,
    error: {
      class: 'transient', retryable: true, reason: 'hermes_run_failed',
      message: 'Hermes could not finish this run. Retry to continue.', step_id: 'hermes',
    },
  };
}
