// Reading a stored message back as the reviewer's view (C98).
//
// One projection serves the approval card, the hand-off task and the inbox
// page, so all three show the same sanitized body and the same server facts.
// The triage status is derived, not stored twice: a message whose run has
// finished without a suggestion reads `no_action`, and one whose run failed
// reads `failed`, exactly as the run row says.
import {
  emailAttachmentSchema,
  emailBodySchema,
  inboundEmailViewSchema,
  senderFactsSchema,
  type InboundEmailView,
} from '@hermes/shared';
import { z } from 'zod';
import type { Tx } from '../db/client.js';

/** SQL for the displayed status; `m` is the message and `r` its triage run (LEFT JOIN). */
export const DERIVED_EMAIL_STATUS_SQL = `CASE
    WHEN m.status = 'triaging' AND r.status = 'completed'
      THEN CASE WHEN cardinality(m.request_ids) > 0 THEN 'suggested' ELSE 'no_action' END
    WHEN m.status = 'triaging' AND r.status IN ('error', 'stopped') THEN 'failed'
    ELSE m.status
  END`;

interface MessageRow {
  id: string;
  inbox_id: string;
  address: string;
  label: string;
  role_slug: string;
  received_at: Date;
  subject: string;
  message_id: string | null;
  to_addresses: string[];
  cc_addresses: string[];
  sender_facts: unknown;
  body: unknown;
  attachments: unknown;
  status: string;
  request_ids: string[];
  raw_sha256: string;
}

export interface StoredEmail {
  readonly view: InboundEmailView;
  readonly rawSha256: string;
}

export async function loadInboundEmail(tx: Tx, workspaceId: string, messageId: string): Promise<StoredEmail | null> {
  const found = await tx.query<MessageRow>(
    `SELECT m.id, m.inbox_id, i.address, i.label, i.role_slug, m.received_at, m.subject, m.message_id,
            m.to_addresses, m.cc_addresses, m.sender_facts, m.body, m.attachments, m.request_ids, m.raw_sha256,
            ${DERIVED_EMAIL_STATUS_SQL} AS status
       FROM inbound_email_messages m
       JOIN email_inboxes i ON i.workspace_id=m.workspace_id AND i.id=m.inbox_id
       LEFT JOIN runs r ON r.workspace_id=m.workspace_id AND r.id=m.triage_run_id
      WHERE m.workspace_id=$1 AND m.id=$2`,
    [workspaceId, messageId],
  );
  const row = found.rows[0];
  if (!row) return null;
  return {
    rawSha256: row.raw_sha256,
    view: inboundEmailViewSchema.parse({
      id: row.id,
      inbox: { id: row.inbox_id, address: row.address, label: row.label, role_slug: row.role_slug },
      received_at: row.received_at.toISOString(),
      subject: row.subject,
      message_id: row.message_id,
      to: row.to_addresses,
      cc: row.cc_addresses,
      sender: senderFactsSchema.parse(row.sender_facts),
      body: emailBodySchema.parse(row.body),
      attachments: z.array(emailAttachmentSchema).parse(row.attachments),
      status: row.status,
      request_ids: row.request_ids.slice(0, 10),
    }),
  };
}

/**
 * Who may read a message's content: the person the inbox's agent acts for,
 * anyone holding the inbox's role, and anyone a suggestion about this message
 * was put in front of. Admins configure inboxes but, like agent conversations
 * (roles plan decision 1), do not read them by virtue of being Admin.
 */
export async function mayReadInboundEmail(tx: Tx, workspaceId: string, messageId: string, userId: string): Promise<boolean> {
  const found = await tx.query<{ allowed: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM inbound_email_messages m
         JOIN email_inboxes i ON i.workspace_id=m.workspace_id AND i.id=m.inbox_id
         JOIN members viewer ON viewer.workspace_id=m.workspace_id AND viewer.user_id=$3 AND viewer.status='active'
        WHERE m.workspace_id=$1 AND m.id=$2
          AND (
            EXISTS (SELECT 1 FROM agent_owners ao WHERE ao.workspace_id=i.workspace_id AND ao.agent_id=i.agent_id AND ao.member_id=viewer.id)
            OR i.role_slug = ANY(viewer.reviewer_roles)
            OR EXISTS (
              SELECT 1 FROM request_audiences ra
               WHERE ra.workspace_id=m.workspace_id AND ra.user_id=$3 AND ra.request_id = ANY(m.request_ids)
            )
          )
     ) AS allowed`,
    [workspaceId, messageId, userId],
  );
  return found.rows[0]?.allowed === true;
}
