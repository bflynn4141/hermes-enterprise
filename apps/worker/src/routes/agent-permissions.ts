// Per-operation consent never grants a capability or changes a business decision.
import type { Context } from 'hono';
import { AGENT_OPERATION_CATALOG, agentPermissionsSchema, operationApprovalDecisionSchema, operationPermissionPatchSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin } from '../auth.js';
import { PgAgentDb } from '../engine/pg-agent-db.js';
import { CONTEXT_ANSWERED_EVENT } from '../engine/constants.js';
import { inWorkspace, jsonBody, pathUuid, type TenantWork } from './tenant.js';
import { RouteError } from './errors.js';
import { requireAgentConfigAccess } from '../domain/agent-config-access.js';

async function agent(c: Context<{ Bindings: Env }>, work: TenantWork): Promise<string> {
  const id = pathUuid(c, 'agent');
  if (!(await work.tx.query('SELECT id FROM agents WHERE id=$1 AND workspace_id=$2', [id,work.workspaceId])).rows[0]) throw new RouteError('No such agent.', 'not_found',404);
  return id;
}
async function tools(c: Context<{ Bindings: Env }>, work: TenantWork, agentId: string): Promise<string[]> {
  const db = new PgAgentDb(c.env,work.workspaceId,crypto.randomUUID());
  try { return await db.loadToolNames(agentId); } finally { await db.close(); }
}
async function view(c: Context<{ Bindings: Env }>, work: TenantWork, agentId: string) {
  const names = new Set(await tools(c,work,agentId));
  const policy = (await work.tx.query<{revision: number; operations: Record<string,boolean>}>('SELECT revision,operations FROM agent_operation_policies WHERE agent_id=$1',[agentId])).rows[0];
  const pending = await work.tx.query<{id:string;operation_id:string;tool_name:string;arguments:Record<string,unknown>;run_id:string;created_at:Date}>(
    `SELECT a.id,a.operation_id,a.tool_name,a.arguments,a.run_id,a.created_at FROM agent_operation_approvals a JOIN runs r ON r.id=a.run_id
      WHERE a.agent_id=$1 AND $2::boolean AND a.status='pending' AND r.status IN ('working','waiting','queued') ORDER BY a.created_at LIMIT 100`,[agentId,work.role==='admin']);
  return agentPermissionsSchema.parse({agent_id:agentId,revision:policy?.revision??0,
    operations:AGENT_OPERATION_CATALOG.map(op=>({...op,tool_names:op.tool_names.filter(name=>names.has(name)),require_human_approval:policy?.operations[op.id]===true})).filter(op=>op.tool_names.length>0),
    pending_approvals:pending.rows.map(row=>({...row,created_at:row.created_at.toISOString()}))});
}
export async function getAgentPermissions(c: Context<{ Bindings: Env }>): Promise<Response> {
  return c.json(await inWorkspace(c,async work=>{
    const id=await agent(c,work);
    await requireAgentConfigAccess(work,id);
    return view(c,work,id);
  }));
}
export async function patchAgentPermissions(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c,{required:true}); requireCsrf(c);
  const parsed=operationPermissionPatchSchema.safeParse(await jsonBody(c));
  if(!parsed.success) throw new RouteError('Invalid operation policy.','invalid_policy');
  const input=parsed.data;
  return c.json(await inWorkspace(c,async work=>{
    work.requireAdmin('Changing operation approval');
    const id=await agent(c,work);
    await requireAgentConfigAccess(work,id);
    const supported=(await view(c,work,id)).operations.some(op=>op.id===input.operation_id);
    if(!supported) throw new RouteError('This agent cannot perform that operation.','operation_unavailable',409);
    await work.tx.query(`INSERT INTO agent_operation_policies(workspace_id,agent_id) VALUES($1,$2) ON CONFLICT(agent_id) DO NOTHING`,[work.workspaceId,id]);
    const changed=await work.tx.query(`UPDATE agent_operation_policies SET operations=jsonb_set(operations,ARRAY[$2],$3::jsonb),revision=revision+1,updated_at=now() WHERE agent_id=$1 AND revision=$4 RETURNING revision`,[id,input.operation_id,JSON.stringify(input.require_human_approval),input.revision]);
    if(!changed.rows[0]) throw new RouteError('Permissions changed. Refresh before saving.','version_conflict',409);
    await work.tx.query(`INSERT INTO agent_operation_policy_revisions(workspace_id,agent_id,revision,operation_id,require_human_approval,changed_by) VALUES($1,$2,$3,$4,$5,$6)`,[work.workspaceId,id,input.revision+1,input.operation_id,input.require_human_approval,work.userId]);
    await work.tx.query(`INSERT INTO events(workspace_id,actor_type,actor_user_id,kind,agent_id) VALUES($1,'user',$2,'settings.changed',$3)`,[work.workspaceId,work.userId,id]);
    return view(c,work,id);
  }));
}
export async function decideAgentOperation(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c,{required:true}); requireCsrf(c);
  const approvalId=pathUuid(c,'approval');
  const parsed=operationApprovalDecisionSchema.safeParse(await jsonBody(c));
  if(!parsed.success) throw new RouteError('Choose approve or decline.','invalid_decision');
  const outcome=await inWorkspace(c,async work=>{
    work.requireAdmin('Approving an agent operation');
    const id=await agent(c,work);
    await requireAgentConfigAccess(work,id);
    const row=(await work.tx.query<{id:string;run_id:string;status:string;tool_name:string;workflow_instance_id:string|null;run_status:string}>(
      `SELECT a.id,a.run_id,a.status,a.tool_name,r.workflow_instance_id,r.status AS run_status FROM agent_operation_approvals a JOIN runs r ON r.id=a.run_id WHERE a.id=$1 AND a.agent_id=$2 FOR UPDATE OF a`,[approvalId,id])).rows[0];
    if(!row) throw new RouteError('No such approval.','not_found',404);
    if(!['working','waiting','queued'].includes(row.run_status)) throw new RouteError('This run is no longer active.','run_inactive',409);
    if(row.status!== 'pending' && row.status!==parsed.data.decision) throw new RouteError('This approval was already decided.','approval_conflict',409);
    if(parsed.data.decision==='approved' && !(await tools(c,work,id)).includes(row.tool_name)) throw new RouteError('This tool is no longer available.','operation_unavailable',409);
    if(row.status==='pending') {
      await work.tx.query(`UPDATE agent_operation_approvals SET status=$2,decided_by=$3,decided_at=now() WHERE id=$1`,[approvalId,parsed.data.decision,work.userId]);
      await work.tx.query(`INSERT INTO events(workspace_id,actor_type,actor_user_id,kind,agent_id,run_id,subject_id) VALUES($1,'user',$2,'settings.changed',$3,$4,$5)`,[work.workspaceId,work.userId,id,row.run_id,approvalId]);
    }
    return row;
  });
  // Native bridge polls the same exact attempt; the legacy Workflow gets an ID-only wake.
  if(outcome.workflow_instance_id) {
    try { await (await c.env.RUN_ATTEMPT.get(outcome.workflow_instance_id)).sendEvent({type:CONTEXT_ANSWERED_EVENT,payload:{run_id:outcome.run_id,key:`operation_approval:${approvalId}`}}); }
    catch { /* The decision stays durable and the human may retry delivery. */ }
  }
  return c.json(await inWorkspace(c,async work=>{
    const id=await agent(c,work);
    await requireAgentConfigAccess(work,id);
    return view(c,work,id);
  }));
}
