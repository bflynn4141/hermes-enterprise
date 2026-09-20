// Official Cloud management protocol boundary. Management grants are distinct
// from inference keys. This module never invokes a lifecycle tool: discovery
// must establish the actual provider contract before paid operations are wired.
export const CLOUD_ORIGIN = 'https://portal.nousresearch.com';
export const CLOUD_RESOURCE = `${CLOUD_ORIGIN}/mcp`;
export const CLOUD_SCOPE = 'mcp:manage_agents';
const MAX_BYTES = 256 * 1024;
const PROTOCOL = '2025-03-26';

export class CloudManagementError extends Error {
  readonly reason: 'cloud_reconnect_required' | 'cloud_scope_invalid' | 'cloud_contract_invalid' | 'cloud_unavailable';
  constructor(reason: CloudManagementError['reason']) {
    super(reason); this.name = 'CloudManagementError';
    this.reason = reason;
  }
}

type ObjectValue = Record<string, unknown>;
const invalid = (): never => { throw new CloudManagementError('cloud_contract_invalid'); };
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as ObjectValue;
}
function string(value: unknown, max = 2048): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\r\n\0]/.test(value)) return invalid();
  return value;
}
function officialUrl(value: unknown): string {
  const raw = string(value);
  let url: URL;
  try { url = new URL(raw); } catch { return invalid(); }
  if (url.origin !== CLOUD_ORIGIN || url.username || url.password || url.hash || url.search) return invalid();
  return url.href;
}
function includes(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string') && value.includes(expected);
}
async function request(fetcher: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(12_000) });
  } catch {
    // Never surface provider exception text: it can contain URLs or tokens.
    throw new CloudManagementError('cloud_unavailable');
  }
}
function checkStatus(response: Response): void {
  if (response.status === 401 || response.status === 403) throw new CloudManagementError('cloud_reconnect_required');
  if (!response.ok) throw new CloudManagementError('cloud_unavailable');
}
async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return invalid();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BYTES) return invalid();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof CloudManagementError) throw error;
    throw new CloudManagementError('cloud_unavailable');
  } finally { await reader.cancel().catch(() => {}); }
}
function parseJson(text: string): ObjectValue {
  try { return object(JSON.parse(text)); } catch { return invalid(); }
}
async function json(response: Response): Promise<ObjectValue> {
  checkStatus(response);
  return parseJson(await boundedText(response));
}

export interface CloudOAuthMetadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  clientCredentialsAdvertised: boolean;
}

export async function discoverCloudOAuth(fetcher: typeof fetch = fetch): Promise<CloudOAuthMetadata> {
  const resource = await json(await request(fetcher, `${CLOUD_ORIGIN}/.well-known/oauth-protected-resource`));
  if (resource.resource !== CLOUD_RESOURCE || !includes(resource.authorization_servers, CLOUD_ORIGIN) ||
      !includes(resource.scopes_supported, CLOUD_SCOPE) || !includes(resource.bearer_methods_supported, 'header')) return invalid();
  const metadata = await json(await request(fetcher, `${CLOUD_ORIGIN}/.well-known/oauth-authorization-server`));
  if (metadata.issuer !== CLOUD_ORIGIN || !includes(metadata.code_challenge_methods_supported, 'S256') ||
      !includes(metadata.grant_types_supported, 'authorization_code') || !includes(metadata.grant_types_supported, 'refresh_token') ||
      !includes(metadata.response_types_supported, 'code') || !includes(metadata.scopes_supported, CLOUD_SCOPE) ||
      !includes(metadata.token_endpoint_auth_methods_supported, 'none')) return invalid();
  return {
    authorizationEndpoint: officialUrl(metadata.authorization_endpoint),
    tokenEndpoint: officialUrl(metadata.token_endpoint),
    registrationEndpoint: metadata.registration_endpoint ? officialUrl(metadata.registration_endpoint) : null,
    clientCredentialsAdvertised: includes(metadata.grant_types_supported, 'client_credentials'),
  };
}

/** The caller persists verifier/state encrypted and binds them to actor+workspace. */
export async function makeCloudAuthorizationUrl(
  metadata: CloudOAuthMetadata,
  input: { clientId: string; redirectUri: string; state: string; verifier: string },
): Promise<string> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.verifier) || !/^[A-Za-z0-9_-]{32,128}$/.test(input.state)) return invalid();
  let redirect: URL;
  try { redirect = new URL(input.redirectUri); } catch { return invalid(); }
  if (redirect.protocol !== 'https:' || redirect.username || redirect.password || redirect.hash || redirect.search) return invalid();
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.verifier)));
  const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = new URL(officialUrl(metadata.authorizationEndpoint));
  url.search = new URLSearchParams({ response_type: 'code', client_id: string(input.clientId, 255),
    redirect_uri: redirect.href, scope: CLOUD_SCOPE, resource: CLOUD_RESOURCE,
    state: input.state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return url.href;
}

export interface CloudManagementCredential {
  accessToken: string;
  refreshToken: string;
  scope: string;
  expiresAt: string;
}

/** Call under the connection's refresh lock; persist rotated tokens atomically. */
export async function refreshCloudCredential(
  metadata: CloudOAuthMetadata,
  input: { clientId: string; refreshToken: string; scope: string },
  fetcher: typeof fetch = fetch,
  now = Date.now(),
): Promise<CloudManagementCredential> {
  if (!input.scope.split(/\s+/).includes(CLOUD_SCOPE)) throw new CloudManagementError('cloud_scope_invalid');
  const response = await request(fetcher, officialUrl(metadata.tokenEndpoint), {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: string(input.clientId, 255),
      refresh_token: string(input.refreshToken, 16384), resource: CLOUD_RESOURCE }),
  });
  if (response.status === 400) {
    const body = parseJson(await boundedText(response));
    if (body.error === 'invalid_grant' || body.error === 'invalid_client') throw new CloudManagementError('cloud_reconnect_required');
    throw new CloudManagementError('cloud_unavailable');
  }
  const token = await json(response);
  const scope = token.scope === undefined ? input.scope : string(token.scope);
  if (!scope.split(/\s+/).includes(CLOUD_SCOPE)) throw new CloudManagementError('cloud_scope_invalid');
  if (typeof token.expires_in !== 'number' || !Number.isInteger(token.expires_in) || token.expires_in < 1 || token.expires_in > 86400 ||
      typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer') return invalid();
  return { accessToken: string(token.access_token, 16384),
    refreshToken: token.refresh_token === undefined ? input.refreshToken : string(token.refresh_token, 16384),
    scope, expiresAt: new Date(now + token.expires_in * 1000).toISOString() };
}

/** Read just the matching RPC response, including servers that keep SSE open. */
async function rpcResponse(response: Response, id: string): Promise<ObjectValue> {
  checkStatus(response);
  const type = response.headers.get('content-type') ?? '';
  const validate = (payload: ObjectValue): ObjectValue => {
    if (payload.jsonrpc !== '2.0' || payload.id !== id || payload.error !== undefined) return invalid();
    return object(payload.result);
  };
  if (type.includes('application/json')) return validate(parseJson(await boundedText(response)));
  if (!type.includes('text/event-stream')) return invalid();
  const reader = response.body?.getReader();
  if (!reader) return invalid();
  const decoder = new TextDecoder();
  let buffer = '', bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return invalid();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) return invalid();
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        const payload = parseJson(data);
        if (payload.id === id) return validate(payload);
      }
    }
  } catch (error) {
    if (error instanceof CloudManagementError) throw error;
    throw new CloudManagementError('cloud_unavailable');
  } finally { await reader.cancel().catch(() => {}); }
}

export interface CloudToolContract { name: string; inputSchema: ObjectValue; outputSchema?: ObjectValue }

/** Tool discovery only. No model, tools/call, instance creation, or billing action. */
export async function inspectCloudTools(
  credential: Pick<CloudManagementCredential, 'accessToken' | 'scope'>,
  fetcher: typeof fetch = fetch,
): Promise<CloudToolContract[]> {
  if (!credential.scope.split(/\s+/).includes(CLOUD_SCOPE)) throw new CloudManagementError('cloud_scope_invalid');
  const headers: Record<string, string> = { Authorization: `Bearer ${string(credential.accessToken, 16384)}`,
    Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' };
  const initId = crypto.randomUUID();
  const initialized = await request(fetcher, CLOUD_RESOURCE, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: initId, method: 'initialize', params: {
      protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'hermes-enterprise-preflight', version: '1.0.0' },
    } }) });
  const init = await rpcResponse(initialized, initId);
  if (init.protocolVersion !== PROTOCOL || !object(init.capabilities).tools) return invalid();
  const sessionId = initialized.headers.get('mcp-session-id');
  if (sessionId) headers['Mcp-Session-Id'] = string(sessionId, 1024);
  headers['MCP-Protocol-Version'] = PROTOCOL;
  const notification = await request(fetcher, CLOUD_RESOURCE, { method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  checkStatus(notification);
  await notification.body?.cancel();
  const contracts: CloudToolContract[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    if (cursors.size >= 20) return invalid();
    const id = crypto.randomUUID();
    const result = await rpcResponse(await request(fetcher, CLOUD_RESOURCE, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} }),
    }), id);
    if (!Array.isArray(result.tools) || result.tools.length > 100) return invalid();
    for (const item of result.tools) {
      const tool = object(item);
      const name = string(tool.name, 255);
      if (name !== 'agents' && name !== 'agent') continue;
      if (contracts.some(existing => existing.name === name)) return invalid();
      contracts.push({ name, inputSchema: object(tool.inputSchema),
        ...(tool.outputSchema === undefined ? {} : { outputSchema: object(tool.outputSchema) }) });
    }
    cursor = result.nextCursor === undefined ? undefined : string(result.nextCursor);
    if (cursor) { if (cursors.has(cursor)) return invalid(); cursors.add(cursor); }
  } while (cursor);
  if (!contracts.some(tool => tool.name === 'agents') || !contracts.some(tool => tool.name === 'agent')) return invalid();
  return contracts;
}
