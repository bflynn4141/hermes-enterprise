import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('attempt waiting clocks', () => {
  it('keeps elapsed time and origin through remount, reload, and a backwards wall clock', async () => {
    const values = new Map<string, string>();
    let pagehide!: () => void;
    vi.stubGlobal('window', { addEventListener: (_name: string, listener: () => void) => { pagehide = listener; } });
    vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    const first = await import('./run-clock.js');
    const origin = '2026-09-19T10:00:00.000Z';
    const key = first.runClockKey('session', 'run', 1);
    expect(first.waitingElapsed(key, origin, Date.parse(origin) + 7000)).toBe(7000);
    expect(first.waitingElapsed(key, '2026-09-19T10:00:05.000Z', Date.parse(origin) + 4000)).toBe(7000);
    expect(first.waitingElapsed(key, origin, Date.parse(origin) + 8700)).toBe(8700);
    pagehide();
    vi.resetModules();
    const reloaded = await import('./run-clock.js');
    expect(reloaded.waitingElapsed(key, '2026-09-19T10:00:05.000Z', Date.parse(origin) + 8000)).toBe(8700);
    expect(reloaded.waitingElapsed(reloaded.runClockKey('session', 'run', 2), origin, Date.parse(origin) + 100)).toBe(100);
  });
});
