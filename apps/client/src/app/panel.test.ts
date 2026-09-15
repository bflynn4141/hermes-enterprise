// The panel's two non-React decisions: what ⌘L means where it landed, and what
// comes back out of localStorage.
import { beforeEach, describe, expect, it } from 'vitest';
import { irisShortcut, readIrisPrefs, writeIrisPrefs, type ShortcutEvent } from './panel.js';
import { irisPanelKey, irisWidthKey, legacyIrisOpenKey } from '../model/constants.js';

const WS = 'ws-1';
const USER = 'user-1';

const key = (patch: Partial<ShortcutEvent> = {}): ShortcutEvent => ({ key: 'l', metaKey: false, ctrlKey: false, target: null, ...patch });
const on = (tagName: string, dataset: Record<string, string> = {}) => ({ tagName, dataset, isContentEditable: false });

describe('the toggle shortcut', () => {
  it('is ⌘L on macOS and Ctrl+L elsewhere, and each platform ignores the other', () => {
    expect(irisShortcut(key({ metaKey: true }), true)).toBe('toggle');
    expect(irisShortcut(key({ ctrlKey: true }), true)).toBe('ignore');
    expect(irisShortcut(key({ ctrlKey: true }), false)).toBe('toggle');
    expect(irisShortcut(key({ metaKey: true }), false)).toBe('ignore');
  });

  it('ignores a bare L, and every modified variant that is somebody else’s shortcut', () => {
    expect(irisShortcut(key(), true)).toBe('ignore');
    expect(irisShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe('ignore');
    expect(irisShortcut(key({ metaKey: true, altKey: true }), true)).toBe('ignore');
    expect(irisShortcut(key({ key: 'k', metaKey: true }), true)).toBe('ignore');
  });

  it('takes an uppercase L: a caps-lock key is the same keystroke', () => {
    expect(irisShortcut(key({ key: 'L', metaKey: true }), true)).toBe('toggle');
  });

  it('leaves every input alone — except the composer, which collapses and hands focus back', () => {
    expect(irisShortcut(key({ metaKey: true, target: on('INPUT') }), true)).toBe('ignore');
    expect(irisShortcut(key({ metaKey: true, target: on('TEXTAREA') }), true)).toBe('ignore');
    expect(irisShortcut(key({ metaKey: true, target: { tagName: 'DIV', isContentEditable: true } }), true)).toBe('ignore');
    expect(irisShortcut(key({ metaKey: true, target: on('TEXTAREA', { composer: 'true' }) }), true)).toBe('collapse-from-composer');
  });

  it('fires from an ordinary element anywhere in the shell', () => {
    expect(irisShortcut(key({ metaKey: true, target: on('BUTTON') }), true)).toBe('toggle');
    expect(irisShortcut(key({ metaKey: true, target: on('BODY') }), true)).toBe('toggle');
  });
});

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

describe('the remembered panel', () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  it('defaults to open with no remembered width', () => {
    expect(readIrisPrefs(WS, USER, 1840)).toEqual({ panel: 'open', width: null });
  });

  it('round-trips a state and a width, clamped to the window it is read in', () => {
    writeIrisPrefs(WS, USER, 'hidden', 900);
    expect(readIrisPrefs(WS, USER, 1840)).toEqual({ panel: 'hidden', width: 900 });
    // The same 900 in a 1440 window is over the 60 percent ceiling.
    expect(readIrisPrefs(WS, USER, 1440).width).toBe(720);
  });

  it('migrates the boolean: false meant "out of the way", which is the rail', () => {
    localStorage.setItem(legacyIrisOpenKey(WS, USER), 'false');
    expect(readIrisPrefs(WS, USER, 1840).panel).toBe('rail');
    // Read once: the legacy key is gone and the migration cannot run again.
    expect(localStorage.getItem(legacyIrisOpenKey(WS, USER))).toBeNull();
    expect(localStorage.getItem(irisPanelKey(WS, USER))).toBe('rail');
  });

  it('a migrated boolean never overwrites a state somebody has since chosen', () => {
    writeIrisPrefs(WS, USER, 'open', null);
    localStorage.setItem(legacyIrisOpenKey(WS, USER), 'false');
    expect(readIrisPrefs(WS, USER, 1840).panel).toBe('open');
  });

  it('ignores a stored value that is not one of the three, and a width that is not a number', () => {
    localStorage.setItem(irisPanelKey(WS, USER), 'maximised');
    localStorage.setItem(irisWidthKey(WS, USER), 'wide');
    expect(readIrisPrefs(WS, USER, 1840)).toEqual({ panel: 'open', width: null });
  });

  it('a null width removes the key rather than storing "null"', () => {
    writeIrisPrefs(WS, USER, 'open', 700);
    writeIrisPrefs(WS, USER, 'open', null);
    expect(localStorage.getItem(irisWidthKey(WS, USER))).toBeNull();
  });
});
