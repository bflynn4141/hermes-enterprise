// The magic-byte check, which is the whole reason `complete` streams the object
// back instead of trusting the declaration.
//
// The named case in the plan is a renamed executable: `payload.exe` uploaded as
// `notes.txt` with `mime: text/plain`. If that passes, an extraction consumer
// hands a model whatever a Mach-O header decodes to, and a workspace has a
// binary sitting in its document store labelled as notes.
import { describe, expect, it } from 'vitest';
import { sniff, SNIFF_BYTES } from '../../src/attachments/sniff.js';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('sniffing a declared type', () => {
  it('accepts a PDF that begins %PDF-', () => {
    expect(sniff('application/pdf', text('%PDF-1.7\n%âãÏÓ')).ok).toBe(true);
  });

  it('refuses a PDF that does not', () => {
    const result = sniff('application/pdf', text('Dear Admissions Committee,'));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('magic_mismatch');
  });

  it('accepts UTF-8 text and markdown, including accents and emoji', () => {
    expect(sniff('text/plain', text('Leah Martínez — 2026 cohort ✓')).ok).toBe(true);
    expect(sniff('text/markdown', text('# Policy\n\n* one\n* two\n')).ok).toBe(true);
  });

  it('refuses a renamed executable declared as text', () => {
    // Mach-O, ELF, and a Windows PE: the three things a "notes.txt" is not.
    for (const head of [
      bytes(0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01),
      bytes(0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00),
      bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00),
    ]) {
      const result = sniff('text/plain', head);
      expect(result.ok, `${head[0]} was accepted as text`).toBe(false);
      expect(result.reason).toBe('magic_mismatch');
    }
  });

  it('refuses a zip — and therefore a .docx or a .jar — declared as text', () => {
    const result = sniff('text/markdown', bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00));
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('zip');
  });

  it('refuses a PDF declared as text, which is the mistake, not the attack', () => {
    expect(sniff('text/plain', text('%PDF-1.4')).ok).toBe(false);
  });

  it('refuses text containing a NUL byte, which no text file has', () => {
    expect(sniff('text/plain', bytes(0x68, 0x69, 0x00, 0x68)).ok).toBe(false);
  });

  it('refuses invalid UTF-8 rather than substituting replacement characters', () => {
    // A lone continuation byte. A non-fatal decoder would turn this into U+FFFD
    // and call it text, which is how any byte sequence becomes "valid".
    expect(sniff('text/plain', bytes(0x41, 0x80, 0x42)).ok).toBe(false);
  });

  it('does not call a valid file invalid because the window cut a character', () => {
    // A 4 KB window through a UTF-8 file almost always lands inside a
    // multi-byte sequence; a strict decoder with no truncation handling would
    // reject every accented document over 4 KB.
    const long = '—'.repeat(SNIFF_BYTES);
    const head = new TextEncoder().encode(long).subarray(0, SNIFF_BYTES);
    expect(head[SNIFF_BYTES - 1]).not.toBe(0x97); // the window really does cut one
    expect(sniff('text/plain', head).ok).toBe(true);
  });

  it('refuses a type that has no extraction path at all', () => {
    const result = sniff('image/png', bytes(0x89, 0x50, 0x4e, 0x47));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unsupported_mime');
  });
});
