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

  // --- Secrets (never in the repository; see .dev.vars.example) -------------
  WORKOS_API_KEY?: string;
  WORKOS_CLIENT_ID?: string;
  WORKOS_COOKIE_PASSWORD?: string;
  /** The current key-encryption key, version 1. Rotations add KEK_V2, etc. */
  KEK_V1?: string;
  SENTRY_DSN?: string;

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

  // --- Queues ---------------------------------------------------------------
  EXTRACT_QUEUE: Queue;
  RENDERS_QUEUE: Queue;

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
