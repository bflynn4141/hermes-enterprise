// The Iris panel's two decisions that are not React: what a keystroke means,
// and what localStorage holds.
//
// Both are here rather than inside `Shell` because both are worth a unit test
// and neither needs a DOM. `irisShortcut` in particular decides something
// subtle — see the comment on it — and a subtle rule inside an event handler is
// a rule nobody ever reads.
import { irisPanelKey, irisWidthKey, legacyIrisOpenKey } from '../model/constants.js';
import { clampIrisWidth, workAreaFor, type IrisPanel } from '../model/store.js';

/** Enough of a `KeyboardEvent` to decide, so the test does not need one. */
export interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** The element the keystroke landed on, or the shape of it the test supplies. */
  target: { tagName?: string; isContentEditable?: boolean; dataset?: Record<string, string | undefined> } | null;
}

export type ShortcutVerdict =
  /** Not our keystroke. Let the browser and the page have it. */
  | 'ignore'
  /** Toggle open↔rail and leave focus where it is. */
  | 'toggle'
  /** Collapse to the rail, and move focus out of the composer into the app. */
  | 'collapse-from-composer';

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * ⌘L on macOS, Ctrl+L elsewhere.
 *
 * The rule that needed writing down: a shortcut that fires while somebody is
 * typing is a shortcut that eats their text, so every editable target is left
 * alone — *except the composer*, which is the one input whose whole context is
 * the panel being collapsed. There, ⌘L still collapses and focus is handed to
 * the app pane, because leaving focus inside a pane that is now 56 px wide is
 * the one outcome nobody wants.
 *
 * Ctrl+L is the shell's "clear screen" and the browser's "focus the address
 * bar" on Windows and Linux; we take it inside the app the way Cursor does
 * (⌘L / Ctrl+L toggles the sidepanel — cursor.com/docs/reference/keyboard-shortcuts)
 * and call `preventDefault` at the call site.
 */
export function irisShortcut(event: ShortcutEvent, isMac: boolean): ShortcutVerdict {
  if (event.key.toLowerCase() !== 'l') return 'ignore';
  if (event.altKey || event.shiftKey) return 'ignore';
  if (isMac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return 'ignore';
  const target = event.target;
  const editable = target ? EDITABLE.has((target.tagName ?? '').toUpperCase()) || target.isContentEditable === true : false;
  if (!editable) return 'toggle';
  return target?.dataset?.['composer'] === 'true' ? 'collapse-from-composer' : 'ignore';
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const PANELS: IrisPanel[] = ['open', 'rail', 'hidden'];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* a private window, or storage that is full. The panel still works. */
  }
}

/**
 * The stored preference, with the boolean migrated.
 *
 * `hermes:iris-open` was `"true"`/`"false"`. `false` becomes `rail` rather than
 * `hidden`, because that is what the button that wrote it meant — "get this out
 * of the way", not "I never want to see it". The legacy key is removed once
 * read, so the migration runs exactly once per workspace and user.
 */
export function readIrisPrefs(workspaceId: string, userId: string, windowWidth: number): { panel: IrisPanel; width: number | null } {
  const legacy = read(legacyIrisOpenKey(workspaceId, userId));
  if (legacy !== null) {
    write(legacyIrisOpenKey(workspaceId, userId), null);
    if (read(irisPanelKey(workspaceId, userId)) === null) write(irisPanelKey(workspaceId, userId), legacy === 'false' ? 'rail' : 'open');
  }
  const stored = read(irisPanelKey(workspaceId, userId));
  const panel = PANELS.includes(stored as IrisPanel) ? (stored as IrisPanel) : 'open';
  const rawWidth = read(irisWidthKey(workspaceId, userId));
  const parsed = rawWidth === null ? Number.NaN : Number(rawWidth);
  const width = Number.isFinite(parsed) ? clampIrisWidth(parsed, workAreaFor(windowWidth)) : null;
  return { panel, width };
}

export function writeIrisPrefs(workspaceId: string, userId: string, panel: IrisPanel, width: number | null): void {
  write(irisPanelKey(workspaceId, userId), panel);
  write(irisWidthKey(workspaceId, userId), width === null ? null : String(width));
}

/** The composer asks for focus by event, so the shell does not need a ref into it. */
export const FOCUS_COMPOSER = 'hermes:focus-composer';

/**
 * "Put the cursor in the composer" is not always something the composer can act
 * on when it is asked.
 *
 * New session opens the panel *and* creates a session, so the textarea that
 * should end up focused may not exist yet, and the one that does exist is about
 * to be handed a different session. So the request is a small piece of state as
 * well as an event: the composer takes it on the event if it is mounted, and
 * again when the session it is rendering changes. It expires, because a focus
 * steal two minutes after the click would be a bug rather than a courtesy.
 */
let focusRequestedAt = 0;
const FOCUS_WINDOW_MS = 3000;

export function requestComposerFocus(now = Date.now()): void {
  focusRequestedAt = now;
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER));
}

export function takeComposerFocus(now = Date.now()): boolean {
  if (focusRequestedAt === 0 || now - focusRequestedAt > FOCUS_WINDOW_MS) return false;
  focusRequestedAt = 0;
  return true;
}

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** What the tooltips and labels say. One string, so the rail and the header cannot disagree. */
export const TOGGLE_SHORTCUT = IS_MAC ? '\u2318L' : 'Ctrl+L';
