// The Markdown subset: what it parses, and what it refuses to become.
//
// Two halves. The first is ordinary: a reply with a list is a list. The second
// is the one that matters — the parser is the allowlist, so every injection
// case here is asserted to come out as a `text` node, which the renderer puts
// in as a React child and React escapes.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { decodeEntities, hasMarkup, parseInline, parseMarkdown, type Block, type Inline } from './markdown-subset.js';
import { Markdown } from './Markdown.js';

/** Every string in a tree, in order. Injection assertions read better on this. */
function textOf(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.value;
        case 'code':
          return node.value;
        case 'link':
          return `${node.label}|${node.href}`;
        default:
          return textOf(node.children);
      }
    })
    .join('');
}

const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

describe('blocks', () => {
  it('splits paragraphs on a blank line and keeps soft breaks inside one', () => {
    const blocks = parseMarkdown('one\ntwo\n\nthree');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph']);
    expect(textOf((blocks[0] as Extract<Block, { type: 'paragraph' }>).children)).toBe('one\ntwo');
  });

  it('reads headings to h3 and folds deeper ones onto h3', () => {
    const blocks = parseMarkdown('# a\n## b\n### c\n#### d');
    expect(blocks.map((b) => (b as Extract<Block, { type: 'heading' }>).level)).toEqual([1, 2, 3, 3]);
  });

  it('reads both list kinds and keeps an ordered list’s start', () => {
    const [unordered, ordered] = parseMarkdown('- a\n- b\n\n3. c\n4. d') as [
      Extract<Block, { type: 'list' }>,
      Extract<Block, { type: 'list' }>,
    ];
    expect(unordered.ordered).toBe(false);
    expect(unordered.items.map(textOf)).toEqual(['a', 'b']);
    expect(ordered.ordered).toBe(true);
    expect(ordered.start).toBe(3);
    expect(ordered.items.map(textOf)).toEqual(['c', 'd']);
  });

  it('keeps a blockquote’s own blocks', () => {
    const [quote] = parseMarkdown('> # heading\n> and a line') as [Extract<Block, { type: 'quote' }>];
    expect(quote.type).toBe('quote');
    expect(quote.children.map((child) => child.type)).toEqual(['heading', 'paragraph']);
  });

  it('reads a pipe table, and leaves a sentence with pipes alone', () => {
    const [table] = parseMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |') as [Extract<Block, { type: 'table' }>];
    expect(table.type).toBe('table');
    expect(table.header.map(textOf)).toEqual(['a', 'b']);
    expect(table.rows.map((row) => row.map(textOf))).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
    expect(parseMarkdown('a | b is a pipe')[0]!.type).toBe('paragraph');
  });

  it('reads a fenced block with its language', () => {
    const [code] = parseMarkdown('```ts\nconst a = 1;\n```') as [Extract<Block, { type: 'code' }>];
    expect(code).toMatchObject({ type: 'code', language: 'ts', value: 'const a = 1;', closed: true });
  });
});

describe('inline', () => {
  it('reads bold, italics and inline code', () => {
    expect(parseInline('**b** *i* `c`').map((n) => n.type)).toEqual(['strong', 'text', 'em', 'text', 'code']);
  });

  it('nests emphasis inside strong', () => {
    const [strong] = parseInline('***both***') as [Extract<Inline, { type: 'strong' }>];
    expect(strong.type).toBe('strong');
    expect(strong.children[0]!.type).toBe('em');
    expect(textOf([strong])).toBe('both');
  });

  it('leaves an underscore inside a word alone', () => {
    expect(parseInline('snake_case_name').map((n) => n.type)).toEqual(['text']);
  });

  it('does not read emphasis inside a code span', () => {
    const [code] = parseInline('`**not bold**`') as [Extract<Inline, { type: 'code' }>];
    expect(code).toEqual({ type: 'code', value: '**not bold**' });
  });

  it('leaves an unterminated marker as the characters it is', () => {
    expect(textOf(parseInline('**still typ'))).toBe('**still typ');
  });
});

// ---------------------------------------------------------------------------
// The half that matters
// ---------------------------------------------------------------------------

describe('injection', () => {
  it('parses a script tag as text, and renders it escaped', () => {
    const source = '<script>alert(1)</script>';
    expect(parseInline(source)).toEqual([{ type: 'text', value: source }]);
    const rendered = html(source);
    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
  });

  it('parses an img onerror as text', () => {
    const source = '<img src=x onerror="alert(1)">';
    expect(textOf(parseInline(source))).toBe(source);
    expect(html(source)).not.toContain('<img');
  });

  it('never renders an anchor, for any link', () => {
    const rendered = html('Read [the policy](https://evil.example/p) now.');
    expect(rendered).not.toContain('<a ');
    expect(rendered).toContain('the policy');
    expect(rendered).toContain('https://evil.example/p');
  });

  it('marks a javascript: target as refused rather than showing the label alone', () => {
    const [link] = parseInline('[click me](javascript:alert(1))') as [Extract<Inline, { type: 'link' }>];
    expect(link).toMatchObject({ type: 'link', label: 'click me', href: 'javascript:alert(1' });
    const rendered = html('[click me](javascript:alert%281%29)');
    expect(rendered).toContain('md-url-refused');
    expect(rendered).not.toContain('<a ');
  });

  it('turns an image into a link node, so nothing remote is ever fetched', () => {
    const [image] = parseInline('![a beacon](https://evil.example/pixel.gif)') as [Extract<Inline, { type: 'link' }>];
    expect(image.type).toBe('link');
    expect(html('![a beacon](https://evil.example/pixel.gif)')).not.toContain('<img');
  });

  it('decodes entities into text, and the renderer escapes them again', () => {
    expect(decodeEntities('&lt;script&gt; &amp; &#39;')).toBe("<script> & '");
    const rendered = html('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
  });

  it('leaves a numeric reference to a control character as written', () => {
    expect(decodeEntities('&#0;&#x1b;')).toBe('&#0;&#x1b;');
  });

  it('renders a fenced block as code, not as markup', () => {
    const rendered = html('```\n<b>hi</b>\n```');
    expect(rendered).not.toContain('<b>hi</b>');
    expect(rendered).toContain('&lt;b&gt;');
  });

  it('renders no anchor anywhere in a reply that is nothing but links', () => {
    const rendered = html('- [a](https://a.example)\n- [b](http://b.example)\n\n<https://c.example>');
    expect(rendered).not.toContain('<a ');
  });
});

// ---------------------------------------------------------------------------
// Streaming: a partial string is a normal string
// ---------------------------------------------------------------------------

describe('partial input', () => {
  it('leaves an unclosed fence open rather than dropping it', () => {
    const [code] = parseMarkdown('```ts\nconst a =') as [Extract<Block, { type: 'code' }>];
    expect(code).toMatchObject({ type: 'code', closed: false, value: 'const a =' });
  });

  it('renders a table header with no body yet', () => {
    const [table] = parseMarkdown('| a | b |\n| --- | --- |') as [Extract<Block, { type: 'table' }>];
    expect(table.rows).toEqual([]);
  });

  it('never loses a character, at any prefix length', () => {
    const full = '# Heading\n\nSome **bold** and `code`.\n\n- one\n- two\n\n> quoted\n\n```js\nx()\n```\n';
    for (let i = 1; i <= full.length; i += 1) {
      // Every visible character survives to some node. The assertion is on the
      // text content rather than on the shape, because the shape is allowed to
      // change as the terminator arrives — the words are not.
      const prefix = full.slice(0, i);
      const rendered = html(prefix);
      const stripped = rendered.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'");
      for (const word of ['Heading', 'bold', 'one', 'quoted']) {
        if (prefix.includes(word)) expect(stripped, `prefix ${i}`).toContain(word);
      }
    }
  });
});

describe('hasMarkup', () => {
  it('is false for a plain sentence, so the ordinary reply keeps its span', () => {
    expect(hasMarkup('Two applications are pending your decision in the Inbox.')).toBe(false);
  });

  it('is true as soon as there is anything to draw', () => {
    expect(hasMarkup('- a')).toBe(true);
    expect(hasMarkup('**a**')).toBe(true);
    expect(hasMarkup('one\n\ntwo')).toBe(true);
  });
});
