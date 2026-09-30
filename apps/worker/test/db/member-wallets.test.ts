import { beforeAll, describe, expect, it } from 'vitest';
import type { MemberWalletAccess, MemberWalletStamp } from '@hermes/shared';
import type { Env } from '../../src/env.js';
import { encode64, MEMBER_ACCOUNT } from '../../src/wallets/member-provider.js';
import { ALLOWED_ORIGIN, asUser, makeEnv } from './harness.js';
import { seedWorkspace,setTenant,withClient,type Fixture } from './helpers.js';
import { ageSession } from './m4-fixtures.js';
import { revokeAccess } from '../../src/routes/members.js';
import { withWorkspaceTransaction } from '../../src/jobs.js';
const credentialId='Y3JlZGVudGlhbC0xMjM0NTY3OA';
const orgId='11111111-2222-4333-8444-555555555555';
const rootId='aaaaaaaa-2222-4333-8444-555555555555';
const address='0x1234567890123456789012345678901234567890';
let key:{publicKey:string;privateKey:string};
beforeAll(async()=>{
  const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign']) as CryptoKeyPair;
  const jwk=await crypto.subtle.exportKey('jwk',pair.privateKey) as JsonWebKey;
  const bytes=(v:string)=>Uint8Array.from(atob(v.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(v.length/4)*4,'=')),c=>c.charCodeAt(0));
  const hex=(b:Uint8Array)=>Array.from(b,n=>n.toString(16).padStart(2,'0')).join('');
  key={publicKey:(bytes(jwk.y!)[31]!&1?'03':'02')+hex(bytes(jwk.x!)),privateKey:hex(bytes(jwk.d!))};
});
class Provider{
  calls:{path:string;body:Record<string,unknown>;stamp:string|null;apiStamp:string|null}[]=[];
  wallets:{walletId:string;walletName:string}[]=[];
  mode:'ok'|'drop_after_create'|'reject'|'bad_account'='ok';
  fetcher={fetch:async(request:Request)=>{
    const path=new URL(request.url).pathname,body=await request.json() as Record<string,unknown>;
    this.calls.push({path,body,stamp:request.headers.get('X-Stamp-Webauthn'),apiStamp:request.headers.get('X-Stamp')});
    if(path.endsWith('get_organization_configs'))return Response.json({configs:{quorum:{threshold:1,userIds:[rootId]}}});
    if(path.endsWith('list_users'))return Response.json({users:[{userId:rootId,apiKeys:[],authenticators:[{credentialId}]}]});
    if(path.endsWith('create_wallet')){
      if(this.mode==='reject')return Response.json({activity:{id:'act',status:'ACTIVITY_STATUS_REJECTED'}});
      const parameters=body.parameters as {walletName:string};this.wallets.push({walletId:crypto.randomUUID(),walletName:parameters.walletName});
      if(this.mode==='drop_after_create')throw new TypeError('lost response');
      return Response.json({activity:{id:'act',status:'ACTIVITY_STATUS_COMPLETED'}});
    }
    if(path.endsWith('list_wallets'))return Response.json({wallets:this.wallets});
    if(path.endsWith('list_wallet_accounts'))return Response.json({accounts:[{...MEMBER_ACCOUNT,organizationId:this.mode==='bad_account'?'foreign':orgId,walletId:body.walletId,address}]});
    if(path.endsWith('get_activity'))return Response.json({activity:{id:'act',status:'ACTIVITY_STATUS_COMPLETED'}});
    return new Response('',{status:404});
  }} as Fetcher;
}
async function sql<T extends Record<string,unknown>>(fx:Fixture,text:string,params:unknown[]=[]){
  return withClient('owner',async c=>{await c.query('BEGIN');await setTenant(c,fx.workspaceId,fx.adminId);const result=await c.query<T>(text,params);await c.query('COMMIT');return result;});
}
async function setup(){
  const fx=await seedWorkspace(),provider=new Provider();
  const rows=(await sql<{id:string;user_id:string}>(fx,'SELECT id,user_id FROM members WHERE workspace_id=$1',[fx.workspaceId])).rows;
  const memberId=rows.find(m=>m.user_id===fx.memberId)!.id,ownerId=rows.find(m=>m.user_id===fx.adminId)!.id;
  await sql(fx,"INSERT INTO workspace_wallet_config(workspace_id,status,provider_org_id,root_member_id,root_verified_at) VALUES($1,'root_verified',$2,$3,now())",[fx.workspaceId,orgId+'-'+fx.workspaceId,ownerId]);
  // The provider org is unique per fixture. The stub validates whatever org the request carries.
  await sql(fx,"UPDATE workspace_wallet_config SET provider_org_id=$2 WHERE workspace_id=$1",[fx.workspaceId,orgId+'-'+fx.workspaceId]);
  await sql(fx,`INSERT INTO wallet_root_setups(workspace_id,member_id,challenge,state,suborg_name,credential_id,provider_org_id,provider_root_user_id,expires_at)
    VALUES($1,$2,$3,'verified',$4,$5,$6,$7,now()+interval '1 hour')`,[fx.workspaceId,ownerId,encode64(crypto.getRandomValues(new Uint8Array(32))),`hermes-ws-${fx.workspaceId}-${crypto.randomUUID()}`,credentialId,orgId+'-'+fx.workspaceId,rootId]);
  const original=provider.fetcher.fetch.bind(provider.fetcher);
  provider.fetcher={fetch:async(req:Request)=>{
    const clone=req.clone(),body=await clone.json() as {organizationId?:string};const result=await original(req);
    if(new URL(req.url).pathname.endsWith('list_wallet_accounts')&&provider.mode!=='bad_account'){
      const payload=await result.json() as {accounts:Record<string,unknown>[]};payload.accounts[0]!.organizationId=body.organizationId;return Response.json(payload);
    }return result;
  }} as Fetcher;
  const env=makeEnv({TURNKEY_WALLETS_ENABLED:'1',TURNKEY_PROVISIONING_ENABLED:'1',TURNKEY_MEMBER_WALLETS_ENABLED:'1',TURNKEY_PARENT_ORG_ID:orgId,TURNKEY_API_PUBLIC_KEY:key.publicKey,TURNKEY_API_PRIVATE_KEY:key.privateKey,TURNKEY_PASSKEY_RP_ID:'localhost',TURNKEY_FETCHER:provider.fetcher}).env;
  return {fx,provider,env,memberId,ownerId};
}
const url=(fx:Fixture,id:string)=>`/w/${fx.workspaceId}/members/${id}/wallet-access`;
const propose=(env:Env,fx:Fixture,id:string,user=fx.adminId)=>asUser(env,user,url(fx,id)+'/proposals',{method:'POST',body:{kind:'create_wallet'}});
async function assertion(access:MemberWalletAccess):Promise<MemberWalletStamp>{
  const request=access.operation!.request!,auth=new Uint8Array(37);auth.set(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(request.rp_id))));auth[32]=5;
  return {credentialId:request.credential_id,authenticatorData:encode64(auth),signature:'c2lnbmF0dXJl',clientDataJson:encode64(new TextEncoder().encode(JSON.stringify({type:'webauthn.get',challenge:request.challenge,origin:ALLOWED_ORIGIN})))};
}
async function submit(env:Env,fx:Fixture,id:string,access:MemberWalletAccess,over:Record<string,unknown>={},user=fx.adminId){
  return asUser(env,user,`${url(fx,id)}/operations/${access.operation!.id}/submit`,{method:'POST',body:{proposal_hash:access.operation!.proposal_hash,stamp:await assertion(access),...over}});
}
describe('member owner-approved wallets',()=>{
  it('creates a real account only after exact owner approval and provider readback',async()=>{
    const {fx,provider,env,memberId}=await setup();const first=await propose(env,fx,memberId);expect(first.status).toBe(201);
    const access=await first.json() as MemberWalletAccess;expect(access.address).toBeNull();expect(access.operation?.request).toBeTruthy();
    const response=await submit(env,fx,memberId,access);expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({wallet_status:'ready',address,payment_review:{allowed:null},operation:{status:'completed'}});
    const create=provider.calls.filter(c=>c.path.endsWith('create_wallet'));expect(create).toHaveLength(1);expect(create[0]!.stamp).toBeTruthy();expect(create[0]!.apiStamp).toBeNull();
    await submit(env,fx,memberId,access);expect(provider.calls.filter(c=>c.path.endsWith('create_wallet'))).toHaveLength(1);
  });
  it('serializes concurrent proposals and never lets non-owners, tampered intent or stale sessions submit',async()=>{
    const {fx,provider,env,memberId}=await setup();const responses=await Promise.all([propose(env,fx,memberId),propose(env,fx,memberId)]);
    const a=await responses[0]!.json() as MemberWalletAccess,b=await responses[1]!.json() as MemberWalletAccess;expect(a.operation?.id).toBe(b.operation?.id);
    expect((await propose(env,fx,memberId,fx.memberId)).status).toBe(403);
    expect((await submit(env,fx,memberId,a,{proposal_hash:'f'.repeat(64)})).status).toBe(400);
    expect((await submit(env,fx,memberId,a,{},fx.memberId)).status).toBe(403);
    await ageSession(fx.adminId,10);expect((await submit(env,fx,memberId,a)).status).toBe(401);
    expect(provider.calls.filter(c=>c.path.endsWith('create_wallet'))).toHaveLength(0);
  });
  it('does not treat a provider success with an unverified account as ready and reconciles without resubmission',async()=>{
    const {fx,provider,env,memberId}=await setup();const access=await(await propose(env,fx,memberId)).json() as MemberWalletAccess;
    provider.mode='bad_account';expect(await(await submit(env,fx,memberId,access)).json()).toMatchObject({address:null,operation:{status:'outcome_unknown'}});
    expect((await asUser(env,fx.adminId,`${url(fx,memberId)}/operations/${access.operation!.id}/cancel`,{method:'POST',body:{}})).status).toBe(409);
    await sql(fx,"UPDATE member_wallet_operations SET updated_at=now()-interval '1 minute' WHERE id=$1",[access.operation!.id]);provider.mode='ok';
    expect(await(await asUser(env,fx.adminId,`${url(fx,memberId)}/operations/${access.operation!.id}/reconcile`,{method:'POST',body:{}})).json()).toMatchObject({wallet_status:'ready',address});
    expect(provider.calls.filter(c=>c.path.endsWith('create_wallet'))).toHaveLength(1);
  });
  it('persists cancellation and invalidates changed identity before making provider changes',async()=>{
    const {fx,provider,env,memberId}=await setup();const a=await(await propose(env,fx,memberId)).json() as MemberWalletAccess;
    const cancel=await asUser(env,fx.adminId,`${url(fx,memberId)}/operations/${a.operation!.id}/cancel`,{method:'POST',body:{}});expect(await cancel.json()).toMatchObject({operation:{status:'cancelled'}});
    const b=await(await propose(env,fx,memberId)).json() as MemberWalletAccess;
    await sql(fx,"UPDATE users SET name='Changed name' WHERE id=$1",[fx.memberId]);
    expect(await(await submit(env,fx,memberId,b)).json()).toMatchObject({operation:{status:'changed'}});
    expect(provider.calls.filter(c=>c.path.endsWith('create_wallet'))).toHaveLength(0);
  });
  it('keeps expired intent immutable and never submits for a removed member',async()=>{
    const {fx,provider,env,memberId}=await setup();const a=await(await propose(env,fx,memberId)).json() as MemberWalletAccess;
    await withClient('owner',async c=>{
      await c.query('BEGIN');await setTenant(c,fx.workspaceId,fx.adminId);
      await expect(c.query("UPDATE member_wallet_operations SET request_body='{}' WHERE id=$1",[a.operation!.id])).rejects.toMatchObject({code:'42501'});await c.query('ROLLBACK');
    });
    await asUser(env,fx.adminId,`${url(fx,memberId)}/operations/${a.operation!.id}/cancel`,{method:'POST',body:{}});
    const expiredId=crypto.randomUUID();
    await sql(fx,`INSERT INTO member_wallet_operations(id,workspace_id,member_id,owner_member_id,requested_by,kind,proposal_hash,proposal,request_body,provider_org_id,wallet_name,expires_at)
      SELECT $2,workspace_id,member_id,owner_member_id,requested_by,kind,proposal_hash,proposal,request_body,provider_org_id,$3,now()-interval '1 minute'
      FROM member_wallet_operations WHERE id=$1`,[a.operation!.id,expiredId,`expired-${expiredId}`]);
    const expired=await asUser(env,fx.adminId,`${url(fx,memberId)}/operations/${expiredId}/submit`,{method:'POST',body:{proposal_hash:a.operation!.proposal_hash,stamp:await assertion(a)}});
    expect(await expired.json()).toMatchObject({operation:{id:expiredId,status:'expired',request:null}});
    const b=await(await propose(env,fx,memberId)).json() as MemberWalletAccess;
    await sql(fx,"UPDATE members SET status='inactive' WHERE workspace_id=$1 AND id=$2",[fx.workspaceId,memberId]);
    expect((await submit(env,fx,memberId,b)).status).toBe(404);
    expect(await(await asUser(env,fx.adminId,url(fx,memberId))).json()).toMatchObject({operation:{status:'changed'}});
    expect(provider.calls.filter(c=>c.path.endsWith('create_wallet'))).toHaveLength(0);
  });
  it('reads back a lost response without creating a second wallet and isolates operation IDs between tenants',async()=>{
    const {fx,provider,env,memberId}=await setup();const a=await(await propose(env,fx,memberId)).json() as MemberWalletAccess;
    const other=await setup();
    expect((await asUser(other.env,other.fx.adminId,`${url(other.fx,other.memberId)}/operations/${a.operation!.id}/submit`,{method:'POST',body:{proposal_hash:a.operation!.proposal_hash,stamp:await assertion(a)}})).status).toBe(403);
    provider.mode='drop_after_create';expect(await(await submit(env,fx,memberId,a)).json()).toMatchObject({wallet_status:'ready',address});
    expect(provider.wallets).toHaveLength(1);
    await withClient('app',async c=>{await c.query('BEGIN');await setTenant(c,other.fx.workspaceId,other.fx.adminId);expect((await c.query('SELECT * FROM member_wallet_operations WHERE workspace_id=$1',[fx.workspaceId])).rows).toEqual([]);await c.query('ROLLBACK');});
  });
  it('requires custody transfer for an ordinary owner removal or demotion, while external revocation still closes access',async()=>{
    const {fx,env,memberId,ownerId}=await setup();
    await sql(fx,"UPDATE members SET role='admin' WHERE workspace_id=$1 AND id=$2",[fx.workspaceId,memberId]);
    for(const options of [{method:'DELETE'}, {method:'PATCH',body:{role:'member'}}]){
      const response=await asUser(env,fx.memberId,`/w/${fx.workspaceId}/members/${ownerId}`,options);
      expect(response.status).toBe(409);expect(await response.json()).toMatchObject({reason:'wallet_owner_transfer_required'});
    }
    expect((await sql(fx,'SELECT role,status FROM members WHERE id=$1',[ownerId])).rows[0]).toMatchObject({role:'admin',status:'active'});
    await withWorkspaceTransaction(env,fx.workspaceId,tx=>revokeAccess(tx,{workspaceId:fx.workspaceId,actorId:null,member:{id:ownerId,user_id:fx.adminId,role:'admin',status:'active',workos_membership_id:null},action:'remove'}));
    expect((await sql(fx,'SELECT status,provider_org_id,root_member_id FROM workspace_wallet_config WHERE workspace_id=$1',[fx.workspaceId])).rows[0]).toMatchObject({status:'needs_attention',root_member_id:ownerId});
    expect((await sql(fx,'SELECT status FROM members WHERE id=$1',[ownerId])).rows[0]).toMatchObject({status:'inactive'});
  });
  it('keeps disabled and unsupported authority paths closed and does not expose another member to ordinary members',async()=>{
    const {fx,env,memberId,ownerId}=await setup();
    expect((await propose({...env,TURNKEY_MEMBER_WALLETS_ENABLED:undefined},fx,memberId)).status).toBe(503);
    expect((await asUser(env,fx.adminId,url(fx,memberId)+'/proposals',{method:'POST',body:{kind:'grant_payment_review'}})).status).toBe(503);
    expect((await asUser(env,fx.memberId,url(fx,ownerId))).status).toBe(404);
    const other=await seedWorkspace();expect((await asUser(env,other.adminId,url(fx,memberId))).status).toBe(404);
    await withClient('app',async c=>{await c.query('BEGIN');await setTenant(c,fx.workspaceId,fx.adminId);await expect(c.query('SELECT confirm_member_wallet($1,$2,$3)',[crypto.randomUUID(),'wallet',address])).rejects.toMatchObject({code:'42501'});await c.query('ROLLBACK');});
    await withClient('agent',async c=>{await c.query('BEGIN');await setTenant(c,fx.workspaceId,fx.adminId);await expect(c.query('SELECT * FROM member_wallet_operations')).rejects.toMatchObject({code:'42501'});await c.query('ROLLBACK');});
  });
});
