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
