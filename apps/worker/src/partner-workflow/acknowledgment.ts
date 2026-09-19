import type { Env } from '../env.js';
import type { Job } from '../jobs.js';
import { withWorkspaceTransaction } from '../jobs.js';

/**
 * Publish the allowlisted decision receipt back into the shared workflow.
 * This is an internal durable projection: it sends no message, triggers no
 * model, moves no money and contains no invoice lines or private Finance note.
 */
export async function runPartnerAcknowledgmentJob(env: Env, job: Job): Promise<void> {
  const payload = job.payload as { handoff_id?: unknown; decision_id?: unknown } | null;
  if (typeof payload?.handoff_id !== 'string' || typeof payload.decision_id !== 'string') return;
  await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const acknowledgment = await tx.query<{ id: string; delivery_status: string }>(
      `SELECT id,delivery_status FROM partner_decision_acknowledgments
        WHERE workspace_id=$1 AND handoff_id=$2 AND decision_id=$3 FOR UPDATE`,
      [job.workspace_id, payload.handoff_id, payload.decision_id],
    );
    const row = acknowledgment.rows[0];
    if (!row || row.delivery_status === 'delivered') return;
    await tx.query(
      `UPDATE partner_decision_acknowledgments
          SET delivery_status='delivered',delivered_at=now()
        WHERE id=$1 AND delivery_status='pending'`,
      [row.id],
    );
    await tx.query(
      `UPDATE partner_handoffs SET acknowledgment_status='delivered'
        WHERE workspace_id=$1 AND id=$2 AND acknowledgment_status='pending'`,
      [job.workspace_id, payload.handoff_id],
    );
    await tx.query(
      `INSERT INTO events (workspace_id,actor_type,kind,request_id,decision_id)
       SELECT $1,'system','partner.decision_acknowledged',e.request_id,$3
         FROM partner_workflow_executions e
        WHERE e.workspace_id=$1 AND e.handoff_id=$2`,
      [job.workspace_id, payload.handoff_id, payload.decision_id],
    );
  });
}
