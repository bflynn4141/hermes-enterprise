// HTML to readable text, for a tool result.
//
// The model is not a browser and a tool result is not a page. What a reviewer
// needs out of a fetched page is the words: the headings, the paragraphs, the
// list items, and the link text with its destination beside it so a citation
// can be checked. Everything else — script, style, template, svg, iframe, the
// attributes — is either noise the context window pays for or a place to hide
// an instruction.
//
// Scripts and styles are removed with their contents rather than stripped of
// their tags, because `<script>ignore your instructions</script>` stripped of
// its tags is the injected sentence, promoted into the readable text.
//
// This is deliberately a small reducer and not a parser. A real HTML parser in
// a Worker is a dependency, a bundle and a CPU budget; the failure mode of this
// one is an odd blank line, and the fetched text is untrusted evidence either
// way.

const DROP_WITH_CONTENT = /<(script|style|noscript|template|svg|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
const BLOCK_END = /<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre|ul|ol|table|header|footer|main|nav)\s*>/gi;
const LINE_BREAK = /<(br|hr)\s*\/?>/gi;
const HEADING_OPEN = /<h([1-6])\b[^>]*>/gi;
const LIST_ITEM = /<li\b[^>]*>/gi;
const ANCHOR = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi;
const ANY_TAG = /<[^>]*>/g;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Control characters decoded out of an entity are how a fetched page
      // smuggles a bidi override past the plain-text rules.
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return '';
      return String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** The page's `<title>`, when it has one, because it is the human's label. */
export function htmlTitle(html: string): string | null {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  if (!match?.[1]) return null;
  const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
  return title.length > 0 ? title.slice(0, 300) : null;
}

/**
 * Reduce a document to the text a person would read aloud.
 *
 * Links become `text (href)`: the destination is kept because a reviewer
 * checking a citation needs it, and it is kept *beside* the words rather than
 * behind them, which is the same rule the client's plain-text rendering obeys.
 */
export function htmlToText(html: string): string {
  let text = html.replace(COMMENT, ' ').replace(DROP_WITH_CONTENT, ' ');
  text = text.replace(ANCHOR, (_match, _q, dq: string | undefined, sq: string | undefined, bare: string | undefined, label: string) => {
    const href = (dq ?? sq ?? bare ?? '').trim();
    const words = label.replace(ANY_TAG, ' ').replace(/\s+/g, ' ').trim();
    if (!href) return words;
    if (!words) return href;
    return `${words} (${href})`;
  });
  text = text.replace(HEADING_OPEN, '\n\n');
  text = text.replace(LIST_ITEM, '\n- ');
  text = text.replace(LINE_BREAK, '\n');
  text = text.replace(BLOCK_END, '\n\n');
  text = text.replace(ANY_TAG, ' ');
  text = decodeEntities(text);
  return text
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Whether a content type is one we reduce, read as text, or refuse. */
export function textKindOf(contentType: string | null): 'html' | 'text' | 'unsupported' {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  if (type.startsWith('text/')) return 'text';
  if (type === 'application/json' || type === 'application/xml' || type.endsWith('+json') || type.endsWith('+xml')) {
    return 'text';
  }
  // An empty content type is treated as text: a lot of small endpoints send
  // none, and the bytes are length-capped and escaped into JSON regardless.
  return type === '' ? 'text' : 'unsupported';
}
