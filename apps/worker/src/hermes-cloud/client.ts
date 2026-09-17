// Minimal client for Nous Portal's official Hermes Cloud management MCP.
// The long-lived machine secret is exchanged for a short-lived OAuth token;
// only that token is sent to MCP. Responses are accepted in either JSON or
// streamable-HTTP SSE form because both are valid MCP transports.
import type { Env } from '../env.js';

const DEFAULT_PORTAL = 'https://portal.nousresearch.com';
const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface CloudAgent {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly health: string | null;
  readonly dashboardUrl: string | null;
  readonly region?: string;
  readonly model?: string;
}

export class HermesCloudError extends Error {
  constructor(message: string, readonly code: string, readonly retryAfterSeconds = 0) {
    super(message);
    this.name = 'HermesCloudError';
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function endpoint(env: Env, raw: string | undefined, path: string): string {
  const url = new URL(raw?.trim() || `${DEFAULT_PORTAL}${path}`);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new HermesCloudError('Hermes Cloud endpoint is invalid', 'cloud_endpoint_invalid');
  }
  if (!['development', 'test'].includes(env.ENVIRONMENT) && url.origin !== DEFAULT_PORTAL) {
    throw new HermesCloudError('Hermes Cloud endpoint is not the pinned Nous Portal origin', 'cloud_endpoint_untrusted');
  }
  return url.toString();
}

function decodeMcp(text: string, contentType: string): Record<string, unknown> {
  if (contentType.includes('text/event-stream')) {
    const frames = text.split(/\r?\n\r?\n/).flatMap((frame) => frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim()));
    for (let index = frames.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = record(JSON.parse(frames[index] ?? ''));
        if (parsed) return parsed;
      } catch { /* Ignore keepalive/non-JSON SSE frames. */ }
    }
    throw new HermesCloudError('Hermes Cloud returned no MCP result', 'cloud_mcp_bad_response');
  }
  try {
    const parsed = record(JSON.parse(text));
    if (parsed) return parsed;
  } catch { /* Report one stable operational error below. */ }
  throw new HermesCloudError('Hermes Cloud returned invalid JSON', 'cloud_mcp_bad_response');
}

function toolPayload(result: unknown): Record<string, unknown> {
  const envelope = record(result);
  if (!envelope) throw new HermesCloudError('Hermes Cloud tool result was empty', 'cloud_mcp_bad_response');
  if (envelope.isError === true || envelope.is_error === true) {
    throw new HermesCloudError('Hermes Cloud rejected the management request', 'cloud_tool_rejected');
  }
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  const text = content.map(record).find((item) => item?.type === 'text' && typeof item.text === 'string')?.text;
  if (typeof text !== 'string') throw new HermesCloudError('Hermes Cloud tool returned no text payload', 'cloud_mcp_bad_response');
  try {
    const parsed = record(JSON.parse(text));
    if (parsed) return parsed;
  } catch { /* The service contract returns JSON text; fail closed otherwise. */ }
  throw new HermesCloudError('Hermes Cloud tool returned invalid JSON', 'cloud_mcp_bad_response');
}

function cloudAgent(value: unknown): CloudAgent | null {
  const row = record(value);
  if (!row || typeof row.id !== 'string' || typeof row.name !== 'string' || typeof row.status !== 'string') return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    health: typeof row.health === 'string' ? row.health : null,
    dashboardUrl: typeof row.dashboardUrl === 'string' ? row.dashboardUrl : null,
    ...(typeof row.region === 'string' ? { region: row.region } : {}),
    ...(typeof row.model === 'string' ? { model: row.model } : {}),
  };
}

export class HermesCloudClient {
  private readonly tokenUrl: string;
  private readonly mcpUrl: string;
  private accessToken: string | null = null;
  private sessionId: string | null = null;
  private initialized = false;
  private requestId = 0;

  constructor(private readonly env: Env, private readonly send: Fetcher = fetch) {
    this.tokenUrl = endpoint(env, env.HERMES_CLOUD_TOKEN_URL, '/api/oauth/token');
    this.mcpUrl = endpoint(env, env.HERMES_CLOUD_MCP_URL, '/mcp');
    if (new URL(this.tokenUrl).origin !== new URL(this.mcpUrl).origin) {
      throw new HermesCloudError('Hermes Cloud OAuth and MCP origins differ', 'cloud_endpoint_mismatch');
    }
  }

  private async token(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const clientId = this.env.HERMES_CLOUD_CLIENT_ID?.trim();
    const clientSecret = this.env.HERMES_CLOUD_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
      throw new HermesCloudError('Hermes Cloud machine credentials are not configured', 'cloud_credentials_missing');
    }
    const response = await this.send(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'mcp:manage_agents',
      }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HermesCloudError('Hermes Cloud credential exchange failed', 'cloud_token_rejected', response.status >= 500 ? 60 : 0);
    }
    const body = record(await response.json());
    if (typeof body?.access_token !== 'string' || body.access_token.length < 20) {
      throw new HermesCloudError('Hermes Cloud token response was invalid', 'cloud_token_invalid');
    }
    this.accessToken = body.access_token;
    return body.access_token;
  }

  private async rpc(method: string, params?: Record<string, unknown>, notification = false): Promise<unknown> {
    const id = notification ? undefined : ++this.requestId;
    const headers = new Headers({
      Authorization: `Bearer ${await this.token()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    });
    if (this.sessionId) headers.set('Mcp-Session-Id', this.sessionId);
    const response = await this.send(this.mcpUrl, {
      method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }),
    });
    if (notification && response.ok) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HermesCloudError('Hermes Cloud MCP request failed', 'cloud_mcp_unavailable', response.status >= 500 ? 60 : 0);
    }
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
    const body = decodeMcp(await response.text(), response.headers.get('content-type') ?? 'application/json');
    const error = record(body.error);
    if (error) throw new HermesCloudError('Hermes Cloud MCP returned an error', 'cloud_mcp_error');
    return body.result;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'hermes-enterprise-provisioner', version: '1.0.0' },
    });
    await this.rpc('notifications/initialized', undefined, true);
    this.initialized = true;
  }

  private async tool(name: 'agents' | 'agent', args: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.initialize();
    return toolPayload(await this.rpc('tools/call', { name, arguments: args }));
  }

  async listAgents(): Promise<CloudAgent[]> {
    const payload = await this.tool('agents', { action: 'list' });
    return (Array.isArray(payload.agents) ? payload.agents : []).map(cloudAgent).filter((row): row is CloudAgent => row !== null);
  }

  async getAgent(agentId: string): Promise<CloudAgent> {
    const payload = await this.tool('agents', { action: 'get', agent_id: agentId });
    const agent = cloudAgent(payload.agent);
    if (!agent) throw new HermesCloudError('Hermes Cloud returned an invalid agent', 'cloud_agent_invalid');
    return agent;
  }

  async createAgent(input: {
    name: string; region: string; model: string; size: string; env: Record<string, string>;
  }): Promise<CloudAgent> {
    const payload = await this.tool('agent', { action: 'create', ...input });
    const agent = cloudAgent(payload.agent);
    if (!agent) throw new HermesCloudError('Hermes Cloud did not return the created agent', 'cloud_agent_invalid');
    return agent;
  }
}
