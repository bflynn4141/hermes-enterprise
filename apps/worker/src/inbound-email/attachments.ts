// Reading an email's attachments as text (C98).
//
// An invoice email usually says little and attaches the invoice, so an agent
// that cannot read the PDF cannot do its job. The same rules as the body
// apply: the text is untrusted data the agent reads between the prompt's
// markers, never instructions, and the reviewer can open exactly the text the
// agent read. Nothing else about the file is kept: the bytes are read once at
// intake and dropped.
//
// The limits keep one email inside the handler's CPU budget. PDF extraction is
// the upload extractor's (`queues/extract.ts`, pdfjs via unpdf, verified under
// workerd); HTML goes through the same sanitizer as the body, so text hidden
// with CSS is not read here either. A PDF can hide text in ways no extractor
// can see (white on white, off the page); the reviewer is told so.
import type { Attachment } from 'postal-mime';
import { ExtractionFailure, extractBytes } from '../queues/extract.js';
import { sanitizeEmailHtml, tidyText } from './sanitize.js';

export const MAX_ATTACHMENTS_READ = 3;
export const MAX_ATTACHMENT_READ_BYTES = 5 * 1024 * 1024;
export const MAX_ATTACHMENT_TEXT = 20_000;

export type UnreadReason = 'type_not_supported' | 'too_large' | 'no_text' | 'unreadable' | 'limit_reached';

export interface ReadAttachment {
  readonly filename: string;
  readonly content_type: string;
  readonly size: number;
  readonly text: string | null;
  readonly unread_reason: UnreadReason | null;
}

const READABLE_TEXT = new Set(['text/plain', 'text/markdown', 'text/csv', 'text/html', 'application/pdf']);

export function attachmentBytes(content: Attachment['content']): Uint8Array {
  if (typeof content === 'string') {
    const binary = atob(content.replace(/\s+/gu, ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/** The attachment's text, or why there is none. Never throws. */
export async function readAttachmentText(mimeType: string, bytes: Uint8Array, alreadyRead: number): Promise<{ text: string | null; unread_reason: UnreadReason | null }> {
  const type = mimeType.toLowerCase().split(';')[0]!.trim();
  if (!READABLE_TEXT.has(type)) return { text: null, unread_reason: 'type_not_supported' };
  if (bytes.byteLength > MAX_ATTACHMENT_READ_BYTES) return { text: null, unread_reason: 'too_large' };
  if (alreadyRead >= MAX_ATTACHMENTS_READ) return { text: null, unread_reason: 'limit_reached' };
  try {
    let text: string;
    if (type === 'application/pdf') {
      text = await extractBytes('application/pdf', bytes);
    } else {
      const decoded = new TextDecoder('utf-8').decode(bytes);
      text = type === 'text/html' ? sanitizeEmailHtml(decoded).text : decoded;
    }
    const tidy = tidyText(text).slice(0, MAX_ATTACHMENT_TEXT);
    return tidy.length > 0 ? { text: tidy, unread_reason: null } : { text: null, unread_reason: 'no_text' };
  } catch (error) {
    if (error instanceof ExtractionFailure && error.reason === 'no_text_layer') return { text: null, unread_reason: 'no_text' };
    return { text: null, unread_reason: 'unreadable' };
  }
}
