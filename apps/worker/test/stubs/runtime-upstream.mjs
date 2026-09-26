// An offline upstream for the transport smoke test. The caller still uses
// native workerd fetch, including its receiver and redirect restrictions.
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname === 'runtime-redirect.test') {
      return Response.json({ run_id: 'run_redirect', status: 'completed', output: 'A redirect was followed.' });
    }
    if (url.hostname !== 'runtime-transport.test') return fetch(request);
    if (request.headers.get('Authorization') !== 'Bearer worker-test-only') {
      return Response.json({ error: 'Missing test authentication.' }, { status: 401 });
    }
    if (url.pathname === '/v1/runs/run_redirect') {
      return Response.redirect('https://runtime-redirect.test/capture', 302);
    }
    if (url.pathname === '/v1/capabilities') {
      return Response.json({
        object: 'hermes.api_server.capabilities', platform: 'hermes-agent',
        auth: { type: 'bearer', required: true },
        runtime: { mode: 'server_agent', tool_execution: 'server', split_runtime: false },
        features: {
          run_submission: true, run_status: true, run_events_sse: true, run_stop: true, run_steer: true,
          runs_idempotency: { supported: true, durable: true, retention_seconds: 86400 },
        },
        endpoints: {
          runs: { method: 'POST', path: '/v1/runs' },
          run_status: { method: 'GET', path: '/v1/runs/{run_id}' },
          run_events: { method: 'GET', path: '/v1/runs/{run_id}/events' },
          run_steer: { method: 'POST', path: '/v1/runs/{run_id}/steer' },
          run_stop: { method: 'POST', path: '/v1/runs/{run_id}/stop' },
        },
        enterprise_contract: {
          schema_version: 1,
          source_revision: 'f97608f178d1ffeca59860195ab7da295f7c8e5f',
          release_ring: 'stable',
          terminal_errors: { supported: true, schema_version: 1 },
        },
      });
    }
    if (url.pathname === '/v1/runs' && request.method === 'POST') {
      const body = await request.json();
      if (request.headers.get('Idempotency-Key') !== 'worker-stable-key' || body.input !== 'Review the application.') {
        return Response.json({ error: 'Unexpected test request.' }, { status: 400 });
      }
      return Response.json({ run_id: 'run_workerd', status: 'started' }, { status: 202 });
    }
    if (url.pathname === '/v1/runs/run_workerd') {
      return Response.json({ run_id: 'run_workerd', status: 'completed', output: 'Reviewed in workerd.' });
    }
    return Response.json({ error: 'Unknown runtime test route.' }, { status: 404 });
  },
};
