// Which providers this deployment offers, in one place (decision R12).
//
// The product is bring-your-own-key, and the key it wants is an OpenRouter one:
// a single credential that reaches every model OpenRouter brokers. The other
// three adapters stay in the codebase — they are how the replay rules are
// tested, and `ScriptedProvider` still exercises them — but nothing on the
// product path may reach them while `ALLOWED_PROVIDERS` does not name them.
//
// "One place" is the whole point of this file. The rule is asked five times:
//
//   * installing, verifying or rotating a key          (routes/keys.ts)
//   * listing the catalog                              (routes/keys.ts → model/catalog.ts)
//   * choosing a session's model                       (routes/sessions.ts)
//   * choosing the workspace default                   (routes/settings.ts)
//   * creating a run                                   (routes/turns.ts)
//
// Each of those asks `requireAllowedProvider`, so there is one sentence, one
// status and one machine-readable reason for all five. A sixth route that
// forgets is a route that forgot to call this function, which is a thing a
// reviewer can see; a sixth route with its own copy of the rule is not.
import { PROVIDER_NOT_ALLOWED_COPY, parseAllowedProviders, type Provider } from '@hermes/shared';
import { RouteError } from '../routes/tenant.js';

/** Just the variable, so a test and a job can call this without a whole `Env`. */
export interface AllowedProvidersEnv {
  readonly ALLOWED_PROVIDERS?: string | undefined;
}

/**
 * The providers this deployment offers.
 *
 * Unset falls back to `openrouter` rather than to everything: a Worker whose
 * variable went missing should refuse a DeepSeek key, not quietly accept one.
 */
export const allowedProviders = (env: AllowedProvidersEnv): Provider[] =>
  parseAllowedProviders(env.ALLOWED_PROVIDERS);

export const isProviderAllowed = (env: AllowedProvidersEnv, provider: string): boolean =>
  (allowedProviders(env) as readonly string[]).includes(provider);

/**
 * 422, because the request is well-formed and names something real — this
 * workspace is not allowed to use it. 400 would say "you sent nonsense" and
 * 403 would say "you, personally, may not", and neither is true.
 */
export function requireAllowedProvider(env: AllowedProvidersEnv, provider: string): void {
  if (isProviderAllowed(env, provider)) return;
  throw new RouteError(PROVIDER_NOT_ALLOWED_COPY, 'provider_not_allowed', 422);
}

export { PROVIDER_NOT_ALLOWED_COPY };
