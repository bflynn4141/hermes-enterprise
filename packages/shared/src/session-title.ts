// How a session is named, shared by the routes that write the name and the
// client that shows it before the server has answered (decision C34b, and the
// server-side move recorded beside it).

/** The placeholder a session is created with, and the one signal that nobody has named it. */
export const DEFAULT_SESSION_TITLE = 'New session';

/**
 * Who wrote the current title. `manual` is sticky: neither the first turn nor
 * a finished run may replace a name a person chose.
 */
export const SESSION_TITLE_SOURCES = ['default', 'turn', 'run', 'manual'] as const;
export type SessionTitleSource = (typeof SESSION_TITLE_SOURCES)[number];

/** The first six words of the first turn, trimmed to a line. */
export function autoTitleFrom(text: string): string | null {
  const words = text.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (words.length === 0) return null;
  let title = words.slice(0, 6).join(' ');
  // A six-word title can still be 200 characters if somebody pastes a URL.
  if (title.length > 60) title = `${title.slice(0, 57).trimEnd()}…`;
  // Trailing punctuation reads as a truncation that is not there.
  return title.replace(/[\s.,;:!?—-]+$/u, '') || null;
}

/**
 * Once a run finishes, the object it produced is a better name than the
 * question that started it: "Ada Ling · application" rather than "Screen the
 * applicant in the". `subject` is the request's subject, falling back to its
 * label; `kind` is the request kind.
 */
export function sessionTitleFromRequest(subject: string | null | undefined, label: string, kind: string): string | null {
  const name = (subject ?? '').trim() || label.trim();
  if (!name) return null;
  return `${name.slice(0, 120)} · ${kind}`;
}
