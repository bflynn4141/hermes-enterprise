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
  it('request_approval is off by default and, when on, parks a native propose_approval call until a person decides (C96)',async()=>{
    const {fx,runId}=await setup();const {env:e}=makeEnv();
    const MODEL='openrouter:anthropic/claude-sonnet-5';
    await withClient('owner',async c=>{await c.query('BEGIN');await setTenant(c,fx.workspaceId,fx.adminId);
      await c.query(`INSERT INTO agent_capabilities(workspace_id,agent_id,kind,title,tool_names) VALUES($1,$2,'can','Ask',ARRAY['propose_approval'])`,[fx.workspaceId,fx.agentId]);
      const member=(await c.query<{id:string}>('SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2',[fx.workspaceId,fx.memberId])).rows[0]!.id;
      await c.query(`INSERT INTO approval_policies(workspace_id,key,version,approval_type,requester_agent_id,max_budget_minor,priority,mode,prevent_self_review,steps)
        VALUES($1,'runtime-plan',1,'run_plan',$2,500,10,'parallel',true,$3::jsonb)`,[fx.workspaceId,fx.agentId,JSON.stringify([{id:'review',label:'Reviewer',order:0,reviewers:[{kind:'member',member_id:member}],quorum:1}])]);
      await c.query('UPDATE sessions SET model_id=$2 WHERE id=$1',[fx.sessionId,MODEL]);
      await c.query('UPDATE runs SET model_id=$2 WHERE id=$1',[runId,MODEL]);
      await c.query('COMMIT');});
    const args={label:'Bounded partner research',policy_key:'runtime-plan',target_agent_ids:[],target_member_ids:[],target_resource_ids:[],dependent_request_ids:[],proposal:{
      kind:'approval',approval_type:'run_plan',summary:'Continue the reviewed partner research plan.',consequence:'Authorize one linked run inside the exact model and spend limits.',evidence:[],illustrative:false,
      details:{goal:'Produce a cited shortlist.',steps:[{id:'research',label:'Research candidates',agent_id:fx.agentId,output:'Cited shortlist'}],participating_agents:[{agent_id:fx.agentId,role:'Researcher'}],
        deliverables:['Cited shortlist'],schedule:'Run once after final approval.',budget:{currency:'USD',estimated_min_minor:10,estimated_max_minor:100,cap_minor:500,estimated_input_tokens:500,estimated_output_tokens:200,
          total_token_cap:2000,call_cap:2,max_output_tokens_per_call:200,max_parallel_calls:1,model_ids:[MODEL],metered_tools:[],retries_included:1,illustrative:false}}}};
    const listed=await(await asUser(e,fx.adminId,path(fx))).json() as {operations:{id:string;require_human_approval:boolean}[]};
    expect(listed.operations).toContainEqual(expect.objectContaining({id:'request_approval',require_human_approval:false}));
    const db=new RuntimeDb(env,fx.workspaceId,'request-approval');
    const q=<T extends Record<string,unknown>>(sql:string,values:unknown[])=>readTenant(fx.workspaceId,fx.adminId,c=>c.query<T>(sql,values)).then(r=>r.rows);
    const parked=()=>q<{id:string;operation_id:string;status:string}>('SELECT id,operation_id,status FROM agent_operation_approvals WHERE run_id=$1',[runId]);
    const run=async()=>(await q<{status:string;waiting_for:string|null}>('SELECT status,waiting_for FROM runs WHERE id=$1',[runId]))[0]!;
    const approvals=async()=>(await q<{count:number}>(`SELECT count(*)::int AS count FROM requests WHERE workspace_id=$1 AND kind='approval'`,[fx.workspaceId]))[0]!.count;
    // The bridge stores results under its own call ids, so count every tool result on the run.
    const toolResults=async()=>(await q<{count:number}>(`SELECT count(*)::int AS count FROM run_turns WHERE run_id=$1 AND role='tool'`,[runId]))[0]!.count;
    try{
      const remote=crypto.randomUUID();await db.bindRun(runId,1,remote,fx.sessionId,`agent-${fx.agentId}`);
      // Default: unchanged. The proposal is created at once and nothing is parked.
      const unparked=await dispatchRuntimeCall(db,fx.workspaceId,fx.agentId,{runtime_run_id:remote,tool_call_id:'default-call',name:'propose_approval',arguments:args});
      expect(unparked.reply).toMatchObject({ok:true});
      expect(await parked()).toEqual([]);
      expect(await approvals()).toBe(1);
      expect(await run()).toMatchObject({status:'working'});
      expect(await toolResults()).toBe(1);

      expect((await asUser(e,fx.adminId,path(fx),{method:'PATCH',body:{revision:0,operation_id:'request_approval',require_human_approval:true}})).status).toBe(200);
      const call={runtime_run_id:remote,tool_call_id:'switched-call',name:'propose_approval',arguments:args};
      expect((await dispatchRuntimeCall(db,fx.workspaceId,fx.agentId,call)).reply).toEqual({status:'pending'});
      const rows=await parked();
      expect(rows).toEqual([expect.objectContaining({operation_id:'request_approval',status:'pending'})]);
      const waiting=await run();
      expect(waiting.status).toBe('waiting');
      expect(waiting.waiting_for).toBe(`operation_approval:${rows[0]!.id}`);
      expect(await toolResults()).toBe(1);
      expect(await approvals()).toBe(1);
      // A retry before the decision stays parked and writes nothing.
      expect((await dispatchRuntimeCall(db,fx.workspaceId,fx.agentId,call)).reply).toEqual({status:'pending'});
      expect(await approvals()).toBe(1);

      expect((await asUser(e,fx.adminId,`${path(fx)}/approvals/${rows[0]!.id}`,{method:'POST',body:{decision:'approved'}})).status).toBe(200);
      const resumed=await dispatchRuntimeCall(db,fx.workspaceId,fx.agentId,call);
      expect(resumed.reply).toMatchObject({ok:true});
      expect(await run()).toMatchObject({status:'working',waiting_for:null});
      expect(await approvals()).toBe(2);
      expect(await toolResults()).toBe(2);
      // Replaying the same call returns the stored result and proposes nothing new.
      expect((await dispatchRuntimeCall(db,fx.workspaceId,fx.agentId,call)).reply).toEqual(resumed.reply);
      expect(await approvals()).toBe(2);
      expect(await toolResults()).toBe(2);
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
