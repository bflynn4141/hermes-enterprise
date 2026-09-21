// One admission path for human retries and scheduled recovery. Decisions,
// completed tool effects, and paid-call leases are never replayed by admission.
import { ACTIVE_RUN_STATUSES, type AgentRecoveryView } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { connect } from '../db/client.js';
import type { Env } from '../env.js';
import { isEnginePaused } from '../env.js';
import { enqueueJob, publishEvents, runJobsAfterCommit, withWorkspaceTransaction, type Job } from '../jobs.js';
import { RouteError } from '../routes/errors.js';
import { consumeRate } from '../auth/rate-limit.js';
import { loadModel } from '../model/catalog.js';
import { requireAllowedProvider, isProviderAllowed } from '../model/allowed.js';
import { checkCaps } from '../model/usage.js';
import { requireInstanceCapacity } from '../ops/instance-cap.js';
import { approvalContinuationRetryBlock } from '../runtime/continuation.js';
import { resolveRuntimeBinding } from '../runtime/config.js';
import { HermesClient } from '../runtime/client.js';
import { createRunInstance, type RunInstanceParams } from './submit.js';
import { runAttemptInstanceId } from './instance-id.js';
import { inspectRecoverySafety, isResponseOnlyRecoveryInput } from './recovery-safety.js';
import { automatedTriggersEnabled, automationIntervalMinutes, paidPartnerScreeningEnabled, unresolvedPartnerWork } from '../partner-screening/automation.js';
import { resolvePartnerSkillAssignment } from '../enterprise-skills/service.js';

export const MAX_AUTOMATIC_ATTEMPTS = 3;
const TRANSIENT_REASONS = new Set(['hermes_provider_unavailable', 'hermes_provider_rate_limited']);
export const automaticRecoveryAuthBlocked = (
  automatic: boolean,
  runtimeAuthMode: 'legacy_hmac' | 'token_digest',
): boolean => automatic && runtimeAuthMode !== 'token_digest';
const isPartnerScreeningRun = (run: Pick<RecoveryRun, 'client_turn_id'>): boolean =>
  run.client_turn_id.startsWith('partner-screening:');
export function automaticRetryAt(run: {attempt:number;error:{reason?:string;retryable?:boolean}|null;ended_at:Date|null;recovery_cancelled:boolean;recovery_not_before?:Date|null}): Date | null {
  if (run.recovery_cancelled || run.attempt >= MAX_AUTOMATIC_ATTEMPTS || !run.ended_at || !run.error?.retryable || !TRANSIENT_REASONS.has(run.error.reason ?? '')) return null;
  const seconds = run.attempt === 1 ? 60 : 300;
  return new Date(Math.max(run.ended_at.getTime() + seconds * 1000, run.recovery_not_before?.getTime() ?? 0));
}
export interface RecoveryRun {
  id:string;session_id:string;agent_id:string;owner_id:string;status:string;attempt:number;
  model_id:string;effort:string|null;session_model_id:string;session_effort:string|null;
  created_at:Date;
  client_turn_id:string;error:{reason?:string;message?:string;retryable?:boolean}|null;
  ended_at:Date|null;recovery_next_at:Date|null;recovery_not_before?:Date|null;recovery_cancelled:boolean;recovery_blocked_reason:string|null;
  trace_id:string;engine_version:number;stop_requested:boolean;
}
export interface RecoveryWork { tx:Tx;workspaceId:string;userId:string;jobs:string[] }

export async function requireRecoveryAgent(work: RecoveryWork, agentId: string, lock = false): Promise<{status:string}> {
  const {rows} = await work.tx.query<{status:string}>(
    `SELECT a.status FROM agents a WHERE a.workspace_id=$1 AND a.id=$2
       AND EXISTS (SELECT 1 FROM members m WHERE m.workspace_id=a.workspace_id AND m.user_id=$3 AND m.status='active')
       AND (EXISTS (SELECT 1 FROM agent_owners o JOIN members m ON m.id=o.member_id
                    WHERE o.workspace_id=a.workspace_id AND o.agent_id=a.id AND m.user_id=$3 AND m.status='active')
         OR (NOT EXISTS (SELECT 1 FROM agent_owners o WHERE o.workspace_id=a.workspace_id AND o.agent_id=a.id)
             AND EXISTS (SELECT 1 FROM sessions s WHERE s.workspace_id=a.workspace_id AND s.agent_id=a.id AND s.owner_id=$3 AND NOT s.read_only AND NOT s.archived)))
       ${lock ? 'FOR UPDATE OF a' : ''}`,
    [work.workspaceId, agentId, work.userId]);
  if (!rows[0]) throw new RouteError('This agent is not assigned to you.', 'agent_not_bound', 404);
  return rows[0];
}
export async function loadRecoveryRun(work: RecoveryWork, agentId:string, runId?:string, lock=false): Promise<RecoveryRun|null> {
  const {rows} = await work.tx.query<RecoveryRun>(
    `SELECT r.*, s.owner_id,s.model_id AS session_model_id,s.effort AS session_effort
       FROM runs r JOIN sessions s ON s.id=r.session_id AND s.workspace_id=r.workspace_id
      WHERE r.workspace_id=$1 AND r.agent_id=$2 AND s.owner_id=$3 AND NOT s.read_only AND NOT s.archived
        AND ($4::uuid IS NULL OR r.id=$4)
      ORDER BY (r.status IN ('working','waiting','stopping')) DESC,r.created_at DESC LIMIT 1 ${lock ? 'FOR UPDATE OF r' : ''}`,
    [work.workspaceId,agentId,work.userId,runId ?? null]);
  if (runId && !rows[0]) throw new RouteError('No such task.', 'unknown_run', 404);
  return rows[0] ?? null;
}
const blank = ():AgentRecoveryView => ({state:'idle',run_id:null,session_id:null,attempt:null,model_id:null,message:'No work is running.',next_retry_at:null,can_retry:false,can_run_now:false,can_cancel:false});

async function wakePolicy(work:RecoveryWork,env:Env,agentId:string):Promise<string|null> {
  if (!automatedTriggersEnabled(env)) return 'Scheduled work is not enabled in this environment.';
  const agent = await requireRecoveryAgent(work,agentId);
  if (agent.status !== 'started') return 'Finish setting up Iris before starting work.';
  // This policy check is shared with the GET recovery view, so it must remain
  // read-only. The POST/job execution path materializes legacy assignments at
  // its explicit admission boundary when needed.
  const resolved = await resolvePartnerSkillAssignment(env, work.tx, work.workspaceId, agentId);
  const config = resolved.config;
  if (!config) return 'Partner screening needs a configured source.';
  if (config.source === 'agentcash_people' && !paidPartnerScreeningEnabled(env)) return 'A new paid search needs an approved allowance.';
  return null;
}

export async function recoveryView(work:RecoveryWork,env:Env,agentId:string,runId?:string):Promise<AgentRecoveryView> {
  await requireRecoveryAgent(work,agentId);
  const run = await loadRecoveryRun(work,agentId,runId);
  const view = blank();
  if (!runId && (!run || !(ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status))
      && !(await unresolvedPartnerWork(work.tx,work.workspaceId,agentId))) {
    const bucket = `${automationIntervalMinutes(env)}m-${Math.floor(Date.now()/(automationIntervalMinutes(env)*60000))}`;
    const queued = await work.tx.query<{ done_at: Date | null }>(
      `SELECT done_at FROM jobs WHERE workspace_id=$1 AND kind='partner_screening' AND key=$2`,
      [work.workspaceId,`partner-screening:auto:${work.workspaceId}:${agentId}:${bucket}`]);
    if (queued.rows[0]) return {...view,state:queued.rows[0].done_at?'idle':'queued',
      message:queued.rows[0].done_at?'No new authorized work is due in this screening cycle.':'Iris is queued to check the current screening cycle.'};
  }
  if (!run) {
    const policy = await wakePolicy(work,env,agentId);
    view.message = policy ?? 'Ready to check for authorized work.';
    view.can_run_now = policy === null;
    return view;
  }
  Object.assign(view,{run_id:run.id,session_id:run.session_id,attempt:run.attempt,model_id:run.model_id});
  if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) {
    view.model_id = run.model_id;
    view.state = run.status === 'working' ? 'working' : 'waiting';
    view.message = run.status === 'working' ? 'Iris is working on this task.' : 'This task is waiting for input or a stop to complete.';
    return view;
  }
  if (run.status === 'completed') {
    view.model_id = run.model_id;
    view.message = 'The last task completed. Check for authorized pending work.';
    view.can_run_now = !runId && (await wakePolicy(work,env,agentId)) === null;
    return view;
  }
  const safety = await inspectRecoverySafety(work.tx,work.workspaceId,run.id);
  if (safety.blockedReason) {
    const reviewed = safety.blockedReason === 'side_effects_present'
      && !(await unresolvedPartnerWork(work.tx,work.workspaceId,agentId));
    return {...view,state:'blocked',message: reviewed
      ? 'The previous task’s saved work has been reviewed. Check for the next authorized screening cycle.'
      : safety.message ?? 'Review the previous task before retrying.',
      can_run_now: !runId && reviewed && (await wakePolicy(work,env,agentId)) === null};
  }
  const model = await loadModel(work.tx,run.model_id);
  if (!model || model.disabled_reason || !model.supports_tools || !isProviderAllowed(env,model.provider)
      || (run.effort !== null && model.effort_map?.[run.effort] === undefined)) {
    return {...view,state:'blocked',message:'The failed attempt’s model settings are no longer available. Start a new turn instead.'};
  }
  if (env.MODEL_SCRIPTED !== '1') {
    const key = await work.tx.query<{status:string}>(`SELECT status FROM workspace_provider_keys WHERE workspace_id=$1 AND provider=$2 AND revoked_at IS NULL`,[work.workspaceId,model.provider]);
    if (!['verified','verified_scoped'].includes(key.rows[0]?.status ?? '')) return {...view,state:'blocked',message:'Reconnect the model provider in Settings before retrying.'};
  }
  if (isEnginePaused(env)) return {...view,state:'blocked',message:'The engine is paused for a deployment. Retry when it is ready.'};
  const caps = await checkCaps(work.tx,work.workspaceId);
  if (!caps.allowed) return {...view,state:'blocked',message:caps.reason === 'daily_token_cap'
    ? 'The workspace reached its daily token limit. Retry after the limit resets or is updated.'
    : 'The workspace already has its allowed number of active tasks. Retry when one finishes.'};
  view.state = run.recovery_next_at && !run.recovery_cancelled ? 'retry_scheduled' : run.status === 'stopped' ? 'stopped' : 'retryable';
  view.can_retry = true;
  view.can_cancel = view.state === 'retry_scheduled';
  view.next_retry_at = view.can_cancel ? run.recovery_next_at!.toISOString() : null;
  view.message = run.recovery_cancelled ? 'Automatic retry is paused. You can retry this task when ready.'
    : run.recovery_blocked_reason === 'provider_retry_after_excessive' ? 'The provider requested an extended wait. Automatic retry is paused; check the model connection before retrying.'
    : run.attempt >= MAX_AUTOMATIC_ATTEMPTS ? 'Automatic retries stopped after three attempts. You can retry when the model is available.'
      : run.error?.message ?? 'The task stopped before it finished.';
  return view;
}

export async function retryTask(work:RecoveryWork,env:Env,agentId:string,runId:string,expectedAttempt?:number,automatic=false):Promise<RecoveryRun> {
  await requireRecoveryAgent(work,agentId,true);
  const run = (await loadRecoveryRun(work,agentId,runId,true))!;
  // A delayed click/POST is never another authorization for a later attempt.
  if (expectedAttempt !== undefined && run.attempt !== expectedAttempt) {
    if (run.attempt === expectedAttempt+1) return run;
    throw new RouteError('The task has changed. Refresh its status.', 'stale_attempt',409);
  }
  if ((ACTIVE_RUN_STATUSES as readonly string[]).includes(run.status)) throw new RouteError('This task is already running.', 'run_active',409);
  if (!['error','stopped'].includes(run.status)) throw new RouteError('This task has already finished.', 'run_completed',409);
  if (automatic) {
    // The agent row is already locked FOR UPDATE, the same row a new turn
    // locks during admission. Rechecking here closes the queue-delay race:
    // even a newer completed turn makes this recovery stale.
    const newer = await work.tx.query(
      `SELECT 1 FROM runs WHERE workspace_id=$1 AND session_id=$2 AND id<>$3
        AND created_at>=$4 LIMIT 1`,
      [work.workspaceId,run.session_id,run.id,run.created_at],
    );
    if (newer.rowCount) {
      await work.tx.query(
        `UPDATE runs SET recovery_next_at=NULL,recovery_cancelled=true,recovery_blocked_reason='newer_session_run'
          WHERE workspace_id=$1 AND id=$2 AND attempt=$3 AND status IN ('error','stopped')`,
        [work.workspaceId,run.id,run.attempt],
      );
      return {...run,recovery_next_at:null,recovery_cancelled:true,recovery_blocked_reason:'newer_session_run'};
    }
  }
  const automaticDue = automaticRetryAt(run);
  if (automatic) {
    if (run.recovery_cancelled || run.stop_requested || !automaticDue) return run;
    if (automaticDue.getTime() > Date.now()) {
      const wait = new Error('run_recovery_not_due') as Error & { retryAfterSeconds?: number };
      wait.retryAfterSeconds = Math.max(1, Math.ceil((automaticDue.getTime() - Date.now()) / 1000));
      throw wait;
    }
  }
  const providerDeadline = run.recovery_not_before?.getTime() ?? 0;
  const boundedBackoff = automaticRetryAt({ ...run, recovery_cancelled: false })?.getTime() ?? 0;
  if (!automatic && Math.max(providerDeadline, boundedBackoff) > Date.now()) {
    throw new RouteError(
      'The provider recovery cooldown is still active. Hermes will retry automatically after the safe backoff.',
      'provider_retry_backoff_active',
      429,
    );
  }
  if (isEnginePaused(env)) throw new RouteError('The engine is paused for a deployment.', 'engine_paused',409);
  const safety = await inspectRecoverySafety(work.tx,work.workspaceId,run.id);
  if (safety.blockedReason) throw new RouteError(safety.message ?? 'Review the previous task before retrying.',safety.blockedReason,409);
  if (automatic && !isResponseOnlyRecoveryInput(safety.resumeInput)) {
    throw new RouteError(
      'Automatic recovery is limited to finishing a response from stored read-only results. Retry this task manually.',
      'automatic_recovery_requires_response_only',
      409,
    );
  }
  if (automatic && (env.AGENT_RUNTIME !== 'hermes' || env.MODEL_SCRIPTED === '1')) {
    throw new RouteError(
      'Automatic recovery requires an attested managed runtime. Retry this task manually.',
      'automatic_recovery_legacy_auth',
      409,
    );
  }
  if (env.MODEL_SCRIPTED !== '1' && env.AGENT_RUNTIME === 'hermes'
      && !isResponseOnlyRecoveryInput(safety.resumeInput)) {
    const authority = await work.tx.query(
      `SELECT 1 FROM runs WHERE workspace_id=$1 AND id=$2 AND attempt=$3
        AND runtime_request_attempt=$3 AND runtime_request IS NOT NULL LIMIT 1`,
      [work.workspaceId,run.id,run.attempt],
    );
    if (!authority.rowCount) {
      throw new RouteError(
        'The failed attempt has no verified runtime authority snapshot. Start a new turn instead.',
        'recovery_authority_snapshot_missing',
        409,
      );
    }
  }
  const approvalBlock = await approvalContinuationRetryBlock(work.tx,run.id,run.attempt+1);
  if (approvalBlock) throw new RouteError('This approved task needs renewed authorization before retrying.',approvalBlock,409);
  const busy = await work.tx.query(`SELECT 1 FROM runs WHERE workspace_id=$1 AND agent_id=$2 AND id<>$3 AND status IN ('working','waiting','stopping') LIMIT 1`,[work.workspaceId,agentId,run.id]);
  if (busy.rowCount) throw new RouteError('Iris already has another task in progress.', 'runtime_profile_busy',409);
  const model = await loadModel(work.tx,run.model_id);
  if (!model || model.disabled_reason || !model.supports_tools) throw new RouteError('Choose an available model before retrying.','model_unavailable',409);
  if (run.effort && model.effort_map?.[run.effort] === undefined) {
    throw new RouteError('The failed attempt’s reasoning setting is no longer available. Start a new turn instead.','model_effort_unavailable',409);
  }
  requireAllowedProvider(env,model.provider);
  if (env.MODEL_SCRIPTED !== '1') {
    const key = await work.tx.query<{status:string}>(`SELECT status FROM workspace_provider_keys WHERE workspace_id=$1 AND provider=$2 AND revoked_at IS NULL`,[work.workspaceId,model.provider]);
    if (!['verified','verified_scoped'].includes(key.rows[0]?.status ?? '')) throw new RouteError('Reconnect the provider before retrying.','key_unverified',409);
    if (env.AGENT_RUNTIME === 'hermes') {
      const binding = await resolveRuntimeBinding(env,work.tx,work.workspaceId,agentId);
      if (automaticRecoveryAuthBlocked(automatic,binding.runtimeAuthMode)) {
        throw new RouteError(
          'Automatic recovery requires an attested managed runtime. Retry manually or update the runtime binding.',
          'automatic_recovery_legacy_auth',
          409,
        );
      }
      await new HermesClient(binding.baseUrl,binding.apiKey,undefined,binding.transport).capabilities();
    }
  }
  const caps = await checkCaps(work.tx,work.workspaceId);
  if (!caps.allowed) throw new RouteError('The workspace has reached its run or token limit.',caps.reason ?? 'cap_exceeded',429);
  await consumeRate(work.tx,work.userId,work.workspaceId,{action:'run.retry',limit:10,windowSeconds:60});
  await requireInstanceCapacity(work.tx,env,work.workspaceId);
  const effort = run.effort;
  const attempt=run.attempt+1, traceId=crypto.randomUUID(), engineVersion=Number(env.ENGINE_VERSION ?? '1') || 1;
  await work.tx.query(
    `UPDATE runs SET attempt=$3,status='working',stop_requested=false,error=NULL,ended_at=NULL,
      engine_version=$4,trace_id=$5,workflow_instance_id=$6,model_id=$7,effort=$8,
      recovery_next_at=NULL,recovery_not_before=NULL,recovery_cancelled=false,recovery_blocked_reason=NULL,recovery_input=$9,
      automatic_recovery=$10,recovery_history=recovery_history || $11::jsonb
      WHERE workspace_id=$1 AND id=$2`,
    [work.workspaceId,run.id,attempt,engineVersion,traceId,runAttemptInstanceId(run.id,attempt),model.model_id,effort,safety.resumeInput,automatic,
     JSON.stringify([{attempt:run.attempt,model_id:run.model_id,effort:run.effort,trace_id:run.trace_id,status:run.status,reason:run.error?.reason ?? null,ended_at:run.ended_at?.toISOString() ?? null,next_model_id:model.model_id,trigger:automatic?'automatic':'manual'}])]);
  await work.tx.query(`UPDATE sessions SET last_activity_at=now() WHERE workspace_id=$1 AND id=$2`,[work.workspaceId,run.session_id]);
  const params:RunInstanceParams={runId:run.id,workspaceId:work.workspaceId,sessionId:run.session_id,attempt,engineVersion,traceId};
  const publishJobIds=await publishEvents(work.tx,work.workspaceId,[{kind:'run.status',sessionId:run.session_id,traceId,payload:{run_id:run.id,attempt,status:'working'}}]);
  work.jobs.push(...publishJobIds);
  const jobId=await enqueueJob(work.tx,work.workspaceId,'run_launch',`run-launch:${run.id}:${attempt}`,{
    ...params,
    ...(publishJobIds[0] ? {afterPublishJobId:publishJobIds[0]} : {}),
  });
  if(jobId) work.jobs.push(jobId);
  await work.tx.query(`INSERT INTO events(workspace_id,actor_type,actor_user_id,kind,run_id,session_id,agent_id) VALUES($1,$2,$3,'run.retried',$4,$5,$6)`,[work.workspaceId,automatic?'system':'user',automatic?null:work.userId,run.id,run.session_id,agentId]);
  return {...run,attempt,status:'working',model_id:model.model_id,effort};
}

export async function runLaunchJob(env:Env,job:Job):Promise<void> {
  const params=job.payload as RunInstanceParams & {afterPublishJobId?:string};
  if (!params?.runId || params.workspaceId!==job.workspace_id) throw new Error('run_launch_payload_invalid');
  const state=await withWorkspaceTransaction(env,job.workspace_id,async tx=>{
    const {rows}=await tx.query<{status:string;attempt:number;owner_id:string;publish_done:boolean}>(
      `SELECT r.status,r.attempt,s.owner_id,
              ($3::uuid IS NULL OR EXISTS(
                SELECT 1 FROM jobs dependency
                 WHERE dependency.workspace_id=$1 AND dependency.id=$3 AND dependency.done_at IS NOT NULL
              )) AS publish_done
         FROM runs r
         JOIN sessions s ON s.id=r.session_id
         JOIN members m ON m.workspace_id=r.workspace_id AND m.user_id=s.owner_id AND m.status='active'
        WHERE r.workspace_id=$1 AND r.id=$2 AND NOT r.stop_requested AND NOT s.archived AND NOT s.read_only`,
      [job.workspace_id,params.runId,params.afterPublishJobId ?? null],
    );
    return {
      // If the run is no longer launchable, this job is a completed no-op and
      // must not remain blocked forever behind an obsolete dependency.
      publishDone: rows[0]?.publish_done ?? true,
      allowed: rows[0]?.status==='working' && rows[0].attempt===params.attempt,
    };
  });
  if(!state.publishDone) {
    const pending = new Error('run_launch_waiting_for_initial_publish') as Error & {retryAfterSeconds?:number};
    pending.retryAfterSeconds=1;
    throw pending;
  }
  if(state.allowed) {
    const {afterPublishJobId: _dependency, ...instanceParams}=params;
    await createRunInstance(env,instanceParams);
  }
}

export async function runRecoveryJob(env:Env,job:Job):Promise<void> {
  const payload=job.payload as {run_id:string;agent_id:string;owner_id:string;expected_attempt:number};
  const jobs:string[]=[];
  try {
    await withWorkspaceTransaction(env,job.workspace_id,async tx=>{
      const work={tx,workspaceId:job.workspace_id,userId:payload.owner_id,jobs};
      const run=await loadRecoveryRun(work,payload.agent_id,payload.run_id);
      if (!run || run.attempt!==payload.expected_attempt || run.status!=='error' || run.recovery_cancelled) return;
      // Partner screening is proactive work and keeps its explicit automation
      // policy. A response continuation was already authorized by the user's
      // chat turn, so recovering it must not depend on partner automation.
      if (isPartnerScreeningRun(run)) {
        const policy = await wakePolicy(work,env,payload.agent_id);
        if (policy) throw new RouteError(policy,'automation_disabled',409);
      }
      await retryTask(work,env,payload.agent_id,run.id,payload.expected_attempt,true);
    });
  } catch(error) {
    if (!(error instanceof RouteError) && job.attempts<3) throw error;
    await withWorkspaceTransaction(env,job.workspace_id,tx=>tx.query(`UPDATE runs SET recovery_next_at=NULL,recovery_blocked_reason=$3,recovery_cancelled=true WHERE workspace_id=$1 AND id=$2 AND attempt=$4 AND status='error'`,[job.workspace_id,payload.run_id,error instanceof RouteError?error.reason:'runtime_unavailable',payload.expected_attempt]));
  }
  if(jobs.length) await runJobsAfterCommit(env,job.workspace_id,jobs);
}

/** A bounded Cron scan repairs failed handoffs even if a terminal callback was lost. */
export async function scheduleRunRecovery(env:Env):Promise<{queued:number}> {
  const includePartnerScreening = automatedTriggersEnabled(env);
  const client=await connect(env,'app');
  let workspaces:string[];
  try {workspaces=(await client.query<{workspace_id:string}>('SELECT workspace_id FROM workspace_directory ORDER BY workspace_id')).rows.map(r=>r.workspace_id);} finally {await client.end();}
  let queued=0;
  for(const workspaceId of workspaces) await withWorkspaceTransaction(env,workspaceId,async tx=>{
    const {rows}=await tx.query<RecoveryRun>(`SELECT r.*,s.owner_id,s.model_id AS session_model_id,s.effort AS session_effort
      FROM runs r JOIN sessions s ON s.id=r.session_id
      JOIN members m ON m.workspace_id=r.workspace_id AND m.user_id=s.owner_id AND m.status='active'
      WHERE r.workspace_id=$1 AND r.status='error'
       AND r.created_at>now()-interval '24 hours' AND r.attempt<3 AND NOT r.stop_requested
       AND NOT r.recovery_cancelled AND r.recovery_next_at IS NULL AND (r.recovery_blocked_reason IS NULL OR r.recovery_blocked_reason='payment_result_pending')
       AND NOT s.archived AND NOT s.read_only
       AND (
         (r.client_turn_id LIKE 'partner-screening:%' AND $2::boolean
          AND NOT EXISTS(SELECT 1 FROM runs newer WHERE newer.workspace_id=r.workspace_id AND newer.agent_id=r.agent_id
            AND newer.client_turn_id LIKE 'partner-screening:%' AND newer.created_at>r.created_at))
         OR
         (r.client_turn_id NOT LIKE 'partner-screening:%'
          AND NOT EXISTS(SELECT 1 FROM runs newer WHERE newer.workspace_id=r.workspace_id
            AND newer.session_id=r.session_id AND newer.created_at>r.created_at))
       )
      ORDER BY r.created_at DESC LIMIT 20 FOR UPDATE OF r SKIP LOCKED`,[workspaceId,includePartnerScreening]);
    for(const run of rows) {
      if (isPartnerScreeningRun(run)) {
        try {
          if (await wakePolicy({tx,workspaceId,userId:run.owner_id,jobs:[]},env,run.agent_id)) continue;
        } catch (error) {
          if (error instanceof RouteError && error.reason === 'agent_not_bound') continue;
          throw error;
        }
      }
      const due=automaticRetryAt(run); if(!due) continue;
      const safety=await inspectRecoverySafety(tx,workspaceId,run.id);
      if(safety.blockedReason) {await tx.query('UPDATE runs SET recovery_blocked_reason=$2 WHERE id=$1',[run.id,safety.blockedReason]);continue;}
      if(!isResponseOnlyRecoveryInput(safety.resumeInput)) {
        await tx.query(
          `UPDATE runs SET recovery_next_at=NULL,recovery_cancelled=true,
             recovery_blocked_reason='automatic_recovery_requires_response_only' WHERE id=$1`,
          [run.id],
        );
        continue;
      }
      const id=await enqueueJob(tx,workspaceId,'run_recovery',`run-recovery:${run.id}:${run.attempt}`,{run_id:run.id,agent_id:run.agent_id,owner_id:run.owner_id,expected_attempt:run.attempt});
      if(!id) continue;
      await tx.query('UPDATE jobs SET next_at=$2 WHERE id=$1',[id,due]);
      await tx.query('UPDATE job_ready SET next_at=$2 WHERE job_id=$1',[id,due]);
      await tx.query('UPDATE runs SET recovery_next_at=$2,recovery_blocked_reason=NULL WHERE id=$1',[run.id,due]);
      queued++;
    }
  });
  return {queued};
}

export async function wakeAuthorizedWork(work:RecoveryWork,env:Env,agentId:string):Promise<AgentRecoveryView> {
  await requireRecoveryAgent(work,agentId,true);
  const policy=await wakePolicy(work,env,agentId);
  if(policy) return {...blank(),state:'blocked',message:policy};
  // An unresolved cycle takes precedence over minting another search allowance.
  const pending = await unresolvedPartnerWork(work.tx,work.workspaceId,agentId);
  if (pending) return recoveryView(work,env,agentId,pending);
  const interval=automationIntervalMinutes(env), bucket=`${interval}m-${Math.floor(Date.now()/(interval*60000))}`;
  const key=`partner-screening:auto:${work.workspaceId}:${agentId}:${bucket}`;
  const id=await enqueueJob(work.tx,work.workspaceId,'partner_screening',key,{agent_id:agentId,owner_user_id:work.userId,bucket});
  if(id) work.jobs.push(id);
  const job=await work.tx.query<{done_at:Date|null}>('SELECT done_at FROM jobs WHERE workspace_id=$1 AND kind=$2 AND key=$3',[work.workspaceId,'partner_screening',key]);
  return {...blank(),state:job.rows[0]?.done_at?'idle':'queued',message:job.rows[0]?.done_at?'No new authorized work is due in this screening cycle.':'Iris is queued to check the current screening cycle.',can_run_now:false};
}
