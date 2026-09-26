// Compare the exact settings the user confirmed while the session row is locked.
// This guards cross-tab writes without changing idempotent turn/retry admission.
import { sessionSettingsSchema, type SessionSettings } from '@hermes/shared';
import { RouteError } from '../routes/errors.js';

export function parseExpectedSettings(value: unknown): SessionSettings | undefined {
  if (value === undefined) return undefined;
  const parsed = sessionSettingsSchema.safeParse(value);
  if (!parsed.success) throw new RouteError('Expected model and effort are required together.', 'bad_settings', 422);
  return parsed.data;
}

export function requireExpectedSettings(current: SessionSettings, expected: SessionSettings | undefined): void {
  if (expected && (current.model_id !== expected.model_id || current.effort !== expected.effort)) {
    throw new RouteError('The session model changed. Refresh the selection before continuing.', 'settings_changed', 409);
  }
}

export function validateSessionEffort(effort: unknown, effortMap: Record<string, unknown> | null): string | null {
  if (effort === null) return null;
  if (typeof effort !== 'string' || effort.length === 0 || effort.length > 32 || !effortMap || !Object.hasOwn(effortMap, effort)) {
    throw new RouteError('That effort is not supported by this model.', 'invalid_effort', 422);
  }
  return effort;
}
