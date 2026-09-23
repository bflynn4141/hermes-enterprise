// The pull-request preview lock (src/preview-gate.ts). A preview runs fake
// auth on a public hostname, so these are the tests that keep it closed.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PREVIEW_COOKIE,
  PREVIEW_UNLOCK_PATH,
  WORKER_FIRST_PATHS,
  isWorkerFirstPath,
  previewGate,
} from '../../src/preview-gate.js';

const ORIGIN = 'https://hermes-pr-7.example.workers.dev';
const env = { PREVIEW_PASSCODE: 'correct horse battery staple' };

const navigate = (path: string, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, {
    headers: { 'sec-fetch-mode': 'navigate', accept: 'text/html', ...(cookie ? { cookie } : {}) },
  });
const fetchData = (path: string, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, { headers: { accept: 'application/json', 'x-dev-user': 'maya@nous.example', ...(cookie ? { cookie } : {}) } });
const unlock = (passcode: string, next = '/workspace/abc') =>
  new Request(`${ORIGIN}${PREVIEW_UNLOCK_PATH}`, { method: 'POST', body: new URLSearchParams({ passcode, next }) });

async function unlockedCookie(): Promise<string> {
  const response = await previewGate(unlock(env.PREVIEW_PASSCODE), env);
  const setCookie = response?.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0]!;
}

describe('previewGate', () => {
  it('does nothing when no passcode is configured, which is every non-preview environment', async () => {
    expect(await previewGate(fetchData('/w/ws/bootstrap'), {})).toBeNull();
    expect(await previewGate(navigate('/'), { PREVIEW_PASSCODE: '' })).toBeNull();
  });

  it('refuses data requests without the cookie, including a forged dev-user header', async () => {
    const response = await previewGate(fetchData('/w/ws/bootstrap'), env);
    expect(response?.status).toBe(401);
    expect(await response?.json()).toMatchObject({ reason: 'preview_locked' });
  });

  it('refuses socket upgrades without the cookie', async () => {
    const upgrade = new Request(`${ORIGIN}/w/ws/hub/workspace`, { headers: { upgrade: 'websocket' } });
    expect((await previewGate(upgrade, env))?.status).toBe(401);
  });

  it('sends a navigation to the unlock page and remembers where it was going', async () => {
    const response = await previewGate(navigate('/workspace/abc?tab=inbox'), env);
    expect(response?.status).toBe(302);
    expect(response?.headers.get('location')).toBe(`${PREVIEW_UNLOCK_PATH}?next=${encodeURIComponent('/workspace/abc?tab=inbox')}`);
  });

  it('keeps /health open for the deploy smoke test', async () => {
    expect(await previewGate(fetchData('/health'), env)).toBeNull();
  });

  it('rejects a wrong passcode and sets no cookie', async () => {
    const response = await previewGate(unlock('wrong'), env);
    expect(response?.status).toBe(401);
    expect(response?.headers.get('set-cookie')).toBeNull();
  });

  it('sets an HttpOnly cookie that is not the passcode itself, then lets requests through', async () => {
    const response = await previewGate(unlock(env.PREVIEW_PASSCODE), env);
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe('/workspace/abc');
    const setCookie = response?.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).not.toContain(encodeURIComponent(env.PREVIEW_PASSCODE));
    const cookie = setCookie.split(';')[0]!;
    expect(await previewGate(fetchData('/w/ws/bootstrap', cookie), env)).toBeNull();
    expect(await previewGate(navigate('/workspace/abc', cookie), env)).toBeNull();
  });

  it('rejects a cookie minted for a different passcode', async () => {
    const cookie = await unlockedCookie();
    expect((await previewGate(fetchData('/w/ws/bootstrap', cookie), { PREVIEW_PASSCODE: 'rotated' }))?.status).toBe(401);
    expect((await previewGate(fetchData('/w/ws/bootstrap', `${PREVIEW_COOKIE}=forged`), env))?.status).toBe(401);
  });

  it('never redirects off-site after unlocking', async () => {
    for (const next of ['https://evil.example/', '//evil.example/', '/\\evil.example/']) {
      const response = await previewGate(unlock(env.PREVIEW_PASSCODE, next), env);
      expect(response?.headers.get('location')).toBe('/');
    }
  });

  it('escapes the destination it writes into the unlock page', async () => {
    const response = await previewGate(navigate(`${PREVIEW_UNLOCK_PATH}?next=${encodeURIComponent('/"><script>x</script>')}`), env);
    const html = await response!.text();
    expect(html).not.toContain('<script>x</script>');
  });
});

describe('isWorkerFirstPath', () => {
  it('matches exact paths and prefixes the way run_worker_first does', () => {
    expect(isWorkerFirstPath('/health')).toBe(true);
    expect(isWorkerFirstPath('/w/abc/bootstrap')).toBe(true);
    expect(isWorkerFirstPath('/workspaces')).toBe(true);
    expect(isWorkerFirstPath('/workspace/abc')).toBe(false);
    expect(isWorkerFirstPath('/assets/index.js')).toBe(false);
    expect(isWorkerFirstPath('/')).toBe(false);
  });

  it('mirrors assets.run_worker_first in wrangler.jsonc exactly', () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), '../../wrangler.jsonc');
    const text = readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => (line.trimStart().startsWith('//') ? '' : line))
      .join('\n');
    const config = JSON.parse(text) as { assets: { run_worker_first: string[] } };
    expect([...WORKER_FIRST_PATHS]).toEqual(config.assets.run_worker_first);
  });
});
