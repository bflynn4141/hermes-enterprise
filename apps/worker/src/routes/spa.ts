// The catch-all, which has to answer two different callers correctly.
//
// A browser navigating to `/w/:ws/inbox` and a `fetch()` asking for
// `/w/:ws/nonexistent` arrive at the same place. The first wants the client
// bundle; the second wants JSON, and handing it `index.html` would make a
// missing route look like a parse error three layers away (decision C19 is
// about exactly that distinction on the client side).
//
// So the catch-all reads the request rather than the path: a GET or HEAD whose
// `Accept` prefers HTML is a navigation and gets `index.html` from the assets
// binding; everything else gets `{"reason":"unknown_route"}` as before. The
// `/api/*` prefix is the one exception — it is the prefix that means "data",
// so it answers JSON even to a browser, because a person who typed an API URL
// into the address bar is better served by the 404 than by the shell.
//
// See decision F1.
import type { Context } from 'hono';
import type { Env } from '../env.js';

/** Does this request want the app, or does it want data? */
export function isNavigation(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  // Fetch Metadata is the reliable signal where it exists: a browser
  // navigation sets `Sec-Fetch-Mode: navigate`, and `fetch()` never does.
  const mode = request.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  const accept = request.headers.get('accept') ?? '';
  if (!accept.includes('text/html')) return false;
  // `Accept: text/html` alongside an explicit `application/json` earlier in
  // the list is a client asking for data and tolerating a page; the order is
  // the answer.
  const html = accept.indexOf('text/html');
  const json = accept.indexOf('application/json');
  return json === -1 || html < json;
}

/**
 * `index.html` from the assets binding, with the navigated path preserved.
 *
 * The binding is asked for `/` rather than for the original path: asking for
 * `/w/:ws/inbox` would go back through `not_found_handling` and, in a worker
 * that reached this line, round-trip for nothing.
 */
export async function serveAppShell(c: Context<{ Bindings: Env }>): Promise<Response> {
  const url = new URL(c.req.url);
  url.pathname = '/';
  url.search = '';
  const response = await c.env.ASSETS.fetch(new Request(url, { method: 'GET', headers: c.req.raw.headers }));
  if (!response.ok) {
    // No bundle built. Saying so is far better than a blank 404: the usual
    // cause is a checkout where `pnpm --filter client build` has not run.
    return c.json({ error: 'the client bundle is not built', reason: 'no_bundle' }, 503);
  }
  // A fresh Response, because the assets binding's own body is already
  // consumed-once and its headers carry an ETag for `/` rather than for the
  // path the browser asked about.
  const headers = new Headers(response.headers);
  headers.delete('etag');
  headers.set('cache-control', 'no-cache');
  return new Response(response.body, { status: 200, headers });
}

/** JSON 404, the answer every non-navigation gets. */
export const unknownRoute = (c: Context<{ Bindings: Env }>): Response =>
  c.json({ error: 'not found', reason: 'unknown_route' }, 404);

/** The catch-all itself. */
export async function appShellOrUnknownRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith('/api/')) return unknownRoute(c);
  if (!isNavigation(c.req.raw)) return unknownRoute(c);
  return serveAppShell(c);
}
