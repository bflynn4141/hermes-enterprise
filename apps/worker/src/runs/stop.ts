import { ACTIVE_RUN_STATUSES } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { publishEvents } from '../jobs.js';

/** The caller proves session ownership; every stop records the same durable flag and event. */
export async function requestRunStop(tx:Tx,workspaceId:string,runId:string):Promise<string[]> {
  const run=(await tx.query<{session_id:string;attempt:number}>(`UPDATE runs SET stop_requested=true,status='stopping',recovery_cancelled=true,recovery_next_at=NULL
    WHERE workspace_id=$1 AND id=$2 AND status=ANY($3::text[]) RETURNING session_id,attempt`,[workspaceId,runId,[...ACTIVE_RUN_STATUSES]])).rows[0];
  if(!run) return [];
  await tx.query(`UPDATE run_queue SET status='paused' WHERE workspace_id=$1 AND run_id=$2 AND status='queued'`,[workspaceId,runId]);
  return publishEvents(tx,workspaceId,[{kind:'run.status',sessionId:run.session_id,payload:{run_id:runId,attempt:run.attempt,status:'stopping'}}]);
}
