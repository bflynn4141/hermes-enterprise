// The provider-key and catalog contract.
//
// Additive to the M1 contract: this file only adds shapes, it changes none.
// Everything here is *masked* by construction. There is no schema in this
// repository that carries a provider key's plaintext, which is deliberate: a
// shape that cannot express the secret cannot accidentally serialise it.
import { z } from 'zod';
import { PROVIDERS, catalogRowSchema } from './catalog.js';

/**
 * A key's lifecycle.
 *
 *   unverified       stored, but the provider has not confirmed it works. The
 *                    probe was throttled (429), forbidden (403) or failed
 *                    (5xx); a `reverify` job will try again.
 *   verified         the provider's list-models endpoint answered 200.
 *   verified_scoped  a scoped key: list-models is forbidden to it, so a
 *                    1-token messages probe was used instead. Rendered as
 *                    "verified (scoped)".
 *   invalid          the provider answered 401. Runs on this provider stop.
 *   revoked          rotated away or removed. The ciphertext is zeroed.
 */
export const KEY_STATUSES = ['unverified', 'verified', 'verified_scoped', 'invalid', 'revoked'] as const;
export type KeyStatus = (typeof KEY_STATUSES)[number];

/** The statuses that let a catalog row be offered and a run be created. */
export const USABLE_KEY_STATUSES = ['verified', 'verified_scoped'] as const satisfies readonly KeyStatus[];

/**
 * What `GET /w/:ws/provider-keys` returns, and the only shape the client ever
 * sees. `fingerprint_prefix` is the first 12 hex characters of the SHA-256 of
 * the key: enough for an Admin to tell two keys apart and to match one against
 * a provider dashboard, not enough to attack the key.
 */
export const maskedProviderKeySchema = z
  .object({
    id: z.uuid(),
    provider: z.enum(PROVIDERS),
    label: z.string().max(80),
    last4: z.string().length(4),
    fingerprint_prefix: z.string().length(12),
    status: z.enum(KEY_STATUSES),
    verified_models: z.array(z.string().max(128)),
    /**
     * Brokered model gateways list hundreds of models, so the key row carries a count and a
     * timestamp instead of the list (decision R7). Null for every provider
     * whose `verified_models` is the whole answer.
     */
    synced_model_count: z.number().int().nonnegative().nullable().default(null),
    models_synced_at: z.iso.datetime().nullable().default(null),
    added_by: z.uuid().nullable(),
    created_at: z.iso.datetime(),
    verified_at: z.iso.datetime().nullable(),
    rotated_at: z.iso.datetime().nullable(),
    revoked_at: z.iso.datetime().nullable(),
    replaces_key_id: z.uuid().nullable(),
  })
  .strict();
export type MaskedProviderKey = z.infer<typeof maskedProviderKeySchema>;

export const providerKeyListSchema = z.object({ keys: z.array(maskedProviderKeySchema) }).strict();

/**
 * Why a catalog row is not offered, as a code the client keys its copy off.
 * The prose in `disabled_reason` is for a human; a string comparison on prose
 * is not a contract.
 */
export const DISABLED_CODES = [
  'catalog',
  'no_key',
  'key_unverified',
  'key_invalid',
  /**
   * The row's provider is not in this deployment's `ALLOWED_PROVIDERS`
   * (decision R12). Different from `catalog`: the row is fine and the key would
   * work, the platform does not offer the provider. The catalog route drops
   * these rows rather than listing them, so the code is what the *server* keys
   * its own refusals off — the settings and session routes both read it.
   */
  'provider_not_allowed',
] as const;
export type DisabledCode = (typeof DISABLED_CODES)[number];

/**
 * A catalog row as a workspace sees it. `enabled` is computed per workspace:
 * a row is offered iff the catalog does not disable it *and* the workspace
 * holds a usable key for the row's provider.
 */
export const CATALOG_SOURCES = ['seed', 'provider_list'] as const;
export type CatalogSource = (typeof CATALOG_SOURCES)[number];

export const catalogEntrySchema = catalogRowSchema
  .extend({
    enabled: z.boolean(),
    /**
     * Where the row came from. `seed` rows are the four a migration wrote and
     * only a migration changes; `provider_list` rows were synced from a
     * provider's own list endpoint and are rewritten on every sync.
     */
    source: z.enum(CATALOG_SOURCES),
    /** The provider's advertised context window, when it publishes one. */
    context_length: z.number().int().positive().nullable(),
    /**
     * The run engine requires tool calling: a model without it is listed and
     * greyed rather than hidden, so "why is that model missing" has an answer.
     */
    supports_tools: z.boolean(),
    /** Whether the effort control means anything for this row. */
    supports_reasoning: z.boolean(),
    disabled_code: z.enum(DISABLED_CODES).nullable(),
    /** Prose. Either the catalog's own reason or the key-state reason. */
    disabled_reason: z.string().max(200).nullable(),
  })
  .strict();
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

/**
 * One page of the catalog. Paged because a gateway catalog can contain
 * hundreds of rows, and a model menu that downloads all of it on open is
 * the failure the paging exists to prevent.
 */
export const catalogPageSchema = z
  .object({
    models: z.array(catalogEntrySchema),
    /** How many rows matched, before the limit. */
    total: z.number().int().nonnegative().default(0),
    /** The `model_id` to pass as `?after=` for the next page, or null. */
    next_cursor: z.string().max(128).nullable().default(null),
  })
  .strict();
export type CatalogPage = z.infer<typeof catalogPageSchema>;
