// Plain text: what a model-authored string is allowed to be.
//
// Every string the model writes that a human later reads — a review note, an
// instruction body, a proposal's evidence field, chat text — is rendered as
// plain text in the client. This file is the other half of that promise: the
// *writer* refuses the markup rather than trusting the renderer to escape it.
//
// Why both halves. A renderer that escapes is one component away from a
// renderer that does not, and the component that stops escaping will be the
// one somebody adds for "just the invoice notes". Rejecting at the tool
// boundary means the dangerous string never reaches a row, so no renderer can
// be the last line of defence. The plan (section 4, prompt-injection defenses)
// puts it plainly: "Every model-authored string ... renders as plain text in
// review panes: no markdown links, no HTML."
//
// What is refused, and why each one:
//
//   * HTML tags. `<img src=x onerror=...>` is the classic, but the quieter
//     failure is `<a href="http://evil">click</a>` inside a note the reviewer
//     reads as if the workspace had written it.
//   * Markdown links and images. `[the policy](http://evil)` hides the
//     destination behind words the human trusts, which is exactly the trick
//     the "URL confirmation" rule exists to stop.
//   * Angle-bracket autolinks (`<http://…>`), because a renderer that turns
//     those into anchors is common and the syntax has no other use.
//   * Control characters, including the bidirectional-override run that can
//     make a string render in an order it is not stored in.
//
// What is allowed: a bare URL. It is displayed as text, it is not clickable,
// and forbidding it would stop the agent citing where something came from.
import { z } from 'zod';

export type PlainTextViolation =
  | 'html_tag'
  | 'markdown_link'
  | 'autolink'
  | 'control_character';

export interface PlainTextFinding {
  readonly violation: PlainTextViolation;
  readonly excerpt: string;
}

/** `<a href=…>`, `</p>`, `<br/>`: a tag name after the bracket is the signal. */
const HTML_TAG = /<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^<>]*)?\/?>/;
/** `[label](target)` and `![alt](target)`. */
const MARKDOWN_LINK = /!?\[[^\]]*\]\([^)]*\)/;
/** `<https://example.com>` and `<mailto:…>`. */
const AUTOLINK = /<(?:[a-zA-Z][a-zA-Z0-9+.-]*:)\/?\/?[^<>\s]+>/;
// Tabs and newlines are text; everything else below 0x20, plus DEL and the
// bidi overrides, is not.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;

const RULES: readonly { violation: PlainTextViolation; pattern: RegExp }[] = [
  { violation: 'html_tag', pattern: HTML_TAG },
  { violation: 'markdown_link', pattern: MARKDOWN_LINK },
  { violation: 'autolink', pattern: AUTOLINK },
  { violation: 'control_character', pattern: CONTROL },
];

/** Every rule a string breaks, with the fragment that broke it. */
export function plainTextFindings(value: string): PlainTextFinding[] {
  const findings: PlainTextFinding[] = [];
  for (const rule of RULES) {
    const match = rule.pattern.exec(value);
    if (match) findings.push({ violation: rule.violation, excerpt: match[0].slice(0, 80) });
  }
  return findings;
}

export const isPlainText = (value: string): boolean => plainTextFindings(value).length === 0;

/** The sentence a tool hands back to the model, which has to be actionable. */
export function plainTextMessage(findings: readonly PlainTextFinding[]): string {
  const names: Record<PlainTextViolation, string> = {
    html_tag: 'an HTML tag',
    markdown_link: 'a markdown link',
    autolink: 'an angle-bracket autolink',
    control_character: 'a control character',
  };
  const listed = findings.map((f) => `${names[f.violation]} (${f.excerpt})`).join(', ');
  return `this field must be plain text: found ${listed}. Write the words out, and put a bare URL in if you need to cite one.`;
}

/**
 * A zod schema for one model-authored string.
 *
 * `max` is required rather than defaulted: every field that uses this already
 * has a length in the tool schema, and a silent default would let the two
 * disagree.
 */
export function plainText(options: { max: number; min?: number }): z.ZodType<string> {
  return z
    .string()
    .min(options.min ?? 0)
    .max(options.max)
    .superRefine((value, ctx) => {
      const findings = plainTextFindings(value);
      if (findings.length > 0) ctx.addIssue({ code: 'custom', message: plainTextMessage(findings) });
    });
}

/**
 * Walk an arbitrary payload and report the first string that is not plain text.
 *
 * `propose_request` payloads are nested documents with forty-odd string fields
 * between them, and enumerating those fields in two places (the document schema
 * and a plain-text schema) is how the two come apart. Walking the parsed value
 * means a field added to `documents.ts` next year is covered on the day it is
 * added.
 *
 * Keys are checked as well as values: an object key is a string the viewer can
 * render too, and nothing legitimate needs markup in one.
 */
export function findMarkup(value: unknown, path: string[] = []): { path: string; finding: PlainTextFinding } | null {
  if (typeof value === 'string') {
    const [finding] = plainTextFindings(value);
    return finding ? { path: path.join('.') || '(root)', finding } : null;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findMarkup(item, [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const [keyFinding] = plainTextFindings(key);
      if (keyFinding) return { path: [...path, key].join('.'), finding: keyFinding };
      const found = findMarkup(item, [...path, key]);
      if (found) return found;
    }
  }
  return null;
}
