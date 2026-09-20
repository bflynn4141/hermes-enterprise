// Official Hermes Runs API transport. The bearer token stays server-side.
// The native SSE queue is not replayable; durable enterprise events are our
// replay source, and GET run is authoritative after a stream disconnect.
import { readSse } from '../model/sse.js';
import runtimeContract from '../../../../runtime/hermes/contract.json';

export type HermesReleaseRing = 'canary' | 'stable';
export type HermesTerminalErrorCode =
  | 'provider_auth'
  | 'provider_quota'
  | 'provider_rate_limited'
  | 'request_rejected'
  | 'provider_unavailable'
  | 'runtime_interrupted'
  | 'runtime_unknown';
export interface HermesTerminalError {
  readonly schema_version: 1;
  readonly code: HermesTerminalErrorCode;
  readonly category: 'auth' | 'quota' | 'rate_limit' | 'rejected' | 'unavailable' | 'interrupted' | 'unknown';
  readonly retryable: boolean;
  readonly source: 'provider' | 'request' | 'runtime';
}

export interface HermesEvent {
  event: string;
  run_id: string;
  delta?: string;
  /** Runtime-provided reasoning preview. Never a contract for private model thought. */
  text?: string;
  output?: string;
  /** Tool lifecycle fields emitted by the official Runs SSE contract. */
  tool?: string;
  preview?: string;
  duration?: number;
  error?: string | boolean;
  terminal_error?: HermesTerminalError;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}
export interface HermesStatus {
  run_id: string;
  status: string;
  output?: string;
  error?: string;
  terminal_error?: HermesTerminalError;
  session_id?: string;
  usage?: HermesEvent['usage'];
  pending_steer?: string;
}
export interface HermesCapabilities {
  durableIdempotency: true;
  retentionSeconds: number;
  contractVersion: 1;
  terminalErrorSchemaVersion: 1;
  sourceRevision: string;
  releaseRing: HermesReleaseRing;
}
export interface HermesEnterpriseReadiness {
  object: 'hermes.enterprise_bridge.readiness';
  version: string;
  runtimeRevision: string | null;
  plugin: {
    name: string;
    version: string;
    revision: string | null;
    artifactDigest: string | null;
  } | null;
  workspaceId: string;
  agentId: string;
  enterpriseUrl: string;
  skills: readonly { name: string; version: string; artifactDigest: string; contentDigest: string }[] | null;
  toolNames: readonly string[] | null;
  agentCashEnabled: boolean;
  agentCashWalletPresent: boolean;
  nativeCronDisabled: boolean;
}
export type HermesTransport = 'native' | 'dashboard_connector';
export class HermesApiError extends Error {
  constructor(readonly status: number, readonly operation: string) {
    super(`Hermes ${operation} failed (${status})`);
  }
}
export class HermesCapabilitiesError extends Error {
  constructor() {
    super('Hermes does not expose the required durable Runs contract');
  }
}
export class HermesContractError extends Error {
  constructor() {
    super('Hermes returned data outside the negotiated Enterprise contract');
  }
}

const REQUIRED_RUN_ENDPOINTS = {
  runs: { method: 'POST', path: '/v1/runs' },
  run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
  run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
  run_steer: { method: 'POST', path: '/v1/runs/{run_id}/steer' },
  run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
} as const;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const TERMINAL_ERROR_SHAPES = {
  provider_auth: ['auth', false, 'provider'],
  provider_quota: ['quota', false, 'provider'],
  provider_rate_limited: ['rate_limit', true, 'provider'],
  request_rejected: ['rejected', false, 'request'],
  provider_unavailable: ['unavailable', true, 'provider'],
  runtime_interrupted: ['interrupted', true, 'runtime'],
  runtime_unknown: ['unknown', true, 'runtime'],
} as const satisfies Record<HermesTerminalErrorCode, readonly [HermesTerminalError['category'], boolean, HermesTerminalError['source']]>;

export function parseHermesTerminalError(value: unknown): HermesTerminalError | null {
  const candidate = record(value);
  if (!candidate || candidate.schema_version !== runtimeContract.terminal_error_schema_version ||
      typeof candidate.code !== 'string' || !(candidate.code in TERMINAL_ERROR_SHAPES)) return null;
  const code = candidate.code as HermesTerminalErrorCode;
  const [category, retryable, source] = TERMINAL_ERROR_SHAPES[code];
  if (candidate.category !== category || candidate.retryable !== retryable || candidate.source !== source ||
      Object.keys(candidate).some((key) => !['schema_version', 'code', 'category', 'retryable', 'source'].includes(key))) return null;
  return { schema_version: 1, code, category, retryable, source };
}

function nativeTurnAuthor(value: unknown): { id: string; name: string; is_bot: true } | null {
  if (value === undefined) return null;
  const author = record(value);
  if (!author || author.is_bot !== true || typeof author.id !== 'string' || typeof author.name !== 'string'
      || !/^bot:[a-z0-9][a-z0-9_-]{0,63}$/.test(author.id)
      || author.name.length < 1 || author.name.length > 64 || /[:\n(]/.test(author.name)) {
    throw new Error('invalid enterprise turn author');
  }
  return { id: author.id, name: author.name, is_bot: true };
}

export class HermesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly send: typeof fetch = (input, init) => fetch(input, init),
    private readonly transport: HermesTransport = 'native',
    private readonly expectedReleaseRing: HermesReleaseRing = 'stable',
  ) {}
  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.apiKey}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    const response = await this.send(`${this.baseUrl.replace(/\/$/, '')}${path}`, { ...init, headers, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(15_000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HermesApiError(response.status, path.endsWith('/steer') ? 'steer' : path.endsWith('/stop') ? 'stop' : 'request');
    }
    return response;
  }
  private async connector(operation: string, payload: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Response> {
    const streaming = operation === 'events';
    const response = await this.send(this.baseUrl.replace(/\/$/, ''), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: streaming ? 'text/event-stream' : 'application/json',
        ...(streaming ? {
          // The response is already compact SSE. Compression thresholds can
          // otherwise turn incremental native frames into one terminal burst.
          'Accept-Encoding': 'identity',
          'Cache-Control': 'no-cache',
        } : {}),
      },
      body: JSON.stringify({ operation, ...payload }),
      redirect: 'manual',
      signal: signal ?? AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HermesApiError(response.status, operation === 'steer' ? 'steer' : operation === 'stop' ? 'stop' : 'request');
    }
    return response;
  }
  private async connectorEvents(id: string, signal: AbortSignal): Promise<Response> {
    // Hermes Dashboard's machine-authenticated plugin edge dispatches POST
    // operations. A GET route can exist inside the plugin yet never be reached
    // through that edge, leaving the Worker to poll until terminal output.
    return this.connector('events', { run_id: id }, signal);
  }
  async capabilities(): Promise<HermesCapabilities> {
    const response = this.transport === 'dashboard_connector'
      ? await this.connector('capabilities')
      : await this.request('/v1/capabilities');
    const body = record(await response.json());
    const auth = record(body?.auth);
    const runtime = record(body?.runtime);
    const features = record(body?.features);
    const idempotency = record(features?.runs_idempotency);
    const enterpriseContract = record(body?.enterprise_contract);
    const terminalErrors = record(enterpriseContract?.terminal_errors);
    const endpoints = record(body?.endpoints);
    const endpointContract = Object.entries(REQUIRED_RUN_ENDPOINTS).every(([name, expected]) => {
      const actual = record(endpoints?.[name]);
      return actual?.method === expected.method && actual.path === expected.path;
    });
    const retentionSeconds = idempotency?.retention_seconds;
    if (body?.object !== 'hermes.api_server.capabilities' || body.platform !== 'hermes-agent' ||
        auth?.type !== 'bearer' || auth.required !== true || runtime?.mode !== 'server_agent' ||
        runtime.tool_execution !== 'server' || runtime.split_runtime !== false ||
        features?.run_submission !== true || features.run_status !== true ||
        features.run_events_sse !== true || features.run_stop !== true || features.run_steer !== true ||
        idempotency?.supported !== true || idempotency.durable !== true ||
        typeof retentionSeconds !== 'number' || !Number.isFinite(retentionSeconds) || retentionSeconds <= 0 ||
        enterpriseContract?.schema_version !== runtimeContract.contract_version ||
        enterpriseContract.source_revision !== runtimeContract.source_revision ||
        enterpriseContract.release_ring !== this.expectedReleaseRing ||
        terminalErrors?.supported !== true ||
        terminalErrors.schema_version !== runtimeContract.terminal_error_schema_version ||
        !endpointContract) {
      throw new HermesCapabilitiesError();
    }
    return {
      durableIdempotency: true,
      retentionSeconds,
      contractVersion: 1,
      terminalErrorSchemaVersion: 1,
      sourceRevision: runtimeContract.source_revision,
      releaseRing: this.expectedReleaseRing,
    };
  }
  async enterpriseReadiness(): Promise<HermesEnterpriseReadiness> {
    if (this.transport !== 'dashboard_connector') throw new HermesCapabilitiesError();
    const response = await this.connector('readiness');
    const body = record(await response.json());
    const hasAnyAttestation = body !== null && [
      body.runtime_revision, body.plugin, body.skills, body.tools,
    ].some((value) => value !== undefined);
    const plugin = hasAnyAttestation ? record(body?.plugin) : null;
    const hasManagedPluginFields = plugin?.revision !== undefined || plugin?.artifact_digest !== undefined;
    const skillRows = hasAnyAttestation && Array.isArray(body?.skills) ? body.skills : null;
    const toolRows = hasAnyAttestation && Array.isArray(body?.tools) ? body.tools : null;
    const skills = skillRows?.map((value) => {
      const skill = record(value);
      return skill && typeof skill.name === 'string' && /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(skill.name) &&
        typeof skill.version === 'string' && /^\d+\.\d+\.\d+$/.test(skill.version) &&
        typeof skill.artifact_digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(skill.artifact_digest) &&
        typeof skill.content_digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(skill.content_digest)
        ? { name: skill.name, version: skill.version, artifactDigest: skill.artifact_digest,
            contentDigest: skill.content_digest }
        : null;
    }) ?? null;
    const toolNames = toolRows?.every((value) => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value))
      ? toolRows as string[] : null;
    if (body?.object !== 'hermes.enterprise_bridge.readiness' || typeof body.version !== 'string' ||
        !/^\d+\.\d+\.\d+$/.test(body.version) ||
        typeof body.workspace_id !== 'string' || body.workspace_id.length === 0 ||
        typeof body.agent_id !== 'string' || body.agent_id.length === 0 ||
        typeof body.enterprise_url !== 'string' || body.enterprise_url.length === 0 ||
        typeof body.agentcash_enabled !== 'boolean' ||
        typeof body.agentcash_wallet_present !== 'boolean' || typeof body.native_cron_disabled !== 'boolean' ||
        (hasAnyAttestation && (
          typeof body.runtime_revision !== 'string' || !/^[0-9a-f]{40}$/.test(body.runtime_revision) ||
          plugin?.name !== 'enterprise_bridge' || plugin.version !== body.version ||
          (hasManagedPluginFields && (
            typeof plugin.revision !== 'string' || !/^[0-9a-f]{40}$/.test(plugin.revision) ||
            typeof plugin.artifact_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(plugin.artifact_digest)
          )) ||
          !skillRows || skillRows.length > 16 || !toolRows || toolRows.length > 128 ||
          !skills || skills.some((skill) => skill === null) || new Set(skills.map((skill) => skill!.name)).size !== skills.length ||
          !toolNames || !toolNames.includes('skill_view') || new Set(toolNames).size !== toolNames.length
        ))) {
      throw new HermesCapabilitiesError();
    }
    return {
      object: 'hermes.enterprise_bridge.readiness', version: body.version,
      runtimeRevision: hasAnyAttestation ? body.runtime_revision as string : null,
      plugin: hasAnyAttestation ? {
        name: plugin!.name as string,
        version: plugin!.version as string,
        revision: hasManagedPluginFields ? plugin!.revision as string : null,
        artifactDigest: hasManagedPluginFields ? plugin!.artifact_digest as string : null,
      } : null,
      workspaceId: body.workspace_id, agentId: body.agent_id, enterpriseUrl: body.enterprise_url,
      skills: hasAnyAttestation ? skills as NonNullable<HermesEnterpriseReadiness['skills']> : null,
      toolNames: hasAnyAttestation ? toolNames : null,
      agentCashEnabled: body.agentcash_enabled, agentCashWalletPresent: body.agentcash_wallet_present,
      nativeCronDisabled: body.native_cron_disabled,
    };
  }
  async submit(body: Record<string, unknown>, key: string): Promise<string> {
    // Audit-only fields stay in the Worker's immutable runtime request. The
    // native API sees the procedure through its governed profile instead.
    const { _enterprise_tool_names, _enterprise_skills, _enterprise_turn_author, ...rest } = body;
    const author = nativeTurnAuthor(_enterprise_turn_author);
    const nativeBody = { ...rest, ...(author ? { turn_author: author } : {}) };
    const response = this.transport === 'dashboard_connector'
      ? await this.connector('submit', { idempotency_key: key, body: nativeBody })
      : await this.request('/v1/runs', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(nativeBody) });
    const result = await response.json() as { run_id?: unknown };
    if (typeof result.run_id !== 'string' || !/^run_[\w-]{1,180}$/.test(result.run_id)) throw new Error('Hermes returned an invalid run id');
    return result.run_id;
  }
  async status(id: string): Promise<HermesStatus> {
    const response = this.transport === 'dashboard_connector'
      ? await this.connector('status', { run_id: id })
      : await this.request(`/v1/runs/${encodeURIComponent(id)}`);
    const raw = await response.json();
    const result = record(raw);
    if (result?.run_id !== id || typeof result.status !== 'string') throw new HermesContractError();
    if (['failed', 'interrupted'].includes(result.status)) {
      const terminalError = parseHermesTerminalError(result.terminal_error);
      if (!terminalError) throw new HermesContractError();
      return { ...result, terminal_error: terminalError } as unknown as HermesStatus;
    }
    return result as unknown as HermesStatus;
  }
  async stop(id: string): Promise<void> {
    const response = this.transport === 'dashboard_connector'
      ? await this.connector('stop', { run_id: id })
      : await this.request(`/v1/runs/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    await response.body?.cancel();
  }
  async steer(id: string, text: string): Promise<boolean> {
    try {
      const response = this.transport === 'dashboard_connector'
        ? await this.connector('steer', { run_id: id, input: text })
        : await this.request(`/v1/runs/${encodeURIComponent(id)}/steer`, { method: 'POST', body: JSON.stringify({ input: text }) });
      await response.body?.cancel();
      return true;
    } catch (error) {
      if (error instanceof HermesApiError && error.status === 409) return false;
      throw error;
    }
  }
  async *events(id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
    const response = this.transport === 'dashboard_connector'
      ? await this.connectorEvents(id, signal)
      : await this.request(`/v1/runs/${encodeURIComponent(id)}/events`, { signal });
    for await (const frame of readSse(response, 'hermes')) {
      if (!frame.data || frame.data === '[DONE]') continue;
      const event = JSON.parse(frame.data) as HermesEvent;
      if (event.run_id !== id || typeof event.event !== 'string') throw new Error('Hermes returned an unrelated run event');
      if (event.event === 'run.failed') {
        const terminalError = parseHermesTerminalError(event.terminal_error);
        if (!terminalError) throw new HermesContractError();
        event.terminal_error = terminalError;
      }
      yield event;
    }
  }
}
export const terminalHermesStatus = (status: string): boolean => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
