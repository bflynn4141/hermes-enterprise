// Development-only Nous Portal verification and catalog seam. It is reachable
// only when the Worker explicitly runs in development with the fixture flag.
import type { Env } from '../env.js';
import { OPENROUTER_FIXTURE_MODELS } from './openrouter-dev.js';
import type { FetchLike } from './types.js';

export const NOUS_PORTAL_FIXTURE_MODELS = OPENROUTER_FIXTURE_MODELS;

export function nousPortalFixtureEnabled(
  env: Pick<Env, 'ENVIRONMENT'> & { NOUS_PORTAL_FIXTURE?: string },
): boolean {
  return env.ENVIRONMENT === 'development' && env.NOUS_PORTAL_FIXTURE === '1';
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

export const nousPortalFixtureFetch: FetchLike = async (input) => {
  const url = typeof input === 'string' ? input : String(input);
  if (url.endsWith('/models')) return ok(NOUS_PORTAL_FIXTURE_MODELS);
  if (url.endsWith('/chat/completions')) {
    return ok({ id: 'fixture-verification', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } });
  }
  return new Response('not available in the fixture seam', { status: 501 });
};
