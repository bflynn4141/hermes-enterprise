// Real tenant Postgres accounting and authority; no provider/source calls.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RuntimeDb } from '../../src/runtime/store.js';
import { makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture, type RoleName } from './helpers.js';
interface Fx extends Fixture { assignmentId:string; modelId:string; runId:string; checkId:string }
type Client=Parameters<Parameters<typeof withClient>[1]>[0];
async function tx<T>(fx:Fixture,role:RoleName,work:(c:Client)=>Promise<T>):Promise<T>{
 return withClient(role,async c=>{await c.query('BEGIN');try{await setTenant(c,fx.workspaceId,fx.adminId);const result=await work(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}});
}
async function addCheck(fx:Omit<Fx,'runId'|'checkId'>,caps={run:0.025,day:0.025,calls:2}){
 const runId=randomUUID(),screeningId=randomUUID(),checkId=randomUUID(),sessionId=randomUUID();
 await tx(fx,'owner',async c=>{
  await c.query(`INSERT INTO sessions(id,workspace_id,owner_id,agent_id,title,model_id) VALUES($1,$2,$3,$4,'Budget concurrency test',$5)`,[sessionId,fx.workspaceId,fx.adminId,fx.agentId,fx.modelId]);
  await c.query(`INSERT INTO runs(id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,trace_id,runtime_kind,runtime_attempt,runtime_run_id) VALUES($1,$2,$3,$4,'working',$5,$6,$7,'hermes',1,$8)`,[runId,fx.workspaceId,sessionId,fx.agentId,fx.modelId,randomUUID(),randomUUID(),`native-${runId}`]);
  await c.query(`INSERT INTO partner_screening_runs(id,workspace_id,agent_id,created_by,idempotency_key,status,source,authentication,config_snapshot,api_requests_max) VALUES($1,$2,$3,$4,$5,'completed','github','unauthenticated','{}',1)`,[screeningId,fx.workspaceId,fx.agentId,fx.adminId,screeningId]);
  await c.query(`INSERT INTO partner_watch_checks(id,workspace_id,agent_id,owner_user_id,assignment_id,assignment_revision,screening_run_id,source_id,source_scope_sha256,max_api_requests,max_cost_usd_per_run,max_cost_usd_per_day,max_model_calls,status,run_id) VALUES($1,$2,$3,$4,$5,1,$6,'url:0',$7,1,$8,$9,$10,'changed',$11)`,[checkId,fx.workspaceId,fx.agentId,fx.adminId,fx.assignmentId,screeningId,'a'.repeat(64),caps.run,caps.day,caps.calls,runId]);
 });return{runId,checkId};
}
async function fixture(caps={run:0.025,day:0.025,calls:2}):Promise<Fx>{
 const base=await seedWorkspace(),assignmentId=randomUUID(),modelId=`openrouter:watch-test-${randomUUID()}`;
 await tx(base,'owner',async c=>{
  await c.query(`INSERT INTO catalog(model_id,provider,label,transport,pricing_per_million,pricing_verified_on,context_length,source) VALUES($1,'openrouter','Synthetic budget test','openrouter_chat','{"input":1,"output":2,"cached_input":0.25}',CURRENT_DATE,10000,'provider_list')`,[modelId]);
  await c.query(`INSERT INTO agent_owners(workspace_id,agent_id,member_id) SELECT $1,$2,id FROM members WHERE workspace_id=$1 AND user_id=$3`,[base.workspaceId,base.agentId,base.adminId]);
  await c.query(`INSERT INTO enterprise_skill_assignments(id,workspace_id,agent_id,skill_key,skill_version,config,schedule,assigned_by) VALUES($1,$2,$3,'partner-program-screening','1.11.0','{"source":"github","github_watch":{"enabled":true}}','{"enabled":true}',$4)`,[assignmentId,base.workspaceId,base.agentId,base.adminId]);
 });const identity={...base,assignmentId,modelId};return{...identity,...await addCheck(identity,caps)};
}
async function reserve(fx:Fx,runId=fx.runId,cost=0.011,attempt=1){return tx(fx,'agent',async c=>(await c.query<{reservation_id:string;budget_id:string}>('SELECT * FROM reserve_partner_watch_model_budget($1,$2,9000,1000,$3,$4)',[runId,fx.modelId,cost,attempt])).rows[0]!);}
async function reconcile(fx:Fx,id:string,resolution:string,usage:[number|null,number|null,number|null]=[null,null,null],cost:number|null=null){return tx(fx,'agent',c=>c.query('SELECT reconcile_partner_watch_model_budget($1,$2,$3,$4,$5,$6)',[id,resolution,...usage,cost]));}
async function ledger(fx:Fx){return tx(fx,'agent',async c=>(await c.query<{status:string;reserved_cost_usd:string;consumed_cost_usd:string|null}>('SELECT status,reserved_cost_usd,consumed_cost_usd FROM partner_watch_model_reservations ORDER BY created_at')).rows);}
describe('partner watch model budgets',()=>{
 it('serializes concurrent admission across checks against the agent day cap',async()=>{
  const fx=await fixture({run:0.02,day:0.02,calls:8}),other=await addCheck(fx,{run:0.02,day:0.02,calls:8});
  const results=await Promise.allSettled([reserve(fx),reserve(fx,other.runId)]);
  expect(results.filter(e=>e.status==='fulfilled')).toHaveLength(1);
  expect(results.find(e=>e.status==='rejected')).toMatchObject({reason:expect.objectContaining({message:expect.stringContaining('partner_watch_budget_daily_cost_limit')})});
  expect(await ledger(fx)).toHaveLength(1);
 });
 it('holds ambiguous calls and never resets the call allowance after rejection or recovery',async()=>{
  const fx=await fixture(),first=await reserve(fx);await reconcile(fx,first.reservation_id,'unresolved');
  const second=await reserve(fx);await reconcile(fx,second.reservation_id,'rejected');
  await expect(reserve(fx)).rejects.toThrow('partner_watch_budget_call_limit');
  await reconcile(fx,first.reservation_id,'completed',[1,1,0],0);
  expect(await ledger(fx)).toEqual([expect.objectContaining({status:'unresolved',consumed_cost_usd:'0.01100000'}),expect.objectContaining({status:'rejected',consumed_cost_usd:'0.00000000'})]);
 });
 it('settles exactly once at pinned rates and ignores claimed dollar usage',async()=>{
  const fx=await fixture(),first=await reserve(fx);
  await tx(fx,'owner',c=>c.query(`UPDATE catalog SET pricing_per_million='{"input":100,"output":100,"cached_input":100}' WHERE model_id=$1`,[fx.modelId]));
  await reconcile(fx,first.reservation_id,'completed',[10,20,4],0);await reconcile(fx,first.reservation_id,'completed',[500,500,0],100);
  expect(await ledger(fx)).toEqual([expect.objectContaining({status:'completed',consumed_cost_usd:'0.00004700'})]);
 });
 it('holds out of bound usage and refuses unknown or understated prices',async()=>{
  const fx=await fixture(),first=await reserve(fx);await reconcile(fx,first.reservation_id,'completed',[9001,1,0],0);
  expect((await ledger(fx))[0]).toMatchObject({status:'unresolved',consumed_cost_usd:'0.01100000'});
  await expect(reserve(fx,fx.runId,0)).rejects.toThrow('partner_watch_budget_price_changed');
  await tx(fx,'owner',c=>c.query(`UPDATE catalog SET pricing_per_million='{"input":null,"output":2}' WHERE model_id=$1`,[fx.modelId]));
  await expect(reserve(fx)).rejects.toThrow('partner_watch_budget_price_unknown');
 });
 it.each(['paused','revision','owner','membership','stopped'] as const)('rejects stale %s authority without making the watch ordinary',async change=>{
  const fx=await fixture();await tx(fx,'owner',async c=>{
   if(change==='paused'||change==='revision')await c.query(`UPDATE enterprise_skill_assignments SET revision=revision+1,state=$2 WHERE id=$1`,[fx.assignmentId,change==='paused'?'paused':'active']);
   if(change==='owner')await c.query('DELETE FROM agent_owners WHERE workspace_id=$1 AND agent_id=$2',[fx.workspaceId,fx.agentId]);
   if(change==='membership'){await c.query(`UPDATE members SET role='admin' WHERE workspace_id=$1 AND user_id=$2`,[fx.workspaceId,fx.memberId]);await c.query(`UPDATE members SET status='inactive' WHERE workspace_id=$1 AND user_id=$2`,[fx.workspaceId,fx.adminId]);}
   if(change==='stopped')await c.query(`UPDATE agents SET status='draft' WHERE id=$1`,[fx.agentId]);
  });await expect(reserve(fx)).rejects.toThrow('partner_watch_budget_authorization_stale');
  const runtime=new RuntimeDb(makeEnv().env,fx.workspaceId,randomUUID());try{
   await expect(runtime.runtimeBudgetForRun(fx.runId)).resolves.toMatchObject({kind:'partner_watch',budgetId:fx.checkId,authorizationState:'stale'});
   await expect(runtime.assertPartnerWatchAuthority(fx.runId)).rejects.toMatchObject({reason:'partner_watch_budget_authorization_stale'});
  }finally{await runtime.close();}
 });
 it('marks native success without the required review as permanent error and keeps its run/check budget',async()=>{
  const fx=await fixture(),reservation=await reserve(fx);
  const runtime=new RuntimeDb(makeEnv().env,fx.workspaceId,randomUUID());try{
   await runtime.finalizeRuntime(fx.runId,1,()=>runtime.setRunStatus(fx.runId,'completed'));
   await expect(runtime.terminalOutcome(fx.runId)).resolves.toMatchObject({status:'error',error:{reason:'partner_watch_review_missing',retryable:false}});
   await expect(runtime.runtimeBudgetForRun(fx.runId)).resolves.toMatchObject({kind:'partner_watch',budgetId:fx.checkId});
  }finally{await runtime.close();}
  expect((await ledger(fx))[0]).toMatchObject({status:'reserved',reserved_cost_usd:'0.01100000'});
  expect(reservation.budget_id).toBe(fx.checkId);
 });
 it('cancels only genuinely stopped unreviewed checks while keeping reserved spend',async()=>{
  const fx=await fixture();await reserve(fx);
  expect(await tx(fx,'agent',async c=>(await c.query('SELECT cancel_stopped_partner_watch($1) AS count',[fx.runId])).rows[0].count)).toBe(0);
  const runtime=new RuntimeDb(makeEnv().env,fx.workspaceId,randomUUID());try{
   await runtime.setRunStatus(fx.runId,'stopped');
   await expect(runtime.assertPartnerWatchAuthority(fx.runId)).rejects.toMatchObject({reason:'partner_watch_budget_authorization_stale'});
  }finally{await runtime.close();}
  expect(await ledger(fx)).toEqual([expect.objectContaining({status:'reserved',reserved_cost_usd:'0.01100000',consumed_cost_usd:null})]);
  expect(await tx(fx,'agent',async c=>(await c.query('SELECT cancel_stopped_partner_watch($1) AS count',[fx.runId])).rows[0].count)).toBe(0);
 });
 it('rejects old attempts, enforces write grants and isolates other tenants',async()=>{
  const fx=await fixture(),other=await seedWorkspace();await expect(reserve(fx,fx.runId,0.011,2)).rejects.toThrow('partner_watch_budget_run_inactive');const first=await reserve(fx);
  await expect(tx(fx,'agent',c=>c.query(`UPDATE partner_watch_model_reservations SET consumed_cost_usd=0 WHERE id=$1`,[first.reservation_id]))).rejects.toThrow('permission denied');
  await expect(tx(fx,'app',c=>c.query(`DELETE FROM partner_watch_model_reservations WHERE id=$1`,[first.reservation_id]))).rejects.toThrow('permission denied');
  expect(await tx(other,'agent',async c=>(await c.query('SELECT id FROM partner_watch_model_reservations')).rows)).toEqual([]);
  await expect(tx(other,'agent',c=>c.query('SELECT reconcile_partner_watch_model_budget($1,$2,NULL,NULL,NULL,NULL)',[first.reservation_id,'rejected']))).rejects.toThrow('partner_watch_budget_reservation_missing');
 });
});
