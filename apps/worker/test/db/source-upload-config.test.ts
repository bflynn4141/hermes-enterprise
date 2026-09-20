import { expect, it } from 'vitest';
import { declareUpload, uploadTarget } from '../../src/attachments/service.js';
import { makeEnv } from './harness.js';
import { seedWorkspace, withClient, setTenant } from './helpers.js';
import type { TenantWork } from '../../src/routes/tenant.js';

it('uses signed storage targets when configured and direct targets only for local development',async()=>{
  const configured=makeEnv({ENVIRONMENT:'staging',R2_ACCOUNT_ID:'test-account',R2_ACCESS_KEY_ID:'test-key',R2_SECRET_ACCESS_KEY:'test-secret',R2_BUCKET:'test-bucket'}).env;
  expect(await uploadTarget(configured,'https://staging.example.test','agent_file','ws','id','test/key','text/plain')).toMatchObject({direct:false,method:'PUT'});
  expect(await uploadTarget(makeEnv().env,'http://localhost:8787','agent_file','ws','id','test/key','text/plain')).toMatchObject({direct:true,url:'http://localhost:8787/w/ws/files/id/upload'});
  await expect(uploadTarget({...configured,R2_SECRET_ACCESS_KEY:undefined},'https://staging.example.test','agent_file','ws','id','test/key','text/plain')).rejects.toMatchObject({reason:'uploads_unavailable'});
});

for (const environment of ['staging','production'] as const) it(`${environment} refuses missing signing configuration before persisting uploads`,async()=>{
  const fx=await seedWorkspace();
  const env=makeEnv({ENVIRONMENT:environment}).env;
  await withClient('owner',async tx=>{
    await tx.query('BEGIN'); await setTenant(tx,fx.workspaceId,fx.adminId);
    const work={tx,workspaceId:fx.workspaceId,userId:fx.adminId} as unknown as TenantWork;
    for (const kind of ['agent_file','attachment'] as const) {
      await expect(declareUpload(env,work,kind,{name:'test.txt',size:10,mime:'text/plain',agent_id:fx.agentId})).rejects.toMatchObject({status:503,reason:'uploads_unavailable'});
      await expect(uploadTarget(env,'https://staging.example.test',kind,fx.workspaceId,fx.agentId,'test/key','text/plain')).rejects.toMatchObject({status:503,reason:'uploads_unavailable'});
    }
    expect((await tx.query('SELECT count(*) AS count FROM agent_files WHERE workspace_id=$1',[fx.workspaceId])).rows[0].count).toBe('0');
    expect((await tx.query('SELECT count(*) AS count FROM attachments WHERE workspace_id=$1',[fx.workspaceId])).rows[0].count).toBe('0');
    await tx.query('ROLLBACK');
  });
});
