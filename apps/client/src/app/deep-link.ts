// The one-shot "you were sent here" mark for the Inbox.
//
// A receipt in the transcript and the Open link a run leaves behind both land
// on a request. The row they select should say so once — a 200 ms rise of its
// action bar — and never on an ordinary click, a filter change or a reload.
// The same shape as `requestComposerFocus`: the intent is recorded before the
// navigation dispatch, and the Inbox takes it, once, when it renders that row.
const HIGHLIGHT_WINDOW_MS = 2_000;
let requested: { id: string; at: number } | null = null;

export function requestInboxHighlight(id: string, now = Date.now()): void {
  requested = { id, at: now };
}

/** `true` once, for the request most recently deep-linked and only within the window. */
export function takeInboxHighlight(id: string, now = Date.now()): boolean {
  if (!requested || requested.id !== id || now - requested.at > HIGHLIGHT_WINDOW_MS) return false;
  requested = null;
  return true;
}
