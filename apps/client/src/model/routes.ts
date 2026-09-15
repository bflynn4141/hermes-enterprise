// Routing, in one pair of pure functions over `packages/shared/refs.ts`.
//
// No router library: the five URL shapes below are the whole surface, and the
// app-pane object is carried in the fragment so that the serialiser and
// `sameRef` are driven by the same `Ref` keys. A new ref key added to the
// contract therefore reaches the URL without a second edit here.
import { refSchema, type Ref } from '@hermes/shared';

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
  if (segments[0] === 'w' && segments[1]) {
    const sessionId = segments[2] === 's' && segments[3] ? segments[3] : null;
    return { kind: 'workspace', workspaceId: segments[1], sessionId, app };
  }
  if (segments[0] === 'onboarding') {
    const step = segments[1] === 'join' ? 'join-workspace' : 'create-workspace';
    return { kind: 'onboarding', step, token: url.searchParams.get('token') };
  }
  if (segments[0] === 'shared' && segments[1]) return { kind: 'shared', token: segments[1] };
  if (segments[0] === 'auth' && segments[1] === 'signin') return { kind: 'signin', returnTo: url.searchParams.get('return_to') };
  if (segments[0] === 'auth' && segments[1] === 'callback') return { kind: 'callback', returnTo: url.searchParams.get('return_to') };
  return { kind: 'unknown' };
}

export function toHref(route: Route): string {
  switch (route.kind) {
    case 'workspace': {
      const base = route.sessionId ? `/w/${route.workspaceId}/s/${route.sessionId}` : `/w/${route.workspaceId}`;
      return route.app ? `${base}#${serialiseRef(route.app)}` : base;
    }
    case 'onboarding':
      return route.step === 'join-workspace' ? `/onboarding/join${route.token ? `?token=${encodeURIComponent(route.token)}` : ''}` : '/onboarding/create';
    case 'shared':
      return `/shared/${route.token}`;
    case 'signin':
      return `/auth/signin${route.returnTo ? `?return_to=${encodeURIComponent(route.returnTo)}` : ''}`;
    case 'callback':
      return `/auth/callback${route.returnTo ? `?return_to=${encodeURIComponent(route.returnTo)}` : ''}`;
    default:
      return '/';
  }
}

export const currentRoute = (): Route => parseRoute(new URL(window.location.href));
