import { describe,expect,it } from 'vitest';
import { asUser,makeEnv } from './harness.js';
import { seedWorkspace,setTenant,withClient,type Fixture } from './helpers.js';
import { fetchReviewBinding,INBOX_HEADERS,seedRequest } from './m4-fixtures.js';
const env=()=>makeEnv().env;
async function sql(fx:Fixture,text:string,values:unknown[]=[]){return withClient('owner',async c=>{await c.query('BEGIN');await setTenant(c,fx.workspaceId,fx.adminId);const r=await c.query(text,values);await c.query('COMMIT');return r;});}
async function member(fx:Fixture){return (await sql(fx,'SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2',[fx.workspaceId,fx.memberId])).rows[0].id as string;}
const send=(fx:Fixture,path:string,body:unknown,method='PATCH')=>asUser(env(),fx.adminId,`/w/${fx.workspaceId}${path}`,{method,body});
async function custody(fx:Fixture){await sql(fx,"INSERT INTO workspace_wallet_config(workspace_id,status,provider_org_id) VALUES($1,'needs_attention',$2)",[fx.workspaceId,crypto.randomUUID()]);}
const rule=(over:object={})=>({admins:false,roles:['finance'],approvals_required:2,allow_requester:true,one_from_each:false,...over});
async function blocked(response:Response){expect(response.status).toBe(409);expect(await response.json()).toMatchObject({reason:'wallet_payment_permission_required'});}

describe('custody-backed payment authority boundary',()=>{
  it('allows existing business workflows before custody and requires owner policy for Finance changes afterward',async()=>{
    const fx=await seedWorkspace(),id=await member(fx);
    expect((await send(fx,`/members/${id}`,{reviewer_roles:['finance']})).status).toBe(200);
    await custody(fx);
    await blocked(await send(fx,`/members/${id}`,{reviewer_roles:[]}));
    // Nonfinancial responsibilities still work, including while Finance is held.
    expect((await send(fx,`/members/${id}`,{reviewer_roles:['finance','legal']})).status).toBe(200);
    expect((await sql(fx,'SELECT reviewer_roles FROM members WHERE id=$1',[id])).rows[0].reviewer_roles).toEqual(['finance','legal']);
  });
  it('compares custom-role and Admin eligibility separately in threshold bands',async()=>{
    const fx=await seedWorkspace(),id=await member(fx);
    const created=await send(fx,'/roles',{name:'Treasury'},'POST');const role=await created.json() as {slug:string;id:string};
    expect((await send(fx,'/approval-routes/payment',rule({threshold:{over_minor:50000,currency:'USD',rule:rule({admins:true,roles:[role.slug]})}}),'PUT')).status).toBe(200);
    // Already eligible in base: adding over-band eligibility must still be blocked.
    expect((await send(fx,`/members/${id}`,{reviewer_roles:['finance']})).status).toBe(200);await custody(fx);
    await blocked(await send(fx,`/members/${id}`,{reviewer_roles:['finance',role.slug]}));
    await blocked(await send(fx,`/members/${id}`,{role:'admin'}));
    await blocked(await send(fx,`/roles/${role.id}/members`,{user_ids:[fx.memberId]},'PUT'));
    expect((await sql(fx,'SELECT role,reviewer_roles FROM members WHERE id=$1',[id])).rows[0]).toMatchObject({role:'member',reviewer_roles:['finance']});
  });
  it('guards bulk Finance holders and changed payment rules, thresholds and resets',async()=>{
    const fx=await seedWorkspace();
    expect((await send(fx,'/approval-routes/payment',rule({threshold:{over_minor:1000,currency:'USD',rule:rule({admins:true})}}),'PUT')).status).toBe(200);
    await custody(fx);
    const finance=(await sql(fx,"SELECT id FROM workspace_roles WHERE workspace_id=$1 AND slug='finance'",[fx.workspaceId])).rows[0].id;
    await blocked(await send(fx,`/roles/${finance}/members`,{user_ids:[fx.adminId,fx.memberId]},'PUT'));
    await blocked(await send(fx,'/approval-routes/payment',rule({admins:true}),'PUT'));
    await blocked(await send(fx,'/approval-routes/payment',rule({threshold:{over_minor:2000,currency:'USD',rule:rule({admins:true})}}),'PUT'));
    await blocked(await send(fx,'/approval-routes/payment',{},'DELETE'));
    // Saving exactly the current policy is harmless and does not require a ceremony.
    expect((await send(fx,'/approval-routes/payment',rule({threshold:{over_minor:1000,currency:'USD',rule:rule({admins:true})}}),'PUT')).status).toBe(200);
  });
  it('blocks existing or externally assigned Finance holders at the actual payment confirmation endpoint',async()=>{
    const fx=await seedWorkspace(),e=env();
    const requestId=await seedRequest(fx,'invoice');
    const approved=await asUser(e,fx.adminId,`/w/${fx.workspaceId}/requests/${requestId}/decisions`,{method:'POST',headers:INBOX_HEADERS,body:{decision:'approve',...await fetchReviewBinding(e,fx,requestId)}});
    expect(approved.status).toBe(201);
    const payment=(await sql(fx,"SELECT id FROM effects WHERE workspace_id=$1 AND request_id=$2 AND kind='payment'",[fx.workspaceId,requestId])).rows[0].id;
    await custody(fx);
    // Mirrors an invitation/provisioning/IdP assignment: it cannot create a provider grant.
    await sql(fx,"UPDATE members SET reviewer_roles=ARRAY['finance'] WHERE workspace_id=$1 AND user_id=$2",[fx.workspaceId,fx.memberId]);
    for(const user of [fx.adminId,fx.memberId])await blocked(await asUser(e,user,`/w/${fx.workspaceId}/effects/${payment}/execute`,{method:'POST',body:{}}));
    expect((await sql(fx,'SELECT * FROM effect_confirmations WHERE effect_id=$1',[payment])).rows).toEqual([]);
    expect((await sql(fx,'SELECT status FROM effects WHERE id=$1',[payment])).rows[0].status).toBe('pending');
  });
});
