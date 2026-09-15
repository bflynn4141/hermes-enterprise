// Routing, in one pair of pure functions over `packages/shared/refs.ts`.
//
// No router library: the five URL shapes below are the whole surface, and the
// app-pane object is carried in the fragment so that the serialiser and
// `sameRef` are driven by the same `Ref` keys. A new ref key added to the
// contract therefore reaches the URL without a second edit here.
import { refSchema, type Ref } from '@hermes/shared';

/**
 * The shell's own path prefix, and why it is not `/w`.
 *
 * `/w/*` is in the Worker's `run_worker_first` list, and the Worker ends that
 * list with `app.all('/w/*')` answering JSON 404 — deliberately, so that a
 * `fetch()` for data is never handed `index.html`. The side effect is that
 * `/w/:ws`, the URL the spec gives the shell, never reaches the SPA fallback
 * either: the browser gets `{"reason":"unknown_route"}` instead of the app.
 *
 * The API keeps `/w/:ws/...`; the *shell* moves to `/workspace/:ws`, which is
 * not worker-first and so falls through to the single-page-application
 * handler. `/w/:ws` is still parsed, so the moment the Worker learns to answer
 * a navigation request there with the shell, the old links work again with no
 * change here. Recorded as decision C-21.
 */
export const SHELL_PREFIX = 'workspace';

export type Route =
  | { kind: 'workspace'; workspaceId: string; sessionId: string | null; app: Ref | null }
  | { kind: 'onboarding'; step: 'create-workspace' | 'join-workspace'; token: string | null }
  | { kind: 'shared'; token: string }
  | { kind: 'signin'; returnTo: string | null }
  | { kind: 'callback'; returnTo: string | null }
  | { kind: 'unknown' };

const REF_ORDER = ['section', 'view', 'id', 'sub', 'step', 'field'] as const;

/** `#agents/context///destination` — positional, so an absent key is an empty slot. */
export function serialiseRef(ref: Ref): string {
  const parts = REF_ORDER.map((k) => encodeURIComponent(ref[k] ?? ''));
  while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts.join('/');
}

export function parseRef(hash: string): Ref | null {
  const raw = hash.replace(/^#/, '');
  if (!raw) return null;
  const parts = raw.split('/').map((p) => decodeURIComponent(p));
  const out: Record<string, string> = {};
  REF_ORDER.forEach((key, i) => {
    const value = parts[i];
    if (value) out[key] = value;
  });
  const parsed = refSchema.safeParse(out);
  return parsed.success ? parsed.data : null;
}

export function parseRoute(url: URL): Route {
  const segments = url.pathname.split('/').filter(Boolean);
  const app = parseRef(url.hash);
  if ((segments[0] === SHELL_PREFIX || segments[0] === 'w') && segments[1]) {
    const sessionId = segments[2] === 's' && segments[3] ? segments[3] : null;
    return { kind: 'workspace', workspaceId: segments[1], sessionId, app };
  }
  if (segments[0] === 'onboarding') {
    const step = segments[1] === 'join' ? 'join-workspace' : 'create-workspace';
    return { kind: 'onboarding', step, token: url.searchParams.get('token') };
  }
  if (segments[0] === 'shared' && segments[1]) return { kind: 'shared', token: segments[1] };
  if (segments[0] === 'auth' && (segments[1] === 'signin' || segments[1] === 'login'))
    return { kind: 'signin', returnTo: url.searchParams.get('return_to') };
  if (segments[0] === 'auth' && segments[1] === 'callback') return { kind: 'callback', returnTo: url.searchParams.get('return_to') };
  return { kind: 'unknown' };
}

export function toHref(route: Route): string {
  switch (route.kind) {
    case 'workspace': {
      const base = route.sessionId
        ? `/${SHELL_PREFIX}/${route.workspaceId}/s/${route.sessionId}`
        : `/${SHELL_PREFIX}/${route.workspaceId}`;
      return route.app ? `${base}#${serialiseRef(route.app)}` : base;
    }
    case 'onboarding':
      return route.step === 'join-workspace' ? `/onboarding/join${route.token ? `?token=${encodeURIComponent(route.token)}` : ''}` : '/onboarding/create';
    case 'shared':
      return `/shared/${route.token}`;
    case 'signin':
      return `/auth/login${route.returnTo ? `?return_to=${encodeURIComponent(route.returnTo)}` : ''}`;
    case 'callback':
      return `/auth/callback${route.returnTo ? `?return_to=${encodeURIComponent(route.returnTo)}` : ''}`;
    default:
      return '/';
  }
}

export const currentRoute = (): Route => parseRoute(new URL(window.location.href));
