// Turning Nous Portal's `GET /v1/models` into catalog rows.
//
// Pure functions first, then the one call that writes. The split is the reason
// the sync is testable from a recorded fixture with no database and no network:
// `normaliseNousModels` is the whole judgement, `syncNousPortalCatalog` is a
// single `SELECT sync_nous_portal_catalog($1, $2)`.
//
// Three judgements live here, and each one is a decision somebody could
// reasonably make differently:
//
//   Price.    Nous Portal quotes USD *per token*, as decimal strings
//             ("0.000003"). The catalog stores USD per million. A model whose
//             price does not parse is skipped rather than defaulted to zero:
//             a free-looking row that is not free is the one error nobody
//             notices until the invoice.
//   Tools.    `supported_parameters` must contain `tools`. The run engine has
//             no path that does not call a tool, so a model without them is
//             synced but greyed, and the menu says why.
//   Effort.   Each model's reasoning metadata supplies its supported efforts
//             and provider default. Never offer a generic `medium` to a model
//             such as DeepSeek V4.1 that only accepts low, high and max.
import {
  NOUS_DEFAULT_EFFORT,
  NOUS_EFFORT_MAP,
  nousCatalogId,
  type CatalogRow,
} from '@hermes/shared';
import type { Tx } from '../db/client.js';

/** One element of the models response, as much of it as we read. */
export interface NousPortalModel {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown } | null;
  top_provider?: { context_length?: unknown } | null;
  pricing?: Record<string, unknown> | null;
  supported_parameters?: unknown;
  reasoning?: { supported_efforts?: unknown; default_effort?: unknown } | null;
}

export interface SyncRow {
  readonly model_id: string;
  readonly label: string;
  readonly effort_map: Record<string, string> | null;
  readonly default_effort: string | null;
  readonly pricing_per_million: CatalogRow['pricing_per_million'];
  readonly context_length: number | null;
  readonly supports_tools: boolean;
  readonly supports_reasoning: boolean;
}

/** A per-token decimal string, as USD per million. Null when unusable. */
export function perMillion(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  // Six decimal places, matching what the cost estimate rounds to anyway.
  return Math.round(parsed * 1_000_000 * 1e6) / 1e6;
}

const asList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function reasoningEfforts(raw: NousPortalModel, supportsReasoning: boolean): Pick<SyncRow, 'effort_map' | 'default_effort'> {
  if (!supportsReasoning) return { effort_map: null, default_effort: null };
  // Older catalogs omit this metadata altogether. An explicit empty or
  // malformed list means there is no safe selectable effort, not permission
  // to invent one from the legacy fallback.
  if (raw.reasoning?.supported_efforts === undefined) {
    return { effort_map: { ...NOUS_EFFORT_MAP }, default_effort: NOUS_DEFAULT_EFFORT };
  }
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const efforts = [...new Set(asList(raw.reasoning.supported_efforts))]
    .filter((value) => /^[a-z][a-z0-9_-]{0,31}$/.test(value))
    .sort((a, b) => {
      const aRank = order.indexOf(a);
      const bRank = order.indexOf(b);
      return (aRank < 0 ? order.length : aRank) - (bRank < 0 ? order.length : bRank) || a.localeCompare(b);
    });
  if (efforts.length === 0) return { effort_map: null, default_effort: null };
  const declared = raw.reasoning.default_effort;
  return {
    effort_map: Object.fromEntries(efforts.map((effort) => [effort, effort])),
    default_effort: typeof declared === 'string' && efforts.includes(declared)
      ? declared
      : efforts.includes(NOUS_DEFAULT_EFFORT) ? NOUS_DEFAULT_EFFORT : efforts[0]!,
  };
}

/**
 * Every model we can offer, as catalog rows.
 *
 * Skipped, quietly and on purpose: a row with no id, a row whose prompt or
 * completion price does not parse, and a row that cannot take text in and
 * produce text out. Skipping is not silence — `syncNousPortalCatalog` returns
 * both counts, and the Settings screen renders the one it wrote.
 */
export function normaliseNousModels(body: unknown): SyncRow[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  const out: SyncRow[] = [];
  const seen = new Set<string>();
  for (const raw of data as NousPortalModel[]) {
    if (typeof raw?.id !== 'string' || raw.id === '') continue;
    const modelId = nousCatalogId(raw.id);
    if (modelId.length > 128 || seen.has(modelId)) continue;

    const input = perMillion(raw.pricing?.['prompt']);
    const output = perMillion(raw.pricing?.['completion']);
    if (input === null || output === null) continue;

    const inputModalities = asList(raw.architecture?.input_modalities);
    const outputModalities = asList(raw.architecture?.output_modalities);
    // An image-only or audio-only endpoint is not something a turn can call.
    if (inputModalities.length > 0 && !inputModalities.includes('text')) continue;
    if (outputModalities.length > 0 && !outputModalities.includes('text')) continue;

    const parameters = asList(raw.supported_parameters);
    const supportsReasoning = parameters.includes('reasoning') || parameters.includes('include_reasoning') || parameters.includes('reasoning_effort');
    const contextRaw = raw.context_length ?? raw.top_provider?.context_length;
    const context = typeof contextRaw === 'number' && Number.isFinite(contextRaw) && contextRaw > 0
      ? Math.floor(contextRaw)
      : null;

    seen.add(modelId);
    out.push({
      model_id: modelId,
      label: typeof raw.name === 'string' && raw.name !== '' ? raw.name.slice(0, 80) : raw.id.slice(0, 80),
      ...reasoningEfforts(raw, supportsReasoning),
      pricing_per_million: {
        input,
        output,
        input_off_peak: null,
        output_off_peak: null,
        // Nous Portal prices a cache read separately when the upstream does.
        cached_input: perMillion(raw.pricing?.['input_cache_read']),
      },
      context_length: context,
      supports_tools: parameters.includes('tools'),
      supports_reasoning: supportsReasoning,
    });
  }
  // Sorted so a sync of the same list writes the same thing in the same order,
  // which is what makes the idempotence test meaningful rather than lucky.
  return out.sort((a, b) => a.model_id.localeCompare(b.model_id));
}

export interface SyncResult {
  /** Rows written (inserted or updated). */
  readonly written: number;
  /** Elements of the response we could not use. */
  readonly skipped: number;
  readonly at: string;
}

/**
 * A provider catalog can shrink, but a 400-row catalog cannot honestly become
 * a five-row catalog in one refresh without stronger evidence than one HTTP
 * response. This catches truncated responses, provider schema drift, and a
 * development fixture accidentally pointed at durable product data.
 */
export const RETIREMENT_BASELINE = 20;
export const RETIREMENT_MINIMUM_RATIO = 0.5;

/**
 * Write the rows.
 *
 * One statement, through the SECURITY DEFINER function 0024 installs: `app` has
 * only SELECT on `catalog`, and the function's body cannot name a provider
 * other than `nous_portal` or touch a row whose `source` is `seed`.
 */
export async function syncNousPortalCatalog(tx: Tx, body: unknown, today: Date = new Date()): Promise<SyncResult> {
  const rows = normaliseNousModels(body);
  const total = Array.isArray((body as { data?: unknown } | null)?.data)
    ? ((body as { data: unknown[] }).data.length)
    : 0;
  const verifiedOn = today.toISOString().slice(0, 10);

  if (rows.length === 0) {
    throw new Error('refusing to replace the Nous Portal catalog with an empty response');
  }

  const { rows: baselines } = await tx.query<{ active: string }>(
    `SELECT count(*)::text AS active
       FROM catalog
      WHERE provider = 'nous_portal'
        AND source = 'provider_list'
        AND disabled_reason IS NULL`,
  );
  const active = Number(baselines[0]?.active ?? 0);
  if (active >= RETIREMENT_BASELINE && rows.length < active * RETIREMENT_MINIMUM_RATIO) {
    throw new Error(`refusing suspicious Nous Portal catalog shrink from ${active} to ${rows.length} models`);
  }

  const { rows: result } = await tx.query<{ written: number }>(
    'SELECT sync_nous_portal_catalog($1::jsonb, $2::date) AS written',
    [JSON.stringify(rows), verifiedOn],
  );
  return {
    written: Number(result[0]?.written ?? 0),
    skipped: Math.max(0, total - rows.length),
    at: today.toISOString(),
  };
}
