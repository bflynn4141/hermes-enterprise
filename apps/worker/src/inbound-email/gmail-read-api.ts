import { z } from 'zod';
import { htmlToText } from '../security/html-text.js';
import {
  GMAIL_EVIDENCE_READ_SCOPE,
  type GmailEvidenceConfig,
} from './gmail-read-config.js';

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  token_type: z.string().default('Bearer'),
});
const profileSchema = z.object({ emailAddress: z.string().email() });
const headerSchema = z.object({ name: z.string(), value: z.string() });
const partSchema: z.ZodType<GmailPart> = z.lazy(() => z.object({
  partId: z.string().optional(),
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  headers: z.array(headerSchema).optional(),
  body: z.object({ data: z.string().optional(), size: z.number().int().nonnegative().optional(), attachmentId: z.string().optional() }).optional(),
  parts: z.array(partSchema).optional(),
}).passthrough());
const messageSchema = z.object({
  id: z.string().min(1).max(256),
  threadId: z.string().min(1).max(256),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: partSchema,
}).passthrough();
const threadSchema = z.object({
  id: z.string().min(1).max(256),
  messages: z.array(messageSchema).min(1).max(250),
}).passthrough();

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailEvidenceTokenBundle {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: string;
  readonly scope: typeof GMAIL_EVIDENCE_READ_SCOPE;
  readonly token_type: string;
}

export class GmailEvidenceApiError extends Error {
  constructor(readonly reason: string, readonly status: number, readonly retryable: boolean) {
    super(reason);
    this.name = 'GmailEvidenceApiError';
  }
}

function exactReadScope(scope: string | undefined): typeof GMAIL_EVIDENCE_READ_SCOPE {
  const scopes = new Set((scope ?? '').split(/\s+/u).filter(Boolean));
  if (scopes.size !== 1 || !scopes.has(GMAIL_EVIDENCE_READ_SCOPE)) {
    throw new GmailEvidenceApiError('gmail_evidence_scope_not_readonly', 409, false);
  }
  return GMAIL_EVIDENCE_READ_SCOPE;
}

async function tokenRequest(body: URLSearchParams, fetcher: typeof fetch): Promise<z.infer<typeof tokenSchema>> {
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!response.ok) throw new GmailEvidenceApiError('gmail_evidence_oauth_exchange_failed', response.status, response.status >= 500 || response.status === 429);
  return tokenSchema.parse(await response.json());
}

export async function exchangeGmailEvidenceCode(
  config: GmailEvidenceConfig,
  code: string,
  fetcher: typeof fetch = fetch,
): Promise<GmailEvidenceTokenBundle> {
  const token = await tokenRequest(new URLSearchParams({
    client_id: config.clientId, client_secret: config.clientSecret, code,
    grant_type: 'authorization_code', redirect_uri: config.redirectUri,
  }), fetcher);
  if (!token.refresh_token) throw new GmailEvidenceApiError('gmail_evidence_refresh_token_missing', 409, false);
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    scope: exactReadScope(token.scope),
    token_type: token.token_type,
  };
}

export async function refreshGmailEvidenceToken(
  config: GmailEvidenceConfig,
  current: GmailEvidenceTokenBundle,
  fetcher: typeof fetch = fetch,
): Promise<GmailEvidenceTokenBundle> {
  const token = await tokenRequest(new URLSearchParams({
    client_id: config.clientId, client_secret: config.clientSecret,
    refresh_token: current.refresh_token, grant_type: 'refresh_token',
  }), fetcher);
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? current.refresh_token,
    expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    scope: exactReadScope(token.scope ?? current.scope),
    token_type: token.token_type,
  };
}

export async function gmailEvidenceProfile(accessToken: string, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new GmailEvidenceApiError('gmail_evidence_profile_failed', response.status, response.status >= 500 || response.status === 429);
  return profileSchema.parse(await response.json()).emailAddress.toLowerCase();
}

const clean = (value: string | undefined, max: number): string =>
  (value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/gu, '').trim().slice(0, max);

function decodeBody(data: string | undefined): string {
  if (!data) return '';
  try { return clean(Buffer.from(data, 'base64url').toString('utf8'), 100_000); }
  catch { return ''; }
}

function headerMap(part: GmailPart): Map<string, string> {
  return new Map((part.headers ?? []).map((header) => [header.name.toLowerCase(), clean(header.value, 4000)]));
}

export interface NormalizedMailbox {
  readonly name: string | null;
  readonly address: string;
}

export function parseMailboxList(value: string | undefined): NormalizedMailbox[] {
  if (!value) return [];
  const found: NormalizedMailbox[] = [];
  const pattern = /(?:"([^"]+)"|([^,<]+))?\s*<([^>\s]+@[^>\s]+)>|([A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,})/giu;
  for (const match of value.matchAll(pattern)) {
    const address = clean(match[3] ?? match[4], 320).toLowerCase();
    if (!address || found.some((entry) => entry.address === address)) continue;
    const name = clean(match[1] ?? match[2], 200).replace(/^"|"$/g, '') || null;
    found.push({ name, address });
  }
  return found.slice(0, 100);
}

function partText(root: GmailPart): string {
  const plain: string[] = [];
  const html: string[] = [];
  const visit = (part: GmailPart): void => {
    const mime = (part.mimeType ?? '').toLowerCase();
    const body = decodeBody(part.body?.data);
    if (body && (mime.startsWith('text/plain') || mime === 'message/delivery-status')) plain.push(body);
    else if (body && mime.startsWith('text/html')) html.push(htmlToText(body));
    for (const child of part.parts ?? []) visit(child);
  };
  visit(root);
  return clean((plain.length ? plain : html).join('\n\n'), 100_000);
}

function attachmentMetadata(root: GmailPart): { filename: string; mime_type: string; size: number }[] {
  const items: { filename: string; mime_type: string; size: number }[] = [];
  const visit = (part: GmailPart): void => {
    const filename = clean(part.filename, 300);
    if (filename) items.push({ filename, mime_type: clean(part.mimeType, 200) || 'application/octet-stream', size: part.body?.size ?? 0 });
    for (const child of part.parts ?? []) visit(child);
  };
  visit(root);
  return items.slice(0, 100);
}

function sentAt(internalDate: string | undefined, dateHeader: string | undefined): string | null {
  const millis = Number(internalDate);
  const value = Number.isFinite(millis) && millis > 0 ? millis : Date.parse(dateHeader ?? '');
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

export interface NormalizedGmailMessage {
  readonly provider_message_id: string;
  readonly internet_message_id: string | null;
  readonly in_reply_to: string | null;
  readonly references: readonly string[];
  readonly sent_at: string | null;
  readonly from: NormalizedMailbox | null;
  readonly to: readonly NormalizedMailbox[];
  readonly cc: readonly NormalizedMailbox[];
  readonly direction: 'inbound' | 'outbound' | 'unknown';
  readonly subject: string;
  readonly snippet: string;
  readonly text_body: string;
  readonly content_type: string | null;
  readonly auto_submitted: string | null;
  readonly list_unsubscribe: string | null;
  readonly attachments: readonly { filename: string; mime_type: string; size: number }[];
}

export interface NormalizedGmailThread {
  readonly provider: 'gmail';
  readonly provider_thread_id: string;
  readonly mailbox_address: string;
  readonly subject: string;
  readonly messages: readonly NormalizedGmailMessage[];
}

export function normalizeGmailThread(raw: unknown, mailboxAddress: string): NormalizedGmailThread {
  const parsed = threadSchema.parse(raw);
  const mailbox = mailboxAddress.toLowerCase();
  const messages = parsed.messages.map((message): NormalizedGmailMessage => {
    const headers = headerMap(message.payload);
    const from = parseMailboxList(headers.get('from'))[0] ?? null;
    const to = parseMailboxList(headers.get('to'));
    const cc = parseMailboxList(headers.get('cc'));
    const recipients = [...to, ...cc];
    const direction = from?.address === mailbox ? 'outbound' : recipients.some((entry) => entry.address === mailbox) ? 'inbound' : 'unknown';
    return {
      provider_message_id: message.id,
      internet_message_id: clean(headers.get('message-id'), 998) || null,
      in_reply_to: clean(headers.get('in-reply-to'), 998) || null,
      references: clean(headers.get('references'), 4000).split(/\s+/u).filter(Boolean).slice(0, 100),
      sent_at: sentAt(message.internalDate, headers.get('date')),
      from, to, cc, direction,
      subject: clean(headers.get('subject'), 500),
      snippet: clean(message.snippet, 1000),
      text_body: partText(message.payload),
      content_type: clean(headers.get('content-type'), 500) || clean(message.payload.mimeType, 500) || null,
      auto_submitted: clean(headers.get('auto-submitted'), 500) || null,
      list_unsubscribe: clean(headers.get('list-unsubscribe'), 2000) || null,
      attachments: attachmentMetadata(message.payload),
    };
  });
  return {
    provider: 'gmail', provider_thread_id: parsed.id, mailbox_address: mailbox,
    subject: messages.map((message) => message.subject).find(Boolean) ?? 'Gmail thread', messages,
  };
}

export async function getSelectedGmailThread(
  accessToken: string,
  threadId: string,
  mailboxAddress: string,
  fetcher: typeof fetch = fetch,
): Promise<NormalizedGmailThread> {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}`);
  url.searchParams.set('format', 'full');
  const response = await fetcher(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new GmailEvidenceApiError('gmail_evidence_thread_fetch_failed', response.status, response.status >= 500 || response.status === 429);
  const text = await response.text();
  if (text.length > 5_000_000) throw new GmailEvidenceApiError('gmail_evidence_thread_too_large', 422, false);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new GmailEvidenceApiError('gmail_evidence_thread_invalid', 502, false); }
  const normalized = normalizeGmailThread(value, mailboxAddress);
  if (normalized.provider_thread_id !== threadId) throw new GmailEvidenceApiError('gmail_evidence_thread_mismatch', 409, false);
  return normalized;
}
