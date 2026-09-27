// Email HTML → something a reviewer can safely look at, and the exact words the
// agent is allowed to read.
//
// Every email-agent incident in the research behind decision C98 leaked data or
// phished the reader without the agent sending anything: an image that loaded
// by itself (EchoLeak, Superhuman), text hidden with CSS that only the model
// could "see" (Gemini's summary phishing), a link whose words and destination
// disagreed. So this module is not a cleaner that edits the sender's markup. It
// reads the markup as tokens and writes a new, well-nested document from an
// allowlist:
//
//   * scripts, styles, forms, frames, media and SVG are dropped with their
//     contents, because a `<style>` stripped of its tags is its contents;
//   * content hidden with inline CSS or the `hidden` attribute is dropped and
//     counted, so the reviewer and the agent read the same words;
//   * no element keeps an `href` or a remote `src`: a link becomes its words
//     plus its real destination as plain text, and a remote image becomes a
//     short placeholder. Nothing in the output can make a network request;
//   * sender-controlled color, size and spacing are removed. Only enumerated
//     emphasis/alignment values survive, so retained text stays readable.
//
// The client renders `html` inside a sandboxed iframe with a Content Security
// Policy that forbids scripts and every remote load, so a mistake here still
// cannot run code or fetch anything. This file is the first wall, not the only
// one.
//
// It is deliberately a small tokenizer rather than a DOM: Workers have no DOM,
// and HTMLRewriter cannot run in the Node unit project that tests this. Its
// failure mode on odd markup is odd formatting, never an emitted tag or
// attribute that is not on the allowlist, because nothing is copied through.

export interface SanitizedLink {
  readonly href: string;
  readonly text: string;
  /** The words look like a web address that is not where the link goes. */
  readonly mismatch: boolean;
}

export interface SanitizedEmail {
  readonly html: string;
  readonly text: string;
  readonly hiddenTextRemovedChars: number;
  readonly remoteImagesBlocked: number;
  readonly links: readonly SanitizedLink[];
}

export interface InlineImage {
  /** Content-ID without angle brackets. */
  readonly contentId: string;
  readonly mimeType: string;
  readonly base64: string;
}

const MAX_HTML = 500_000;
const MAX_TEXT = 200_000;
const MAX_LINKS = 200;
const MAX_INLINE_IMAGE_BASE64 = 280_000; // ~200 KB decoded

/** Removed together with everything inside them. */
const DROP_WITH_CONTENT = new Set([
  'head', 'title', 'script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'applet', 'video', 'audio', 'canvas', 'form', 'select', 'textarea', 'button', 'map',
  'noembed', 'noframes', 'xmp', 'plaintext', 'dialog', 'portal',
]);

/** Their contents are raw text until the matching end tag. */
const RAWTEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);

/** Written to the output under the same name. Anything else is unwrapped. */
const ALLOWED = new Set([
  'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'col', 'colgroup', 'dd', 'del', 'div', 'dl', 'dt',
  'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q',
  's', 'samp', 'span', 'strike', 'strong', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'tr', 'u', 'ul',
]);
/** Legacy tags written as a neutral equivalent. */
const RENAMED: Readonly<Record<string, string>> = {
  font: 'span', center: 'div', a: 'span', tt: 'code', big: 'span',
  // Repeated relative-size tags can conceal text even without CSS.
  small: 'span', sub: 'span', sup: 'span',
};

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'center', 'dd', 'div', 'dl', 'dt', 'footer', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul',
]);

const ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  '*': new Set(['align', 'dir']),
  img: new Set(['alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan', 'valign', 'width', 'height']),
  th: new Set(['colspan', 'rowspan', 'valign', 'width', 'height']),
  table: new Set(['width', 'cellpadding', 'cellspacing', 'border']),
  tr: new Set(['valign']),
  col: new Set(['span', 'width']),
  colgroup: new Set(['span', 'width']),
  ol: new Set(['start', 'type']),
};

// Never retain arbitrary CSS values: even network-free CSS can hide words.
const STYLE_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  'font-weight': new Set(['normal', 'bold', '500', '600', '700', '800', '900']),
  'font-style': new Set(['normal', 'italic', 'oblique']),
  'text-align': new Set(['left', 'right', 'center', 'justify']),
  'border-collapse': new Set(['collapse', 'separate']),
};

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bull: '•', middot: '·',
  laquo: '«', raquo: '»', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', times: '×', divide: '÷',
  zwnj: '‌', zwj: '‍', shy: '­', ensp: ' ', emsp: ' ', thinsp: ' ',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});?/giu, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

export const escapeHtml = (value: string): string =>
  value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'start'; readonly name: string; readonly attrs: ReadonlyMap<string, string>; readonly selfClosing: boolean }
  | { readonly type: 'end'; readonly name: string };

function* tokenize(html: string): Generator<Token> {
  const length = html.length;
  let index = 0;
  let textStart = 0;
  const flushText = function* (end: number): Generator<Token> {
    if (end > textStart) yield { type: 'text', value: html.slice(textStart, end) };
  };
  while (index < length) {
    if (html[index] !== '<') { index += 1; continue; }
    const next = html[index + 1] ?? '';
    if (html.startsWith('<!--', index)) {
      yield* flushText(index);
      const close = html.indexOf('-->', index + 4);
      index = close === -1 ? length : close + 3;
      textStart = index;
      continue;
    }
    if (next === '!' || next === '?') {
      yield* flushText(index);
      const close = html.indexOf('>', index + 2);
      index = close === -1 ? length : close + 1;
      textStart = index;
      continue;
    }
    const isEnd = next === '/';
    const nameStart = index + (isEnd ? 2 : 1);
    if (!/[A-Za-z]/u.test(html[nameStart] ?? '')) { index += 1; continue; }
    yield* flushText(index);
    let cursor = nameStart;
    while (cursor < length && !/[\s/>]/u.test(html[cursor]!)) cursor += 1;
    const name = html.slice(nameStart, cursor).toLowerCase();
    const attrs = new Map<string, string>();
    let selfClosing = false;
    // Attributes, per the HTML tokenizer's rules closely enough for email.
    while (cursor < length && html[cursor] !== '>') {
      const char = html[cursor]!;
      if (/\s/u.test(char)) { cursor += 1; continue; }
      if (char === '/') { selfClosing = html[cursor + 1] === '>'; cursor += 1; continue; }
      const attrStart = cursor;
      while (cursor < length && !/[\s/>=]/u.test(html[cursor]!)) cursor += 1;
      const attrName = html.slice(attrStart, cursor).toLowerCase();
      while (cursor < length && /\s/u.test(html[cursor]!)) cursor += 1;
      let value = '';
      if (html[cursor] === '=') {
        cursor += 1;
        while (cursor < length && /\s/u.test(html[cursor]!)) cursor += 1;
        const quote = html[cursor];
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, cursor + 1);
          const end = close === -1 ? length : close;
          value = html.slice(cursor + 1, end);
          cursor = end + 1;
        } else {
          const valueStart = cursor;
          while (cursor < length && !/[\s>]/u.test(html[cursor]!)) cursor += 1;
          value = html.slice(valueStart, cursor);
        }
      }
      if (attrName && !attrs.has(attrName)) attrs.set(attrName, decodeEntities(value));
    }
    index = cursor + 1;
    textStart = index;
    if (isEnd) {
      yield { type: 'end', name };
      continue;
    }
    yield { type: 'start', name, attrs, selfClosing };
    if (RAWTEXT.has(name)) {
      if (name === 'plaintext') { index = length; textStart = length; continue; }
      const closing = new RegExp(`</${name}[\\s/>]`, 'iu');
      const rest = html.slice(index);
      const match = closing.exec(rest);
      const end = match ? index + match.index : length;
      if (end > index) yield { type: 'text', value: html.slice(index, end) };
      yield { type: 'end', name };
      if (match) {
        const close = html.indexOf('>', end);
        index = close === -1 ? length : close + 1;
      } else {
        index = length;
      }
      textStart = index;
    }
  }
  yield* flushText(length);
}

// ---------------------------------------------------------------------------
// Style and visibility
// ---------------------------------------------------------------------------

function parseStyle(value: string): Map<string, string> {
  const declarations = new Map<string, string>();
  // Comments and escapes are how CSS filters are evaded; neither is legitimate
  // in an email's inline style often enough to keep.
  const cleaned = value.replace(/\/\*[\s\S]*?\*\//gu, '');
  for (const part of cleaned.split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const propertyValue = part.slice(colon + 1).trim().replace(/\s*!important\s*$/iu, '');
    if (property && propertyValue) declarations.set(property, propertyValue);
  }
  return declarations;
}

const ZERO_SIZE = /^(?:0|0?\.0+|0(?:\.0+)?(?:px|pt|em|rem|%)|[01](?:\.\d+)?px|0?\.\d+(?:pt|em|rem))$/iu;

/** Whether inline CSS or an attribute hides this element from a human reader. */
export function hiddenByMarkup(attrs: ReadonlyMap<string, string>): boolean {
  if (attrs.has('hidden')) return true;
  const style = parseStyle(attrs.get('style') ?? '');
  const display = style.get('display')?.toLowerCase();
  if (display === 'none') return true;
  const visibility = style.get('visibility')?.toLowerCase();
  if (visibility === 'hidden' || visibility === 'collapse') return true;
  if (style.get('mso-hide')?.toLowerCase() === 'all') return true;
  const opacity = style.get('opacity');
  if (opacity !== undefined && Number.parseFloat(opacity) <= 0.05) return true;
  const fontSize = style.get('font-size');
  if (fontSize !== undefined && ZERO_SIZE.test(fontSize.trim())) return true;
  const color = style.get('color')?.toLowerCase().replace(/\s+/gu, '');
  if (color === 'transparent' || color === 'rgba(0,0,0,0)') return true;
  const overflowHidden = style.get('overflow')?.toLowerCase() === 'hidden';
  for (const dimension of ['height', 'max-height', 'width', 'max-width']) {
    const size = style.get(dimension);
    if (overflowHidden && size !== undefined && ZERO_SIZE.test(size.trim())) return true;
  }
  const clip = style.get('clip')?.toLowerCase().replace(/\s+/gu, '');
  if (clip === 'rect(0,0,0,0)' || clip === 'rect(0px,0px,0px,0px)') return true;
  const indent = style.get('text-indent');
  if (indent !== undefined && /^-\d{3,}/u.test(indent.trim())) return true;
  const position = style.get('position')?.toLowerCase();
  const offset = (style.get('left') ?? style.get('top') ?? '').trim();
  if ((position === 'absolute' || position === 'fixed') && /^-\d{3,}/u.test(offset)) return true;
  return false;
}

function safeStyle(value: string): string | null {
  const kept: string[] = [];
  for (const [property, propertyValue] of parseStyle(value)) {
    const normalized = propertyValue.trim().toLowerCase();
    if (!Object.hasOwn(STYLE_VALUES, property) || !STYLE_VALUES[property]!.has(normalized)) continue;
    kept.push(`${property}:${normalized}`);
    if (kept.length >= 24) break;
  }
  return kept.length > 0 ? kept.join(';') : null;
}

function safeAttributeValue(name: string, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > 200) return null;
  if (['width', 'height', 'colspan', 'rowspan', 'span', 'cellpadding', 'cellspacing', 'border', 'start'].includes(name)) {
    return /^\d{1,4}%?$/u.test(trimmed) ? trimmed : null;
  }
  if (name === 'align') return /^(left|right|center|justify)$/iu.test(trimmed) ? trimmed.toLowerCase() : null;
  if (name === 'valign') return /^(top|middle|bottom|baseline)$/iu.test(trimmed) ? trimmed.toLowerCase() : null;
  if (name === 'dir') return /^(ltr|rtl|auto)$/iu.test(trimmed) ? trimmed.toLowerCase() : null;
  if (name === 'type') return /^[1aAiI]$/u.test(trimmed) ? trimmed : null;
  if (name === 'alt') return trimmed;
  return null;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** The destination a reviewer should see, or null when it is not a web or mail link. */
export function normalizeHref(value: string): string | null {
  // Browsers ignore tabs and newlines inside URLs, which is how `java\nscript:`
  // gets past a naive prefix check. Remove them before deciding anything.
  const compact = value.replace(/[\u0000- \u007f]+/gu, '');
  if (!compact) return null;
  try {
    const url = new URL(compact);
    if (url.protocol === 'mailto:') return url.href.slice(0, 2000);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    return url.href.slice(0, 2000);
  } catch {
    return null;
  }
}

const hostOf = (value: string): string | null => {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/iu.test(value) ? value : `https://${value}`);
    return url.hostname.toLowerCase().replace(/^www\./u, '');
  } catch {
    return null;
  }
};

/** Link words that name a web address (`paypal.com/login`, `https://x.y`). */
const LOOKS_LIKE_URL = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/:?#]\S*)?$/iu;

export function linkMismatch(text: string, href: string): boolean {
  const words = text.trim();
  if (!LOOKS_LIKE_URL.test(words) || href.startsWith('mailto:')) return false;
  const shown = hostOf(words);
  const actual = hostOf(href);
  return shown !== null && actual !== null && shown !== actual;
}

// ---------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------

interface Frame {
  readonly name: string;
  /** The tag written for this element, or null when it was unwrapped. */
  readonly written: string | null;
  readonly suppressed: 'none' | 'hidden' | 'dropped';
  readonly link: { href: string | null; text: string } | null;
}

export function sanitizeEmailHtml(html: string, inlineImages: readonly InlineImage[] = []): SanitizedEmail {
  const images = new Map(inlineImages.map((image) => [image.contentId.toLowerCase(), image]));
  const out: string[] = [];
  const text: string[] = [];
  const links: SanitizedLink[] = [];
  const stack: Frame[] = [];
  let hiddenChars = 0;
  let remoteImages = 0;
  let outLength = 0;
  let htmlOverflow = false;

  const suppression = (): Frame['suppressed'] => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const state = stack[index]!.suppressed;
      if (state !== 'none') return state;
    }
    return 'none';
  };
  const openLink = (): Frame['link'] => {
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      const link = stack[index]!.link;
      if (link) return link;
    }
    return null;
  };
  const write = (value: string): void => {
    if (htmlOverflow || outLength + value.length > MAX_HTML) {
      htmlOverflow = true;
      return;
    }
    out.push(value);
    outLength += value.length;
  };
  const breakLine = (): void => { text.push('\n'); };

  const closeFrame = (frame: Frame): void => {
    // The destination is written after the link's own closing tag, so it is
    // plain text beside the words rather than part of something that looks
    // clickable.
    let destination: string | null = null;
    if (frame.link && frame.suppressed === 'none' && suppression() === 'none') {
      const words = frame.link.text.replace(/\s+/gu, ' ').trim();
      if (frame.link.href) {
        const mismatch = linkMismatch(words, frame.link.href);
        if (links.length < MAX_LINKS) links.push({ href: frame.link.href, text: words.slice(0, 500), mismatch });
        const shown = frame.link.href.replace(/^mailto:/u, '');
        if (words !== shown && words !== frame.link.href) destination = shown;
      }
    }
    if (frame.written) write(`</${frame.written}>`);
    if (destination !== null) {
      write(`<span class="hermes-link-destination"> (${escapeHtml(destination)})</span>`);
      text.push(` (${destination})`);
    }
    // A list item already started its own line; ending it again would leave
    // a blank line between every item.
    if (BLOCK.has(frame.name) && frame.name !== 'li' && frame.suppressed === 'none') breakLine();
  };

  for (const token of tokenize(html)) {
    if (token.type === 'text') {
      const decoded = decodeEntities(token.value);
      const state = suppression();
      if (state === 'hidden') {
        hiddenChars += decoded.replace(/\s+/gu, '').length;
        continue;
      }
      if (state === 'dropped') continue;
      write(escapeHtml(decoded));
      text.push(decoded);
      const link = openLink();
      if (link) link.text += decoded;
      continue;
    }

    if (token.type === 'end') {
      if (VOID.has(token.name)) continue;
      let match = -1;
      for (let index = stack.length - 1; index >= 0; index -= 1) {
        if (stack[index]!.name === token.name) { match = index; break; }
      }
      if (match === -1) continue;
      while (stack.length > match) closeFrame(stack.pop()!);
      continue;
    }

    const { name, attrs } = token;
    const inherited = suppression();
    if (name === 'br') {
      if (inherited === 'none') { write('<br>'); breakLine(); }
      continue;
    }
    if (name === 'img') {
      if (inherited !== 'none') continue;
      const src = (attrs.get('src') ?? '').trim();
      const alt = (attrs.get('alt') ?? '').trim().slice(0, 200);
      const cid = /^cid:(.+)$/iu.exec(src)?.[1]?.replace(/^<|>$/gu, '').toLowerCase();
      const inline = cid ? images.get(cid) : undefined;
      const dataUrl = /^data:image\/(png|jpe?g|gif|webp);base64,([a-z0-9+/=\s]+)$/iu.exec(src);
      let source: string | null = null;
      if (inline && /^image\/(png|jpe?g|gif|webp)$/iu.test(inline.mimeType) && inline.base64.length <= MAX_INLINE_IMAGE_BASE64) {
        source = `data:${inline.mimeType.toLowerCase()};base64,${inline.base64}`;
      } else if (dataUrl && dataUrl[2]!.length <= MAX_INLINE_IMAGE_BASE64) {
        source = `data:image/${dataUrl[1]!.toLowerCase()};base64,${dataUrl[2]!.replace(/\s+/gu, '')}`;
      }
      if (source) {
        const width = safeAttributeValue('width', attrs.get('width') ?? '');
        const height = safeAttributeValue('height', attrs.get('height') ?? '');
        write(`<img src="${escapeHtml(source)}" alt="${escapeHtml(alt)}"${width ? ` width="${width}"` : ''}${height ? ` height="${height}"` : ''}>`);
        continue;
      }
      if (/^https?:/iu.test(src) || src.startsWith('//')) {
        remoteImages += 1;
        const tiny = ['width', 'height'].some((dimension) => /^[01]$/u.test((attrs.get(dimension) ?? '').trim()));
        if (tiny) continue; // a tracking pixel: counted, never shown
        const host = hostOf(src.startsWith('//') ? `https:${src}` : src) ?? 'another site';
        write(`<span class="hermes-image-blocked">Image not shown${alt ? `: ${escapeHtml(alt)}` : ''} (from ${escapeHtml(host)})</span>`);
      } else if (alt) {
        write(`<span class="hermes-image-blocked">[Image: ${escapeHtml(alt)}]</span>`);
      }
      continue;
    }
    if (VOID.has(name)) {
      if (name === 'hr' && inherited === 'none') { write('<hr>'); breakLine(); }
      continue;
    }

    const dropped = DROP_WITH_CONTENT.has(name);
    const hidden = !dropped && inherited === 'none' && hiddenByMarkup(attrs);
    const suppressed: Frame['suppressed'] = dropped ? 'dropped' : hidden ? 'hidden' : 'none';
    const visible = inherited === 'none' && suppressed === 'none';
    const written = visible ? (ALLOWED.has(name) ? name : RENAMED[name] ?? null) : null;
    const link = name === 'a' && visible
      ? { href: normalizeHref(attrs.get('href') ?? ''), text: '' }
      : null;
    if (visible && BLOCK.has(name)) breakLine();
    if (visible && name === 'li') text.push('• ');
    if (written) {
      const parts: string[] = [written];
      const allowed = new Set([...ALLOWED_ATTRIBUTES['*']!, ...(ALLOWED_ATTRIBUTES[name] ?? [])]);
      for (const [attribute, value] of attrs) {
        if (!allowed.has(attribute)) continue;
        const clean = safeAttributeValue(attribute, value);
        if (clean !== null) parts.push(`${attribute}="${escapeHtml(clean)}"`);
      }
      const style = attrs.has('style') ? safeStyle(attrs.get('style')!) : null;
      if (style) parts.push(`style="${escapeHtml(style)}"`);
      if (name === 'a') parts.push('class="hermes-link"');
      write(`<${parts.join(' ')}>`);
    }
    stack.push({ name, written, suppressed, link });
    if (token.selfClosing && !ALLOWED.has(name) && !RENAMED[name]) {
      // `<foo/>` in HTML is an open tag; only foreign elements self-close. We
      // treat it as closed so an unknown self-closed wrapper cannot swallow
      // the rest of the message into a hidden or dropped frame.
      closeFrame(stack.pop()!);
    }
  }
  while (stack.length > 0) closeFrame(stack.pop()!);

  const visibleText = tidyText(text.join(''));
  // Never display a sliced document while giving the model unseen tail text.
  // Empty HTML selects the plain-text view in every email surface.
  return {
    html: htmlOverflow || visibleText.length > MAX_TEXT ? '' : out.join(''),
    text: visibleText.slice(0, MAX_TEXT),
    hiddenTextRemovedChars: hiddenChars,
    remoteImagesBlocked: remoteImages,
    links,
  };
}

/** Collapse the whitespace a layout table leaves behind, keeping paragraph breaks. */
export function tidyText(value: string): string {
  return value
    .replace(/ /gu, ' ')
    .replace(/[​‌‍⁠﻿­]/gu, '')
    .split('\n')
    .map((line) => line.replace(/[\t ]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/giu;

/** A plain-text message: nothing to render, but its links are still listed. */
export function plainTextEmail(value: string): SanitizedEmail {
  const text = tidyText(value.replace(/\r\n?/gu, '\n')).slice(0, MAX_TEXT);
  const links: SanitizedLink[] = [];
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const href = normalizeHref(match[0]);
    if (href && links.length < MAX_LINKS) links.push({ href, text: match[0], mismatch: false });
  }
  return { html: '', text, hiddenTextRemovedChars: 0, remoteImagesBlocked: 0, links };
}
