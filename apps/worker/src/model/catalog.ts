// The catalog, as one workspace sees it.
//
// Two gates, and they answer different questions:
//
//   `catalog.disabled_reason`   we do not offer this model to anyone yet, and
//                               the row says why. Product policy, one migration
//                               away from changing.
//   the workspace's keys        this workspace cannot reach that provider. Not
//                               policy: an empty state with an action.
//
// Keeping them apart is what lets the model menu say "Add an Anthropic key in
// Settings" for one row and "Not enabled for the pilot" for another, instead of
// showing both as an unexplained absence. `disabled_code` is the machine-
// readable half, because the client keys its copy off a code and never off
// prose.
import { USABLE_KEY_STATUSES, catalogEntrySchema, type CatalogEntry, type DisabledCode } from '@hermes/shared';
import type { Tx } from '../db/client.js';

interface CatalogQueryRow {
  model_id: string;
  provider: string;
  label: string;
  transport: string;
  effort_map: Record<string, string> | null;
  default_effort: string | null;
  pricing_per_million: Record<string, number | null>;
  pricing_verified_on: Date | string;
  disabled_reason: string | null;
  key_status: string | null;
}

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  nous_portal: 'Nous Portal',
};

const providerLabel = (provider: string): string => PROVIDER_LABEL[provider] ?? provider;

/** Postgres `date` comes back as a Date in UTC; the contract wants `YYYY-MM-DD`. */
function isoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

/**
 * Why this row is not offered, given the catalog and the workspace's key.
 *
 * Catalog policy wins: a row the pilot does not offer stays unexplained-by-key
 * even if the workspace has a perfectly good key, because adding a key would
 * not change the answer and saying so would be a lie the user acts on.
 */
function disabledBecause(
  row: CatalogQueryRow,
): { code: DisabledCode; reason: string } | null {
  if (row.disabled_reason !== null) return { code: 'catalog', reason: row.disabled_reason };

  const label = providerLabel(row.provider);
  switch (row.key_status) {
    case null:
      return { code: 'no_key', reason: `Add your ${label} key in Settings to use this model.` };
    case 'unverified':
      return {
        code: 'key_unverified',
        reason: `Your ${label} key has not been verified yet. Verify it in Settings.`,
      };
    case 'invalid':
      return { code: 'key_invalid', reason: `Your ${label} key was rejected. Replace it in Settings.` };
    default:
      return (USABLE_KEY_STATUSES as readonly string[]).includes(row.key_status)
        ? null
        : { code: 'no_key', reason: `Add your ${label} key in Settings to use this model.` };
  }
}

/**
 * Every catalog row, with this workspace's answer attached.
 *
 * One query, not one per row: the key state is joined in, so a workspace with
 * forty models still costs one round trip. The subquery picks the live key
 * (`revoked_at IS NULL`), of which the partial unique index guarantees at most
 * one per provider.
 */
export async function loadCatalog(tx: Tx, workspaceId: string): Promise<CatalogEntry[]> {
  const { rows } = await tx.query<CatalogQueryRow>(
    `SELECT c.model_id, c.provider, c.label, c.transport, c.effort_map, c.default_effort,
            c.pricing_per_million, c.pricing_verified_on, c.disabled_reason,
            (SELECT k.status FROM workspace_provider_keys k
              WHERE k.workspace_id = $1 AND k.provider = c.provider AND k.revoked_at IS NULL
              LIMIT 1) AS key_status
       FROM catalog c
      ORDER BY c.model_id`,
    [workspaceId],
  );

  return rows.map((row) => {
    const disabled = disabledBecause(row);
    return catalogEntrySchema.parse({
      model_id: row.model_id,
      provider: row.provider,
      label: row.label,
      transport: row.transport,
      effort_map: row.effort_map,
      default_effort: row.default_effort,
      pricing_per_million: {
        input: row.pricing_per_million.input ?? 0,
        output: row.pricing_per_million.output ?? 0,
        input_off_peak: row.pricing_per_million.input_off_peak ?? null,
        output_off_peak: row.pricing_per_million.output_off_peak ?? null,
        cached_input: row.pricing_per_million.cached_input ?? null,
      },
      pricing_verified_on: isoDate(row.pricing_verified_on),
      enabled: disabled === null,
      disabled_code: disabled?.code ?? null,
      disabled_reason: disabled?.reason ?? null,
    });
  });
}

/** One row, for the engine: the transport, the effort map and the price. */
export interface CatalogModel {
  readonly model_id: string;
  readonly provider: string;
  readonly transport: string;
  readonly effort_map: Record<string, string> | null;
  readonly default_effort: string | null;
  readonly pricing: {
    input: number;
    output: number;
    input_off_peak: number | null;
    output_off_peak: number | null;
    cached_input: number | null;
  };
}

export async function loadModel(tx: Tx, modelId: string): Promise<CatalogModel | null> {
  const { rows } = await tx.query<CatalogQueryRow>(
    `SELECT model_id, provider, label, transport, effort_map, default_effort,
            pricing_per_million, pricing_verified_on, disabled_reason, NULL AS key_status
       FROM catalog WHERE model_id = $1`,
    [modelId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    model_id: row.model_id,
    provider: row.provider,
    transport: row.transport,
    effort_map: row.effort_map,
    default_effort: row.default_effort,
    pricing: {
      input: row.pricing_per_million.input ?? 0,
      output: row.pricing_per_million.output ?? 0,
      input_off_peak: row.pricing_per_million.input_off_peak ?? null,
      output_off_peak: row.pricing_per_million.output_off_peak ?? null,
      cached_input: row.pricing_per_million.cached_input ?? null,
    },
  };
}

export interface TokenCounts {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_input_tokens: number;
}

/**
 * Our estimate of what a call cost, in USD.
 *
 * Estimate, and the Usage screen says so: the provider does the billing, we
 * only have the token counts they streamed us and a price we wrote down on a
 * date. Cached input is priced at its own rate and subtracted from input, so a
 * cache hit does not get billed twice in our own numbers.
 *
 * Rounded to six decimal places, matching `model_calls.cost_usd_estimate`
 * numeric(12,6): a value the column would round anyway is better rounded here,
 * where the rounding is visible.
 */
export function estimateCostUsd(pricing: CatalogModel['pricing'], tokens: TokenCounts): number {
  const cached = Math.min(tokens.cached_input_tokens, tokens.input_tokens);
  const fresh = tokens.input_tokens - cached;
  const cachedRate = pricing.cached_input ?? pricing.input;
  const dollars =
    (fresh * pricing.input + cached * cachedRate + tokens.output_tokens * pricing.output) / 1_000_000;
  return Math.round(dollars * 1e6) / 1e6;
}
