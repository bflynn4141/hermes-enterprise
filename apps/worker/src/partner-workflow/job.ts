import type { Env } from '../env.js';
import type { Job } from '../jobs.js';
import { runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import { createRunInstance, type RunInstanceParams } from '../runs/submit.js';
import { preparePartnerInvoiceReviewModelTurn, processPartnerInvoiceReview } from './service.js';

/**
 * Hybrid orchestration: the server finishes the authoritative invoice checks
 * in the same transaction that admits a visible Bot Mode-compatible turn. A
 * non-simulated model run starts only after those durable results commit.
 */
export async function runPartnerInvoiceReviewJob(env: Env, job: Job): Promise<void> {
  const handoffId = (job.payload as { handoff_id?: unknown } | null)?.handoff_id;
  if (typeof handoffId !== 'string') return;
  if (job.attempts > 3) {
    await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
      await tx.query(
        `UPDATE partner_handoffs
            SET status='failed', result_reason='Invoice review exceeded three attempts.', completed_at=now()
          WHERE workspace_id=$1 AND id=$2 AND status NOT IN ('completed','needs_information','stale')`,
        [job.workspace_id, handoffId],
      );
      await tx.query(
        `UPDATE partner_workflow_executions
            SET status='failed', result_reason='Invoice review exceeded three attempts.'
          WHERE workspace_id=$1 AND handoff_id=$2 AND status NOT IN ('completed','needs_information','stale')`,
        [job.workspace_id, handoffId],
      );
    });
    return;
  }
  const jobIds: string[] = [];
  let create: RunInstanceParams | null = null;
  await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    create = await preparePartnerInvoiceReviewModelTurn(tx, env, job.workspace_id, handoffId, jobIds);
    await processPartnerInvoiceReview(tx, job.workspace_id, handoffId);
  });
  if (jobIds.length > 0) await runJobsAfterCommit(env, job.workspace_id, jobIds);
  if (create) await createRunInstance(env, create);
}
