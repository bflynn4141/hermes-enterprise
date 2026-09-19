// Only timing metadata is retained. Transcript and recovery state remain server-owned.
const STORAGE = 'hermes:run-clocks:v1';
const clocks = new Map<string, { origin: string; elapsed: number }>();
let loaded = false;

export const runClockKey = (sessionId: string, runId: string, attempt: number): string => `${sessionId}:${runId}:${attempt}`;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const entries: unknown = JSON.parse(sessionStorage.getItem(STORAGE) ?? '[]');
    if (!Array.isArray(entries)) return;
    for (const entry of entries.slice(-64)) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !entry[1] || typeof entry[1] !== 'object') continue;
      const value = entry[1] as { origin?: unknown; elapsed?: unknown };
      if (typeof value.origin === 'string' && Number.isFinite(Date.parse(value.origin)) && typeof value.elapsed === 'number' && Number.isFinite(value.elapsed)) {
        clocks.set(entry[0], { origin: value.origin, elapsed: Math.max(0, value.elapsed) });
      }
    }
  } catch { /* Timing still works when browser storage is unavailable. */ }
}

function persist(): void {
  while (clocks.size > 64) clocks.delete(clocks.keys().next().value!);
  try { sessionStorage.setItem(STORAGE, JSON.stringify([...clocks])); } catch { /* Optional continuity only. */ }
}

export function waitingOrigin(key: string, proposed: string): string {
  load();
  const current = clocks.get(key);
  if (current && Date.parse(current.origin) <= Date.parse(proposed)) return current.origin;
  clocks.set(key, { origin: proposed, elapsed: current?.elapsed ?? 0 });
  persist();
  return proposed;
}

export function waitingElapsed(key: string, startedAt: string, now: number): number {
  const origin = waitingOrigin(key, startedAt);
  const current = clocks.get(key)!;
  const elapsed = Math.max(current.elapsed, Math.max(0, now - Date.parse(origin)));
  if (elapsed !== current.elapsed) {
    current.elapsed = elapsed;
    persist();
  }
  return elapsed;
}
