// The one way a view offers "Sign in again" after the server asks for a recent
// sign-in (`reauth_required`, which `requireStepUp` answers on every write that
// changes authority).
//
// `needsSignIn` keys off the machine-readable reason, never the message, so a
// copy change on the server cannot hide the link. `signIn` sends the browser to
// the step-up URL; `reason` names what the step-up was for and stays on the
// client (see `stepUpUrl`).
import { useCallback } from 'react';
import type { AuthAdapter } from '../../model/auth.js';
import { useAdapter } from '../store-context.js';

export type StepUpReason = Parameters<AuthAdapter['stepUpUrl']>[1];

export const needsSignIn = (problem: unknown): boolean =>
  (problem as { reason?: string } | null)?.reason === 'reauth_required';

export function useStepUp(reason: StepUpReason): { needsSignIn: (problem: unknown) => boolean; signIn: () => void } {
  const adapter = useAdapter();
  const signIn = useCallback(() => {
    const url = adapter.auth.stepUpUrl(window.location.href, reason);
    if (url) window.location.assign(url);
  }, [adapter, reason]);
  return { needsSignIn, signIn };
}
