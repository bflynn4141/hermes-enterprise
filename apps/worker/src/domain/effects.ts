// What a decision implies, and what the pilot does about it: nothing.
//
// Invariant 3 (docs/CONVENTIONS.md): a decision records what a human decided.
// Anything that crosses a system boundary as a result — an access grant, an
// email, a payment, a signature — is an `effects` row in `pending` that a human
// with the required role executes. The decision never executes one, and in this
// build no execution exists at all: there is no SMTP client, no payment
// provider, no signature provider, and no webhook that would reach one. The
// execute route says so in words a reviewer can read, which is the honest
// version of a feature that is not built.
//
// The plan for each kind comes from the demo's receipts, which are the product
// specification for this: an admission leaves "Access pending · No message
// sent", an invoice is "Saved in Library · Not sent · No money moved", an
// agreement is "Saved in Library · Unsigned · Not sent". Each of those phrases
// is one pending effect.
import { EFFECT_REQUIREMENTS, type Decision, type EffectKind, type RequestKind } from '@hermes/shared';

export interface PlannedEffect {
  readonly kind: EffectKind;
  readonly requiredRole: string;
  readonly approvalsRequired: number;
}

const plan = (kind: EffectKind): PlannedEffect => ({
  kind,
  requiredRole: EFFECT_REQUIREMENTS[kind].requiredRole,
  approvalsRequired: EFFECT_REQUIREMENTS[kind].approvals,
});

/**
 * Kind x decision -> the effects the decision records as pending.
 *
 * A decline records none, in every kind. That is the demo's "No further action
 * taken · No message sent", and it is also the reason a decline cannot be a
 * cheaper path to an outreach: there is no row for anyone to execute.
 */
export function plannedEffects(kind: RequestKind, decision: Decision): readonly PlannedEffect[] {
  if (decision === 'decline') return [];
  switch (kind) {
    case 'application':
      // Admission is a status, not access. Someone holding the `access`
      // reviewer role still has to grant it, and `v_pending_grants` counts the
      // ones nobody has.
      return [plan('access_grant')];
    case 'invoice':
      // Two, because "created" is neither "sent" nor "paid", and collapsing
      // them would let one approval imply both.
      return [plan('email_send'), plan('payment')];
    case 'agreement':
      // Signature first: sending an unsigned agreement and sending a signed one
      // are different acts, and the order the rows are written in is the order
      // the review pane lists them.
      return [plan('signature'), plan('email_send')];
    default:
      return [];
  }
}

/** Short label for the review pane. Ids and enums stay in `events`; this is UI. */
export const EFFECT_LABELS: Readonly<Record<EffectKind, string>> = {
  access_grant: 'Grant workspace access',
  email_send: 'Send to the recipient',
  payment: 'Pay the invoice',
  signature: 'Collect signatures',
};

/**
 * The copy every execution returns in the pilot.
 *
 * Kept as one exported constant rather than written at three call sites,
 * because it is the sentence the product makes to a reviewer about what this
 * build does and does not do, and three copies of a promise drift.
 */
export const EFFECT_UNAVAILABLE_REASON =
  'Not executed. This build sends nothing, pays nothing, grants nothing and signs nothing.';

export const EFFECT_UNAVAILABLE_DETAIL =
  'The decision is recorded and this effect is waiting. Execution is deliberately absent from the pilot: ' +
  'no outreach, payment, access or signature code exists in this repository, behind a flag or otherwise. ' +
  'A person holding the required role performs it outside the product and marks it here in a later milestone.';

/** The enforcement record written when someone presses Execute. */
export const unavailableEnforcement = (
  userId: string,
): { result: 'unavailable'; reason: string; detail: string; attempted_by: string; attempted_at: string } => ({
  result: 'unavailable',
  reason: EFFECT_UNAVAILABLE_REASON,
  detail: EFFECT_UNAVAILABLE_DETAIL,
  attempted_by: userId,
  attempted_at: new Date().toISOString(),
});
