// What is actually in the file.
//
// The client declares a name, a size and a MIME type. All three are the
// client's opinion, and a rename is the oldest trick there is: `payload.exe`
// becomes `notes.txt`, the declared type says `text/plain`, and whatever reads
// it next decides for itself what it is holding. So `complete` streams the
// object back out of R2, looks at the first bytes, and refuses anything that
// disagrees with the declaration — then deletes the object, because an object
// we refused to account for must not survive the refusal.
//
// Two rules, one per family:
//
//   application/pdf     must begin `%PDF-`.
//   text/*              must be valid UTF-8 with no NUL and no stray control
//                       bytes, and must not begin with an executable or
//                       archive magic number.
//
// The text rule is the interesting one: there is no positive magic number for
// "this is text", so the check is that it decodes and contains nothing a text
// file never contains. That refuses a renamed ELF binary, a Mach-O, a PE, a zip
// (and therefore a .docx or a .jar), gzip, and any UTF-16 file, whose NUL bytes
// would otherwise reach a model as mojibake.

/** Enough bytes for every magic number below, and for a UTF-8 validity read. */
export const SNIFF_BYTES = 4096;

export interface SniffResult {
  readonly ok: boolean;
  /** Machine-readable, because the client keys its copy off it. */
  readonly reason?: string;
  readonly detail?: string;
}

const startsWith = (head: Uint8Array, bytes: readonly number[]): boolean =>
  bytes.every((byte, index) => head[index] === byte);

/** Magic numbers a text file is definitely not. Named, so a reader can check. */
const BINARY_SIGNATURES: readonly { name: string; bytes: readonly number[] }[] = [
  { name: 'PE/DOS executable', bytes: [0x4d, 0x5a] }, // MZ
  { name: 'ELF executable', bytes: [0x7f, 0x45, 0x4c, 0x46] },
  { name: 'Mach-O executable', bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { name: 'Mach-O executable', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { name: 'Mach-O executable', bytes: [0xcf, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O executable', bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { name: 'Mach-O universal binary', bytes: [0xca, 0xfe, 0xba, 0xbe] },
  { name: 'zip archive', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { name: 'zip archive', bytes: [0x50, 0x4b, 0x05, 0x06] },
  { name: 'gzip archive', bytes: [0x1f, 0x8b] },
  { name: 'PDF', bytes: [0x25, 0x50, 0x44, 0x46] }, // a PDF declared as text
  { name: 'PNG image', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: 'JPEG image', bytes: [0xff, 0xd8, 0xff] },
  { name: 'UTF-16 text', bytes: [0xff, 0xfe] },
  { name: 'UTF-16 text', bytes: [0xfe, 0xff] },
];

/** Control bytes a text file may contain: tab, newline, carriage return, form feed. */
const ALLOWED_CONTROL = new Set([0x09, 0x0a, 0x0d, 0x0c, 0x1b]);

function looksLikeText(head: Uint8Array): SniffResult {
  for (const signature of BINARY_SIGNATURES) {
    if (startsWith(head, signature.bytes)) {
      return { ok: false, reason: 'magic_mismatch', detail: `declared as text, begins with a ${signature.name}` };
    }
  }
  for (const byte of head) {
    if (byte === 0) return { ok: false, reason: 'magic_mismatch', detail: 'declared as text, contains a NUL byte' };
    if (byte < 0x20 && !ALLOWED_CONTROL.has(byte)) {
      return { ok: false, reason: 'magic_mismatch', detail: 'declared as text, contains control bytes' };
    }
  }
  try {
    // `fatal` is the whole point: a decoder that substitutes U+FFFD would
    // accept any byte sequence at all.
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(head.subarray(0, truncateToCodePoint(head)));
  } catch {
    return { ok: false, reason: 'magic_mismatch', detail: 'declared as text, is not valid UTF-8' };
  }
  return { ok: true };
}

/**
 * Where to stop so the sample does not end mid-character.
 *
 * A 4 KB window through a UTF-8 file will usually land inside a multi-byte
 * sequence, and a strict decoder would call a perfectly good file invalid. The
 * last few bytes are dropped back to the nearest sequence start instead.
 */
function truncateToCodePoint(head: Uint8Array): number {
  let end = head.length;
  for (let i = 0; i < 3 && end > 0; i += 1) {
    const byte = head[end - 1] ?? 0;
    if ((byte & 0x80) === 0) return end; // ASCII: a clean boundary
    if ((byte & 0xc0) === 0xc0) return end - 1; // a lead byte: drop it
    end -= 1; // a continuation byte: keep walking back
  }
  return end;
}

/** Does the object's first bytes agree with what the client declared? */
export function sniff(declaredMime: string, head: Uint8Array): SniffResult {
  if (declaredMime === 'application/pdf') {
    // `%PDF-`. The version digits after it vary and are not checked: a PDF that
    // says 1.4 and is really 1.7 is a PDF, and this test is about the family.
    return startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])
      ? { ok: true }
      : { ok: false, reason: 'magic_mismatch', detail: 'declared as PDF, does not begin %PDF-' };
  }
  if (declaredMime === 'text/plain' || declaredMime === 'text/markdown') {
    return looksLikeText(head);
  }
  return { ok: false, reason: 'unsupported_mime', detail: `${declaredMime} is not an accepted type` };
}
