// Official Hermes Runs API transport. The bearer token stays server-side.
// The native SSE queue is not replayable; durable enterprise events are our
// replay source, and GET run is authoritative after a stream disconnect.
import { readSse } from '../model/sse.js';

export interface HermesEvent {
  event: string;
  run_id: string;
  delta?: string;
  output?: string;
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
}
export interface HermesStatus {
  run_id: string;
  status: string;
  output?: string;
  error?: string;
  session_id?: string;
  usage?: HermesEvent['usage'];
  pending_steer?: string;
}
export interface HermesCapabilities {
  durableIdempotency: true;
  retentionSeconds: number;
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

const REQUIRED_RUN_ENDPOINTS = {
  runs: { method: 'POST', path: '/v1/runs' },
  run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
  run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
  run_steer: { method: 'POST', path: '/v1/runs/{run_id}/steer' },
  run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
} as const;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export class HermesClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly send: typeof fetch = (input, init) => fetch(input, init),
    private readonly transport: HermesTransport = 'native',
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
    const response = await this.send(this.baseUrl.replace(/\/$/, ''), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: operation === 'events' ? 'text/event-stream' : 'application/json',
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
  async capabilities(): Promise<HermesCapabilities> {
    const response = this.transport === 'dashboard_connector'
      ? await this.connector('capabilities')
      : await this.request('/v1/capabilities');
    const body = record(await response.json());
    const auth = record(body?.auth);
    const runtime = record(body?.runtime);
    const features = record(body?.features);
    const idempotency = record(features?.runs_idempotency);
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
        !endpointContract) {
      throw new HermesCapabilitiesError();
    }
    return { durableIdempotency: true, retentionSeconds };
  }
  async submit(body: Record<string, unknown>, key: string): Promise<string> {
    // Audit-only fields stay in the Worker's immutable runtime request. The
    // native API sees the procedure through its governed profile instead.
    const { _enterprise_tool_names, _enterprise_skills, ...nativeBody } = body;
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
    const result = await response.json() as HermesStatus;
    if (result.run_id !== id || typeof result.status !== 'string') throw new Error('Hermes returned an invalid run status');
    return result;
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
      ? await this.connector('events', { run_id: id }, signal)
      : await this.request(`/v1/runs/${encodeURIComponent(id)}/events`, { signal });
    for await (const frame of readSse(response, 'hermes')) {
      if (!frame.data || frame.data === '[DONE]') continue;
      const event = JSON.parse(frame.data) as HermesEvent;
      if (event.run_id !== id || typeof event.event !== 'string') throw new Error('Hermes returned an unrelated run event');
      yield event;
    }
  }
}
export const terminalHermesStatus = (status: string): boolean => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
