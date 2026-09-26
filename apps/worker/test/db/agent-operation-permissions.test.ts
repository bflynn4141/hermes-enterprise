// Real routes and restricted agent-role proofs for exact-attempt human consent.
import { describe,expect,it } from 'vitest';
import { asUser,makeEnv,readTenant } from './harness.js';
import { seedWorkspace,withClient,setTenant,type Fixture } from './helpers.js';
import { RuntimeDb } from '../../src/runtime/store.js';
import { dispatchRuntimeCall } from '../../src/runtime/bridge.js';
import { AGENT_URL,APP_URL } from '../../scripts/db-config.mjs';
import type { Env } from '../../src/env.js';
const env={ENVIRONMENT:'test',ENGINE_VERSION:'1',HYPERDRIVE_APP:{connectionString:APP_URL},HYPERDRIVE_AGENT:{connectionString:AGENT_URL}} as unknown as Env;
const path=(f:Fixture)=>`/w/${f.workspaceId}/agents/${f.agentId}/permissions`;
async function setup(){
  const fx=await seedWorkspace();
  const runId=await withClient('owner',async c=>{
    await c.query('BEGIN');await setTenant(c,fx.workspaceId,fx.adminId);
    await c.query(`INSERT INTO agent_capabilities(workspace_id,agent_id,kind,title,tool_names) VALUES($1,$2,'can','Draft',ARRAY['propose_instruction'])`,[fx.workspaceId,fx.agentId]);
    const row=(await c.query(`INSERT INTO runs(workspace_id,session_id,agent_id,status,model_id,client_turn_id,mode) VALUES($1,$2,$3,'working','deepseek-flash',$4,'work') RETURNING id`,[fx.workspaceId,fx.sessionId,fx.agentId,crypto.randomUUID()])).rows[0];
    await c.query(`INSERT INTO run_turns(workspace_id,run_id,turn,seq,role,provider_message) VALUES($1,$2,0,0,'user','{"role":"user","content":"start"}')`,[fx.workspaceId,row.id]);
    await c.query('COMMIT');return row.id as string;
  });
  return {fx,runId};
}
describe('agent operation permissions',()=>{
  it('lists only configured executable operations and preserves existing Off behavior',async()=>{
    const {fx}=await setup();const {env:e}=makeEnv();
    const r=await asUser(e,fx.adminId,path(fx));expect(r.status).toBe(200);
    const v=await r.json() as {operations:unknown[];revision:number};
    expect(v.revision).toBe(0);expect(v.operations).toEqual([expect.objectContaining({id:'prepare_drafts',tool_names:['propose_instruction'],require_human_approval:false})]);
  });
  it('requires admin, supported operation, tenant identity, and exact revision',async()=>{
    const {fx}=await setup();const other=await seedWorkspace();const {env:e}=makeEnv();
    const body={revision:0,operation_id:'prepare_drafts',require_human_approval:true};
    expect((await asUser(e,fx.adminId,path(fx),{method:'PATCH',body,origin:'https://attacker.example'})).status).toBe(403);
    expect((await asUser(e,fx.adminId,path(fx),{method:'PATCH',body,origin:null})).status).toBe(403);
    expect((await asUser(e,fx.memberId,path(fx),{method:'PATCH',body})).status).toBe(403);
    expect((await asUser(e,fx.adminId,`/w/${fx.workspaceId}/agents/${other.agentId}/permissions`,{method:'PATCH',body})).status).toBe(404);
    expect((await asUser(e,fx.adminId,path(fx),{method:'PATCH',body:{...body,operation_id:'save_review_notes'}})).status).toBe(409);
    const saved=await asUser(e,fx.adminId,path(fx),{method:'PATCH',body});expect(saved.status).toBe(200);
    expect((await asUser(e,fx.adminId,path(fx),{method:'PATCH',body})).status).toBe(409);
  });
  it('On parks native tool, Off does not release pending, human approval resumes once and replay stays exact',async()=>{
    const {fx,runId}=await setup();const {env:e}=makeEnv();
    expect((await asUser(e,fx.adminId,path(fx),{method:'PATCH',body:{revision:0,operation_id:'prepare_drafts',require_human_approval:true}})).status).toBe(200);
    const db=new RuntimeDb(env,fx.workspaceId,'consent');
    try{
      const remote=crypto.randomUUID();await db.bindRun(runId,1,remote,fx.sessionId,`agent-${fx.agentId}`);
      const call={runtime_run_id:remote,tool_call_id:'exact-call',name:'propose_instruction',arguments:{body:'Only this approved text'}};
      expect((await dispatchRuntimeCall(db,fx.workspaceId,fx.agentId,call)).reply).toEqual({status:'pending'});
      const view=await (await asUser(e,fx.adminId,path(fx))).json() as {pending_approvals:{id:string}[]};
      const id=view.pending_approvals[0]!.id;
      expect(await (await asUser(e,fx.memberId,path(fx))).json()).toMatchObject({pending_approvals:[]});
      expect((await asUser(e,fx.adminId,path(fx),{method:'PATCH',body:{revision:1,operation_id:'prepare_drafts',require_human_approval:false}})).status).toBe(200);
      expect((await dispatchRuntimeCall(db,fx.workspaceId,fx.agentId,call)).reply).toEqual({status:'pending'});
      expect((await asUser(e,fx.memberId,`${path(fx)}/approvals/${id}`,{method:'POST',body:{decision:'approved'}})).status).toBe(403);
      expect((await asUser(e,fx.adminId,`${path(fx)}/approvals/${id}`,{method:'POST',body:{decision:'approved'}})).status).toBe(200);
      const completed=await dispatchRuntimeCall(db,fx.workspaceId,fx.agentId,call);expect(completed.reply).toMatchObject({ok:true});
      expect((await dispatchRuntimeCall(db,fx.workspaceId,fx.agentId,call)).reply).toEqual(completed.reply);
      // The same native id with other arguments is a new call (providers reuse
      // per-response ids). It never inherits the earlier approval: with
      // approval back On it parks for a fresh human decision and writes nothing.
      expect((await asUser(e,fx.adminId,path(fx),{method:'PATCH',body:{revision:2,operation_id:'prepare_drafts',require_human_approval:true}})).status).toBe(200);
      expect((await dispatchRuntimeCall(db,fx.workspaceId,fx.agentId,{...call,arguments:{body:'Not reviewed'}})).reply).toEqual({status:'pending'});
      const pending=await (await asUser(e,fx.adminId,path(fx))).json() as {pending_approvals:{id:string}[]};
      expect(pending.pending_approvals.map((approval)=>approval.id)).not.toContain(id);
      const count=await readTenant(fx.workspaceId,fx.adminId,c=>c.query('SELECT count(*)::int AS count FROM instruction_versions WHERE run_id=$1',[runId]));
      expect(count.rows[0].count).toBe(1);
    }finally{await db.close();}
  });
  it('declined attempts remain denied, cannot be reapproved, and produce no write',async()=>{
    const {fx,runId}=await setup();const {env:e}=makeEnv();
    await asUser(e,fx.adminId,path(fx),{method:'PATCH',body:{revision:0,operation_id:'prepare_drafts',require_human_approval:true}});
    const db=new RuntimeDb(env,fx.workspaceId,'declined');
    try{
      const remote=crypto.randomUUID();await db.bindRun(runId,1,remote,fx.sessionId,`agent-${fx.agentId}`);
      const input={runtime_run_id:remote,tool_call_id:'declined-call',name:'propose_instruction',arguments:{body:'Do not write'}};
      await dispatchRuntimeCall(db,fx.workspaceId,fx.agentId,input);
      const view=await(await asUser(e,fx.adminId,path(fx))).json() as {pending_approvals:{id:string}[]};
      const approvalPath=`${path(fx)}/approvals/${view.pending_approvals[0]!.id}`;
      expect((await asUser(e,fx.adminId,approvalPath,{method:'POST',body:{decision:'denied'}})).status).toBe(200);
      expect((await asUser(e,fx.adminId,approvalPath,{method:'POST',body:{decision:'approved'}})).status).toBe(409);
      expect((await dispatchRuntimeCall(db,fx.workspaceId,fx.agentId,input)).reply).toMatchObject({ok:false});
      const count=await readTenant(fx.workspaceId,fx.adminId,c=>c.query('SELECT count(*)::int AS count FROM instruction_versions WHERE run_id=$1',[runId]));
      expect(count.rows[0].count).toBe(0);
    }finally{await db.close();}
  });
  it('agent cannot approve itself or alter policy and foreign tenants cannot read pending args',async()=>{
    const {fx,runId}=await setup();const other=await seedWorkspace();const {env:e}=makeEnv();
    await asUser(e,fx.adminId,path(fx),{method:'PATCH',body:{revision:0,operation_id:'prepare_drafts',require_human_approval:true}});
    const db=new RuntimeDb(env,fx.workspaceId,'consent');
    try{
      const approval=await db.operationConsent({runId,agentId:fx.agentId,toolCallId:'guard',toolName:'propose_instruction',arguments:{body:'private'}});
      expect(approval?.status).toBe('pending');
      await expect(db.runtimeQuery(`UPDATE agent_operation_approvals SET status='approved' WHERE id=$1`,[approval!.id])).rejects.toThrow();
      await expect(db.runtimeQuery(`UPDATE agent_operation_policies SET operations='{}' WHERE agent_id=$1`,[fx.agentId])).rejects.toThrow();
      await withClient('agent',async c=>{await c.query('BEGIN');await setTenant(c,other.workspaceId,other.adminId);expect((await c.query('SELECT id FROM agent_operation_approvals WHERE id=$1',[approval!.id])).rows).toEqual([]);await c.query('ROLLBACK');});
    }finally{await db.close();}
  });
});
