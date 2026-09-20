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
import {
  PROVIDER_NOT_ALLOWED_COPY,
  USABLE_KEY_STATUSES,
  catalogEntrySchema,
  type CatalogEntry,
  type DisabledCode,
} from '@hermes/shared';
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
  source: string;
  context_length: number | null;
  supports_tools: boolean;
  supports_reasoning: boolean;
  key_status: string | null;
}

const PROVIDER_LABEL: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  nous_portal: 'Nous Portal',
  openrouter: 'OpenRouter',
};

/** Human-readable provider labels used in refusal and setup copy. */
export const providerLabel = (provider: string): string => PROVIDER_LABEL[provider] ?? provider;

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
  allowed: readonly string[] | undefined,
): { code: DisabledCode; reason: string } | null {
  // First, because it outranks both of the others: a provider this deployment
  // does not offer cannot be reached by adding a key or by changing the row
  // (decision R12). The catalog *route* drops these rows rather than listing
  // them; the code exists because the settings and session routes read it to
  // refuse a model a client asked for by id.
  if (allowed !== undefined && !allowed.includes(row.provider)) {
    return { code: 'provider_not_allowed', reason: PROVIDER_NOT_ALLOWED_COPY };
  }
  if (row.disabled_reason !== null) return { code: 'catalog', reason: row.disabled_reason };

  // Tool calling is not a preference: every run in this product calls a tool,
  // so a model without it would fail on its first step. Refused here rather
  // than in the client so the turns route refuses it too, and coded `catalog`
  // because adding a key would not change the answer.
  if (!row.supports_tools) {
    return { code: 'catalog', reason: 'This model has no tool calling, which every run needs.' };
  }

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
export interface CatalogQuery {
  /** Case-insensitive substring of the id or the label. */
  readonly q?: string | undefined;
  readonly provider?: string | undefined;
  readonly limit?: number | undefined;
  /** Exclusive: the last `model_id` of the previous page. */
  readonly after?: string | undefined;
  /** Only the four seeded rows plus anything in `include`. */
  readonly seedOnly?: boolean | undefined;
  readonly include?: readonly string[] | undefined;
  /**
   * The providers this deployment offers (decision R12). Rows of any other
   * provider are marked `provider_not_allowed`; omit it and nothing is marked,
   * which is what a test asking about key state alone wants.
   */
  readonly allowed?: readonly string[] | undefined;
  /**
   * Drop the rows `allowed` would have marked, rather than listing them. The
   * catalog route sets it: a menu of models nobody can pick is a menu that
   * teaches people to distrust it. Needs `allowed`.
   */
  readonly onlyAllowed?: boolean | undefined;
}

export const CATALOG_PAGE_DEFAULT = 50;
export const CATALOG_PAGE_MAX = 200;

export interface CatalogPageResult {
  readonly models: CatalogEntry[];
  readonly total: number;
  readonly next_cursor: string | null;
}

/**
 * One page of the catalog, with this workspace's answer attached.
 *
 * Paged and searched in SQL rather than in the client. Before OpenRouter the
 * table held four rows and `loadCatalog` returning all of them was the simplest
 * thing that could work; a synced OpenRouter list is three hundred rows per
 * workspace per model-menu open, which is the download the `?q=&provider=&limit=`
 * parameters exist to avoid (decision R8).
 *
 * Still one query: the key state is joined in, so a page costs one round trip
 * no matter how many rows it carries.
 */
export async function loadCatalogPage(
  tx: Tx,
  workspaceId: string,
  query: CatalogQuery = {},
): Promise<CatalogPageResult> {
  const limit = Math.min(Math.max(1, Math.floor(query.limit ?? CATALOG_PAGE_DEFAULT)), CATALOG_PAGE_MAX);

  // The filter's placeholders are numbered from $1 so the count query — which
  // has no workspace in it — can reuse them unchanged. The workspace id is
  // appended last, for the page query only. Passing a parameter a statement
  // never mentions is not harmless: Postgres refuses to infer its type and the
  // whole query fails with 42P18.
  const filterParams: unknown[] = [];
  const where: string[] = [];
  const push = (value: unknown): string => {
    filterParams.push(value);
    return `$${filterParams.length}`;
  };

  if (query.q !== undefined && query.q.trim() !== '') {
    // `position(lower(...))` rather than LIKE: the needle is user text and
    // escaping `%` and `_` in it is one more thing to get wrong.
    const needle = push(query.q.trim().slice(0, 80).toLowerCase());
    where.push(`(position(${needle} in lower(c.model_id)) > 0 OR position(${needle} in lower(c.label)) > 0)`);
  }
  if (query.provider !== undefined && query.provider !== '') {
    where.push(`c.provider = ${push(query.provider)}`);
  }
  if (query.onlyAllowed === true && query.allowed !== undefined) {
    where.push(`c.provider = ANY(${push([...query.allowed])}::text[])`);
  }
  if (query.seedOnly === true) {
    const include = push(query.include ?? []);
    where.push(`(c.source = 'seed' OR c.model_id = ANY(${include}::text[]))`);
  }

  const filter = where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`;
  const { rows: totals } = await tx.query<{ total: string }>(
    `SELECT count(*)::text AS total FROM catalog c ${filter}`,
    filterParams,
  );

  const pageParams = [...filterParams];
  const pageWhere = [...where];
  if (query.after !== undefined && query.after !== '') {
    pageParams.push(query.after);
    pageWhere.push(`c.model_id > $${pageParams.length}`);
  }
  pageParams.push(limit + 1);
  const limitParam = `$${pageParams.length}`;
  pageParams.push(workspaceId);
  const workspaceParam = `$${pageParams.length}`;

  const { rows } = await tx.query<CatalogQueryRow>(
    `SELECT ${CATALOG_COLUMNS},
            (SELECT k.status FROM workspace_provider_keys k
              WHERE k.workspace_id = ${workspaceParam}::uuid AND k.provider = c.provider AND k.revoked_at IS NULL
              LIMIT 1) AS key_status
       FROM catalog c
      ${pageWhere.length === 0 ? '' : `WHERE ${pageWhere.join(' AND ')}`}
      ORDER BY c.model_id
      LIMIT ${limitParam}`,
    pageParams,
  );

  const page = rows.slice(0, limit);
  return {
    models: page.map((row) => toEntry(row, query.allowed)),
    total: Number(totals[0]?.total ?? page.length),
    next_cursor: rows.length > limit ? (page[page.length - 1]?.model_id ?? null) : null,
  };
}

const CATALOG_COLUMNS = `c.model_id, c.provider, c.label, c.transport, c.effort_map, c.default_effort,
            c.pricing_per_million, c.pricing_verified_on, c.disabled_reason,
            c.source, c.context_length, c.supports_tools, c.supports_reasoning`;

function toEntry(row: CatalogQueryRow, allowed: readonly string[] | undefined): CatalogEntry {
  const disabled = disabledBecause(row, allowed);
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
    source: row.source,
    context_length: row.context_length,
    supports_tools: row.supports_tools,
    supports_reasoning: row.supports_reasoning,
  });
}

/** Every row. Still used where the count is known to be small (settings). */
export async function loadCatalog(
  tx: Tx,
  workspaceId: string,
  allowed?: readonly string[],
): Promise<CatalogEntry[]> {
  const { rows } = await tx.query<CatalogQueryRow>(
    `SELECT ${CATALOG_COLUMNS},
            (SELECT k.status FROM workspace_provider_keys k
              WHERE k.workspace_id = $1 AND k.provider = c.provider AND k.revoked_at IS NULL
              LIMIT 1) AS key_status
       FROM catalog c
      ORDER BY c.model_id`,
    [workspaceId],
  );
  // Marked, never filtered: this is the function the settings route validates a
  // default model against, and it has to be able to say *why* a model it was
  // handed cannot be the default (decision R12).
  return rows.map((row) => toEntry(row, allowed));
}

/** One row, for the engine: the transport, the effort map and the price. */
export interface CatalogModel {
  readonly disabled_reason: string | null;
  readonly supports_tools: boolean;
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
            pricing_per_million, pricing_verified_on, disabled_reason,
            source, context_length, supports_tools, supports_reasoning, NULL AS key_status
       FROM catalog WHERE model_id = $1`,
    [modelId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    disabled_reason: row.disabled_reason,
    supports_tools: row.supports_tools,
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
