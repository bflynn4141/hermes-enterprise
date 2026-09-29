import { describe, expect, it } from 'vitest';
import { paymentBandAuthority } from '../../src/wallets/member-authority.js';
import { memberWalletSubmitSchema, type MemberWalletStamp } from '@hermes/shared';
import { encode64, memberChallenge, memberStampMatches, memberWalletBody, submitMemberWallet } from '../../src/wallets/member-provider.js';
const credentialId='Y3JlZGVudGlhbC0xMjM0NTY3OA';
async function stamp(body:string,origin='https://hermes.test',flags=5):Promise<MemberWalletStamp>{
  const auth=new Uint8Array(37);auth.set(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('hermes.test'))));auth[32]=flags;
  return {credentialId,authenticatorData:encode64(auth),clientDataJson:encode64(new TextEncoder().encode(JSON.stringify({type:'webauthn.get',challenge:await memberChallenge(body),origin}))),signature:'c2lnbmF0dXJl'};
}
describe('exact member wallet owner request',()=>{
  it('binds user verification, origin, RP, credential and the exact request bytes',async()=>{
    const body=memberWalletBody('org','member-operation',123),assertion=await stamp(body);
    const expected={credentialId,rpId:'hermes.test',origins:['https://hermes.test']};
    expect(await memberStampMatches(assertion,body,expected)).toBe(true);
    expect(await memberStampMatches(assertion,body+' ',expected)).toBe(false);
    expect(await memberStampMatches(await stamp(body,'https://evil.test'),body,expected)).toBe(false);
    expect(await memberStampMatches(await stamp(body,'https://hermes.test',1),body,expected)).toBe(false);
    expect(await memberStampMatches(assertion,body,{...expected,rpId:'evil.test'})).toBe(false);
    expect(await memberStampMatches({...assertion,credentialId:'d3JvbmctY3JlZGVudGlhbA'},body,expected)).toBe(false);
    expect(memberWalletSubmitSchema.safeParse({proposal_hash:'a'.repeat(64),stamp:assertion,organizationId:'foreign'}).success).toBe(false);
  });
  it('forwards only the exact browser stamp and never adds a parent API stamp',async()=>{
    const body=memberWalletBody('org','member-operation',123),assertion=await stamp(body);
    let observed=false;
    const result=await submitMemberWallet({baseUrl:'https://api.turnkey.test',fetch:async(input,init)=>{
      expect(String(input)).toBe('https://api.turnkey.test/public/v1/submit/create_wallet');expect(init?.body).toBe(body);
      const h=new Headers(init?.headers);expect(h.has('X-Stamp')).toBe(false);expect(JSON.parse(h.get('X-Stamp-Webauthn')!)).toEqual(assertion);
      observed=true;return Response.json({activity:{id:'act',status:'ACTIVITY_STATUS_COMPLETED'}});
    }},body,assertion);
    expect(observed).toBe(true);expect(result.kind).toBe('completed');
  });
  it('keeps transport, redirect, and server errors ambiguous',async()=>{
    const body=memberWalletBody('org','member-operation',123),assertion=await stamp(body);
    for(const fetcher of [async()=>{throw new Error('offline');},async()=>new Response('',{status:503}),async()=>new Response('',{status:302})]){
      expect((await submitMemberWallet({baseUrl:'https://api.turnkey.test',fetch:fetcher},body,assertion)).kind).toBe('ambiguous');
    }
  });
});

describe('payment quorum authority',()=>{
  it('detects group changes even when a member stays eligible in a one-from-each quorum',()=>{
    const rule={admins:true,roles:['finance'],approvals_required:2,allow_requester:true,one_from_each:true};
    expect(paymentBandAuthority(rule,{role:'admin',reviewer_roles:['finance']})).not.toEqual(paymentBandAuthority(rule,{role:'member',reviewer_roles:['finance']}));
    expect(paymentBandAuthority({...rule,one_from_each:false},{role:'admin',reviewer_roles:['finance']})).toEqual(paymentBandAuthority({...rule,one_from_each:false},{role:'member',reviewer_roles:['finance']}));
  });
});
