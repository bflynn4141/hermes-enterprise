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
export class HermesApiError extends Error {
  constructor(readonly status: number, readonly operation: string) {
    super(`Hermes ${operation} failed (${status})`);
  }
}
export class HermesClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string, private readonly send: typeof fetch = (input, init) => fetch(input, init)) {}
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
  async submit(body: Record<string, unknown>, key: string): Promise<string> {
    const { _enterprise_tool_names, ...nativeBody } = body;
    const response = await this.request('/v1/runs', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(nativeBody) });
    const result = await response.json() as { run_id?: unknown };
    if (typeof result.run_id !== 'string' || !/^run_[\w-]{1,180}$/.test(result.run_id)) throw new Error('Hermes returned an invalid run id');
    return result.run_id;
  }
  async status(id: string): Promise<HermesStatus> {
    const result = await (await this.request(`/v1/runs/${encodeURIComponent(id)}`)).json() as HermesStatus;
    if (result.run_id !== id || typeof result.status !== 'string') throw new Error('Hermes returned an invalid run status');
    return result;
  }
  async stop(id: string): Promise<void> {
    await (await this.request(`/v1/runs/${encodeURIComponent(id)}/stop`, { method: 'POST' })).body?.cancel();
  }
  async steer(id: string, text: string): Promise<boolean> {
    try {
      await (await this.request(`/v1/runs/${encodeURIComponent(id)}/steer`, { method: 'POST', body: JSON.stringify({ input: text }) })).body?.cancel();
      return true;
    } catch (error) {
      if (error instanceof HermesApiError && error.status === 409) return false;
      throw error;
    }
  }
  async *events(id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
    const response = await this.request(`/v1/runs/${encodeURIComponent(id)}/events`, { signal });
    for await (const frame of readSse(response, 'hermes')) {
      if (!frame.data || frame.data === '[DONE]') continue;
      const event = JSON.parse(frame.data) as HermesEvent;
      if (event.run_id !== id || typeof event.event !== 'string') throw new Error('Hermes returned an unrelated run event');
      yield event;
    }
  }
}
export const terminalHermesStatus = (status: string): boolean => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
