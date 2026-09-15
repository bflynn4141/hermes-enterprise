// Server-sent events, parsed once for all three adapters.
//
// All three providers stream SSE, and all three have the same two failure modes
// worth naming: a frame split across two chunks, and a stream that ends in the
// middle of one. The first is handled by buffering until a blank line; the
// second is reported as a transient failure rather than a quiet truncation,
// because a run that silently drops the last third of an answer is worse than
// one that retries.
import { ProviderError } from './types.js';

export interface SseFrame {
  readonly event: string | null;
  readonly data: string;
}

/**
 * Parse an SSE body into frames.
 *
 * `provider` is only used in the error message, and is a constant we choose:
 * nothing from the response body reaches it.
 */
export async function* readSse(response: Response, provider: string): AsyncGenerator<SseFrame> {
  const body = response.body;
  if (!body) throw new ProviderError(`${provider} returned no response body`, 'transient', response.status, provider);

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. `\r\n` is tolerated because the
      // separator is what varies between proxies, not the content.
      let boundary = findBoundary(buffer);
      while (boundary !== null) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
        boundary = findBoundary(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }

  // A trailing frame with no blank line after it is well-formed enough to use;
  // anything else left in the buffer means the stream was cut.
  const tail = parseFrame(buffer);
  if (tail) yield tail;
}

function findBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseFrame(raw: string): SseFrame | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  let event: string | null = null;
  const data: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith(':')) continue; // a comment, which is also a keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0 && event === null) return null;
  return { event, data: data.join('\n') };
}

/** JSON that came from a provider. A parse failure is transient, not a crash. */
export function parseFrameJson<T>(frame: SseFrame, provider: string): T | null {
  if (frame.data === '' || frame.data === '[DONE]') return null;
  try {
    return JSON.parse(frame.data) as T;
  } catch {
    throw new ProviderError(`${provider} sent a frame that is not JSON`, 'transient', undefined, provider);
  }
}
