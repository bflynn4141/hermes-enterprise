// Receiving one email at a role inbox (decision C98).
//
// Cloudflare Email Routing delivers every message sent to the intake domain to
// the Worker's email() handler, which calls `receiveInboundEmail`. There is no
// URL and no session, so the workspace comes from the recipient address through
// `email_inbox_directory` (0076), the same "the tenant key is the answer"
// pattern as share links. Everything after the lookup runs under that
// workspace's own key.
//
// The order below is the security argument:
//
//   1. parse and sanitize, so the stored body is already the reviewer's view;
//   2. compute sender facts from our own receiver's authentication header and
//      the workspace's history, never from anything the body claims;
//   3. store the message, its facts and one `email_triage` job in one
//      transaction (invariant 6). The agent reads the stored visible text
//      later; nothing here calls a model.
//
// A message this code cannot place is rejected at SMTP time with a short
// reason, which is kinder to a sender with a typo than a silent drop and tells
// an attacker nothing they did not already know.
import PostalMime, { type Address, type Attachment } from 'postal-mime';
import type { EmailBody, SenderFacts } from '@hermes/shared';
import { connect } from '../db/client.js';
import type { Env } from '../env.js';
import { enqueueJob, runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import { attachmentBytes, readAttachmentText, type ReadAttachment } from './attachments.js';
import { plainTextEmail, sanitizeEmailHtml, type InlineImage } from './sanitize.js';
import { DEFAULT_AUTHSERV_ID, parseAuthenticationResults, senderFacts } from './sender-facts.js';

/** Well under Cloudflare's 25 MiB limit; attachments are listed, never stored. */
export const MAX_INBOUND_EMAIL_BYTES = 10 * 1024 * 1024;

export interface IncomingEmail {
  /** Envelope recipient: the role address this message was delivered to. */
  readonly to: string;
  readonly raw: Uint8Array;
}

export type IntakeOutcome =
  | { readonly status: 'stored'; readonly workspaceId: string; readonly messageId: string; readonly duplicate: boolean }
  | { readonly status: 'rejected'; readonly reason: 'too_large' | 'unknown_address' | 'unparseable' | 'no_sender' };

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const mailboxes = (value: readonly Address[] | Address | undefined): { name: string; address: string }[] => {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value as Address];
  return list.flatMap((entry) => entry.group ? entry.group : entry.address ? [{ name: entry.name, address: entry.address }] : []);
};

const cleanAddress = (value: string | undefined): string | null => {
  const address = (value ?? '').trim().toLowerCase();
  return /^[^\s@<>()",;:]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,}$/u.test(address) ? address : null;
};

/** Message-ID and friends, kept only when they are a single well-formed id. */
const cleanMessageId = (value: string | undefined): string | null => {
  const id = (value ?? '').trim();
  return /^<[^<>\s\r\n]{3,990}>$/u.test(id) ? id : null;
};

const cleanReferences = (value: string | undefined): string | null => {
  const ids = (value ?? '').match(/<[^<>\s]{3,990}>/gu) ?? [];
  const joined = ids.slice(-50).join(' ');
  return joined.length > 0 && joined.length <= 8000 ? joined : null;
};

const base64Of = (content: Attachment['content']): string => {
  if (typeof content === 'string') return content;
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

async function resolveInbox(env: Env, address: string): Promise<{ workspaceId: string; inboxId: string } | null> {
  const client = await connect(env, 'app');
  try {
    const found = await client.query<{ workspace_id: string | null; inbox_id: string | null }>(
      `SELECT workspace_id, inbox_id FROM hermes_email_inbox($1)`,
      [address],
    );
    const row = found.rows[0];
    return row?.workspace_id && row.inbox_id ? { workspaceId: row.workspace_id, inboxId: row.inbox_id } : null;
  } finally {
    await client.end();
  }
}

export async function receiveInboundEmail(env: Env, email: IncomingEmail): Promise<IntakeOutcome> {
  if (email.raw.byteLength > MAX_INBOUND_EMAIL_BYTES) return { status: 'rejected', reason: 'too_large' };
  const recipient = cleanAddress(email.to);
  if (!recipient) return { status: 'rejected', reason: 'unknown_address' };
  const inbox = await resolveInbox(env, recipient);
  if (!inbox) return { status: 'rejected', reason: 'unknown_address' };

  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    parsed = await PostalMime.parse(email.raw, { attachmentEncoding: 'base64', maxNestingDepth: 50, maxHeadersSize: 256 * 1024 });
  } catch {
    return { status: 'rejected', reason: 'unparseable' };
  }
  const from = mailboxes(parsed.from)[0];
  const fromAddress = cleanAddress(from?.address);
  if (!fromAddress) return { status: 'rejected', reason: 'no_sender' };

  const inlineImages: InlineImage[] = [];
  const attachments: ReadAttachment[] = [];
  let read = 0;
  for (const attachment of parsed.attachments) {
    const contentId = attachment.contentId?.replace(/^<|>$/gu, '');
    if (contentId && attachment.disposition !== 'attachment' && /^image\//iu.test(attachment.mimeType)) {
      inlineImages.push({ contentId, mimeType: attachment.mimeType, base64: base64Of(attachment.content) });
      continue;
    }
    if (attachments.length >= 50) continue;
    const bytes = attachmentBytes(attachment.content);
    const { text, unread_reason } = await readAttachmentText(attachment.mimeType, bytes, read);
    if (text !== null) read += 1;
    attachments.push({
      filename: (attachment.filename ?? 'attachment').slice(0, 255),
      content_type: attachment.mimeType.slice(0, 200),
      size: bytes.byteLength,
      text,
      unread_reason,
    });
  }

  const sanitized = parsed.html
    ? sanitizeEmailHtml(parsed.html, inlineImages)
    : plainTextEmail(parsed.text ?? '');
  // Some senders put the real words only in text/plain and a stub in HTML.
  const visibleText = sanitized.text || (parsed.text ?? '').trim();
  const body: EmailBody = {
    html: parsed.html ? sanitized.html : null,
    text: visibleText.slice(0, 200_000),
    hidden_text_removed_chars: sanitized.hiddenTextRemovedChars,
    remote_images_blocked: sanitized.remoteImagesBlocked,
    links: sanitized.links.map((link) => ({ href: link.href, text: link.text, mismatch: link.mismatch })),
  };

  const authenticationHeaders = parsed.headers
    .filter((header) => header.key === 'authentication-results')
    .map((header) => header.value);
  const authentication = parseAuthenticationResults(authenticationHeaders, env.EMAIL_INTAKE_AUTHSERV_ID ?? DEFAULT_AUTHSERV_ID);
  const replyTo = cleanAddress(mailboxes(parsed.replyTo)[0]?.address);
  const rawSha256 = await sha256Hex(email.raw);

  const jobs: string[] = [];
  const stored = await withWorkspaceTransaction(env, inbox.workspaceId, async (tx) => {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM inbound_email_messages WHERE workspace_id=$1 AND inbox_id=$2 AND raw_sha256=$3`,
      [inbox.workspaceId, inbox.inboxId, rawSha256],
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, duplicate: true };

    const members = await tx.query<{ email: string; name: string | null }>(
      `SELECT lower(u.email) AS email, u.name
         FROM members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id=$1 AND m.status='active' AND u.email IS NOT NULL`,
      [inbox.workspaceId],
    );
    // Addresses this workspace already corresponds with: earlier senders to any
    // of its inboxes, and recipients of email a person approved.
    const known = await tx.query<{ address: string }>(
      `(SELECT DISTINCT from_address AS address FROM inbound_email_messages WHERE workspace_id=$1 LIMIT 2000)
       UNION
       (SELECT DISTINCT recipient_address FROM outbound_email_outbox
         WHERE workspace_id=$1 AND state IN ('sent','simulated') LIMIT 2000)`,
      [inbox.workspaceId],
    );
    const facts: SenderFacts = senderFacts({
      fromAddress,
      fromName: from?.name?.trim() || null,
      replyTo,
      authentication,
      members: members.rows,
      knownAddresses: new Set(known.rows.map((row) => row.address)),
      visibleText,
      hiddenTextRemovedChars: body.hidden_text_removed_chars,
      remoteImagesBlocked: body.remote_images_blocked,
      mismatchedLinks: body.links.filter((link) => link.mismatch).length,
      attachmentsRead: attachments.filter((item) => item.text !== null).length,
      attachmentsUnread: attachments.filter((item) => item.text === null).length,
    });

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO inbound_email_messages
         (workspace_id, inbox_id, raw_sha256, raw_size, message_id, in_reply_to, references_header,
          subject, from_address, from_name, to_addresses, cc_addresses, sender_facts, body, attachments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::text[],$13::jsonb,$14::jsonb,$15::jsonb)
       ON CONFLICT (workspace_id, inbox_id, raw_sha256) DO NOTHING
       RETURNING id`,
      [
        inbox.workspaceId, inbox.inboxId, rawSha256, email.raw.byteLength,
        cleanMessageId(parsed.messageId), cleanMessageId(parsed.inReplyTo), cleanReferences(parsed.references),
        (parsed.subject ?? '').replace(/[\r\n]+/gu, ' ').slice(0, 998),
        fromAddress, facts.name,
        mailboxes(parsed.to).map((entry) => cleanAddress(entry.address)).filter((value): value is string => value !== null).slice(0, 100),
        mailboxes(parsed.cc).map((entry) => cleanAddress(entry.address)).filter((value): value is string => value !== null).slice(0, 100),
        JSON.stringify(facts), JSON.stringify(body), JSON.stringify(attachments),
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) {
      const raced = await tx.query<{ id: string }>(
        `SELECT id FROM inbound_email_messages WHERE workspace_id=$1 AND inbox_id=$2 AND raw_sha256=$3`,
        [inbox.workspaceId, inbox.inboxId, rawSha256],
      );
      return { id: raced.rows[0]!.id, duplicate: true };
    }
    await tx.query(
      `INSERT INTO events (workspace_id, actor_type, kind) VALUES ($1, 'system', 'inbound_email.received')`,
      [inbox.workspaceId],
    );
    const job = await enqueueJob(tx, inbox.workspaceId, 'email_triage', `email-triage:${id}`, { message_id: id });
    if (job) jobs.push(job);
    return { id, duplicate: false };
  });
  if (jobs.length > 0) await runJobsAfterCommit(env, inbox.workspaceId, jobs);
  return { status: 'stored', workspaceId: inbox.workspaceId, messageId: stored.id, duplicate: stored.duplicate };
}
