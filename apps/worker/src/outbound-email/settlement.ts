// A person settles an email send the provider never confirmed or refused
// (Quest audit H1). The send job marks such a send `ambiguous` and stops; it
// never retries, because the provider may already have delivered it. Someone
// checks the mailbox and says what happened:
//
//   sent      recorded as sent on that person's word, next to who and when.
//   not_sent  the row is cancelled and the approval reopens as a new revision,
//             so the email's reviewers approve it again before it goes out.
//
// Settling never calls a provider itself.
import { emailSendListSchema, type EmailSendList, type SettleEmailSendInput } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { approvalReviewerMemberIds, reopenApprovalForResend, type ApprovalHumanContext } from '../domain/approvals.js';
import { publishEvents } from '../jobs.js';
import { RouteError } from '../routes/errors.js';

interface SendRow {
  id: string;
  authorization_revision: number;
  recipient_name: string;
  recipient_address: string;
  sender_address: string;
  state: EmailSendList['sends'][number]['state'];
  sent_at: Date | null;
  settled_outcome: 'sent' | 'not_sent' | null;
  settled_at: Date | null;
  settled_by_name: string | null;
}

/** Who is asking, as the settle rule sees them. */
export interface SettleViewer {
  readonly memberId: string;
  /** Workspace role: `admin` or `member`. */
  readonly role: string;
}

/**
 * Whether this person may settle an uncertain send on this approval.
 *
 * `reviewers` holds every member who could review the approval under its
 * policy (for an agent's email: its owner and the holders of its role).
 * Admins are included because they usually connected the Gmail or Microsoft
 * account whose Sent folder answers the question. Anyone else is refused:
 * settling as `sent` closes the approval, so it is a reviewer's call.
 */
export function maySettleUncertainSend(viewer: SettleViewer, reviewers: ReadonlySet<string>): boolean {
  if (viewer.role === 'admin') return true;
  return reviewers.has(viewer.memberId);
}

async function viewerFor(tx: Tx, workspaceId: string, userId: string): Promise<SettleViewer | null> {
  const found = await tx.query<{ id: string; role: string }>(
    `SELECT id, role FROM members WHERE workspace_id=$1 AND user_id=$2 AND status='active'`,
    [workspaceId, userId],
  );
  const member = found.rows[0];
  return member ? { memberId: member.id, role: member.role } : null;
}

async function sendRows(tx: Tx, workspaceId: string, requestId: string): Promise<SendRow[]> {
  const result = await tx.query<SendRow>(
    `SELECT o.id, o.authorization_revision, o.recipient_name, o.recipient_address, o.sender_address,
            o.state, o.sent_at, o.settled_outcome, o.settled_at, u.name AS settled_by_name
       FROM outbound_email_outbox o
       LEFT JOIN users u ON u.id = o.settled_by
      WHERE o.workspace_id=$1 AND o.request_id=$2
      ORDER BY o.authorization_revision, o.recipient_index
      LIMIT 100`,
    [workspaceId, requestId],
  );
  return result.rows;
}

/** Every delivery of an approved email, and whether this viewer may settle the uncertain ones. */
export async function listEmailSends(tx: Tx, workspaceId: string, requestId: string, userId: string): Promise<EmailSendList> {
  const rows = await sendRows(tx, workspaceId, requestId);
  const viewer = await viewerFor(tx, workspaceId, userId);
  const canSettle = viewer !== null && rows.some((row) => row.state === 'ambiguous')
    && maySettleUncertainSend(viewer, await approvalReviewerMemberIds(tx, requestId));
  return emailSendListSchema.parse({
    sends: rows.map((row) => ({
      id: row.id,
      authorization_revision: row.authorization_revision,
      recipient_name: row.recipient_name,
      recipient_address: row.recipient_address,
      sender_address: row.sender_address,
      state: row.state,
      sent_at: row.sent_at ? row.sent_at.toISOString() : null,
      settled: row.settled_outcome && row.settled_at
        ? { outcome: row.settled_outcome, by_name: row.settled_by_name, at: row.settled_at.toISOString() }
        : null,
    })),
    can_settle: canSettle,
  });
}

/**
 * Record what a person found in the mailbox. Pressing the same answer twice
 * is a no-op; a different answer after the first is refused, since the first
 * one already changed what happens next.
 */
export async function settleEmailSend(
  context: ApprovalHumanContext,
  requestId: string,
  outboxId: string,
  input: SettleEmailSendInput,
): Promise<{ list: EmailSendList; duplicate: boolean }> {
  const { tx, workspaceId, userId } = context;
  const found = await tx.query<{ state: string; settled_outcome: string | null; candidate_id: string | null }>(
    `SELECT state, settled_outcome, candidate_id FROM outbound_email_outbox
      WHERE workspace_id=$1 AND request_id=$2 AND id=$3 FOR UPDATE`,
    [workspaceId, requestId, outboxId],
  );
  const row = found.rows[0];
  if (!row) throw new RouteError('no such email send', 'unknown_email_send', 404);
  const viewer = await viewerFor(tx, workspaceId, userId);
  if (!viewer || !maySettleUncertainSend(viewer, await approvalReviewerMemberIds(tx, requestId))) {
    throw new RouteError('Only a reviewer of this email or an Admin can settle its send.', 'email_send_settle_forbidden', 403);
  }
  if (row.settled_outcome === input.outcome) {
    return { list: await listEmailSends(tx, workspaceId, requestId, userId), duplicate: true };
  }
  if (row.state !== 'ambiguous') throw new RouteError('Only a send whose outcome is unknown can be settled.', 'email_send_not_uncertain', 409);

  if (input.outcome === 'sent') {
    await tx.query(
      `UPDATE outbound_email_outbox SET state='sent', settled_outcome='sent', settled_by=$3, settled_at=now(),
              sent_at=coalesce(sent_at, now())
        WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, outboxId, userId],
    );
    const open = await tx.query(
      `SELECT 1 FROM outbound_email_outbox o
         JOIN approval_requests ar ON ar.workspace_id=o.workspace_id AND ar.request_id=o.request_id
        WHERE o.workspace_id=$1 AND o.request_id=$2 AND o.authorization_revision=ar.authorization_revision
          AND o.state <> 'sent' LIMIT 1`,
      [workspaceId, requestId],
    );
    if (open.rowCount === 0) {
      await tx.query(
        `UPDATE approval_requests SET effect_status='executed', effect_reason='A reviewer checked the mailbox and confirmed the approved email was sent.',
             work_status='completed', work_reason=NULL
          WHERE workspace_id=$1 AND request_id=$2`,
        [workspaceId, requestId],
      );
    }
    if (row.candidate_id) {
      await tx.query(
        `UPDATE partner_engagements SET stage='sent', last_outreach_at=coalesce(last_outreach_at, now())
          WHERE workspace_id=$1 AND candidate_id=$2 AND request_id=$3`,
        [workspaceId, row.candidate_id, requestId],
      );
    }
    await tx.query(
      `INSERT INTO events (workspace_id,actor_type,actor_user_id,kind,request_id)
       VALUES ($1,'user',$2,'outbound_email.settled_sent',$3)`,
      [workspaceId, userId, requestId],
    );
    context.jobs.push(...await publishEvents(tx, workspaceId, [
      { kind: 'entity.updated', payload: { entity_type: 'request', entity_id: requestId, ref: { section: 'inbox', view: 'request', id: requestId }, version: null } },
    ]));
  } else {
    await tx.query(
      `UPDATE outbound_email_outbox SET state='cancelled', settled_outcome='not_sent', settled_by=$3, settled_at=now()
        WHERE workspace_id=$1 AND id=$2`,
      [workspaceId, outboxId, userId],
    );
    await tx.query(
      `INSERT INTO events (workspace_id,actor_type,actor_user_id,kind,request_id)
       VALUES ($1,'user',$2,'outbound_email.settled_not_sent',$3)`,
      [workspaceId, userId, requestId],
    );
    await reopenApprovalForResend(context, requestId);
  }
  return { list: await listEmailSends(tx, workspaceId, requestId, userId), duplicate: false };
}
