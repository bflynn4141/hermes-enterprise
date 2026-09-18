// Development-only Nous Portal verification and catalog seam. It is reachable
// only when the Worker explicitly runs in development with the fixture flag.
import type { Env } from '../env.js';
import { OPENROUTER_FIXTURE_MODELS } from './openrouter-dev.js';
import type { FetchLike } from './types.js';

export const NOUS_PORTAL_FIXTURE_MODELS = {
  data: [
    ...OPENROUTER_FIXTURE_MODELS.data,
    {
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek: DeepSeek V4.1 Flash',
      context_length: 1_048_576,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0.00000015', completion: '0.0000006', input_cache_read: '0.000000015' },
      supported_parameters: ['tools', 'reasoning', 'reasoning_effort'],
      reasoning: { supported_efforts: ['max', 'high', 'low'], default_effort: 'high' },
    },
  ],
} as const;

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
