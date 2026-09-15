// A safe subset of Markdown, parsed to a tree the renderer can only turn into
// elements it knows about.
//
// Why a parser rather than a library. Every Markdown library worth using ships
// a raw-HTML passthrough and a link renderer, and both are switched on by
// default; turning them off is a configuration line that somebody removes the
// day they want a table to have a `<br>` in it. Here there is nothing to turn
// off: the node union below has no HTML node and no anchor node, so the worst a
// model can do with a `<script>` is have it rendered as the nine characters it
// is. The parser is the allowlist.
//
// What is in the subset, and why each one:
//
//   paragraphs, headings ≤ h3   structure a reply actually uses
//   bold, italic, inline code   emphasis inside a sentence
//   fenced code                 the library's CodeBlock renders it
//   ordered / unordered lists   the shape almost every reply reaches for
//   blockquotes                 quoting the document being discussed
//   simple tables               pipe tables, header row and body
//
// What is deliberately out:
//
//   raw HTML          there is no node for it; it is text (see above)
//   links as anchors  a `link` node carries its label and its href, and the
//                     renderer draws the label as text beside a non-interactive
//                     chip showing the bare URL. An anchor to a host the model
//                     chose is the one thing the plain-text rule was written to
//                     stop (plan §4, "no markdown links"), and a reply is not a
//                     safer place for it than a review note (decision C39).
//   images            same reasoning, and a remote image is also a beacon
//   nested lists      one level. A second level is a shape to add when a reply
//                     needs it, not a guess made in advance
//   footnotes, html entities beyond the five below, setext headings, tasklists
//
// ## Streaming
//
// `parseMarkdown` is a pure function of the accumulated text, called on every
// delta. Partial input is the normal case, not an error case: an unterminated
// fence is a code block that is still open (`closed: false`), an unterminated
// `**` is literal text, and a table with only its header row is a table with no
// body. Nothing waits for a terminator, so nothing pops into place when one
// arrives — the block only grows.

export type Inline =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'strong'; readonly children: readonly Inline[] }
  | { readonly type: 'em'; readonly children: readonly Inline[] }
  | { readonly type: 'code'; readonly value: string }
  /** Rendered as `label`, plus a chip showing `href`. Never an anchor. */
  | { readonly type: 'link'; readonly label: string; readonly href: string };

export type Block =
  | { readonly type: 'paragraph'; readonly children: readonly Inline[] }
  | { readonly type: 'heading'; readonly level: 1 | 2 | 3; readonly children: readonly Inline[] }
  | { readonly type: 'list'; readonly ordered: boolean; readonly start: number; readonly items: readonly (readonly Inline[])[] }
  | { readonly type: 'code'; readonly language: string | null; readonly value: string; readonly closed: boolean }
  | { readonly type: 'quote'; readonly children: readonly Block[] }
  | { readonly type: 'table'; readonly header: readonly (readonly Inline[])[]; readonly rows: readonly (readonly (readonly Inline[])[])[] };

/**
 * The five named entities, and numeric references.
 *
 * Decoded rather than left literal, because `&lt;script&gt;` left literal reads
 * as a bug and decoded reads as what the model wrote. Decoding is safe here in
 * a way it is not in an HTML pipeline: the result is a `text` node, and the
 * renderer puts a text node in as a React child, which escapes it again. There
 * is no point in this file where a string becomes markup.
 */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body.startsWith('#x') || body.startsWith('#X') ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      // Surrogates, out-of-range and the C0 range are left as written: a
      // numeric reference to a control character is not something a reply
      // needs, and `String.fromCodePoint` throws on the invalid ones.
      if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
      return String.fromCodePoint(code);
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** `http` and `https` only. Anything else is shown as the text it was. */
export function isDisplayableUrl(href: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(href.trim());
}

const text = (value: string): Inline => ({ type: 'text', value: decodeEntities(value) });

/**
 * Inline parsing, in one left-to-right pass.
 *
 * Order matters and is the usual one: code spans win over everything, because
 * `` `**not bold**` `` is a code span; then links, so `[**a**](x)`'s brackets
 * are not eaten by emphasis; then strong, then emphasis, so `***a***` is strong
 * wrapping emphasis rather than three separate openers.
 */
export function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let buffer = '';
  const flush = (): void => {
    if (buffer) out.push(text(buffer));
    buffer = '';
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    // `code` and ``code with ` in it``
    const code = /^(`+)([\s\S]*?)\1(?!`)/.exec(rest);
    if (code) {
      flush();
      // Code spans are the one place entities are not decoded: the point of a
      // code span is that it is what it says.
      out.push({ type: 'code', value: code[2]!.replace(/^ (.*) $/, '$1') });
      i += code[0].length;
      continue;
    }

    // [label](href) — and the image form, which loses its bang and becomes a
    // link, because there is no image node.
    const link = /^!?\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+"[^"]*")?\s*\)/.exec(rest);
    if (link) {
      flush();
      const label = decodeEntities(link[1] ?? '');
      const href = decodeEntities(link[2] ?? '');
      out.push({ type: 'link', label, href });
      i += link[0].length;
      continue;
    }

    // `***a***` before `**a**`, because the lazy `**` match would otherwise
    // close on the first two of the three closing stars and leave a stray one.
    const both = /^(\*\*\*|___)(?=\S)([\s\S]+?)(?<=\S)\1/.exec(rest);
    if (both) {
      flush();
      out.push({ type: 'strong', children: [{ type: 'em', children: parseInline(both[2]!) }] });
      i += both[0].length;
      continue;
    }

    const strong = /^(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/.exec(rest);
    if (strong) {
      flush();
      out.push({ type: 'strong', children: parseInline(strong[2]!) });
      i += strong[0].length;
      continue;
    }

    // `_` only between non-word characters, so `snake_case_name` is one word.
    const em = /^(\*)(?=\S)([\s\S]+?)(?<=\S)\1|^(_)(?=\S)([\s\S]+?)(?<=\S)\3(?![A-Za-z0-9])/.exec(rest);
    if (em && (em[1] === '*' || i === 0 || !/[A-Za-z0-9]/.test(source[i - 1]!))) {
      flush();
      out.push({ type: 'em', children: parseInline((em[2] ?? em[4])!) });
      i += em[0].length;
      continue;
    }

    // An escape: `\*` is a star.
    if (rest[0] === '\\' && rest.length > 1 && /[\\`*_{}[\]()#+\-.!|>]/.test(rest[1]!)) {
      buffer += rest[1];
      i += 2;
      continue;
    }

    buffer += rest[0];
    i += 1;
  }
  flush();
  return out;
}

const FENCE = /^\s{0,3}(```|~~~)\s*([A-Za-z0-9_+.#-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const BULLET = /^(\s{0,3})([-*+])\s+(.*)$/;
const ORDERED = /^(\s{0,3})(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** `| a | b |` → `['a', 'b']`, tolerant of the outer pipes being absent. */
function splitRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
}

const isTableRow = (line: string): boolean => line.includes('|') && line.trim().length > 0;

/**
 * Block parsing.
 *
 * A single pass over the lines with no lookahead beyond the next line, so that
 * the same function is correct on a complete reply and on the first forty
 * characters of one.
 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const closeParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', children: parseInline(paragraph.join('\n')) });
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const fence = FENCE.exec(line);
    if (fence) {
      closeParagraph();
      const marker = fence[1]!;
      const body: string[] = [];
      let closed = false;
      i += 1;
      while (i < lines.length) {
        const candidate = lines[i]!;
        if (new RegExp(`^\\s{0,3}${marker}\\s*$`).test(candidate)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(candidate);
        i += 1;
      }
      blocks.push({ type: 'code', language: fence[2] ? fence[2] : null, value: body.join('\n'), closed });
      continue;
    }

    if (line.trim() === '') {
      closeParagraph();
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      closeParagraph();
      // h4 and below are folded onto h3 rather than dropped: the words are
      // still the model's, and a reply with a fourth level is a reply with a
      // flatter shape than it wanted, not a reply with a missing sentence.
      const level = Math.min(3, heading[1]!.length) as 1 | 2 | 3;
      blocks.push({ type: 'heading', level, children: parseInline(heading[2]!.replace(/\s+#+\s*$/, '')) });
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      closeParagraph();
      const body: string[] = [quote[1] ?? ''];
      i += 1;
      while (i < lines.length) {
        const inner = QUOTE.exec(lines[i]!);
        if (!inner) break;
        body.push(inner[1] ?? '');
        i += 1;
      }
      blocks.push({ type: 'quote', children: parseMarkdown(body.join('\n')) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      closeParagraph();
      const isOrdered = Boolean(ordered);
      const start = ordered ? Number.parseInt(ordered[2]!, 10) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const candidate = lines[i]!;
        const nextBullet = BULLET.exec(candidate);
        const nextOrdered = ORDERED.exec(candidate);
        if (nextBullet && !isOrdered) {
          items.push(nextBullet[3]!);
          i += 1;
        } else if (nextOrdered && isOrdered) {
          items.push(nextOrdered[3]!);
          i += 1;
        } else if (items.length > 0 && candidate.trim() !== '' && /^\s{2,}/.test(candidate) && !FENCE.test(candidate)) {
          // A lazy continuation line belongs to the item above it.
          items[items.length - 1] += `\n${candidate.trim()}`;
          i += 1;
        } else break;
      }
      blocks.push({ type: 'list', ordered: isOrdered, start, items: items.map((item) => parseInline(item)) });
      continue;
    }

    // A table is a row whose *next* line is the divider. Without the divider it
    // is a paragraph that happens to contain pipes, which is what a sentence
    // about a pipe is.
    if (isTableRow(line) && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      closeParagraph();
      const header = splitRow(line).map((cell) => parseInline(cell));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && isTableRow(lines[i]!)) {
        rows.push(splitRow(lines[i]!).map((cell) => parseInline(cell)));
        i += 1;
      }
      blocks.push({ type: 'table', header, rows });
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  closeParagraph();
  return blocks;
}

/**
 * Is there anything here a renderer would draw differently from `<span>`?
 *
 * The transcript uses this to leave an ordinary one-paragraph reply on the
 * plain `white-space: pre-wrap` path it has always been on, so that the common
 * case keeps its exact typography and the Markdown path is only entered by a
 * reply that actually has structure.
 */
export function hasMarkup(source: string): boolean {
  const blocks = parseMarkdown(source);
  if (blocks.length !== 1) return blocks.length > 1;
  const only = blocks[0]!;
  if (only.type !== 'paragraph') return true;
  return only.children.some((node) => node.type !== 'text');
}
