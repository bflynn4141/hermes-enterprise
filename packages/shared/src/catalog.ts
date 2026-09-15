// The model catalog is data, not code.
//
// Vendors change prices and deprecate models faster than we deploy, so every
// row carries `pricing_verified_on` and the Usage screen says "estimated,
// billed by your provider". A row is offered to a workspace only when that
// workspace holds a verified key for the row's provider; `disabled_reason` is
// the second gate, for rows we deliberately do not offer yet.
//
// These constants are the seed for the `catalog` table. The migration inserts
// them; a later price change is a new migration, so the change is reviewable.
import { z } from 'zod';

export const PROVIDERS = ['deepseek', 'anthropic', 'openai', 'nous_portal', 'openrouter'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** How the harness talks to the model, which decides the replay rules. */
export const TRANSPORTS = ['deepseek_chat', 'anthropic_messages', 'openai_responses', 'openrouter_chat'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export const catalogRowSchema = z
  .object({
    // 128 rather than 64: an OpenRouter row is `openrouter:<vendor>/<model>`
    // (decision R1) and the longest ids on the provider list are already past
    // 64 characters with the prefix.
    model_id: z.string().min(1).max(128),
    provider: z.enum(PROVIDERS),
    label: z.string().min(1).max(80),
    transport: z.enum(TRANSPORTS),
    /** Effort names this model accepts, in order. Null means effort is fixed. */
    effort_map: z.record(z.string().max(32), z.string().max(64)).nullable(),
    default_effort: z.string().max(32).nullable(),
    /** USD per million tokens. `input_off_peak` is null unless the vendor has one. */
    pricing_per_million: z
      .object({
        input: z.number().nonnegative(),
        output: z.number().nonnegative(),
        input_off_peak: z.number().nonnegative().nullable(),
        output_off_peak: z.number().nonnegative().nullable(),
        cached_input: z.number().nonnegative().nullable(),
      })
      .strict(),
    pricing_verified_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Non-null keeps the row out of every workspace's model menu. */
    disabled_reason: z.string().max(200).nullable(),
  })
  .strict();

export type CatalogRow = z.infer<typeof catalogRowSchema>;

/**
 * Seed rows. Prices are the figures recorded in the production plan on
 * 2026-09-14 and are treated as illustrative until re-verified against the
 * vendor's own pricing page; `pricing_verified_on` is what makes that visible
 * instead of implied.
 */
export const CATALOG_SEED: readonly CatalogRow[] = [
  {
    model_id: 'deepseek-flash',
    provider: 'deepseek',
    label: 'DeepSeek Flash',
    transport: 'deepseek_chat',
    effort_map: { low: 'low', high: 'high', max: 'max' },
    default_effort: 'high',
    // DeepSeek publishes peak and off-peak prices; both are carried so the
    // estimate does not silently use the wrong one.
    pricing_per_million: { input: 0.28, output: 0.42, input_off_peak: 0.14, output_off_peak: 0.21, cached_input: 0.028 },
    pricing_verified_on: '2026-09-14',
    disabled_reason: null,
  },
  {
    model_id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    transport: 'anthropic_messages',
    effort_map: { low: 'low', medium: 'medium', high: 'high', max: 'max' },
    default_effort: 'high',
    pricing_per_million: { input: 3, output: 15, input_off_peak: null, output_off_peak: null, cached_input: 0.3 },
    pricing_verified_on: '2026-09-14',
    disabled_reason: null,
  },
  {
    model_id: 'claude-opus-4-7',
    provider: 'anthropic',
    label: 'Claude Opus 4.7',
    transport: 'anthropic_messages',
    effort_map: null,
    default_effort: null,
    pricing_per_million: { input: 15, output: 75, input_off_peak: null, output_off_peak: null, cached_input: 1.5 },
    pricing_verified_on: '2026-09-14',
    // Held back from the pilot: the cost per screening run is an order of
    // magnitude above Sonnet and the pilot has a platform spend alarm at $50.
    disabled_reason: 'Not enabled for the pilot: cost per run exceeds the pilot spend budget.',
  },
  {
    model_id: 'gpt-5-5',
    provider: 'openai',
    label: 'GPT-5.5',
    transport: 'openai_responses',
    effort_map: null,
    default_effort: null,
    pricing_per_million: { input: 1.25, output: 10, input_off_peak: null, output_off_peak: null, cached_input: 0.125 },
    pricing_verified_on: '2026-09-14',
    // The encrypted-reasoning replay rule for the Responses transport is only
    // exercised by an engine test in M3; until it passes, the row stays off.
    disabled_reason: 'Awaiting the M3 reasoning-replay engine test for the Responses transport.',
  },
];

export const CATALOG_BY_ID: ReadonlyMap<string, CatalogRow> = new Map(CATALOG_SEED.map((row) => [row.model_id, row]));

/** The pilot default. Cheapest transport, and the first replay rule we prove. */
export const DEFAULT_MODEL_ID = 'deepseek-flash';
export const DEFAULT_EFFORT = 'high';

// ---------------------------------------------------------------------------
// OpenRouter (decision R1)
// ---------------------------------------------------------------------------

/**
 * Catalog ids for OpenRouter rows are the provider's own id behind one prefix:
 * `openrouter:anthropic/claude-sonnet-4.6`.
 *
 * The prefix is not decoration. `catalog.model_id` is a single global primary
 * key across every provider, OpenRouter re-exports ids that other providers
 * also publish (`anthropic/claude-*` today, a bare `gpt-5-5` tomorrow), and
 * `model_calls.model_id` is read months later by someone asking who was billed.
 * A row whose id says which account paid for it answers that without a join.
 *
 * The adapter strips the prefix before it reaches the wire, so nothing outside
 * these two functions has to know the convention.
 */
export const OPENROUTER_PREFIX = 'openrouter:';

export const openRouterCatalogId = (providerModelId: string): string => `${OPENROUTER_PREFIX}${providerModelId}`;

/** The id OpenRouter itself expects, or null when this is not an OpenRouter row. */
export function openRouterModelId(catalogModelId: string): string | null {
  return catalogModelId.startsWith(OPENROUTER_PREFIX) ? catalogModelId.slice(OPENROUTER_PREFIX.length) : null;
}

/**
 * The vendor a row is grouped under in the model menu: the segment before the
 * first slash of the OpenRouter id (`anthropic`, `openai`, `meta-llama`, …).
 * A row with no slash groups under `other`, which is a real case on OpenRouter.
 */
export function vendorPrefix(catalogModelId: string): string {
  const id = openRouterModelId(catalogModelId);
  if (id === null) return 'native';
  const slash = id.indexOf('/');
  return slash === -1 ? 'other' : id.slice(0, slash);
}

/**
 * Our effort names, mapped to the `reasoning.effort` values OpenRouter accepts.
 * Written once here so the adapter, the sync and a test all agree.
 * https://openrouter.ai/docs/use-cases/reasoning-tokens
 */
export const OPENROUTER_EFFORT_MAP: Readonly<Record<string, string>> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
};
export const OPENROUTER_DEFAULT_EFFORT = 'medium';
