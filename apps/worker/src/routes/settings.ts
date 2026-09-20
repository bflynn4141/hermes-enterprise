// Settings: the workspace's own knobs, the data-and-privacy page, and the one
// route in this product with no undo.
//
//   GET    /w/:ws/settings                      any member
//   PATCH  /w/:ws/settings                      Admin for the workspace half,
//                                               anyone for their own notifications
//   GET    /w/:ws/settings/data-privacy         any member
//   PATCH  /w/:ws/provider-keys/:id/attestation Admin + step-up
//   DELETE /w/:ws                               Admin + step-up
//   POST   /w/:ws/settings/undelete             Admin + step-up
//
// Two rules shape the whole file.
//
// **The workspace half and the personal half are one route and two
// authorisations.** A Member editing "email me when the agent is blocked" and
// an Admin editing `daily_token_cap` are the same screen and emphatically not
// the same permission. Splitting them into two routes would mean the client
// deciding which to call, which is the client deciding what a Member may
// change. So one PATCH takes both shapes, and the Admin check is applied to the
// fields that need it — a body carrying only `notifications` never reaches it.
//
// **A cap that cannot be read is a cap that gets blamed.** Every refusal the
// caps produce (`daily_token_cap`, `max_concurrent_runs`, the platform instance
// cap) names a number, and every one of those numbers is on this route. The one
// exception is the platform cap, which is ours and is reported as a boolean
// rather than a number, because telling a tenant our fleet ceiling tells them
// how to reach it.
import { DEFAULT_EFFORT, DEFAULT_MODEL_ID } from '@hermes/shared';
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import type { Tx } from '../db/client.js';
import { enqueueJob, publishEvents } from '../jobs.js';
import { loadCatalog } from '../model/catalog.js';
import { allowedProviders, requireAllowedProvider } from '../model/allowed.js';
import { checkCaps } from '../model/usage.js';
import { DELETION_SLEEP_DAYS } from '../workflows-long/workspace-deletion.js';
import { workspaceDeletionInstanceId } from '../workflows-long/index.js';
import { logEvent } from '../keys/redact.js';
import { RouteError, inWorkspace, jsonBody, pathUuid, type TenantWork } from './tenant.js';

// ---------------------------------------------------------------------------
// The copy this route is the source of truth for
// ---------------------------------------------------------------------------

/**
 * The DeepSeek warning, fixed and non-dismissible.
 *
 * Plan section 7, Data protection gate: "DeepSeek keys carry a fixed
 * PRC-storage warning (**verified**, cdn.deepseek.com privacy policy)." It is a
 * server constant rather than client copy for the same reason the usage
 * disclaimer is: a client that forgot to render it would be a client that let
 * someone paste an applicant's file into a jurisdiction they did not choose.
 */
export const DEEPSEEK_WARNING =
  'DeepSeek stores data on servers in the People’s Republic of China. Its privacy policy is explicit ' +
  'about this. Do not send real applicant data, or any other personal data you do not have a lawful basis ' +
  'to transfer there, on a DeepSeek key. Use synthetic or consented data, or a provider whose Admin has ' +
  'recorded a zero-retention attestation.';

/**
 * Erasure timing. Plan section 6: "Settings > Data and privacy says erasure
 * completes only after Neon's 7-day window and the 30-day backup rule have
 * passed."
 *
 * The honest version, not the comfortable one. "Deleted immediately" would be
 * false: the row is tombstoned at once and the bytes survive in a point-in-time
 * window and a nightly dump, and a data subject told otherwise has been
 * misinformed by us rather than by a vendor.
 */
export const ERASURE_TIMING = {
  tombstone: 'immediate',
  /** Neon's Launch-plan history window. */
  point_in_time_history_days: 7,
  /** The nightly `pg_dump` to R2 and its bucket lifecycle rule. */
  backup_retention_days: 30,
  /** The honest headline: the later of the two. */
  complete_after_days: 30,
  copy:
    'Erasure tombstones the rows immediately: the person’s text is gone from the product the moment you ' +
    'ask, and the audit trail keeps only ids. The bytes take longer to disappear from the places that exist ' +
    'so that we can recover from a failure. Point-in-time database history holds them for 7 days and the ' +
    'nightly backup for 30, both on fixed expiry rules nobody here can shorten for one record. Erasure is ' +
    'therefore complete 30 days after you ask, and we will not tell you otherwise.',
} as const;

/** What the Workflows-state row of the inventory says. Plan section 6. */
export const RETENTION_FACTS = [
  { store: 'Requests, notes and documents', retention: 'until tombstoned', erasure: 'redact_subject' },
  { store: 'Turns, messages and stream events', retention: '90 days', erasure: 'redact_subject plus subject_key search' },
  { store: 'Uploads, extracted text and rendered documents', retention: 'until deleted', erasure: 'deleted by row' },
  { store: 'Nightly backup copy', retention: '30 days', erasure: 'expires on the bucket lifecycle rule' },
  { store: 'Workflow instance state', retention: '30 days after completion', erasure: 'ids only, by rule' },
  { store: 'Database point-in-time history', retention: '7 days', erasure: 'expires' },
  { store: 'Logs and error tracking', retention: '7 and 30 days', erasure: 'ids only; redaction tested' },
  { store: 'Identity provider (WorkOS)', retention: 'authentication data only', erasure: 'account deletion' },
] as const;

const hasAttestation = (attestation: Record<string, unknown> | null): boolean =>
  typeof attestation?.kind === 'string' && attestation.kind.length > 0;

/** Only a recorded ZDR or DPA permits real personal data. `synthetic_only`
 * and `none` are explicit restrictions, not weaker approvals. */
const allowsRealData = (attestation: Record<string, unknown> | null): boolean =>
  attestation?.kind === 'zdr' || attestation?.kind === 'dpa';

// ---------------------------------------------------------------------------
// GET /w/:ws/settings
// ---------------------------------------------------------------------------

interface SettingsRow {
  default_model_id: string;
  default_effort: string | null;
  default_runtime: string;
  daily_token_cap: string | null;
  max_concurrent_runs: number;
  flags: Record<string, unknown>;
  timezone: string;
}

const DEFAULTS: SettingsRow = {
  default_model_id: DEFAULT_MODEL_ID,
  default_effort: DEFAULT_EFFORT,
  default_runtime: 'cloud',
  daily_token_cap: null,
  max_concurrent_runs: 3,
  flags: {},
  timezone: 'UTC',
};

async function readSettings(tx: Tx, workspaceId: string): Promise<SettingsRow> {
  const { rows } = await tx.query<SettingsRow>(
    `SELECT default_model_id, default_effort, default_runtime,
            daily_token_cap::text AS daily_token_cap, max_concurrent_runs, flags, timezone
       FROM workspace_settings WHERE workspace_id = $1`,
    [workspaceId],
  );
  return rows[0] ?? DEFAULTS;
}

interface NotificationRow {
  approvals: boolean;
  blocked: boolean;
  digest: boolean;
}

async function readNotifications(tx: Tx, workspaceId: string, userId: string): Promise<NotificationRow> {
  const { rows } = await tx.query<NotificationRow>(
    `SELECT approvals, blocked, digest FROM user_notification_settings
      WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  // The schema's defaults, repeated here rather than inserted on read: a GET
  // that wrote a row would make "has this person ever changed a preference"
  // unanswerable, and that is the question a digest opt-in needs.
  return rows[0] ?? { approvals: true, blocked: true, digest: false };
}

/** The allowlist of hosts the `fetch_url` tool may reach. Decision E2. */
function readAllowlist(flags: Record<string, unknown>): string[] {
  const raw = flags.fetch_url_allowlist;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string');
}

function settingsView(
  workspaceId: string,
  settings: SettingsRow,
  notifications: NotificationRow,
  caps: Awaited<ReturnType<typeof checkCaps>>,
  deletion: { requested_at: string | null; scheduled_at: string | null },
  role: string,
): Record<string, unknown> {
  const admin = role === 'admin';
  return {
    workspace_id: workspaceId,
    role,
    defaults: {
      model_id: settings.default_model_id,
      effort: settings.default_effort,
      runtime: settings.default_runtime,
    },
    caps: {
      daily_token_cap: settings.daily_token_cap === null ? null : Number(settings.daily_token_cap),
      max_concurrent_runs: settings.max_concurrent_runs,
      tokens_today: caps.tokensToday,
      active_runs: caps.activeRuns,
      warn: caps.warn,
    },
    timezone: settings.timezone,
    // Defaults and caps are part of ordinary run behavior, and notifications
    // belong to the current user. Feature flags, the network allowlist and a
    // pending workspace deletion are administrative configuration state.
    flags: admin ? settings.flags : {},
    fetch_url_allowlist: admin ? readAllowlist(settings.flags) : [],
    notifications,
    deletion: admin ? deletion : { requested_at: null, scheduled_at: null },
  };
}

export async function getSettings(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await inWorkspace(c, async (work) => {
    const [settings, notifications, caps] = await Promise.all([
      readSettings(work.tx, work.workspaceId),
      readNotifications(work.tx, work.workspaceId, work.userId),
      checkCaps(work.tx, work.workspaceId),
    ]);
    const { rows } = await work.tx.query<{ requested: Date | null; scheduled: Date | null }>(
      `SELECT deletion_requested_at AS requested, deletion_scheduled_at AS scheduled
         FROM workspaces WHERE id = $1`,
      [work.workspaceId],
    );
    return settingsView(work.workspaceId, settings, notifications, caps, {
      requested_at: rows[0]?.requested ? rows[0].requested.toISOString() : null,
      scheduled_at: rows[0]?.scheduled ? rows[0].scheduled.toISOString() : null,
    }, work.role);
  });
  return c.json(body);
}

// ---------------------------------------------------------------------------
// PATCH /w/:ws/settings
// ---------------------------------------------------------------------------

interface PatchBody {
  default_model_id?: unknown;
  default_effort?: unknown;
  default_runtime?: unknown;
  daily_token_cap?: unknown;
  max_concurrent_runs?: unknown;
  timezone?: unknown;
  flags?: unknown;
  fetch_url_allowlist?: unknown;
  notifications?: { approvals?: unknown; blocked?: unknown; digest?: unknown };
}

const WORKSPACE_FIELDS = [
  'default_model_id',
  'default_effort',
  'default_runtime',
  'daily_token_cap',
  'max_concurrent_runs',
  'timezone',
  'flags',
  'fetch_url_allowlist',
] as const;

const EFFORTS = ['low', 'medium', 'high', 'max'] as const;
const RUNTIMES = ['cloud', 'local'] as const;

/** A cap of zero is a deliberate stop; a negative one is a typo. */
function readCap(value: unknown): number | null {
  if (value === null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new RouteError('daily_token_cap must be a whole number of tokens, or null', 'bad_cap', 422);
  }
  return n;
}

/**
 * The allowlist, normalised to bare hostnames.
 *
 * Decision E2: the list lives in `workspace_settings.flags` and empty means
 * nothing is reachable, not everything. Entries are lowercased and stripped of
 * scheme and path, because `https://example.com/` and `example.com` are the
 * same intention and an allowlist that treated them differently would quietly
 * allow nothing while looking populated.
 */
function readHosts(value: unknown): string[] {
  if (!Array.isArray(value)) throw new RouteError('fetch_url_allowlist must be a list', 'bad_allowlist', 422);
  const hosts: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!trimmed) continue;
    if (!/^[a-z0-9.-]+$/.test(trimmed) || trimmed.length > 253) {
      throw new RouteError(`${entry} is not a hostname`, 'bad_allowlist', 422);
    }
    if (!hosts.includes(trimmed)) hosts.push(trimmed);
  }
  if (hosts.length > 100) throw new RouteError('the allowlist is limited to 100 hosts', 'bad_allowlist', 422);
  return hosts;
}

async function applyWorkspaceFields(env: Env, work: TenantWork, body: PatchBody): Promise<string[]> {
  const changed: string[] = [];
  const settings = await readSettings(work.tx, work.workspaceId);
  const next: SettingsRow = { ...settings };

  if ('default_model_id' in body) {
    const modelId = String(body.default_model_id ?? '');
    // Marked rather than filtered, so that a model of a provider this
    // deployment does not offer can be refused with *that* reason rather than
    // with "the catalog does not offer that model", which would send an Admin
    // looking for a row that is right there (decision R12).
    const catalog = await loadCatalog(work.tx, work.workspaceId, allowedProviders(env));
    const row = catalog.find((entry) => entry.model_id === modelId);
    if (row) requireAllowedProvider(env, row.provider);
    if (!row || row.disabled_reason !== null) {
      throw new RouteError('the catalog does not offer that model', 'unknown_model', 422);
    }
    next.default_model_id = modelId;
    changed.push('default_model_id');
  }
  if ('default_effort' in body) {
    const effort = body.default_effort === null ? null : String(body.default_effort ?? '');
    if (effort !== null && !(EFFORTS as readonly string[]).includes(effort)) {
      throw new RouteError('effort must be low, medium, high or max', 'bad_effort', 422);
    }
    next.default_effort = effort;
    changed.push('default_effort');
  }
  if ('default_runtime' in body) {
    const runtime = String(body.default_runtime ?? '');
    if (!(RUNTIMES as readonly string[]).includes(runtime)) {
      throw new RouteError('runtime must be cloud or local', 'bad_runtime', 422);
    }
    next.default_runtime = runtime;
    changed.push('default_runtime');
  }
  if ('daily_token_cap' in body) {
    const cap = readCap(body.daily_token_cap);
    next.daily_token_cap = cap === null ? null : String(cap);
    changed.push('daily_token_cap');
  }
  if ('max_concurrent_runs' in body) {
    const n = Number(body.max_concurrent_runs);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      throw new RouteError('max_concurrent_runs must be between 1 and 50', 'bad_concurrency', 422);
    }
    next.max_concurrent_runs = n;
    changed.push('max_concurrent_runs');
  }
  if ('timezone' in body) {
    const tz = String(body.timezone ?? 'UTC');
    // Validated by asking Postgres, which is the thing that will have to
    // interpret it when the daily cap resets. A list of our own would drift
    // from the database's the first time tzdata moved.
    const { rows } = await work.tx.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS ok`,
      [tz],
    );
    if (!rows[0]?.ok) throw new RouteError('that is not a timezone this database knows', 'bad_timezone', 422);
    next.timezone = tz;
    changed.push('timezone');
  }
  if ('flags' in body) {
    if (typeof body.flags !== 'object' || body.flags === null || Array.isArray(body.flags)) {
      throw new RouteError('flags must be an object', 'bad_flags', 422);
    }
    // Merged, not replaced: two tabs toggling two different flags must not
    // erase each other, and `flags` is the one field several features share.
    next.flags = { ...next.flags, ...(body.flags as Record<string, unknown>) };
    changed.push('flags');
  }
  if ('fetch_url_allowlist' in body) {
    next.flags = { ...next.flags, fetch_url_allowlist: readHosts(body.fetch_url_allowlist) };
    changed.push('fetch_url_allowlist');
  }

  if (changed.length === 0) return changed;

  await work.tx.query(
    `INSERT INTO workspace_settings
       (workspace_id, default_model_id, default_effort, default_runtime,
        daily_token_cap, max_concurrent_runs, flags, timezone)
     VALUES ($1, $2, $3, $4, $5::bigint, $6, $7::jsonb, $8)
     ON CONFLICT (workspace_id) DO UPDATE SET
       default_model_id = EXCLUDED.default_model_id,
       default_effort = EXCLUDED.default_effort,
       default_runtime = EXCLUDED.default_runtime,
       daily_token_cap = EXCLUDED.daily_token_cap,
       max_concurrent_runs = EXCLUDED.max_concurrent_runs,
       flags = EXCLUDED.flags,
       timezone = EXCLUDED.timezone,
       updated_at = now()`,
    [
      work.workspaceId,
      next.default_model_id,
      next.default_effort,
      next.default_runtime,
      next.daily_token_cap,
      next.max_concurrent_runs,
      JSON.stringify(next.flags),
      next.timezone,
    ],
  );
  return changed;
}

async function applyNotifications(work: TenantWork, input: PatchBody['notifications']): Promise<boolean> {
  if (!input) return false;
  const current = await readNotifications(work.tx, work.workspaceId, work.userId);
  const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
  const next = {
    approvals: bool(input.approvals, current.approvals),
    blocked: bool(input.blocked, current.blocked),
    digest: bool(input.digest, current.digest),
  };
  await work.tx.query(
    `INSERT INTO user_notification_settings (workspace_id, user_id, approvals, blocked, digest, previous)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET
       approvals = EXCLUDED.approvals, blocked = EXCLUDED.blocked, digest = EXCLUDED.digest,
       previous = EXCLUDED.previous, updated_at = now()`,
    [work.workspaceId, work.userId, next.approvals, next.blocked, next.digest, JSON.stringify(current)],
  );
  return true;
}

/**
 * Every key this route understands. `notifications` is the personal half;
 * WORKSPACE_FIELDS is the Admin half.
 */
const KNOWN_FIELDS: readonly string[] = [...WORKSPACE_FIELDS, 'notifications'];

/**
 * A key nothing stores is a typo, not a preference.
 *
 * The PATCH used to accept any object and quietly store the parts it
 * recognised: `{ notify_approvals: true }` and `{ reduce_motion: true }` both
 * matched no field, took no Admin check, wrote no audit row and answered 200
 * with a settings view that did not contain them (client findings 12 and 13).
 * Two real client bugs lived behind that for a milestone each, and the next one
 * would have too. 422 with the offending names is the answer that makes a
 * misspelled field a test failure on the day it is written rather than a
 * support question a year later.
 */
function refuseUnknownFields(body: unknown): void {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new RouteError('the settings patch must be an object', 'bad_body', 422);
  }
  const unknown = Object.keys(body).filter((key) => !KNOWN_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw new RouteError(
      `this workspace has no setting called ${unknown.slice(0, 10).join(', ')}`,
      'unknown_fields',
      422,
    );
  }
}

export async function patchSettings(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const body = await jsonBody<PatchBody>(c);
  refuseUnknownFields(body);

  const result = await inWorkspace(c, async (work) => {
    const touchesWorkspace = WORKSPACE_FIELDS.some((field) => field in body);
    // The Admin check is applied to the fields that need it, not to the route:
    // a Member changing only their own notification preferences never reaches
    // it. See the header.
    if (touchesWorkspace) work.requireAdmin('changing workspace settings');

    const changed = touchesWorkspace ? await applyWorkspaceFields(c.env, work, body) : [];
    const notificationsChanged = await applyNotifications(work, body.notifications);

    if (changed.length > 0) {
      // One audit row for the workspace half. The personal half is not audited:
      // an audit trail of who muted their own email is surveillance, not audit.
      await work.tx.query(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind) VALUES ($1, 'user', $2, 'settings.changed')`,
        [work.workspaceId, work.userId],
      );
      work.jobs.push(
        ...(await publishEvents(work.tx, work.workspaceId, [
          {
            kind: 'entity.updated',
            payload: { entity: 'workspace_settings', id: work.workspaceId, reason: 'settings_changed' },
          },
        ])),
      );
    }

    const [settings, notifications, caps] = await Promise.all([
      readSettings(work.tx, work.workspaceId),
      readNotifications(work.tx, work.workspaceId, work.userId),
      checkCaps(work.tx, work.workspaceId),
    ]);
    logEvent({
      at: 'settings.patch',
      workspace_id: work.workspaceId,
      changed,
      notifications: notificationsChanged,
    });
    return settingsView(work.workspaceId, settings, notifications, caps, {
      requested_at: null,
      scheduled_at: null,
    }, work.role);
  });

  return c.json(result);
}

// ---------------------------------------------------------------------------
// GET /w/:ws/settings/data-privacy
// ---------------------------------------------------------------------------

/**
 * What this workspace's own keys mean for the data it processes.
 *
 * Per key, three facts and no fourth: the provider, whether an Admin has
 * recorded an attestation, and the warning that provider carries whatever the
 * attestation says. The DeepSeek warning is not suppressed by an attestation,
 * because an attestation is a statement about retention and the warning is a
 * statement about jurisdiction, and one does not answer the other.
 */
export async function getDataPrivacy(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await inWorkspace(c, async (work) => {
    const { rows } = await work.tx.query<{
      id: string;
      provider: string;
      label: string;
      last4: string;
      status: string;
      attestation: Record<string, unknown> | null;
      verified_at: Date | null;
    }>(
      `SELECT id, provider, label, last4, status, attestation, verified_at
         FROM workspace_provider_keys
        WHERE workspace_id = $1 AND revoked_at IS NULL
        ORDER BY created_at`,
      [work.workspaceId],
    );

    const keys = work.role === 'admin'
      ? rows.map((row) => ({
          key_id: row.id,
          provider: row.provider,
          label: row.label,
          last4: row.last4,
          status: row.status,
          verified_at: row.verified_at ? row.verified_at.toISOString() : null,
          attestation: row.attestation ?? null,
          /** True when an Admin has recorded ZDR or a DPA against this key. */
          attested: hasAttestation(row.attestation),
          warnings: row.provider === 'deepseek' ? [DEEPSEEK_WARNING] : [],
          /** Plan section 7: real applicant data needs an attestation or synthetic data. */
          real_data_allowed:
            row.provider !== 'deepseek' && allowsRealData(row.attestation),
        }))
      // A member sees processor policy rather than credential inventory: one
      // row per provider, an ephemeral presentation id, and no key label,
      // fingerprint, health, verification time, count or attestation text.
      : [...new Map(rows.map((row) => [row.provider, row.provider])).values()].map((provider) => {
          const providerRows = rows.filter((row) => row.provider === provider);
          const attested = providerRows.some((row) => hasAttestation(row.attestation));
          const allKeysAllowRealData = providerRows.length > 0
            && providerRows.every((row) => allowsRealData(row.attestation));
          return {
            key_id: crypto.randomUUID(),
            provider,
            label: provider,
            last4: '',
            status: 'configured',
            verified_at: null,
            attestation: null,
            attested,
            warnings: provider === 'deepseek' ? [DEEPSEEK_WARNING] : [],
            real_data_allowed: provider !== 'deepseek' && allKeysAllowRealData,
          };
        });

    return {
      keys,
      retention: RETENTION_FACTS,
      erasure: ERASURE_TIMING,
      /** Where personal data sits when it is not ours. Plan section 7. */
      residency: {
        identity_provider: 'WorkOS, United States, under Standard Contractual Clauses',
        database: 'the region this workspace’s Neon project was created in',
        objects: 'the R2 bucket jurisdiction, set at creation and unchangeable',
        processing:
          'Workers and Workflow steps run wherever the request lands. Workflow state, queues and logs have ' +
          'no documented jurisdiction control; the pilot data-processing agreement states this.',
      },
    };
  });
  return c.json(body);
}

// ---------------------------------------------------------------------------
// PATCH /w/:ws/provider-keys/:id/attestation
// ---------------------------------------------------------------------------

/** What an Admin may claim. Anything else is refused rather than stored. */
export const ATTESTATION_KINDS = ['zdr', 'dpa', 'synthetic_only', 'none'] as const;

interface AttestationBody {
  kind?: unknown;
  reference?: unknown;
  note?: unknown;
}

/**
 * Record an attestation against one key.
 *
 * Admin plus step-up, the same guard as adding the key, and for a stronger
 * reason: this is the row the M5 data-protection gate reads. Whoever writes it
 * is asserting to a future auditor that a zero-retention arrangement or a DPA
 * exists, and an unattended laptop should not be able to make that assertion.
 *
 * The row records *who* and *when* alongside the claim, because an attestation
 * with no author is a claim nobody made.
 */
export async function patchAttestation(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const keyId = pathUuid(c, 'id');
  const body = await jsonBody<AttestationBody>(c);
  const kind = String(body.kind ?? '');
  if (!(ATTESTATION_KINDS as readonly string[]).includes(kind)) {
    throw new RouteError(
      `attestation kind must be one of ${ATTESTATION_KINDS.join(', ')}`,
      'bad_attestation',
      422,
    );
  }
  const reference = typeof body.reference === 'string' ? body.reference.trim().slice(0, 200) : '';
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : '';

  const view = await inWorkspace(c, async (work) => {
    work.requireAdmin('recording an attestation');
    requireStepUp(work.session);

    const attestation = {
      kind,
      reference,
      note,
      recorded_by: work.userId,
      recorded_at: new Date().toISOString(),
    };
    const { rows } = await work.tx.query<{ id: string; provider: string }>(
      `UPDATE workspace_provider_keys
          SET attestation = $3::jsonb, updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL
        RETURNING id, provider`,
      [work.workspaceId, keyId, JSON.stringify(attestation)],
    );
    const row = rows[0];
    if (!row) throw new RouteError('no such key', 'unknown_key', 404);

    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, key_id)
       VALUES ($1, 'user', $2, 'provider_key.attested', $3)`,
      [work.workspaceId, work.userId, keyId],
    );

    return {
      key_id: row.id,
      provider: row.provider,
      attestation,
      warnings: row.provider === 'deepseek' ? [DEEPSEEK_WARNING] : [],
    };
  });
  return c.json(view);
}

// ---------------------------------------------------------------------------
// DELETE /w/:ws
// ---------------------------------------------------------------------------

/**
 * Schedule this workspace's deletion.
 *
 * The immediate half and the scheduled half are separated on purpose. What
 * happens now: every share revoked, every session read-only, every working run
 * asked to stop, every member evicted from their sockets, the workspace marked.
 * What happens in seven days: the WorkOS organization, the rows and the objects,
 * in that order, inside `WorkspaceDeletion`.
 *
 * Access is revoked *now* because the two reasons someone deletes a workspace
 * are "we are done" and "someone got in", and the second one cannot wait a
 * week. Destruction waits seven days because it is the operation with no undo.
 *
 * The Workflow is created after the transaction commits, and its id is derived
 * from the workspace id, so a re-POST creates nothing: `create()` throws on a
 * duplicate id, which is treated as a no-op exactly as the turns route does.
 */
export async function deleteWorkspace(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);

  const outcome = await inWorkspace(c, async (work) => {
    work.requireAdmin('deleting a workspace');
    requireStepUp(work.session);

    const existing = await work.tx.query<{ requested: Date | null }>(
      `SELECT deletion_requested_at AS requested FROM workspaces WHERE id = $1`,
      [work.workspaceId],
    );
    if (existing.rows[0]?.requested) {
      throw new RouteError('this workspace is already scheduled for deletion', 'already_scheduled', 409);
    }

    const instanceId = workspaceDeletionInstanceId(work.workspaceId);
    const marked = await work.tx.query<{ scheduled: Date }>(
      `UPDATE workspaces
          SET deletion_requested_at = now(),
              deletion_requested_by = $2,
              deletion_scheduled_at = now() + make_interval(days => $3::int),
              deletion_instance_id = $4,
              updated_at = now()
        WHERE id = $1
        RETURNING deletion_scheduled_at AS scheduled`,
      [work.workspaceId, work.userId, DELETION_SLEEP_DAYS, instanceId],
    );

    // The immediate half, in the same transaction as the mark.
    await work.tx.query(
      `UPDATE session_shares SET revoked_at = now() WHERE workspace_id = $1 AND revoked_at IS NULL`,
      [work.workspaceId],
    );
    await work.tx.query(`UPDATE sessions SET read_only = true WHERE workspace_id = $1`, [work.workspaceId]);
    await work.tx.query(
      `UPDATE runs SET stop_requested = true WHERE workspace_id = $1 AND status IN ('working', 'waiting')`,
      [work.workspaceId],
    );

    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind)
       VALUES ($1, 'user', $2, 'workspace.deletion_scheduled')`,
      [work.workspaceId, work.userId],
    );

    // One evict job per member: their sockets close now rather than when their
    // ten-minute ticket lapses.
    const members = await work.tx.query<{ user_id: string }>(
      `SELECT user_id FROM members WHERE workspace_id = $1 AND status = 'active'`,
      [work.workspaceId],
    );
    for (const member of members.rows) {
      const jobId = await enqueueJob(
        work.tx,
        work.workspaceId,
        'evict',
        `evict:${work.workspaceId}:${member.user_id}:deletion`,
        { user_id: member.user_id },
      );
      if (jobId) work.jobs.push(jobId);
    }

    return {
      workspace_id: work.workspaceId,
      requested_by: work.userId,
      instance_id: instanceId,
      scheduled_at: (marked.rows[0]?.scheduled ?? new Date()).toISOString(),
      grace_period_days: DELETION_SLEEP_DAYS,
      members_evicted: members.rows.length,
    };
  });

  // After the commit, like every other side effect. A duplicate id means a
  // concurrent request already created it, which is a no-op, not a failure.
  try {
    await c.env.WORKSPACE_DELETION?.create({
      id: outcome.instance_id,
      params: {
        workspaceId: outcome.workspace_id,
        requestedBy: outcome.requested_by,
        requestedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already exists|duplicate|instance.*id/i.test(message)) {
      // The rows are already marked and access is already revoked, so this is
      // logged rather than thrown: telling the Admin their deletion failed when
      // the irreversible-for-them half succeeded would be worse than a
      // reconciliation job. The runbook's orphan sweep covers it.
      logEvent({ at: 'workspace_deletion.create', ok: false, workspace_id: outcome.workspace_id, error: message });
    }
  }

  return c.json({ ...outcome, copy: ERASURE_TIMING.copy }, 202);
}

/**
 * POST /w/:ws/settings/undelete — the cancel, inside the grace period.
 *
 * It exists because a seven-day sleep with no cancel is a seven-day sleep that
 * has to be cancelled by an engineer with production credentials, which is the
 * kind of routine operation that teaches people to keep such credentials handy.
 */
export async function undeleteWorkspace(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);

  const instanceId = await inWorkspace(c, async (work) => {
    work.requireAdmin('cancelling a deletion');
    requireStepUp(work.session);
    const { rows } = await work.tx.query<{ instance: string | null }>(
      `UPDATE workspaces
          SET deletion_requested_at = NULL, deletion_requested_by = NULL,
              deletion_scheduled_at = NULL, updated_at = now()
        WHERE id = $1 AND deletion_requested_at IS NOT NULL
        RETURNING deletion_instance_id AS instance`,
      [work.workspaceId],
    );
    if (rows.length === 0) throw new RouteError('this workspace is not scheduled for deletion', 'not_scheduled', 409);

    // Sessions stay read-only until someone puts them back deliberately: an
    // undelete that silently resumed every run would resume runs that have been
    // stopped for days against a world that moved on.
    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind)
       VALUES ($1, 'user', $2, 'workspace.deletion_cancelled')`,
      [work.workspaceId, work.userId],
    );
    return rows[0]?.instance ?? null;
  });

  // Belt: terminate the instance. Braces: the Workflow re-reads the row after
  // its sleep and stops on its own if this call was lost.
  if (instanceId) {
    try {
      const instance = await c.env.WORKSPACE_DELETION?.get(instanceId);
      await instance?.terminate();
    } catch (error) {
      logEvent({ at: 'workspace_deletion.terminate', ok: false, error: String(error) });
    }
  }

  return c.json({ cancelled: true });
}
