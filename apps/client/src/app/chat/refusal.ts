// What the composer says when the server refuses a turn.
//
// The bug this exists for (decision C45): `POST /w/:ws/sessions/:id/turns`
// answered `400 {"error":"Add a deepseek key in Settings to start","reason":
// "no_key"}` — a correct, well-written refusal — and the composer's
// `.catch(() => undefined)` threw it away. The person pressed Enter, the draft
// vanished, the session renamed itself after the message, and nothing else
// happened. The product had been told exactly what was wrong and said nothing.
//
// Three rules here, and they are the ones this codebase keeps everywhere:
//
//   * **the server's sentence, verbatim.** The Worker writes "Add a deepseek
//     key in Settings to start"; it knows which provider, and a client that
//     rewrote it would drift. `title` is always `error.message` when there is
//     one. What the client adds is the *route to the fix*, which is a thing
//     only the client knows.
//   * **a reason the client does not know is still shown.** The fallback is the
//     server's message with no action, never a swallowed error and never
//     "Something went wrong" over the top of a sentence that was more useful.
//   * **nothing is lost.** Every refusal keeps the draft; the caller restores
//     it, and the session's name is put back if the turn that renamed it never
//     ran.
import type { RestError } from '../../model/rest.js';

export interface Refusal {
  /** The server's own sentence. */
  readonly text: string;
  /** Where the person can go to fix it, when the client knows. */
  readonly action: { readonly label: string; readonly target: 'provider-keys' } | null;
  /** `true` for the ones a person can do something about right now. */
  readonly actionable: boolean;
}

const PROVIDER_KEYS = { label: 'Settings → Provider keys', target: 'provider-keys' } as const;

/**
 * A refusal, from whatever the adapter threw.
 *
 * Takes `unknown` because that is what a `catch` gives, and because a thrown
 * `TypeError` from a dropped connection has to produce a sentence too.
 */
export function refusalFor(error: unknown): Refusal {
  const rest = error as Partial<RestError> | null;
  const reason = typeof rest?.reason === 'string' ? rest.reason : '';
  const message = typeof rest?.message === 'string' && rest.message ? rest.message : '';

  switch (reason) {
    // No verified key for the model this session is on. The server's sentence
    // names the provider; the client knows the screen.
    case 'no_key':
    case 'key_invalid':
    case 'key_revoked':
      return {
        text: message || 'This session’s model has no verified provider key.',
        action: PROVIDER_KEYS,
        actionable: true,
      };

    // A cap. The server's copy carries the number and the window, both of which
    // it is the only one that knows.
    case 'max_concurrent_runs':
    case 'daily_token_cap':
    case 'platform_capacity':
    case 'rate_limited':
      return { text: message || 'This workspace has reached a limit.', action: null, actionable: false };

    case 'engine_paused':
      return {
        text: message || 'Iris is paused. Nothing was sent, and your draft is still here.',
        action: null,
        actionable: false,
      };

    case 'reauth_required':
      return { text: message || 'Confirm it is you before sending this.', action: null, actionable: true };

    default:
      // A reason this file has never seen still gets the server's own words —
      // it wrote a sentence for a person, and a generic one over the top of it
      // would be strictly worse. But only when there *is* a reason: a bare
      // `TypeError: Failed to fetch` from a dropped connection has a message
      // written for a developer, and showing it to somebody who pressed Enter
      // tells them nothing they can act on.
      if (reason && message) return { text: message, action: null, actionable: false };
      return { text: 'That did not reach the workspace. Your draft is still here — try again.', action: null, actionable: true };
  }
}
