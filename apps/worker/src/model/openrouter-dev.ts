// The development-only OpenRouter seam.
//
// Why it exists: the live end-to-end scenario has to prove that adding a key,
// verifying it and picking one of the synced models works in the real client
// against the real Worker — and it must do that with no network call and no
// key. `MODEL_SCRIPTED=1` already does the equivalent for a *run*; this does it
// for *verification and catalog sync*, which is the one part of the OpenRouter
// path `MODEL_SCRIPTED` does not cover.
//
// Three guards, and all three are the point:
//
//   1. It is refused unless `ENVIRONMENT=development`. A staging or production
//      Worker has no branch that can reach it.
//   2. It is opt-in per deployment through `OPENROUTER_FIXTURE=1`, which is a
//      var and not a secret, and which `wrangler.jsonc` sets nowhere.
//   3. It serves a fixed six-model fixture and nothing else. It cannot be made
//      to return a caller-supplied body, so it is not a way to write arbitrary
//      catalog rows.
//
// Documented in README under "OpenRouter" so nobody discovers it by grep.
import type { Env } from '../env.js';
import type { FetchLike } from './types.js';

/**
 * Six models, chosen to exercise every branch of `normaliseModels`: with and
 * without tools, with and without reasoning, an image-only endpoint that must
 * be skipped, and one whose price does not parse.
 */
export const OPENROUTER_FIXTURE_MODELS = {
  data: [
    {
      id: 'anthropic/claude-sonnet-4.6',
      name: 'Anthropic: Claude Sonnet 4.6',
      context_length: 200_000,
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
      supported_parameters: ['tools', 'tool_choice', 'reasoning', 'max_tokens'],
    },
    {
      id: 'openai/gpt-5.5',
      name: 'OpenAI: GPT-5.5',
      context_length: 400_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.00000125', completion: '0.00001' },
      supported_parameters: ['tools', 'tool_choice', 'reasoning'],
    },
    {
      id: 'google/gemini-3-flash',
      name: 'Google: Gemini 3 Flash',
      context_length: 1_000_000,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.0000001', completion: '0.0000004' },
      supported_parameters: ['tools', 'max_tokens'],
    },
    {
      id: 'meta-llama/llama-4-70b-instruct',
      name: 'Meta: Llama 4 70B Instruct',
      context_length: 131_072,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { prompt: '0.00000027', completion: '0.00000085' },
      // No `tools`: listed, and greyed with a reason.
      supported_parameters: ['max_tokens', 'temperature'],
    },
    {
      id: 'black-forest-labs/flux-2',
      name: 'Black Forest Labs: FLUX.2',
      context_length: 4096,
      architecture: { input_modalities: ['text'], output_modalities: ['image'] },
      pricing: { prompt: '0.00001', completion: '0' },
      supported_parameters: [],
    },
    {
      id: 'broken/no-price',
      name: 'Broken: no price',
      context_length: 8192,
      architecture: { input_modalities: ['text'], output_modalities: ['text'] },
      pricing: { completion: '0.000001' },
      supported_parameters: ['tools'],
    },
  ],
} as const;

export function openRouterFixtureEnabled(env: Pick<Env, 'ENVIRONMENT'> & { OPENROUTER_FIXTURE?: string }): boolean {
  return env.ENVIRONMENT === 'development' && env.OPENROUTER_FIXTURE === '1';
}

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/**
 * A `fetch` that answers the two OpenRouter endpoints verification touches and
 * refuses everything else, so a run that reached for this by accident fails
 * loudly instead of answering fiction.
 */
export const openRouterFixtureFetch: FetchLike = async (input) => {
  const url = typeof input === 'string' ? input : String(input);
  if (url.endsWith('/key')) {
    return ok({ data: { label: 'development fixture', usage: 0, limit: null, is_free_tier: false } });
  }
  if (url.endsWith('/models')) return ok(OPENROUTER_FIXTURE_MODELS);
  return new Response('not available in the fixture seam', { status: 501 });
};
