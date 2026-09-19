// The same execution boundary enforces consent for legacy and native runtimes.
import { describe,expect,it,vi } from 'vitest';
import { AGENT_OPERATION_CATALOG,agentOperationForTool,operationPermissionPatchSchema } from '@hermes/shared';
import { executeTool,TOOLS } from '../../src/engine/tools.js';
import { FakeAgentDb } from './engine/fake-db.js';
import { runHarness,toolCall,stop,textDelta } from './engine/harness.js';
import { FakeStep } from './engine/fake-step.js';

describe('supported operation consent',()=>{
  for(const decision of ['approved','denied'] as const) it(`legacy Workflow resumes only exact persisted ${decision} consent`,async()=>{
    const db=new FakeAgentDb({agentId:crypto.randomUUID()});
    const step=new FakeStep();
    const approvalId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    let status:'pending'|'approved'|'denied'='pending';
    let persisted:{toolName:string;toolCallId:string;arguments:Record<string,unknown>;status:string}|null=null;
    Object.assign(db,{
      operationConsent:async(input:{toolName:string;toolCallId:string;arguments:Record<string,unknown>})=>{persisted={...input,status};return{id:approvalId,status};},
      loadOperationApproval:async()=>persisted?{...persisted,status}:null,
    });
    let wakes=0;
    step.waitForEvent=async <T>(name:string,options:{type:string;timeout:string})=>{
      step.waits.push({name,options});
      wakes+=1;
      // An unrelated old question wakes first; it must not fail or execute.
      if(wakes===1){expect(db.instructions).toHaveLength(0);return {payload:{run_id:'other-run',key:'other-question'} as T};}
      status=decision;
      return {payload:{run_id:'ignored',key:`operation_approval:${approvalId}`} as T};
    };
    const result=await runHarness([{events:[toolCall('draft','propose_instruction',{body:'Exact consent text'}),stop('tool_use')]},{events:[textDelta('Finished.'),stop('end_turn')]}],{db,step});
    expect(db.contextFields.size).toBe(0);
    expect(db.instructions).toHaveLength(decision==='approved'?1:0);
    expect(result.error).toBeNull();
    expect(step.waits).toHaveLength(2);
    expect(step.waits[0]?.name).not.toBe(step.waits[1]?.name);
    if(decision==='approved') expect(db.instructions[0]?.body).toBe('Exact consent text');
  });
  it('offers only registered tools and no effects or authorization commands',()=>{
    for(const operation of AGENT_OPERATION_CATALOG) for(const name of operation.tool_names) expect(TOOLS.some(t=>t.name===name)).toBe(true);
    for(const name of ['pay_invoice','sign_agreement','send_email','grant_access','propose_approval','fetch_url']) expect(agentOperationForTool(name)).toBeUndefined();
  });
  it('rejects invented operations, stale-shaped revisions, and coercion',()=>{
    for(const input of [{revision:0,operation_id:'pay_invoice',require_human_approval:false},{revision:-1,operation_id:'save_review_notes',require_human_approval:false},{revision:0,operation_id:'save_review_notes',require_human_approval:'false'}]) expect(operationPermissionPatchSchema.safeParse(input).success).toBe(false);
  });
  for(const status of ['pending','approved','denied',null] as const) it(`${status??'Off'} cannot bypass or duplicate the action`,async()=>{
    const db=new FakeAgentDb({agentId:crypto.randomUUID()});
    const consent=vi.fn(async()=>status?{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',status}:null);
    const writes=Object.assign(db,{operationConsent:consent});
    const run=(await db.loadRun())!;
    const action=vi.fn(async()=>({ok:true as const,data:{done:true}}));
    const tool={...TOOLS.find(t=>t.name==='save_review_note')!,run:action};
    const result=await executeTool(tool,{body:'Exact reviewed text'},{writes,reads:db,run,toolCallId:'one',mode:'work',now:()=>new Date()});
    expect(action).toHaveBeenCalledTimes(status===null||status==='approved'?1:0);
    expect(consent).toHaveBeenCalledWith(expect.objectContaining({runId:run.id,toolCallId:'one',arguments:{body:'Exact reviewed text'}}));
    if(status==='pending') expect(result).toMatchObject({ok:true,waiting:{key:'operation_approval:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}});
    if(status==='denied') expect(result.ok).toBe(false);
  });
  it('Plan previews do not create consent or run effects',async()=>{
    const db=new FakeAgentDb({agentId:crypto.randomUUID()});
    const operationConsent=vi.fn();
    const writes=Object.assign(db,{operationConsent});
    const run=(await db.loadRun())!;
    const action=vi.fn();
    await executeTool({...TOOLS.find(t=>t.name==='save_review_note')!,run:action},{body:'Preview',request_id:crypto.randomUUID()},{writes,reads:db,run,toolCallId:'plan',mode:'plan',now:()=>new Date()});
    expect(action).not.toHaveBeenCalled();expect(operationConsent).not.toHaveBeenCalled();
  });
});
