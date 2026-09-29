import type { Context } from 'hono';
import { memberWalletAccessSchema, memberWalletProposalInputSchema, memberWalletSubmitSchema, type MemberWalletAccess, type MemberWalletOperation } from '@hermes/shared';
import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { consumeRate } from '../auth/rate-limit.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { inWorkspace, jsonBody, pathUuid, RouteError, type TenantWork } from './tenant.js';
import { turnkeySetupConfig } from '../wallets/turnkey-config.js';
import { readRoot, query, classifyActivity, sameCredentialId, type SubmitOutcome } from '../wallets/turnkey-client.js';
import { memberChallenge, memberWalletBody, memberStampMatches, readMemberWallet, sha256, submitMemberWallet, type VerifiedMemberWallet } from '../wallets/member-provider.js';

type C = Context<{ Bindings: Env }>;
type Snapshot = { member_id: string; member_name: string; member_status: string; owner_member_id: string; owner_user_id: string; provider_org_id: string; root_user_id: string; credential_id: string; root_setup_id: string };
type Operation = { id: string; workspace_id: string; member_id: string; owner_member_id: string; requested_by: string; kind: MemberWalletOperation['kind']; state: MemberWalletOperation['status']; proposal_hash: string; proposal: Snapshot; request_body: string; provider_org_id: string; wallet_name: string; provider_activity_id: string|null; expires_at: Date; created_at: Date; updated_at: Date };
const conflict = (code: string, message: string) => new RouteError(message, code, 409);
const unavailable = () => new RouteError('member wallet creation is not configured', 'owner_operations_not_configured', 503);
const isOpen = (state: string) => ['awaiting_owner_review', 'submitting', 'outcome_unknown'].includes(state);
const configured = (env: Env) => env.TURNKEY_MEMBER_WALLETS_ENABLED === '1' ? turnkeySetupConfig(env) : null;
const guardWrite = (c: C) => { requireOrigin(c, { required: true }); requireCsrf(c); };
async function audit(tx: Tx, workspaceId: string, userId: string, memberId: string) {
  await tx.query("INSERT INTO events(workspace_id,actor_type,actor_user_id,kind,member_id) VALUES($1,'user',$2,'settings.changed',$3)", [workspaceId,userId,memberId]);
}
async function snapshot(work: TenantWork, memberId: string): Promise<Snapshot|null> {
  const { rows } = await work.tx.query<Snapshot>(`SELECT m.id AS member_id,COALESCE(u.name,'Member') AS member_name,m.status AS member_status,
    c.root_member_id AS owner_member_id,o.user_id AS owner_user_id,c.provider_org_id,
    s.provider_root_user_id AS root_user_id,s.credential_id,s.id AS root_setup_id
    FROM members m JOIN users u ON u.id=m.user_id
    JOIN workspace_wallet_config c ON c.workspace_id=m.workspace_id AND c.status='root_verified'
    JOIN members o ON o.workspace_id=c.workspace_id AND o.id=c.root_member_id AND o.status='active' AND o.role='admin'
    JOIN wallet_root_setups s ON s.workspace_id=c.workspace_id AND s.member_id=o.id AND s.state='verified' AND s.provider_org_id=c.provider_org_id
    WHERE m.workspace_id=$1 AND m.id=$2`, [work.workspaceId,memberId]);
  return rows[0] ?? null;
}
async function target(work: TenantWork, id: string, active = false) {
  const { rows } = await work.tx.query<{ user_id: string; status: string }>('SELECT user_id,status FROM members WHERE workspace_id=$1 AND id=$2', [work.workspaceId,id]);
  const row = rows[0];
  if (!row || (work.role !== 'admin' && row.user_id !== work.userId) || (active && row.status !== 'active')) throw new RouteError('no member in this workspace', 'unknown_member',404);
  return row;
}
async function loadOperation(work: TenantWork, memberId: string, operationId?: string): Promise<Operation|null> {
  const { rows } = await work.tx.query<Operation>(`SELECT * FROM member_wallet_operations WHERE workspace_id=$1 AND member_id=$2
    ${operationId ? 'AND id=$3' : ''} ORDER BY created_at DESC,id DESC LIMIT 1`, operationId ? [work.workspaceId,memberId,operationId] : [work.workspaceId,memberId]);
  return rows[0] ?? null;
}
async function invalidate(work: TenantWork, op: Operation|null, current: Snapshot|null): Promise<void> {
  if (!op || op.state !== 'awaiting_owner_review') return;
  const changed = !current || current.member_status !== 'active' || Object.keys(op.proposal).some(k => op.proposal[k as keyof Snapshot] !== current[k as keyof Snapshot]);
  const next = changed ? 'changed' : new Date(op.expires_at).getTime() <= Date.now() ? 'expired' : null;
  if (!next) return;
  await work.tx.query('UPDATE member_wallet_operations SET state=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state=\'awaiting_owner_review\'', [work.workspaceId,op.id,next]);
  op.state = next;
}
async function overview(work: TenantWork, env: Env, memberId: string): Promise<MemberWalletAccess> {
  await target(work,memberId);
  const current = await snapshot(work,memberId);
  const op = await loadOperation(work,memberId);
  // GET stays read-only; expiry/context invalidation is represented immediately
  // and persisted on the next mutation/reconcile transaction.
  let status = op?.state;
  if (op?.state === 'awaiting_owner_review') {
    if (!current || current.member_status !== 'active' || Object.keys(op.proposal).some(k => op.proposal[k as keyof Snapshot] !== current[k as keyof Snapshot])) status='changed';
    else if (new Date(op.expires_at).getTime() <= Date.now()) status='expired';
  }
  const { rows: bindings } = await work.tx.query<{ address: string }>(`SELECT a.address FROM member_wallet_bindings b
    JOIN wallet_accounts a ON a.workspace_id=b.workspace_id AND a.principal_id=b.principal_id AND a.chain_id=8453
    JOIN workspace_wallet_config c ON c.workspace_id=b.workspace_id AND c.provider_org_id=b.provider_org_id AND c.status='root_verified'
    WHERE b.workspace_id=$1 AND b.member_id=$2`,[work.workspaceId,memberId]);
  const config = configured(env);
  let operation: MemberWalletOperation|null = null;
  if (op) operation={ id:op.id,kind:op.kind,status:status!,proposal_hash:op.proposal_hash,version:1,expires_at:new Date(op.expires_at).toISOString(),created_at:new Date(op.created_at).toISOString(),requested_by:op.requested_by,summary:`Create a wallet for ${op.proposal.member_name}`,
    request: status==='awaiting_owner_review' && current?.owner_user_id===work.userId && config
      ? {body:op.request_body,challenge:await memberChallenge(op.request_body),rp_id:config.rpId,credential_id:current.credential_id} : null };
  const { rows: owners } = current ? await work.tx.query<{name:string}>('SELECT u.name FROM members m JOIN users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.id=$2',[work.workspaceId,current.owner_member_id]) : {rows:[]};
  return memberWalletAccessSchema.parse({member_id:memberId,wallet_status:bindings[0]?'ready':status&&isOpen(status)?'awaiting_owner_review':'not_created',address:bindings[0]?.address??null,
    payment_review:{allowed:null,confirmed_at:null},owner:current?{member_id:current.owner_member_id,name:owners[0]?.name??'Workspace owner',is_current_user:current.owner_user_id===work.userId}:null,
    capability:{available:Boolean(config&&current),reason:env.TURNKEY_WALLETS_ENABLED!=='1'?'wallets_disabled':!current?'owner_setup_required':!config?'owner_operations_not_configured':null},
    payment_capability:{available:false,reason:'member_authenticator_and_policy_required'},operation,can_manage:work.role==='admin'&&current?.member_status!=='inactive'});
}
export async function getMemberWalletAccess(c:C):Promise<Response> {
  const id=pathUuid(c,'id'); c.header('Cache-Control','no-store');
  return c.json(await inWorkspace(c,w=>overview(w,c.env,id)));
}
export async function proposeMemberWallet(c:C):Promise<Response> {
  guardWrite(c); const id=pathUuid(c,'id'); const input=memberWalletProposalInputSchema.safeParse(await jsonBody(c));
  if(!input.success) throw new RouteError('choose a wallet operation','bad_wallet_operation',422);
  const result=await inWorkspace(c,async work=>{
    work.requireAdmin('changing member wallet access');requireStepUp(work.session);await target(work,id,true);
    if(!configured(c.env)) throw unavailable();
    if(input.data.kind!=='create_wallet') throw new RouteError('member passkey enrollment and a verified approval policy are required','member_payment_policy_required',503);
    await work.tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[work.workspaceId]);
    const current=await snapshot(work,id);if(!current)throw conflict('wallet_owner_required','set up the wallet owner first');
    const existing=await loadOperation(work,id);await invalidate(work,existing,current);
    if(existing&&isOpen(existing.state)) return overview(work,c.env,id);
    const ready=await work.tx.query('SELECT 1 FROM member_wallet_bindings WHERE workspace_id=$1 AND member_id=$2',[work.workspaceId,id]);
    if(ready.rows.length)throw conflict('member_wallet_exists','this member already has a wallet');
    await consumeRate(work.tx,work.userId,work.workspaceId,{action:'member_wallet.propose',limit:20,windowSeconds:3600});
    const operationId=crypto.randomUUID(),name=`hermes-member-${id}-${operationId}`;
    const body=memberWalletBody(current.provider_org_id,name,Date.now());
    const hash=await sha256(JSON.stringify({version:1,workspace_id:work.workspaceId,proposal:current,request_body:body}));
    await work.tx.query(`INSERT INTO member_wallet_operations(id,workspace_id,member_id,owner_member_id,requested_by,kind,proposal_hash,proposal,request_body,provider_org_id,wallet_name,expires_at)
      VALUES($1,$2,$3,$4,$5,'create_wallet',$6,$7::jsonb,$8,$9,$10,now()+interval '5 minutes')`,[operationId,work.workspaceId,id,current.owner_member_id,work.userId,hash,JSON.stringify(current),body,current.provider_org_id,name]);
    await audit(work.tx,work.workspaceId,work.userId,id);return overview(work,c.env,id);
  });c.header('Cache-Control','no-store');return c.json(result,201);
}
async function finish(env:Env,op:Operation,outcome:{state:'completed'|'rejected'|'outcome_unknown';wallet?:VerifiedMemberWallet;activityId?:string;code?:string}) {
  await withWorkspaceTransaction(env,op.workspace_id,async tx=>{
    const locked=await tx.query<Operation>('SELECT * FROM member_wallet_operations WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[op.workspace_id,op.id]);
    if(!locked.rows[0]||!['submitting','outcome_unknown'].includes(locked.rows[0].state))return;
    if(outcome.state==='completed'&&outcome.wallet){
      await tx.query('SELECT confirm_member_wallet($1,$2,$3)', [op.id,outcome.wallet.walletId,outcome.wallet.address]);
    }
    await tx.query(`UPDATE member_wallet_operations SET state=$3,provider_activity_id=COALESCE($4,provider_activity_id),failure_code=$5,updated_at=now() WHERE workspace_id=$1 AND id=$2`,[op.workspace_id,op.id,outcome.state,outcome.activityId??null,outcome.code??null]);
    await audit(tx,op.workspace_id,op.requested_by,op.member_id);
  });
}
async function providerFinish(env:Env,op:Operation,outcome:SubmitOutcome):Promise<void>{
  const activityId=outcome.kind==='completed'||outcome.kind==='pending'?outcome.activity.id:outcome.kind==='rejected'?outcome.activity?.id:outcome.activityId;
  if(outcome.kind==='rejected'){await finish(env,op,{state:'rejected',activityId,code:'provider_rejected'});return;}
  try{
    const config=configured(env);if(!config)throw new Error('configuration_changed');
    const wallet=await readMemberWallet(config.turnkey,op.provider_org_id,op.wallet_name);
    if(wallet){await finish(env,op,{state:'completed',wallet,activityId});return;}
  }catch{/* A result is never sufficient without provider read-back. */}
  await finish(env,op,{state:'outcome_unknown',activityId,code:'readback_required'});
}
export async function submitMemberWalletOperation(c:C):Promise<Response>{
  guardWrite(c);const id=pathUuid(c,'id'),operationId=pathUuid(c,'operationId');
  const parsed=memberWalletSubmitSchema.safeParse(await jsonBody(c));if(!parsed.success)throw new RouteError('invalid owner approval','bad_wallet_stamp',422);
  const config=configured(c.env);if(!config)throw unavailable();
  const prepared=await inWorkspace(c,async work=>{
    work.requireAdmin('approving member wallet setup');requireStepUp(work.session);await target(work,id,true);
    const current=await snapshot(work,id),op=await loadOperation(work,id,operationId);
    if(!op||!current||current.owner_user_id!==work.userId)throw new RouteError('the current wallet owner must approve','wallet_owner_required',403);
    return {op,current};
  });
  // Re-read custody before claiming the operation. The API key only queries.
  const root=await readRoot(config.turnkey,prepared.op.provider_org_id).catch(()=>null);
  if(!root||root.threshold!==1||root.rootUserIds.length!==1||root.rootUserIds[0]!==prepared.current.root_user_id
    ||!root.users.some(u=>u.userId===prepared.current.root_user_id&&u.apiKeyCount===0&&u.credentialIds.some(v=>sameCredentialId(v,prepared.current.credential_id))))
    throw conflict('wallet_owner_changed','wallet owner access must be checked again');
  const claim=await inWorkspace(c,async work=>{
    work.requireAdmin('approving member wallet setup');requireStepUp(work.session);await target(work,id,true);
    await work.tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[work.workspaceId]);
    const op=await loadOperation(work,id,operationId),current=await snapshot(work,id);
    if(!op||!current||current.owner_user_id!==work.userId)throw new RouteError('the current wallet owner must approve','wallet_owner_required',403);
    await invalidate(work,op,current);
    if(op.state!=='awaiting_owner_review')return {op:null,result:await overview(work,c.env,id)};
    if(op.proposal_hash!==parsed.data.proposal_hash||!await memberStampMatches(parsed.data.stamp,op.request_body,{credentialId:current.credential_id,rpId:config.rpId,origins:config.passkeyOrigins}))
      throw new RouteError('the passkey does not approve this exact request','bad_wallet_stamp',400);
    await consumeRate(work.tx,work.userId,work.workspaceId,{action:'member_wallet.submit',limit:20,windowSeconds:3600});
    await work.tx.query("UPDATE member_wallet_operations SET state='submitting',updated_at=now() WHERE workspace_id=$1 AND id=$2",[work.workspaceId,op.id]);
    return {op,result:null};
  });
  if(claim.op)await providerFinish(c.env,claim.op,await submitMemberWallet(config.turnkey,claim.op.request_body,parsed.data.stamp));
  c.header('Cache-Control','no-store');return c.json(claim.result??await inWorkspace(c,w=>overview(w,c.env,id)));
}
export async function cancelMemberWalletOperation(c:C):Promise<Response>{
  guardWrite(c);const id=pathUuid(c,'id'),operationId=pathUuid(c,'operationId');
  const result=await inWorkspace(c,async work=>{
    work.requireAdmin('cancelling wallet setup');requireStepUp(work.session);await target(work,id);
    await work.tx.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',[work.workspaceId]);
    const op=await loadOperation(work,id,operationId);if(!op)throw new RouteError('unknown wallet operation','unknown_wallet_operation',404);
    await invalidate(work,op,await snapshot(work,id));
    if(op.state==='awaiting_owner_review'){
      await work.tx.query("UPDATE member_wallet_operations SET state='cancelled',updated_at=now() WHERE workspace_id=$1 AND id=$2",[work.workspaceId,op.id]);
      await audit(work.tx,work.workspaceId,work.userId,id);
    }else if(['submitting','outcome_unknown'].includes(op.state))throw conflict('wallet_outcome_unknown','check the provider result before making another change');
    return overview(work,c.env,id);
  });return c.json(result);
}
export async function reconcileMemberWalletOperation(c:C):Promise<Response>{
  guardWrite(c);const id=pathUuid(c,'id'),operationId=pathUuid(c,'operationId');
  const op=await inWorkspace(c,async work=>{
    work.requireAdmin('checking wallet setup');await target(work,id);
    await consumeRate(work.tx,work.userId,work.workspaceId,{action:'member_wallet.reconcile',limit:30,windowSeconds:3600});
    const operation=await loadOperation(work,id,operationId);if(!operation)throw new RouteError('unknown wallet operation','unknown_wallet_operation',404);
    await invalidate(work,operation,await snapshot(work,id));return operation;
  });
  if(['submitting','outcome_unknown'].includes(op.state)&&Date.now()-new Date(op.updated_at).getTime()>15_000){
    const config=configured(c.env);if(!config)throw unavailable();
    let outcome:SubmitOutcome={kind:'ambiguous',reason:'reconciliation'};
    if(op.provider_activity_id){
      try{const response=await query<{activity?:Parameters<typeof classifyActivity>[0]}>(config.turnkey,'/public/v1/query/get_activity',{organizationId:op.provider_org_id,activityId:op.provider_activity_id});outcome=classifyActivity(response.activity);}catch{/* Still unknown; do not resubmit. */}
    }
    await providerFinish(c.env,op,outcome);
  }
  c.header('Cache-Control','no-store');return c.json(await inWorkspace(c,w=>overview(w,c.env,id)));
}
