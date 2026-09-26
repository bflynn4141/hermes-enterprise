// The official-runtime allowlist and scoped bridge credentials. Neither a model
// argument nor a runtime URL may select a different enterprise workspace.
import { RouteError } from '../routes/errors.js';
import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';
import { openSecret, type StoredEnvelope } from '../keys/envelope.js';
import type { HermesReleaseRing } from './client.js';
import { requireDigestBearer, runtimeBearer } from './credentials.js';

export interface RuntimeEnv {
  readonly ENVIRONMENT: string;
  readonly AGENT_RUNTIME?: string;
  readonly HERMES_RUNTIME_AGENTS?: string;
  readonly HERMES_BRIDGE_SECRET?: string;
}
export interface RuntimeBinding {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly profile: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly transport: 'native' | 'dashboard_connector';
  /** Fixed profiles cannot be reassigned. Invitee-pool profiles are claimed once at invitation acceptance. */
  readonly assignment: 'fixed' | 'invitee_pool' | 'provisioned';
  /** Deployment attestation that this profile was launched with the bounded AgentCash MCP. */
  readonly agentCash: boolean;
  /** Capability-attested rollout ring; prevents canary/stable binding swaps. */
  readonly releaseRing: HermesReleaseRing;
  readonly runtimeAuthMode: 'legacy_hmac' | 'token_digest';
  readonly runtimeCredentialDigest: Uint8Array | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const misconfigured = (): never => {
  throw new RouteError('The official Hermes runtime is not configured for this agent.', 'runtime_not_configured', 503);
};
export function runtimeBinding(env: RuntimeEnv, workspaceId: string, agentId: string): RuntimeBinding {
  if (!UUID.test(workspaceId) || !UUID.test(agentId)) throw new RouteError('Invalid runtime path.', 'bad_id', 400);
  if (env.AGENT_RUNTIME !== 'hermes' || !env.HERMES_BRIDGE_SECRET || env.HERMES_BRIDGE_SECRET.length < 32) return misconfigured();
  let bindings: unknown;
  try { bindings = JSON.parse(env.HERMES_RUNTIME_AGENTS ?? ''); } catch { return misconfigured(); }
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return misconfigured();
  const entry = (bindings as Record<string, unknown>)[agentId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return misconfigured();
  const row = entry as Record<string, unknown>;
  if (row.workspace_id !== workspaceId) throw new RouteError('This runtime agent is not bound to this workspace.', 'runtime_binding_mismatch', 403);
  if (typeof row.base_url !== 'string' || typeof row.api_key !== 'string' || !row.api_key.trim()) return misconfigured();
  const transport = row.transport ?? 'native';
  if (transport !== 'native' && transport !== 'dashboard_connector') return misconfigured();
  const assignment = row.assignment ?? 'fixed';
  if (assignment !== 'fixed' && assignment !== 'invitee_pool') return misconfigured();
  if (row.agentcash !== undefined && typeof row.agentcash !== 'boolean') return misconfigured();
  const releaseRing = row.release_ring ?? 'stable';
  if (releaseRing !== 'canary' && releaseRing !== 'stable') return misconfigured();
  let url: URL;
  try { url = new URL(row.base_url); } catch { return misconfigured(); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(env.ENVIRONMENT === 'development' && local && url.protocol === 'http:'))) return misconfigured();
  return {
    workspaceId,
    agentId,
    profile: `agent-${agentId}`,
    baseUrl: url.toString().replace(/\/$/, ''),
    apiKey: row.api_key,
    transport,
    assignment,
    agentCash: row.agentcash === true,
    releaseRing,
    runtimeAuthMode: 'legacy_hmac',
    runtimeCredentialDigest: null,
  };
}
export function runtimeBindings(env: RuntimeEnv): RuntimeBinding[] {
  if (env.AGENT_RUNTIME !== 'hermes') return [];
  let bindings: unknown;
  try { bindings = JSON.parse(env.HERMES_RUNTIME_AGENTS ?? ''); } catch { return misconfigured(); }
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) return misconfigured();
  const rows = Object.entries(bindings as Record<string, unknown>);
  if (rows.length === 0) return misconfigured();
  return rows.map(([agentId, entry]) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return misconfigured();
    const workspaceId = (entry as Record<string, unknown>).workspace_id;
    if (typeof workspaceId !== 'string') return misconfigured();
    return runtimeBinding(env, workspaceId, agentId);
  });
}

/**
 * Exact, deployment-provisioned capacity that invitation acceptance may claim.
 * A pool entry is usable only when the operator explicitly attests that its
 * isolated profile has the bounded AgentCash integration enabled.
 */
export function inviteeRuntimeAgentIds(env: RuntimeEnv, workspaceId: string): string[] {
  if (env.AGENT_RUNTIME !== 'hermes') return [];
  return runtimeBindings(env)
    .filter((binding) => binding.workspaceId === workspaceId
      && binding.assignment === 'invitee_pool'
      && binding.agentCash)
    .map((binding) => binding.agentId)
    .sort();
}
/** Existing sessions show the configured execution location after a rollout.
 * Missing configuration still fails turn admission; it must not hide onboarding
 * or historical conversations merely because a profile has not been provisioned.
 */
export function runtimeLocation(env: RuntimeEnv, workspaceId: string, agentId: string, fallback: 'local' | 'cloud'): 'local' | 'cloud' {
  if (env.AGENT_RUNTIME !== 'hermes') return fallback;
  try {
    const url = new URL(runtimeBinding(env, workspaceId, agentId).baseUrl);
    return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'local' : 'cloud';
  } catch { return fallback; }
}
async function signingKey(env: RuntimeEnv): Promise<CryptoKey> {
  const secret = env.HERMES_BRIDGE_SECRET;
  if (!secret || secret.length < 32) return misconfigured();
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
export async function bridgeToken(env: RuntimeEnv, workspaceId: string, agentId: string): Promise<string> {
  runtimeBinding(env, workspaceId, agentId);
  return provisioningBridgeToken(env, workspaceId, agentId);
}

/** Mint the reverse-bridge token before a new dynamic binding is ready. */
export async function provisioningBridgeToken(env: RuntimeEnv, workspaceId: string, agentId: string): Promise<string> {
  if (!UUID.test(workspaceId) || !UUID.test(agentId)) throw new RouteError('Invalid runtime path.', 'bad_id', 400);
  const bytes = await crypto.subtle.sign('HMAC', await signingKey(env), new TextEncoder().encode(`${workspaceId}:${agentId}`));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function requireBridgeAuth(env: RuntimeEnv, workspaceId: string, agentId: string, authorization: string | null): Promise<RuntimeBinding> {
  const binding = runtimeBinding(env, workspaceId, agentId);
  const token = runtimeBearer(authorization);
  const bytes = Uint8Array.from((token ?? '0'.repeat(64)).match(/../g) ?? [], (part) => Number.parseInt(part, 16));
  const valid = await crypto.subtle.verify('HMAC', await signingKey(env), bytes, new TextEncoder().encode(`${workspaceId}:${agentId}`));
  if (!token || !valid) throw new RouteError('Invalid runtime credential.', 'runtime_unauthorized', 403);
  return binding;
}

const CONTROL_NAMESPACE = 'hermes/runtime-control/v1';
type RuntimeBindingQuery = Pick<Tx, 'query'>;
const envelopeBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value;
  throw new Error('expected runtime credential envelope bytes');
};

/**
 * Resolve a ready, dynamically-provisioned binding first, then fall back to
 * deployment configuration for the original fixed staging profile.
 */
export async function dynamicRuntimeBinding(
  env: Env,
  tx: RuntimeBindingQuery,
  workspaceId: string,
  agentId: string,
  readyOnly: boolean,
): Promise<RuntimeBinding | null> {
  if (!UUID.test(workspaceId) || !UUID.test(agentId)) throw new RouteError('Invalid runtime path.', 'bad_id', 400);
  if (env.AGENT_RUNTIME !== 'hermes' || !env.HERMES_BRIDGE_SECRET || env.HERMES_BRIDGE_SECRET.length < 32) return misconfigured();
  const dynamic = await tx.query<{
    profile: string; base_url: string; transport: 'native' | 'dashboard_connector';
    assignment: 'fixed' | 'invitee_pool' | 'provisioned'; agentcash: boolean;
    ciphertext: Uint8Array; iv: Uint8Array; wrapped_dek: Uint8Array; wrap_iv: Uint8Array; kek_version: number;
    runtime_auth_mode: 'legacy_hmac' | 'token_digest'; runtime_credential_digest: Uint8Array | null;
    ready_at: Date | null; capacity_quarantined: boolean;
  }>(
    `SELECT profile, base_url, transport, assignment, agentcash,
            ciphertext, iv, wrapped_dek, wrap_iv, kek_version,
            runtime_auth_mode, runtime_credential_digest, ready_at,
            EXISTS (
              SELECT 1 FROM hermes_cloud_capacity c
               WHERE c.workspace_id=agent_runtime_bindings.workspace_id
                 AND c.assigned_agent_id=agent_runtime_bindings.agent_id
                 AND c.state='quarantined'
            ) AS capacity_quarantined
       FROM agent_runtime_bindings
      WHERE workspace_id=$1 AND agent_id=$2 AND base_url IS NOT NULL
      LIMIT 1`,
    [workspaceId, agentId],
  );
  const row = dynamic.rows[0];
  if (!row) return null;
  if (readyOnly && (!row.ready_at || row.capacity_quarantined)) return misconfigured();
  const apiKey = await openSecret(env, { workspaceId, keyId: agentId, namespace: CONTROL_NAMESPACE }, {
    ciphertext: envelopeBytes(row.ciphertext), iv: envelopeBytes(row.iv), wrappedDek: envelopeBytes(row.wrapped_dek),
    wrapIv: envelopeBytes(row.wrap_iv), kekVersion: row.kek_version,
  } satisfies StoredEnvelope);
  let url: URL;
  try { url = new URL(row.base_url); } catch { return misconfigured(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return misconfigured();
  return {
    workspaceId, agentId, profile: row.profile, baseUrl: url.toString().replace(/\/$/, ''), apiKey,
    transport: row.transport, assignment: row.assignment, agentCash: row.agentcash,
    releaseRing: 'stable',
    runtimeAuthMode: row.runtime_auth_mode,
    runtimeCredentialDigest: row.runtime_credential_digest,
  };
}

export async function resolveRuntimeBinding(
  env: Env,
  tx: RuntimeBindingQuery,
  workspaceId: string,
  agentId: string,
): Promise<RuntimeBinding> {
  return await dynamicRuntimeBinding(env, tx, workspaceId, agentId, true)
    ?? runtimeBinding(env, workspaceId, agentId);
}

/** Used only by the explicit Admin readiness check before ready_at is set. */
export async function resolveProvisioningRuntimeBinding(
  env: Env,
  tx: RuntimeBindingQuery,
  workspaceId: string,
  agentId: string,
): Promise<RuntimeBinding> {
  const binding = await dynamicRuntimeBinding(env, tx, workspaceId, agentId, false);
  if (!binding) return misconfigured();
  return binding;
}

export async function requireResolvedBridgeAuth(
  env: Env,
  tx: RuntimeBindingQuery,
  workspaceId: string,
  agentId: string,
  authorization: string | null,
): Promise<RuntimeBinding> {
  const dynamic = await dynamicRuntimeBinding(env, tx, workspaceId, agentId, true);
  if (dynamic) {
    await requireRuntimeBindingAuth(env, dynamic, authorization);
    return dynamic;
  }
  // Once an identity has entered discovery, revoked and expired credentials
  // must not reopen execution through an older deployment-map HMAC entry.
  const discovery = await tx.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM runtime_discovery_grants
        WHERE workspace_id=$1 AND agent_id=$2
     ) AS exists`,
    [workspaceId, agentId],
  );
  if (discovery.rows[0]?.exists) {
    throw new RouteError('Invalid runtime credential.', 'runtime_unauthorized', 403);
  }
  const binding = runtimeBinding(env, workspaceId, agentId);
  await requireRuntimeBindingAuth(env, binding, authorization);
  return binding;
}

export async function requireDynamicBridgeAuth(
  env: Env,
  tx: RuntimeBindingQuery,
  workspaceId: string,
  agentId: string,
  authorization: string | null,
): Promise<RuntimeBinding> {
  const binding = await dynamicRuntimeBinding(env, tx, workspaceId, agentId, true);
  if (!binding) return misconfigured();
  await requireRuntimeBindingAuth(env, binding, authorization);
  return binding;
}

async function requireRuntimeBindingAuth(
  env: Env,
  binding: RuntimeBinding,
  authorization: string | null,
): Promise<void> {
  if (binding.runtimeAuthMode === 'token_digest') {
    await requireDigestBearer(
      binding.runtimeCredentialDigest,
      binding.workspaceId,
      binding.agentId,
      authorization,
    );
    return;
  }
  const token = runtimeBearer(authorization);
  const candidate = Uint8Array.from((token ?? '0'.repeat(64)).match(/../g) ?? [], (part) => Number.parseInt(part, 16));
  const valid = await crypto.subtle.verify(
    'HMAC',
    await signingKey(env),
    candidate,
    new TextEncoder().encode(`${binding.workspaceId}:${binding.agentId}`),
  );
  if (!token || !valid) throw new RouteError('Invalid runtime credential.', 'runtime_unauthorized', 403);
}
