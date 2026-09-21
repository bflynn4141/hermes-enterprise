// What a legacy decision implies, and what this effect route can execute.
//
// Invariant 3 (docs/CONVENTIONS.md): a decision records what a human decided.
// Anything that crosses a system boundary as a result — an access grant, an
// email, a payment, a signature — is an `effects` row in `pending` that a human
// with the required role executes. The decision never executes one, and in this
// route does not execute one. Approved email delivery now has a separate,
// exact-revision outbox; that does not turn a legacy `email_send` effect into a
// delivery receipt. Payment, signature and access executors remain absent.
//
// A non-production environment may instead answer `simulated`: the route
// invents a reference and a provider-shaped timeline, writes them to
// `enforcement_result`, and sets `status = 'simulated'`. That status is never
// `executed`, and `effectExecutorMode` refuses the switch under `production`,
// so the honest answer is the only one a customer can ever receive.
//
// The plan for each kind comes from the demo's receipts, which are the product
// specification for this: an admission leaves "Access pending · No message
// sent", an invoice is "Saved in Library · Not sent · No money moved", an
// agreement is "Saved in Library · Unsigned · Not sent". Each of those phrases
// is one pending effect.
import {
  EFFECT_REQUIREMENTS,
  type Decision,
  type EffectExecutorMode,
  type EffectKind,
  type EffectSimulation,
  type RequestKind,
} from '@hermes/shared';

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
  'Not executed. This legacy effect has no configured executor; no email, payment, access or signature action was completed.';

export const EFFECT_UNAVAILABLE_DETAIL =
  'The decision is recorded and this legacy effect remains unavailable. Approved communications use a separate governed outbox when configured; this row does not queue or prove delivery. ' +
  'Payment, access and signature executors are not configured, so a person holding the required role must complete that work outside the product.';

/** The enforcement record written when someone records a legacy-effect attempt. */
export const unavailableEnforcement = (
  userId: string,
): { result: 'unavailable'; reason: string; detail: string; attempted_by: string; attempted_at: string } => ({
  result: 'unavailable',
  reason: EFFECT_UNAVAILABLE_REASON,
  detail: EFFECT_UNAVAILABLE_DETAIL,
  attempted_by: userId,
  attempted_at: new Date().toISOString(),
});

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

/**
 * Which executor answers Execute. `simulated` needs both the variable and a
 * non-production environment; production is pinned to `unavailable` here in
 * code so that a mistaken var in wrangler.jsonc cannot turn a customer's
 * ledger into a stage set. A unit test asserts both halves.
 */
export function effectExecutorMode(
  env: Pick<import('../env.js').Env, 'ENVIRONMENT'> & { EFFECT_EXECUTOR_MODE?: string },
): EffectExecutorMode {
  if (env.ENVIRONMENT === 'production') return 'unavailable';
  return env.EFFECT_EXECUTOR_MODE === 'simulated' ? 'simulated' : 'unavailable';
}

/** Facts from the request the simulation is allowed to echo. All optional. */
export interface SimulationContext {
  readonly subjectName?: string | null;
  readonly payeeName?: string | null;
  readonly currency?: string | null;
  readonly totalMinor?: number | null;
  readonly documentNumber?: string | null;
  readonly parties?: readonly string[];
}

const SIM_PREFIX: Readonly<Record<EffectKind, string>> = {
  access_grant: 'SIM-ACC',
  email_send: 'SIM-MSG',
  payment: 'SIM-PAY',
  signature: 'SIM-SIG',
};

const money = (currency: string | null | undefined, minor: number | null | undefined): string | null => {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return null;
  const major = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
  return `${(currency ?? 'USD').toUpperCase()} ${major}`;
};

/** Six hex characters from crypto, so two simulations never share a reference. */
export function simulationReference(kind: EffectKind, random: () => string = randomHex): string {
  return `${SIM_PREFIX[kind]}-${random()}`;
}

function randomHex(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * The invented outcome for one effect kind. The copy reads like a settled
 * provider receipt on purpose: the row's `simulated` status, its `SIM-` reference
 * and the client's pill are what say it was simulated, not every sentence.
 * Steps are spaced a few seconds apart and all lie in the past, so nothing
 * looks in flight; nothing polls or updates it.
 */
export function simulateEffect(
  kind: EffectKind,
  context: SimulationContext,
  now: Date = new Date(),
  reference: string = simulationReference(kind),
): EffectSimulation {
  const at = (secondsAgo: number): string => new Date(now.getTime() - secondsAgo * 1000).toISOString();
  const who = context.payeeName ?? context.subjectName ?? 'the recipient';
  switch (kind) {
    case 'payment': {
      const amount = money(context.currency, context.totalMinor);
      return {
        reference,
        summary: `${amount ? `${amount} to ${who}` : `Payment to ${who}`} · Settled`,
        steps: [
          { label: 'Payment instruction created', at: at(9) },
          { label: 'Bank accepted the instruction', at: at(6) },
          { label: `Settled · ${reference}`, at: at(1) },
        ],
      };
    }
    case 'signature': {
      const signers = context.parties && context.parties.length > 0 ? context.parties : [who];
      return {
        reference,
        summary: `${context.documentNumber ?? 'Agreement'} · Signed by ${signers.length === 1 ? signers[0] : `${signers.length} parties`}`,
        steps: [
          { label: 'Signing envelope sent', at: at(12) },
          ...signers.slice(0, 3).map((name, index) => ({ label: `${name} signed`, at: at(8 - index * 2) })),
          { label: `Envelope completed · ${reference}`, at: at(1) },
        ],
      };
    }
    case 'email_send':
      return {
        reference,
        summary: `${context.documentNumber ?? 'Message'} sent to ${who} · Delivered`,
        steps: [
          { label: 'Message rendered', at: at(6) },
          { label: 'Accepted by the mail service', at: at(4) },
          { label: `Delivered · ${reference}`, at: at(1) },
        ],
      };
    case 'access_grant':
    default:
      return {
        reference,
        summary: `Workspace access for ${who} · Granted`,
        steps: [
          { label: 'Grant recorded', at: at(3) },
          { label: `Granted · ${reference}`, at: at(1) },
        ],
      };
  }
}

/** The one sentence on every simulated row. Kept as a constant for the same reason as the unavailable copy. */
export const EFFECT_SIMULATED_REASON =
  'Simulated. No email, payment, access or signature action was completed; this environment invents the outcome so the flow can be followed to the end.';

/** The enforcement record written when the simulated executor answers. */
export const simulatedEnforcement = (
  userId: string,
  simulation: EffectSimulation,
): { result: 'simulated'; reason: string; simulation: EffectSimulation; attempted_by: string; attempted_at: string } => ({
  result: 'simulated',
  reason: EFFECT_SIMULATED_REASON,
  simulation,
  attempted_by: userId,
  attempted_at: new Date().toISOString(),
});
