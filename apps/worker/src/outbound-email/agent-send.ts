import { messageIds } from './gmail-api.js';

// Sending as an agent's own address through Cloudflare Email Service (C100).
//
// The structured send takes the approved text as plain text and the threading
// headers explicitly; From, To and Subject are API fields, so nothing in the
// body can add a header. Cloudflare sets Message-ID and signs with the domain.

/** A send the binding refused, with whether retrying could help and whether it may have gone. */
export class AgentSendError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly ambiguous: boolean) {
    super(`agent_send_failed:${code}`);
    this.name = 'AgentSendError';
  }
}

/** Codes Cloudflare returns before accepting a message: nothing was sent. */
const REJECTED = new Set([
  'E_VALIDATION_ERROR', 'E_SENDER_NOT_VERIFIED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED', 'E_TOO_MANY_RECIPIENTS', 'E_CONTENT_TOO_LARGE', 'E_HEADER_NOT_ALLOWED',
  'E_HEADER_USE_API_FIELD', 'E_HEADER_VALUE_INVALID', 'E_HEADER_VALUE_TOO_LONG', 'E_HEADER_NAME_INVALID',
]);
const HEADER_LIMIT = 2_000;

/** References newest-last, dropping the oldest until the header fits Cloudflare's 2,048-byte limit. */
export function referencesHeader(value: string | null | undefined): string | null {
  const ids = messageIds(value).slice(-50);
  while (ids.length > 0 && ids.join(' ').length > HEADER_LIMIT) ids.shift();
  return ids.length > 0 ? ids.join(' ') : null;
}

export async function sendAsAgent(
  binding: SendEmail,
  input: {
    fromName: string;
    fromAddress: string;
    toName: string;
    toAddress: string;
    subject: string;
    body: string;
    inReplyTo?: string | null;
    references?: string | null;
  },
): Promise<{ id: string }> {
  const headers: Record<string, string> = {};
  const inReplyTo = messageIds(input.inReplyTo).at(-1);
  if (inReplyTo) headers['In-Reply-To'] = inReplyTo;
  const references = referencesHeader(input.references);
  if (references) headers.References = references;
  try {
    const result = await binding.send({
      from: { name: input.fromName.slice(0, 200), email: input.fromAddress },
      to: { name: input.toName.slice(0, 200), email: input.toAddress },
      subject: input.subject,
      text: input.body,
      headers,
    });
    return { id: result.messageId };
  } catch (error) {
    const text = error instanceof Error ? `${(error as { code?: unknown }).code ?? ''} ${error.message}` : String(error);
    const code = /E_[A-Z_]+/u.exec(text)?.[0] ?? 'E_UNKNOWN';
    if (code === 'E_RATE_LIMIT_EXCEEDED' || code === 'E_DAILY_LIMIT_EXCEEDED') throw new AgentSendError(code, true, false);
    // Anything Cloudflare did not name as a refusal may have been accepted.
    throw new AgentSendError(code, false, !REJECTED.has(code));
  }
}
