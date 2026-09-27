// What the composer says when the server refuses a turn.
//
// The bug this exists for (decision C45): `POST /w/:ws/sessions/:id/turns`
// answered `400 {"error":"Add a deepseek key in Settings to start","reason":
// "no_key"}` — a correct refusal — and the composer's `.catch(() => undefined)`
// threw it away. The person pressed Enter, the draft vanished, the session
// renamed itself after the message, and nothing else happened.
//
// Three rules here:
//
//   * **the reason is the contract, the sentence is ours.** docs/DESIGN.md:
//     the server's `reason` is mapped to a plain sentence written for the
//     person, and the server's own text ("run.turn is limited to 30 per 60
//     seconds") is never shown. The client adds the route to the fix, which is
//     a thing only the client knows.
//   * **a reason the client does not know is still said.** It gets a generic
//     sentence that says nothing was sent and the draft is kept — never a
//     swallowed error and never the server's words.
//   * **nothing is lost.** Every refusal keeps the draft; the caller restores
//     it, and the session's name is put back if the turn that renamed it never
//     ran.
import type { RestError } from '../../model/rest.js';
import { providerName } from '../copy/names.js';

export interface Refusal {
  /** A plain sentence for the person. */
  readonly text: string;
  /** Where the person can go to fix it, when the client knows. */
  readonly action: { readonly label: string; readonly target: 'provider-keys' } | null;
  /** `true` for the ones a person can do something about right now. */
  readonly actionable: boolean;
}

/** What the composer knows that the refusal does not. */
export interface RefusalContext {
  /** The session model's provider slug, so the sentence can name it. */
  readonly provider?: string | null;
  /** The agent's name ("Iris"). */
  readonly agentName?: string | null;
}

const PROVIDER_KEYS = { label: 'Admin → Model providers', target: 'provider-keys' } as const;

const KEPT = 'Nothing was sent, and your draft is still here.';

/**
 * A refusal, from whatever the adapter threw.
 *
 * Takes `unknown` because that is what a `catch` gives, and because a thrown
 * `TypeError` from a dropped connection has to produce a sentence too.
 */
export function refusalFor(error: unknown, context: RefusalContext = {}): Refusal {
  const rest = error as Partial<RestError> | null;
  const reason = typeof rest?.reason === 'string' ? rest.reason : '';
  const provider = providerName(context.provider ?? 'nous_portal');
  const agent = context.agentName?.trim() || 'The agent';
  const say = (text: string, actionable = false): Refusal => ({ text, action: null, actionable });

  switch (reason) {
    // No verified key for the model this session is on.
    case 'no_key':
      return { text: `Connect ${provider} to start. ${KEPT}`, action: PROVIDER_KEYS, actionable: true };
    case 'key_invalid':
      return { text: `Your ${provider} key was rejected. Replace it to continue. ${KEPT}`, action: PROVIDER_KEYS, actionable: true };
    case 'key_unverified':
      return { text: `Your ${provider} key hasn't been verified yet. Verify it to continue. ${KEPT}`, action: PROVIDER_KEYS, actionable: true };
    case 'key_revoked':
      return { text: `Your ${provider} key was removed. Add a new one to continue. ${KEPT}`, action: PROVIDER_KEYS, actionable: true };

    // Limits.
    case 'max_concurrent_runs':
    case 'cap_exceeded':
      return say('This workspace is already running as many tasks as it allows. Try again when one finishes.');
    case 'daily_token_cap':
      return say('This workspace has used its daily allowance. Try again tomorrow, or ask an Admin to raise it.');
    case 'platform_capacity':
      return say('Hermes is at capacity right now. Try again in a few minutes.');
    case 'rate_limited':
      return say('You’re sending messages faster than allowed. Wait a minute, then try again.');

    case 'engine_paused':
      return say(`Hermes is updating. ${KEPT}`);
    case 'runtime_unhealthy':
      return say(`${agent} isn’t ready right now. ${KEPT} Try again in a moment.`);
    case 'run_in_flight':
      return say(`${agent} is still working on your last message. Wait for it to finish, or stop it first.`);

    case 'context_changed':
      return say('This question changed. Check your answer and try again.', true);
    case 'context_source_changed':
      return say('That source changed since you picked it. Select it again.', true);
    case 'context_source_missing':
      return say(`That source is no longer available to ${agent}. Pick another one.`, true);
    case 'context_source_unready':
      return say('That source is still being read, or couldn’t be read. Wait a moment or replace it.', true);
    case 'context_source_budget':
      return say('Those sources are too long to use together. Pick fewer or shorter ones.', true);

    case 'reauth_required':
      return say('Confirm it’s you before sending this.', true);

    case 'unknown_model':
    case 'model_not_in_catalog':
      return say('This session’s model isn’t available anymore. Pick another model and send again.', true);
    case 'read_only':
      return say('This conversation is read-only.');
    case 'not_owner':
      return say('Only the person who started this conversation can send to it.');
    case 'unknown_session':
      return say('This conversation isn’t available anymore.');
    case 'empty_guidance':
    case 'empty_queue_item':
      return say('Type a message first.', true);
    case 'unknown_queue_item':
      return say('That queued message isn’t there anymore.');
    case 'run_not_waiting':
      return say(`${agent} isn’t waiting for an answer anymore.`);
    case 'wrong_key':
      return say(`${agent} is waiting for a different answer now. Refresh to see it.`);
    case 'stale_attempt':
    case 'expected_attempt_required':
      return say('This task changed. Refresh and try again.');
    case 'run_active':
      return say('This task is already running.');
    case 'run_completed':
      return say('This task has already finished.');
    case 'unknown_run':
      return say('This task isn’t available anymore.');

    default:
      // A reason this file has never seen gets a generic sentence, never the
      // server's text (docs/DESIGN.md). With no reason at all the request most
      // likely never reached the Worker: a bare `TypeError: Failed to fetch`
      // has a message written for a developer.
      if (reason) return say(`Something went wrong. ${KEPT}`, true);
      return { text: 'That did not reach the workspace. Your draft is still here — try again.', action: null, actionable: true };
  }
}
