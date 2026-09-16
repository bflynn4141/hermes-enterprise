// The Worker's bindings and variables, in one place.
//
// `wrangler types` can generate this, but it is written by hand so that each
// binding can say what it is for: a reader of the Worker should be able to see
// the whole surface the code is allowed to touch without opening the config.
import type { SessionHub, WorkspaceHub } from './hubs.js';

export interface Env {
  // --- Variables (plain text, set per environment in wrangler.jsonc) --------
  /** 'staging' | 'production' | 'development'. */
  ENVIRONMENT: string;
  /** Bumped when a deploy changes existing Workflow step names. */
  ENGINE_VERSION: string;
  /** Official execution plane; unset preserves legacy runs during rollout. */
  AGENT_RUNTIME?: 'hermes' | 'legacy';
  /** Server-only agent -> isolated profile endpoint/credential mapping. */
  HERMES_RUNTIME_AGENTS?: string;
  /** Signs a bridge credential scoped to one workspace and agent. */
  HERMES_BRIDGE_SECRET?: string;
  /**
   * 'fake' reads a seeded user from `x-dev-user`; 'workos' verifies a sealed
   * cookie. M1 ships 'fake' only, behind the same `getSession` interface the
   * WorkOS middleware will implement in M2.
   */
  AUTH_MODE: string;
  /** 'off' | 'passthrough'. Whether model calls go through an AI Gateway. */
  MODEL_GATEWAY_MODE: string;
  /** '1' refuses to create new Workflow instances (engine-version runbook). */
  ENGINE_PAUSED: string;
  /** Comma-separated list; a WebSocket upgrade or command needs a match. */
  ALLOWED_ORIGINS: string;
  /**
   * Comma-separated provider names this deployment offers. The Hermes
   * Enterprise deployment uses `nous_portal` (decision C55). A key, a catalog row, a session model or
   * a run naming anything else is refused with `provider_not_allowed`. Unset
   * means `nous_portal` rather than everything, so a missing variable fails
   * closed; `model/allowed.ts` is the only reader.
   */
  ALLOWED_PROVIDERS?: string;
  /**
   * The platform instance cap: the most Workflow instances this deployment will
   * create in an hour, across every tenant (plan section 5). Unset or
   * unparseable means no cap, which is what local development wants; the value
   * is a plain var rather than a secret because knowing it grants nothing.
   */
  PLATFORM_MAX_INSTANCES_PER_HOUR?: string;
  /**
   * '1' makes the run engine answer from `ScriptedProvider` instead of a real
   * provider, so `wrangler dev --local` can create a run with no key in the
   * store. Refused outside `ENVIRONMENT=development`.
   */
  MODEL_SCRIPTED?: string;
  /**
   * '1' serves OpenRouter's `/key` and `/models` from a built-in fixture rather
   * than the network, so the live scenario can verify a fake key and sync a
   * catalog offline. Refused outside `ENVIRONMENT=development`; see
   * `model/openrouter-dev.ts` and the README's OpenRouter section.
   */
  OPENROUTER_FIXTURE?: string;
  /** Development-only Nous Portal verification and catalog fixture. */
  NOUS_PORTAL_FIXTURE?: string;
  /** Enables the official Nous inference device-authorization flow. */
  NOUS_PORTAL_OAUTH_ENABLED?: string;
  /** Enterprise/public OAuth client id provisioned by Nous for this deployment. */
  NOUS_PORTAL_OAUTH_CLIENT_ID?: string;
  /** Production is pinned to portal.nousresearch.com; tests may override it. */
  NOUS_PORTAL_BASE_URL?: string;
  /**
   * The uploads bucket's *name*, which a presigned URL needs and a binding does
   * not: the binding is resolved by Cloudflare, the URL has to spell the bucket
   * out in its path. Not a secret, so it is a plain var per environment.
   */
  R2_BUCKET: string;

  // --- Secrets (never in the repository; see .dev.vars.example) -------------
  WORKOS_API_KEY?: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_COOKIE_PASSWORD?: string;
  /**
   * Exact expected `iss` in AuthKit user access tokens. Read it from the
   * application's OIDC discovery document. Tests may omit it and use WorkOS's
   * legacy API-origin value; staging and production readiness require it.
   */
  WORKOS_ISSUER?: string;
  /**
   * Overrides the redirect URI sent to AuthKit. Normally the callback is this
   * Worker's own origin plus `/auth/callback`, which is what a single-origin
   * deployment wants; the variable exists for the case where the browser
   * reaches us through a different host than the Worker sees.
   */
  WORKOS_REDIRECT_URI?: string;
  /** Slack app installation and HTTP Events API. All values are server-only. */
  SLACK_ENABLED?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  SLACK_STATE_SECRET?: string;
  SLACK_REDIRECT_URI?: string;
  /**
   * Signs hub tickets. Falls back to WORKOS_COOKIE_PASSWORD, and in
   * development only, to a constant; a deployed environment with neither
   * refuses to mint a ticket rather than signing with a guessable key.
   */
  HUB_TICKET_SECRET?: string;
  /** The current key-encryption key, version 1. Rotations add KEK_V2, etc. */
  KEK_V1?: string;
  /**
   * Which KEK version new material is encrypted under. Unset means the highest
   * one present, so a single-version environment needs nothing. It exists so a
   * rotation is two deploys: add `KEK_V2`, deploy, then set this to 2. Between
   * them an instance holding the new secret but not the new setting still
   * writes v1, which every instance can read.
   */
  KEK_CURRENT?: string;
  SENTRY_DSN?: string;
  /**
   * The S3-compatible credentials that let this Worker mint a presigned URL.
   *
   * The R2 *binding* below is how the Worker reads and writes objects itself;
   * these three are only for handing the browser a URL it can PUT to directly,
   * so that 20 MB of bytes never pass through a Worker request. When they are
   * absent — `wrangler dev --local` with no R2 account — the attachments route
   * falls back to a direct-upload route through the binding and says so in the
   * response (`upload.direct`), which is a development convenience and is
   * refused outside development.
   */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

  // --- Postgres through Hyperdrive -----------------------------------------
  /** The `app` role: every tenant request runs on this one. */
  HYPERDRIVE_APP: Hyperdrive;
  /** The `agent` role: the run engine's steps, with far fewer grants. */
  HYPERDRIVE_AGENT: Hyperdrive;

  // --- Durable Objects: delivery only, never truth --------------------------
  SESSION_HUB: DurableObjectNamespace<SessionHub>;
  WORKSPACE_HUB: DurableObjectNamespace<WorkspaceHub>;

  // --- Workflows ------------------------------------------------------------
  /** One instance per run attempt, id `${run_id}-a${attempt}`. */
  RUN_ATTEMPT: Workflow;
  /**
   * The three long-wait Workflows (M5a). Optional because the Node test project
   * builds an `Env` by hand and because a deployment mid-rollout may not have
   * them yet; every caller guards, and `DELETE /w/:ws` logs rather than throws
   * when the binding is absent, because its immediate half has already
   * committed by then.
   */
  WORKSPACE_DELETION?: Workflow;
  KEK_ROTATION?: Workflow;
  NIGHTLY_VALIDATOR?: Workflow;

  // --- Queues ---------------------------------------------------------------
  EXTRACT_QUEUE: Queue;
  RENDERS_QUEUE: Queue;

  // --- R2 -------------------------------------------------------------------
  /** Uploads, extracted text (`{key}.txt`) and, from M4, rendered documents. */
  UPLOADS: R2Bucket;
  /**
   * The nightly copy's destination. Optional, and deliberately: a development
   * machine has no second bucket, and a `backup_uploads` job that found one
   * missing should log that it did nothing rather than fail forever. Declared
   * in wrangler.jsonc only where the bucket actually exists.
   */
  BACKUP_UPLOADS?: R2Bucket;

  // --- Analytics Engine -----------------------------------------------------
  /**
   * The metrics dataset (plan section 5). Optional and guarded at every call:
   * `wrangler dev --local` and the Node test project have no dataset, and a
   * metric helper that threw there would be observability tooling causing the
   * outage it exists to explain.
   */
  ANALYTICS?: AnalyticsEngineDataset;

  // --- Static assets (the client bundle, with SPA fallback) -----------------
  ASSETS: Fetcher;
}

/** Origins allowed to open a socket or issue a guarded command. */
export function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export const isEnginePaused = (env: Env): boolean => env.ENGINE_PAUSED === '1';

/**
 * Can this environment mint a presigned URL?
 *
 * All three or none: a half-configured environment would sign with a missing
 * secret and hand the browser a URL R2 answers 403 to, which looks like a
 * broken upload rather than a missing secret.
 */
export const canPresign = (env: Env): boolean =>
  Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET);

/** Local development, where the dev-only direct-upload route is allowed. */
export const isDevelopment = (env: Env): boolean =>
  env.ENVIRONMENT === 'development' || env.ENVIRONMENT === 'test';
