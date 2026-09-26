// The lock on a pull-request preview.
//
// A preview is a development build on a public workers.dev hostname: fake
// auth, the scripted model, the fixture catalog. Fake auth trusts an
// `x-dev-user` header, so without a lock anybody who found the URL could act as
// any seeded Admin. The lock is one shared passcode: a person enters it once,
// the Worker sets an HttpOnly cookie, and every request after that (the app
// shell, the API and both socket upgrades) carries it.
//
// The gate is on exactly when `PREVIEW_PASSCODE` is set, which only
// `scripts/preview.mjs` does, as a secret. Local development, the tests,
// staging and production never set it and never see this code do anything.
//
// A preview deploys with `run_worker_first: true`, so the Worker sees static
// asset requests too; once the gate has passed, anything outside the paths the
// Worker owns goes straight to the assets binding, exactly as the ordinary
// `run_worker_first` list would have sent it. See docs/PREVIEWS.md.
import { constantTimeEqual } from './routes/demo-access.js';
import { isNavigation } from './routes/spa.js';

export const PREVIEW_COOKIE = 'hermes_preview';
export const PREVIEW_UNLOCK_PATH = '/__preview/unlock';

/**
 * The paths the Worker answers before the assets binding. Mirrors
 * `assets.run_worker_first` in wrangler.jsonc; a unit test holds them equal.
 */
export const WORKER_FIRST_PATHS = [
  '/health', '/internal/*', '/integrations/*', '/api/*', '/w/*', '/auth/*',
  '/workspaces', '/invitations/*', '/shared/*', '/demo/*',
] as const;

export function isWorkerFirstPath(pathname: string): boolean {
  return WORKER_FIRST_PATHS.some((pattern) =>
    pattern.endsWith('/*') ? pathname.startsWith(pattern.slice(0, -1)) : pathname === pattern);
}

type GateEnv = { PREVIEW_PASSCODE?: string };

/** The cookie proves the passcode without being it: HMAC(passcode, label). */
async function unlockToken(passcode: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passcode), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('hermes-preview-v1'));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/** Only a same-origin path survives as the post-unlock destination. */
function safeNext(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

function unlockPage(next: string, failed: boolean): Response {
  const escaped = next.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Preview</title><style>
body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#111}
form{display:grid;gap:12px;width:min(320px,90vw)}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #ccc}
button{background:#111;color:#fff;border-color:#111}p{margin:0;color:#555}.error{color:#b00020}</style></head>
<body><form method="post" action="${PREVIEW_UNLOCK_PATH}">
<h1 style="font-size:20px;margin:0">Pull request preview</h1>
<p>Enter the preview passcode. It uses sample data and a scripted agent.</p>
${failed ? '<p class="error">That passcode is not right.</p>' : ''}
<input type="password" name="passcode" autocomplete="current-password" aria-label="Passcode" required autofocus>
<input type="hidden" name="next" value="${escaped}"><button type="submit">Open preview</button></form></body></html>`;
  return new Response(html, {
    status: failed ? 401 : 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * `null` means the request may proceed. A Response means the gate answered it:
 * the unlock page, the unlock itself, or a refusal.
 */
export async function previewGate(request: Request, env: GateEnv): Promise<Response | null> {
  const passcode = env.PREVIEW_PASSCODE;
  if (!passcode) return null;
  const url = new URL(request.url);

  // `/health` stays open so the deploy script can smoke-test before unlocking.
  if (url.pathname === '/health') return null;

  if (url.pathname === PREVIEW_UNLOCK_PATH) {
    if (request.method === 'POST') {
      const form = await request.formData().catch(() => null);
      const attempt = form?.get('passcode');
      const next = safeNext(typeof form?.get('next') === 'string' ? (form.get('next') as string) : null);
      if (typeof attempt !== 'string' || !(await constantTimeEqual(attempt, passcode))) {
        return unlockPage(next, true);
      }
      return new Response(null, {
        status: 303,
        headers: {
          location: next,
          'set-cookie': `${PREVIEW_COOKIE}=${await unlockToken(passcode)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
          'cache-control': 'no-store',
        },
      });
    }
    return unlockPage(safeNext(url.searchParams.get('next')), false);
  }

  const presented = cookieValue(request, PREVIEW_COOKIE);
  if (presented && (await constantTimeEqual(presented, await unlockToken(passcode)))) return null;

  if (isNavigation(request)) {
    const next = encodeURIComponent(url.pathname + url.search);
    return new Response(null, { status: 302, headers: { location: `${PREVIEW_UNLOCK_PATH}?next=${next}`, 'cache-control': 'no-store' } });
  }
  return Response.json({ error: 'this preview is locked', reason: 'preview_locked' }, { status: 401 });
}
