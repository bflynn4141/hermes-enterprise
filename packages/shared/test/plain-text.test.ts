import { describe, expect, it } from 'vitest';
import { findMarkup, isPlainText, plainText, plainTextFindings } from '../src/plain-text.js';

describe('what plain text refuses', () => {
  it('refuses HTML tags', () => {
    expect(isPlainText('<img src=x onerror=alert(1)>')).toBe(false);
    expect(isPlainText('<a href="https://evil.test">the policy</a>')).toBe(false);
    expect(isPlainText('done.<br/>next')).toBe(false);
    expect(plainTextFindings('<b>hi</b>')[0]?.violation).toBe('html_tag');
  });

  it('refuses markdown links and images', () => {
    expect(isPlainText('see [the policy](https://evil.test)')).toBe(false);
    expect(isPlainText('![logo](https://evil.test/x.png)')).toBe(false);
    expect(plainTextFindings('[a](b)')[0]?.violation).toBe('markdown_link');
  });

  it('refuses angle-bracket autolinks', () => {
    expect(isPlainText('write to <mailto:ada@example.com>')).toBe(false);
    expect(isPlainText('<https://example.com>')).toBe(false);
  });

  it('refuses control characters and bidirectional overrides', () => {
    expect(isPlainText('a\u0000b')).toBe(false);
    expect(isPlainText('total: 100\u202egnidnep\u202c')).toBe(false);
  });
});

describe('what plain text allows', () => {
  it('allows a bare URL, because a citation has to be writable', () => {
    expect(isPlainText('Source: https://example.com/policy (read 2026-09-14)')).toBe(true);
  });

  it('allows ordinary punctuation, newlines and mathematics', () => {
    expect(isPlainText('Score 72/100.\nThe bar is 65.\nRatio 3 < 5 and 9 > 2.')).toBe(true);
    expect(isPlainText('Ada said "three papers" — two as first author.')).toBe(true);
  });

  it('allows a less-than that is not opening a tag', () => {
    expect(isPlainText('amount < 5,000 and > 1,000')).toBe(true);
  });
});

describe('the zod helper', () => {
  const schema = plainText({ max: 40, min: 1 });

  it('accepts plain text within the length', () => {
    expect(schema.parse('A short note.')).toBe('A short note.');
  });

  it('rejects markup with a message that says what to do instead', () => {
    const result = schema.safeParse('see <a href="x">here</a>');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain('plain text');
  });

  it('still enforces the length', () => {
    expect(schema.safeParse('x'.repeat(41)).success).toBe(false);
    expect(schema.safeParse('').success).toBe(false);
  });
});

describe('walking a payload', () => {
  it('finds markup anywhere in a nested document, and says where', () => {
    const found = findMarkup({
      kind: 'application',
      criteria: [{ label: 'Publications', evidence: 'Three papers <script>alert(1)</script>' }],
    });
    expect(found?.path).toBe('criteria.0.evidence');
    expect(found?.finding.violation).toBe('html_tag');
  });

  it('checks object keys as well as values', () => {
    expect(findMarkup({ '<b>key</b>': 'value' })?.finding.violation).toBe('html_tag');
  });

  it('returns null for a clean payload', () => {
    expect(
      findMarkup({
        kind: 'invoice',
        lines: [{ label: 'Design system audit', amount_minor: 900000 }],
        notes: 'Payable within 30 days. See https://example.com/terms',
      }),
    ).toBeNull();
  });
});
