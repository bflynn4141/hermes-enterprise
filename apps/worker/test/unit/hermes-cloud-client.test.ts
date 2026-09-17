import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import { HermesCloudClient } from '../../src/hermes-cloud/client.js';

const env = {
  ENVIRONMENT: 'test',
  HERMES_CLOUD_CLIENT_ID: 'service-client',
  HERMES_CLOUD_CLIENT_SECRET: 'service-secret-that-never-reaches-mcp',
  HERMES_CLOUD_TOKEN_URL: 'https://portal.nousresearch.com/api/oauth/token',
  HERMES_CLOUD_MCP_URL: 'https://portal.nousresearch.com/mcp',
} as Env;

const rpc = (id: number, result: unknown, headers: Record<string, string> = {}) => new Response(
  JSON.stringify({ jsonrpc: '2.0', id, result }),
  { status: 200, headers: { 'Content-Type': 'application/json', ...headers } },
);
const tool = (id: number, payload: unknown) => rpc(id, {
  content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false,
});

describe('Hermes Cloud machine client', () => {
  it('exchanges the service credential once and creates through the official MCP tool', async () => {
    const responses = [
      new Response(JSON.stringify({ access_token: 'short-lived-management-token-12345', token_type: 'Bearer', expires_in: 300 }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
      rpc(1, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'portal', version: '1' } }, { 'Mcp-Session-Id': 'session-1' }),
      new Response(null, { status: 202 }),
      tool(2, { agents: [] }),
      tool(3, { agent: {
        id: 'cloud-1', name: 'iris-partner-12345678', status: 'PROVISIONING', health: 'PENDING',
        dashboardUrl: 'https://iris-partner-12345678.agents.nousresearch.com',
      } }),
    ];
    const send = vi.fn<typeof fetch>(async () => responses.shift()!);
    const client = new HermesCloudClient(env, send);

    await expect(client.listAgents()).resolves.toEqual([]);
    await expect(client.createAgent({
      name: 'iris-partner-12345678', region: 'sjc', model: 'z-ai/glm-5.2', size: 'medium',
      env: { ENTERPRISE_AGENT_ID: '12345678-1234-4234-8234-123456789012' },
    })).resolves.toMatchObject({ id: 'cloud-1', status: 'PROVISIONING' });

    expect(send).toHaveBeenCalledTimes(5);
    const tokenBody = new URLSearchParams(String(send.mock.calls[0]?.[1]?.body));
    expect(tokenBody.get('grant_type')).toBe('client_credentials');
    expect(tokenBody.get('scope')).toBe('mcp:manage_agents');
    const mcpCalls = send.mock.calls.slice(1);
    expect(mcpCalls.every(([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer short-lived-management-token-12345')).toBe(true);
    expect(JSON.stringify(mcpCalls)).not.toContain(env.HERMES_CLOUD_CLIENT_SECRET);
    expect(JSON.parse(String(send.mock.calls[4]?.[1]?.body))).toMatchObject({
      method: 'tools/call',
      params: { name: 'agent', arguments: { action: 'create', name: 'iris-partner-12345678', region: 'sjc', size: 'medium' } },
    });
  });

  it('accepts streamable-HTTP SSE tool results', async () => {
    const send = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { id?: number; method: string };
      if (String(init?.body).includes('client_credentials')) throw new Error('unexpected');
      if (body.method === 'initialize') return rpc(body.id!, {}, { 'Mcp-Session-Id': 'session-sse' });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {
        content: [{ type: 'text', text: JSON.stringify({ agents: [{ id: 'a', name: 'Iris', status: 'RUNNING', health: 'HEALTHY', dashboardUrl: null }] }) }],
      } })}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    const seeded = { ...env, HERMES_CLOUD_CLIENT_ID: undefined, HERMES_CLOUD_CLIENT_SECRET: undefined } as Env;
    // Supply the token response as the first call, then use the SSE transport.
    const routed = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes('/api/oauth/token')) return new Response(JSON.stringify({ access_token: 'short-lived-management-token-67890' }), { status: 200 });
      return send(url, init);
    });
    await expect(new HermesCloudClient({ ...seeded, HERMES_CLOUD_CLIENT_ID: 'id', HERMES_CLOUD_CLIENT_SECRET: 'secret' }, routed).listAgents())
      .resolves.toEqual([expect.objectContaining({ id: 'a', health: 'HEALTHY' })]);
  });
});
