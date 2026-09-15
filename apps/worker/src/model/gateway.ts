// The optional AI Gateway passthrough.
//
// Off by default, and the reason is in section 4 of the production plan: AI
// Gateway's own BYOK stores keys in Secrets Store, which caps at 100 per
// account in beta and 20 gateways, its aliases work only on passthrough URLs
// with no read-back, and any token with Run permission reaches every stored
// key. That is fine for an account's own keys and wrong for tenant keys, so the
// keys stay in our table and the gateway, when it is on at all, is a transparent
// proxy that never sees a stored credential — the tenant's key rides the request
// as it always did.
//
// What we do get from it is caching and rate-limit visibility. What we must not
// get is a second copy of every applicant's text: `cf-aig-collect-log-payload:
// false` turns payload logging off per request, and `configTest` below asserts
// it, because a gateway silently retaining prompt bodies would make the erasure
// inventory in section 6 wrong.
import type { Env } from '../env.js';
import type { GatewayRouting } from './types.js';

/** The header that turns payload logging off for a request. */
export const COLLECT_LOG_PAYLOAD_HEADER = 'cf-aig-collect-log-payload';

/** Provider path segment in a gateway passthrough URL. */
const GATEWAY_SEGMENT: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  deepseek: 'deepseek',
};

export interface GatewayConfig {
  readonly accountId: string;
  readonly gatewayId: string;
  /** Optional gateway auth token. Never a provider key. */
  readonly token?: string | undefined;
}

export const gatewayModeOn = (env: Pick<Env, 'MODEL_GATEWAY_MODE'>): boolean =>
  env.MODEL_GATEWAY_MODE === 'passthrough';

/**
 * Build the routing an adapter uses, or null when the gateway is off.
 *
 * Returning null rather than an identity rewriter is deliberate: an adapter's
 * `gateway` field being null is what a reader checks to answer "does this
 * request leave our account?", and an identity function would hide the answer.
 */
export function gatewayRouting(
  env: Pick<Env, 'MODEL_GATEWAY_MODE'>,
  config: GatewayConfig | null,
): GatewayRouting | null {
  if (!gatewayModeOn(env) || config === null) return null;

  const base = `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}`;
  return {
    rewrite(provider, url) {
      const segment = GATEWAY_SEGMENT[provider];
      if (segment === undefined) return url;
      const parsed = new URL(url);
      return `${base}/${segment}${parsed.pathname}${parsed.search}`;
    },
    headers: {
      // Logging off, on every single request. Not a gateway setting someone can
      // flip in a dashboard without a code review.
      [COLLECT_LOG_PAYLOAD_HEADER]: 'false',
      ...(config.token === undefined ? {} : { 'cf-aig-authorization': `Bearer ${config.token}` }),
    },
  };
}

/**
 * What the CI config test asserts.
 *
 * Exported as a function rather than written inside the test so that the claim
 * "logging is off" is made by the code that builds the headers, and the test
 * only checks that the claim holds.
 */
export function gatewayConfigCheck(
  env: Pick<Env, 'MODEL_GATEWAY_MODE'>,
  config: GatewayConfig | null,
): { readonly mode: string; readonly payloadLoggingOff: boolean } {
  const routing = gatewayRouting(env, config);
  return {
    mode: env.MODEL_GATEWAY_MODE,
    // Off when the gateway is off (there is nothing to log), and off when it is
    // on (because the header says so). There is no configuration in which this
    // is true.
    payloadLoggingOff: routing === null || routing.headers[COLLECT_LOG_PAYLOAD_HEADER] === 'false',
  };
}
