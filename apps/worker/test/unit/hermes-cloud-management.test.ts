import { describe, expect, it } from 'vitest';
import { CLOUD_ORIGIN, CLOUD_RESOURCE, CLOUD_SCOPE, discoverCloudOAuth, inspectCloudTools,
  makeCloudAuthorizationUrl, refreshCloudCredential, registerCloudClient, exchangeCloudCode, inspectCloudOrganization } from '../../src/hermes-cloud/management.js';

const metadata = { authorizationEndpoint: `${CLOUD_ORIGIN}/oauth/authorize`, tokenEndpoint: `${CLOUD_ORIGIN}/api/oauth/token`,
  registrationEndpoint: `${CLOUD_ORIGIN}/api/oauth/register`, clientCredentialsAdvertised: true };
const resource = { resource: CLOUD_RESOURCE, authorization_servers: [CLOUD_ORIGIN], scopes_supported: [CLOUD_SCOPE], bearer_methods_supported: ['header'] };
const authorization = { issuer: CLOUD_ORIGIN, authorization_endpoint: metadata.authorizationEndpoint,
  token_endpoint: metadata.tokenEndpoint, registration_endpoint: metadata.registrationEndpoint,
  scopes_supported: [CLOUD_SCOPE], code_challenge_methods_supported: ['S256'], response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'], token_endpoint_auth_methods_supported: ['none'] };
const credential = { accessToken: 'test-access-not-a-real-token', scope: CLOUD_SCOPE };
function fake(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(String(input), init))) as typeof fetch;
}

describe('Cloud management discovery and grants', () => {
  it('registers only the exact HTTPS public PKCE callback', async () => {
    const redirectUri = 'https://enterprise.example/w/workspace/cloud/callback';
    expect(await registerCloudClient(metadata, redirectUri, fake((url, init) => {
      expect(url).toBe(metadata.registrationEndpoint);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', scope: CLOUD_SCOPE });
      return Response.json({ ...body, client_id: 'registered-client' });
    }))).toBe('registered-client');
    await expect(registerCloudClient(metadata, 'http://enterprise.example/callback', fake(() => { throw new Error('must not fetch'); })))
      .rejects.toMatchObject({ reason: 'cloud_contract_invalid' });
    await expect(registerCloudClient(metadata, redirectUri, fake(() => Response.json({ client_id: 'client', token_endpoint_auth_method: 'none', redirect_uris: ['https://attacker.invalid'] }))))
      .rejects.toMatchObject({ reason: 'cloud_contract_invalid' });
  });
  it('exchanges the code only in a PKCE token request with a refreshable management grant', async () => {
    const input = { clientId: 'client', redirectUri: 'https://enterprise.example/callback', code: 'code-secret', verifier: 'v'.repeat(43) };
    const result = await exchangeCloudCode(metadata, input, fake((url, init) => {
      expect(url).toBe(metadata.tokenEndpoint);
      expect(new URLSearchParams(String(init?.body)).get('code_verifier')).toBe(input.verifier);
      expect(String(init?.body)).toContain('resource=');
      return Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 600 });
    }), 0);
    expect(result.expiresAt).toBe('1970-01-01T00:10:00.000Z');
    for (const changed of [{ scope: 'inference:invoke' }, { refresh_token: undefined }, { token_type: 'Other' }, { expires_in: 0 }]) {
      await expect(exchangeCloudCode(metadata, input, fake(() => Response.json({ access_token: 'access', refresh_token: 'refresh', token_type: 'Bearer', expires_in: 600, ...changed })))).rejects.toThrow();
    }
  });
  it('attributes only an authenticated organization and bounds provider responses', async () => {
    expect(await inspectCloudOrganization('test-token', fake((url, init) => {
      expect(url).toBe(`${CLOUD_ORIGIN}/api/oauth/account`);
      expect(init?.redirect).toBe('manual');
      return Response.json({ organisation: { id: 'org-id', name: 'Acme' }, secret: 'not projected' });
    }))).toEqual({ id: 'org-id', name: 'Acme' });
    expect(await inspectCloudOrganization('test-token', fake(() => new Response('', { status: 403 })))).toBeNull();
    await expect(inspectCloudOrganization('test-token', fake(() => Response.json({ padding: 'a'.repeat(300000) })))).rejects.toThrow('cloud_contract_invalid');
  });
  it('discovers the official management scope without inferring service access', async () => {
    const result = await discoverCloudOAuth(fake((url, init) => {
      expect(init?.redirect).toBe('manual');
      expect(init?.headers).toBeUndefined();
      return Response.json(url.endsWith('oauth-protected-resource') ? resource : authorization);
    }));
    expect(result).toEqual(metadata);
  });
  it.each([
    { token_endpoint: 'https://attacker.invalid/token' },
    { token_endpoint: 'https://portal.nousresearch.com@attacker.invalid/token' },
    { token_endpoint: `${CLOUD_ORIGIN}/token?leak=1` },
    { issuer: 'https://attacker.invalid' },
    { scopes_supported: ['inference:invoke'] },
    { code_challenge_methods_supported: ['plain'] },
  ])('refuses untrusted or incompatible OAuth metadata %j', async change => {
    await expect(discoverCloudOAuth(fake(url => Response.json(url.endsWith('oauth-protected-resource') ? resource : { ...authorization, ...change }))))
      .rejects.toMatchObject({ reason: 'cloud_contract_invalid' });
  });
  it('builds PKCE using the RFC7636 S256 vector and management resource', async () => {
    const result = new URL(await makeCloudAuthorizationUrl(metadata, {
      clientId: 'registered-client', redirectUri: 'https://enterprise.example/cloud/callback', state: 's'.repeat(43),
      verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    }));
    expect(result.searchParams.get('code_challenge')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
    expect(result.searchParams.get('scope')).toBe(CLOUD_SCOPE);
    expect(result.searchParams.get('resource')).toBe(CLOUD_RESOURCE);
    expect(result.searchParams.has('code_verifier')).toBe(false);
  });
  it('rotates refresh credentials without leaking them into the URL', async () => {
    const result = await refreshCloudCredential(metadata, { clientId: 'client', refreshToken: 'old-test-refresh', scope: CLOUD_SCOPE }, fake((url, init) => {
      expect(url).toBe(metadata.tokenEndpoint);
      const body = new URLSearchParams(String(init?.body));
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('resource')).toBe(CLOUD_RESOURCE);
      return Response.json({ access_token: 'new-test-access', refresh_token: 'new-test-refresh', token_type: 'Bearer', expires_in: 600 });
    }), 0);
    expect(result.refreshToken).toBe('new-test-refresh');
    expect(result.expiresAt).toBe('1970-01-01T00:10:00.000Z');
  });
  it('retains a refresh token when the provider does not rotate it', async () => {
    const result = await refreshCloudCredential(metadata, { clientId: 'client', refreshToken: 'old-test-refresh', scope: CLOUD_SCOPE },
      fake(() => Response.json({ access_token: 'new-test-access', token_type: 'Bearer', expires_in: 600 })));
    expect(result.refreshToken).toBe('old-test-refresh');
  });
  it('requires reconnection after revocation and suppresses provider detail', async () => {
    await expect(refreshCloudCredential(metadata, { clientId: 'client', refreshToken: 'test-refresh', scope: CLOUD_SCOPE },
      fake(() => Response.json({ error: 'invalid_grant', error_description: 'SECRET' }, { status: 400 }))))
      .rejects.toThrow('cloud_reconnect_required');
  });
  it('refuses inference grants before any network access', async () => {
    let calls = 0;
    await expect(inspectCloudTools({ ...credential, scope: 'inference:invoke' }, fake(() => { calls++; return Response.json({}); })))
      .rejects.toMatchObject({ reason: 'cloud_scope_invalid' });
    expect(calls).toBe(0);
  });
});

describe('Read-only Cloud MCP contract preflight', () => {
  function transport(sse = false): { fetcher: typeof fetch; methods: string[] } {
    const methods: string[] = [];
    const fetcher = fake((url, init) => {
      expect(url).toBe(CLOUD_RESOURCE);
      expect(init?.redirect).toBe('manual');
      const body = JSON.parse(String(init?.body)) as { id?: string; method: string; params?: { cursor?: string } };
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${credential.accessToken}`);
      methods.push(body.method);
      if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id,
        result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } }, { headers: { 'mcp-session-id': 'test-session' } });
      expect(headers.get('mcp-session-id')).toBe('test-session');
      expect(headers.get('mcp-protocol-version')).toBe('2025-03-26');
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      expect(body.method).toBe('tools/list');
      const result = body.params?.cursor
        ? { tools: [{ name: 'agent', inputSchema: { type: 'object' } }] }
        : { tools: [{ name: 'agents', inputSchema: { type: 'object' } }], nextCursor: 'page-2' };
      const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
      if (!sse) return new Response(payload, { headers: { 'content-type': 'application/json' } });
      // Intentionally keep the SSE stream open; discovery must finish at reply.
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(': heartbeat\r\n\r\ndata: ' + payload + '\r'));
        controller.enqueue(new TextEncoder().encode('\n\r\n'));
      } }), { headers: { 'content-type': 'text/event-stream' } });
    });
    return { fetcher, methods };
  }
  it.each([false, true])('discovers both paginated contracts with SSE=%s without calling a tool', async sse => {
    const { fetcher, methods } = transport(sse);
    expect((await inspectCloudTools(credential, fetcher)).map(tool => tool.name)).toEqual(['agents', 'agent']);
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
  });
  it('does not follow authentication redirects with bearer credentials', async () => {
    let calls = 0;
    await expect(inspectCloudTools(credential, fake((_url, init) => {
      calls++; expect(init?.redirect).toBe('manual'); return new Response(null, { status: 302, headers: { Location: 'https://attacker.invalid' } });
    }))).rejects.toThrow('cloud_unavailable');
    expect(calls).toBe(1);
  });
  it('rejects unexpected response IDs and overlarge bodies', async () => {
    await expect(inspectCloudTools(credential, fake(() => Response.json({ jsonrpc: '2.0', id: 'wrong', result: {} }))))
      .rejects.toThrow('cloud_contract_invalid');
    await expect(inspectCloudTools(credential, fake(() => new Response('x'.repeat(262145), { headers: { 'content-type': 'application/json' } }))))
      .rejects.toThrow('cloud_contract_invalid');
  });
  it('does not echo network errors that may include credentials', async () => {
    await expect(inspectCloudTools(credential, fake(() => { throw new Error('SECRET'); }))).rejects.toThrow('cloud_unavailable');
  });
  it.each(['application/json', 'text/event-stream'])('redacts failures while reading %s response bodies', async contentType => {
    const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('SECRET')); } }),
      { headers: { 'content-type': contentType } });
    await expect(inspectCloudTools(credential, fake(() => response))).rejects.toThrow('cloud_unavailable');
  });
});
