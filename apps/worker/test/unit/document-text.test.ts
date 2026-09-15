// The 6,000-token cap on `get_document_text`.
//
// A tool result is model input. A 20 MB extracted PDF handed back in one call
// is a context-window error at best and a large bill at worst, so the read is
// paged: at most 6,000 estimated tokens, plus the offset to ask for next.
import { describe, expect, it } from 'vitest';
import { CHARS_PER_TOKEN, MAX_DOCUMENT_TEXT_TOKENS } from '@hermes/shared';
import { estimateTokens, pageOf } from '../../src/storage/text.js';

const lines = (count: number, width = 80): string =>
  Array.from({ length: count }, (_, i) => `${i}`.padEnd(width, 'x')).join('\n');

describe('paging extracted text', () => {
  it('returns the whole document when it fits', () => {
    const page = pageOf('a short policy document');
    expect(page.text).toBe('a short policy document');
    expect(page.nextOffset).toBeNull();
    expect(page.truncated).toBe(false);
  });

  it('never returns more than the cap, however long the document', () => {
    const long = lines(20_000);
    expect(estimateTokens(long)).toBeGreaterThan(MAX_DOCUMENT_TEXT_TOKENS * 10);
    const page = pageOf(long);
    expect(page.tokenEstimate).toBeLessThanOrEqual(MAX_DOCUMENT_TEXT_TOKENS);
    expect(page.truncated).toBe(true);
    expect(page.nextOffset).toBeGreaterThan(0);
    expect(page.totalLength).toBe(long.length);
  });

  it('honours a smaller cap when one is asked for', () => {
    const page = pageOf(lines(20_000), 0, 100);
    expect(page.tokenEstimate).toBeLessThanOrEqual(100);
  });

  it('walks the whole document in pages, losing and repeating nothing', () => {
    const long = lines(3000);
    let offset: number | null = 0;
    let rebuilt = '';
    let pages = 0;
    while (offset !== null) {
      const page: ReturnType<typeof pageOf> = pageOf(long, offset);
      rebuilt += page.text;
      offset = page.nextOffset;
      pages += 1;
      expect(pages).toBeLessThan(100); // a cap that never advances would hang
    }
    expect(pages).toBeGreaterThan(1);
    expect(rebuilt).toBe(long);
  });

  it('breaks on a line ending rather than mid-sentence', () => {
    const page = pageOf(lines(20_000));
    // Cutting a document mid-line is how a model comes to quote half a clause
    // as if it were the whole one.
    expect(page.text.endsWith('\n')).toBe(true);
  });

  it('still makes progress on a document with no line breaks at all', () => {
    const oneLine = 'x'.repeat(MAX_DOCUMENT_TEXT_TOKENS * CHARS_PER_TOKEN * 3);
    const page = pageOf(oneLine);
    expect(page.text.length).toBe(MAX_DOCUMENT_TEXT_TOKENS * CHARS_PER_TOKEN);
    expect(page.nextOffset).toBe(MAX_DOCUMENT_TEXT_TOKENS * CHARS_PER_TOKEN);
  });

  it('clamps an offset past the end rather than throwing', () => {
    const page = pageOf('short', 9999);
    expect(page.text).toBe('');
    expect(page.nextOffset).toBeNull();
  });

  it('estimates four characters to a token', () => {
    expect(estimateTokens('12345678')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });
});
