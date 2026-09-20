// The M5a response shapes: the settings, usage, data-privacy and workspace
// lifecycle routes the Worker serves and the client had no schema for.
//
// These are written *from the Worker's handlers*, not from the client-port
// spec's sketch, because the handlers are what answers. The one that mattered
// most was usage: `entities.ts` carries a `usageResponseSchema` with
// `{ group, rows, daily_token_cap, tokens_today }` and `GET /w/:ws/usage`
// answers `{ range, totals, by_day, by_session, by_key, caps, disclaimer }`.
// Nothing had ever parsed it against the live route, so every call failed the
// client's own "nothing unvalidated reaches the reducer" rule as
// `contract_violation` and the Usage tab rendered its error state. Decision C25.
//
// Additive: `usageResponseSchema` is untouched and still exported, because
// `mock.ts` produces it and the mock suite parses it. What changed is which
// schema the live REST client uses.
import { z } from 'zod';
import { uuidSchema } from './events.js';

// ---------------------------------------------------------------------------
// GET /w/:ws/usage?range=today|7d|30d|90d   (src/usage/aggregate.ts)
// ---------------------------------------------------------------------------

export const USAGE_RANGES = ['today', '7d', '30d', '90d'] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

const usageTotalsSchema = z
  .object({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    cached_input_tokens: z.number().int().min(0),
    reasoning_tokens: z.number().int().min(0),
    total_tokens: z.number().int().min(0),
    cost_usd_estimate: z.number().nonnegative(),
    calls: z.number().int().min(0),
    errors: z.number().int().min(0),
  })
  .strict();

export const usageDaySchema = z
  .object({
    day: z.string().max(10),
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
    cached_input_tokens: z.number().int().min(0),
    reasoning_tokens: z.number().int().min(0),
    total_tokens: z.number().int().min(0),
    cost_usd_estimate: z.number().nonnegative(),
    calls: z.number().int().min(0),
    errors: z.number().int().min(0),
  })
  .strict();

export const usageSessionSchema = z
  .object({
    session_id: uuidSchema.nullable(),
    title: z.string().max(200).nullable(),
    runs: z.number().int().min(0),
    total_tokens: z.number().int().min(0),
    cost_usd_estimate: z.number().nonnegative(),
    last_call_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();

export const usageKeySchema = z
  .object({
    key_id: uuidSchema.nullable(),
    provider: z.string().max(40).nullable(),
    label: z.string().max(200).nullable(),
    last4: z.string().max(8).nullable(),
    status: z.string().max(32).nullable(),
    total_tokens: z.number().int().min(0),
    cost_usd_estimate: z.number().nonnegative(),
    calls: z.number().int().min(0),
  })
  .strict();

export const usageCapsSchema = z
  .object({
    daily_token_cap: z.number().int().min(0).nullable(),
    tokens_today: z.number().int().min(0),
    fraction_used: z.number().nullable(),
    warn: z.boolean(),
    max_concurrent_runs: z.number().int().min(0),
    active_runs: z.number().int().min(0),
  })
  .strict();

export const usageReportSchema = z
  .object({
    range: z.enum(USAGE_RANGES),
    timezone: z.string().max(64),
    from: z.iso.datetime({ offset: true }),
    to: z.iso.datetime({ offset: true }),
    /**
     * The sentence the server writes and the client is required to render
     * beside the total rather than in a footnote (`ESTIMATE_DISCLAIMER`).
     */
    disclaimer: z.string().max(400),
    totals: usageTotalsSchema,
    by_day: z.array(usageDaySchema).max(400),
    by_session: z.array(usageSessionSchema).max(200),
    by_key: z.array(usageKeySchema).max(200),
    caps: usageCapsSchema,
  })
  .strict();
export type UsageReport = z.infer<typeof usageReportSchema>;

// ---------------------------------------------------------------------------
// GET|PATCH /w/:ws/settings   (routes/settings.ts `settingsView`)
// ---------------------------------------------------------------------------

export const notificationSettingsSchema = z
  .object({ approvals: z.boolean(), blocked: z.boolean(), digest: z.boolean() })
  .strict();
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const settingsViewSchema = z
  .object({
    workspace_id: uuidSchema,
    role: z.string().max(32),
    defaults: z
      .object({ model_id: z.string().max(64), effort: z.string().max(16).nullable(), runtime: z.string().max(16) })
      .strict(),
    caps: z
      .object({
        daily_token_cap: z.number().int().min(0).nullable(),
        max_concurrent_runs: z.number().int().min(0),
        tokens_today: z.number().int().min(0),
        active_runs: z.number().int().min(0),
        warn: z.boolean(),
      })
      .strict(),
    timezone: z.string().max(64),
    flags: z.record(z.string(), z.unknown()),
    fetch_url_allowlist: z.array(z.string().max(200)).max(100),
    notifications: notificationSettingsSchema,
    /** Null on the PATCH answer, which does not re-read the workspace row. */
    deletion: z
      .object({
        requested_at: z.iso.datetime({ offset: true }).nullable(),
        scheduled_at: z.iso.datetime({ offset: true }).nullable(),
      })
      .strict(),
  })
  .strict();
export type SettingsView = z.infer<typeof settingsViewSchema>;

// ---------------------------------------------------------------------------
// GET /w/:ws/settings/data-privacy
// ---------------------------------------------------------------------------

export const ATTESTATION_KINDS = ['zdr', 'dpa', 'synthetic_only', 'none'] as const;
export type AttestationKind = (typeof ATTESTATION_KINDS)[number];

/** Free-form on the wire: the row is whatever an Admin recorded, plus who. */
export const attestationSchema = z
  .object({
    kind: z.string().max(32),
    reference: z.string().max(200).optional(),
    note: z.string().max(1000).optional(),
    recorded_by: z.string().max(64).optional(),
    recorded_at: z.string().max(40).optional(),
  })
  .loose();

export const privacyKeySchema = z
  .object({
    key_id: uuidSchema,
    provider: z.string().max(40),
    label: z.string().max(200),
    last4: z.string().max(8),
    status: z.string().max(32),
    verified_at: z.iso.datetime({ offset: true }).nullable(),
    attestation: attestationSchema.nullable(),
    attested: z.boolean(),
    /** The provider warnings the server writes; never client copy. */
    warnings: z.array(z.string().max(1000)).max(8),
    real_data_allowed: z.boolean(),
  })
  .strict();

export const retentionFactSchema = z
  .object({ store: z.string().max(120), retention: z.string().max(120), erasure: z.string().max(200) })
  .strict();

export const erasureTimingSchema = z
  .object({
    tombstone: z.string().max(40),
    point_in_time_history_days: z.number().int().min(0),
    backup_retention_days: z.number().int().min(0),
    complete_after_days: z.number().int().min(0),
    copy: z.string().max(2000),
  })
  .strict();

/**
 * Data-use / sharing facts the server owns. The client must render these
 * verbatim — paraphrasing them would be a client making a data-protection
 * claim nobody reviewed.
 */
export const policyFactSchema = z
  .object({
    id: z.string().max(64),
    label: z.string().max(120),
    value: z.string().max(400),
  })
  .strict();
export type PolicyFact = z.infer<typeof policyFactSchema>;

export const dataPrivacySchema = z
  .object({
    /** Server-owned policy statements shown above retention / processors. */
    policy: z.array(policyFactSchema).max(20),
    keys: z.array(privacyKeySchema).max(50),
    retention: z.array(retentionFactSchema).max(40),
    erasure: erasureTimingSchema,
    residency: z
      .object({
        identity_provider: z.string().max(400),
        database: z.string().max(400),
        objects: z.string().max(400),
        processing: z.string().max(800),
      })
      .strict(),
  })
  .strict();
export type DataPrivacy = z.infer<typeof dataPrivacySchema>;

export const attestationResultSchema = z
  .object({
    key_id: uuidSchema,
    provider: z.string().max(40),
    attestation: attestationSchema,
    warnings: z.array(z.string().max(1000)).max(8),
  })
  .strict();

// ---------------------------------------------------------------------------
// DELETE /w/:ws  and  POST /w/:ws/settings/undelete
// ---------------------------------------------------------------------------

export const workspaceDeletionSchema = z
  .object({
    workspace_id: uuidSchema,
    requested_by: uuidSchema,
    instance_id: z.string().max(200),
    scheduled_at: z.iso.datetime({ offset: true }),
    grace_period_days: z.number().int().min(0),
    members_evicted: z.number().int().min(0),
    /** `ERASURE_TIMING.copy`: the honest sentence, written by the server. */
    copy: z.string().max(2000),
  })
  .strict();
export type WorkspaceDeletion = z.infer<typeof workspaceDeletionSchema>;

export const undeleteResultSchema = z.object({ cancelled: z.boolean() }).strict();
