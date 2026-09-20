import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, withClient, setTenant, type Fixture } from './helpers.js';
import { captureContext } from '../../src/context-snapshot.js';
import { recordVerdict } from '../../src/attachments/service.js';
import { FakeR2 } from '../stubs/fake-r2.js';
import type { TenantWork } from '../../src/routes/tenant.js';

let fx: Fixture;
const env = makeEnv().env;
let file: string;
beforeEach(async () => {
  fx = await seedWorkspace(); file = randomUUID();
  await withClient('owner', async tx => {
    await tx.query('BEGIN'); await setTenant(tx,fx.workspaceId,fx.adminId);
    await tx.query(`INSERT INTO agent_context_notes(workspace_id,agent_id,title,text,author_id) VALUES($1,$2,'Private title','Private fact',$3)`,[fx.workspaceId,fx.agentId,fx.adminId]);
    await tx.query(`INSERT INTO agent_files(id,workspace_id,agent_id,name,storage_key,sha256,size_bytes,mime) VALUES($1,$2,$3,'Private source',$4,$5,10,'text/plain')`,[file,fx.workspaceId,fx.agentId,`test/${file}`,'a'.repeat(64)]);
    await tx.query(`INSERT INTO agent_owners(workspace_id,agent_id,member_id) SELECT $1,$2,id FROM members WHERE workspace_id=$1 AND user_id=$3`,[fx.workspaceId,fx.agentId,fx.memberId]);
    await tx.query('COMMIT');
  });
});
const notes = () => `/w/${fx.workspaceId}/agents/${fx.agentId}/context-notes`;
const files = () => `/w/${fx.workspaceId}/files?agent_id=${fx.agentId}`;

it('owner can read private context; other active member/admin cannot enumerate or fetch it',async()=>{
  expect((await asUser(env,fx.memberId,notes())).status).toBe(200);
  expect((await asUser(env,fx.memberId,files())).status).toBe(200);
  expect((await asUser(env,fx.memberId,`/w/${fx.workspaceId}/files/${file}`)).status).toBe(200);
  for (const url of [notes(),files(),`/w/${fx.workspaceId}/files/${file}`]) {
    const response=await asUser(env,fx.adminId,url);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('Private');
  }
  expect((await asUser(env,fx.adminId,`/w/${fx.workspaceId}/files`)).status).toBe(400);
  expect((await asUser(env,fx.adminId,notes(),{method:'POST',body:{title:'Overwrite',text:'No'}})).status).toBe(404);
});

it('direct capture cannot bypass ownership, including notes-only capture',async()=>{
  await withClient('owner',async tx=>{
    await tx.query('BEGIN'); await setTenant(tx,fx.workspaceId,fx.adminId);
    const work={tx,workspaceId:fx.workspaceId,userId:fx.adminId} as unknown as TenantWork;
    for(const sources of [[],[{id:file,kind:'agent_file',sha256:'a'.repeat(64)}]]) {
      await expect(captureContext(work,env,fx.agentId,sources)).rejects.toMatchObject({status:404});
    }
    expect(await captureContext({...work,userId:fx.memberId},env,fx.agentId,[])).toMatchObject({notes:[{text:'Private fact'}]});
    await tx.query('ROLLBACK');
  });
});

it('removing an ownership binding cannot downgrade private content to shared',async()=>{
  await withClient('owner',async tx=>{
    await tx.query('BEGIN'); await setTenant(tx,fx.workspaceId,fx.adminId);
    await tx.query('DELETE FROM agent_owners WHERE workspace_id=$1 AND agent_id=$2',[fx.workspaceId,fx.agentId]);
    await tx.query('UPDATE sessions SET owner_id=$2 WHERE id=$1',[fx.sessionId,fx.memberId]);
    await tx.query('COMMIT');
  });
  // A provisioning GET must not recreate a revoked grant from session ownership.
  await asUser(env,fx.memberId,`/w/${fx.workspaceId}/agents/${fx.agentId}/provisioning`);
  expect((await asUser(env,fx.memberId,notes())).status).toBe(404);
  expect((await asUser(env,fx.adminId,files())).status).toBe(404);
});

it('rechecks source authorization when recording an upload verification result',async()=>{
  await withClient('owner',async tx=>{
    await tx.query('BEGIN'); await setTenant(tx,fx.workspaceId,fx.memberId);
    await tx.query('DELETE FROM agent_owners WHERE workspace_id=$1 AND agent_id=$2',[fx.workspaceId,fx.agentId]);
    const work={tx,workspaceId:fx.workspaceId,userId:fx.memberId} as unknown as TenantWork;
    await expect(recordVerdict(work,'agent_file',file,{ok:true,digest:'b'.repeat(64)})).rejects.toMatchObject({status:404});
    await expect(recordVerdict(work,'agent_file',file,{ok:false,reason:'magic_mismatch',detail:'bad bytes',status:422})).rejects.toMatchObject({status:404});
    await tx.query('ROLLBACK');
  });
});

for (const invalid of [false,true]) it(`revocation during upload verification prevents ${invalid ? 'refusal/deletion' : 'completion'} through HTTP`,async()=>{
  const bucket=new FakeR2(), key=`test/${file}`;
  const bytes=invalid ? new Uint8Array([0xcf,0xfa,0xed,0xfe,7,0,0,1,0,0]) : new TextEncoder().encode('safe text!');
  await bucket.put(key,bytes);
  await withClient('owner',async tx=>{
    await tx.query('BEGIN'); await setTenant(tx,fx.workspaceId,fx.adminId);
    await tx.query('UPDATE agent_owners SET member_id=(SELECT id FROM members WHERE workspace_id=$1 AND user_id=$3) WHERE workspace_id=$1 AND agent_id=$2',[fx.workspaceId,fx.agentId,fx.adminId]);
    await tx.query('UPDATE agent_files SET sha256=NULL WHERE id=$1',[file]);
    await tx.query('COMMIT');
  });
  const get=bucket.get.bind(bucket);
  bucket.get=async key=>{
    await withClient('owner',async tx=>{
      await tx.query('BEGIN'); await setTenant(tx,fx.workspaceId,fx.adminId);
      await tx.query('DELETE FROM agent_owners WHERE workspace_id=$1 AND agent_id=$2',[fx.workspaceId,fx.agentId]);
      await tx.query('COMMIT');
    });
    return get(key);
  };
  const testEnv=makeEnv({UPLOADS:bucket as unknown as R2Bucket}).env;
  expect((await asUser(testEnv,fx.adminId,`/w/${fx.workspaceId}/files/${file}/complete`,{method:'POST'})).status).toBe(404);
  expect(bucket.objects.has(key)).toBe(true);
  await withClient('owner',async tx=>{
    await tx.query('BEGIN'); await setTenant(tx,fx.workspaceId,fx.adminId);
    expect((await tx.query('SELECT sha256,extraction_status FROM agent_files WHERE id=$1',[file])).rows[0]).toMatchObject({sha256:null,extraction_status:'pending'});
    await tx.query('ROLLBACK');
  });
});

it('allows the active team principal and fails closed after its binding is revoked',async()=>{
  await withClient('owner',async tx=>{
    await tx.query('BEGIN'); await setTenant(tx,fx.workspaceId,fx.adminId);
    await tx.query('DELETE FROM agent_owners WHERE workspace_id=$1 AND agent_id=$2',[fx.workspaceId,fx.agentId]);
    const team=randomUUID();
    await tx.query(`INSERT INTO enterprise_teams(id,workspace_id,slug,name) VALUES($1,$2,'partnerships','Partnerships')`,[team,fx.workspaceId]);
    await tx.query(`INSERT INTO enterprise_team_agents(workspace_id,team_id,agent_id,principal_user_id,role_template_key) VALUES($1,$2,$3,$4,'partnerships-agent')`,[fx.workspaceId,team,fx.agentId,fx.memberId]);
    await tx.query('COMMIT');
  });
  expect((await asUser(env,fx.memberId,notes())).status).toBe(200);
  expect((await asUser(env,fx.memberId,files())).status).toBe(200);
  expect((await asUser(env,fx.adminId,notes())).status).toBe(404);
  await withClient('owner',async tx=>{
    await tx.query('BEGIN'); await setTenant(tx,fx.workspaceId,fx.adminId);
    await tx.query('DELETE FROM enterprise_team_agents WHERE workspace_id=$1 AND agent_id=$2',[fx.workspaceId,fx.agentId]);
    await tx.query('COMMIT');
  });
  expect((await asUser(env,fx.memberId,notes())).status).toBe(404);
});

it('does not let an unrelated admin complete, delete, or declare private source files',async()=>{
  for (const suffix of ['/complete','']) {
    const response=await asUser(env,fx.adminId,`/w/${fx.workspaceId}/files/${file}${suffix}`,{method:suffix ? 'POST' : 'DELETE'});
    expect(response.status).toBe(404);
  }
  const response=await asUser(env,fx.adminId,`/w/${fx.workspaceId}/files`,{method:'POST',body:{agent_id:fx.agentId,name:'new.txt',mime:'text/plain',size:10}});
  expect(response.status).toBe(404);
});

it('inactive owners and other workspaces cannot access context',async()=>{
  const other=await seedWorkspace();
  expect((await asUser(env,other.adminId,notes())).status).not.toBe(200);
  await withClient('owner',async tx=>{
    await tx.query('BEGIN'); await setTenant(tx,fx.workspaceId,fx.adminId);
    await tx.query("UPDATE members SET status='inactive' WHERE workspace_id=$1 AND user_id=$2",[fx.workspaceId,fx.memberId]);
    await tx.query('COMMIT');
  });
  expect((await asUser(env,fx.memberId,notes())).status).not.toBe(200);
  expect((await asUser(env,fx.adminId,notes())).status).toBe(404);
});

it('explicit legacy shared context remains readable without making unbound private agents public',async()=>{
  const legacy=await seedWorkspace();
  expect((await asUser(env,legacy.memberId,`/w/${legacy.workspaceId}/agents/${legacy.agentId}/context-notes`)).status).toBe(200);
  await withClient('owner',async tx=>{
    await tx.query('BEGIN'); await setTenant(tx,legacy.workspaceId,legacy.adminId);
    await tx.query("UPDATE agents SET context_scope='private' WHERE id=$1",[legacy.agentId]);
    const work={tx,workspaceId:legacy.workspaceId,userId:legacy.adminId} as unknown as TenantWork;
    expect(await captureContext(work,env,legacy.agentId,[])).toEqual({notes:[],sources:[]});
    await tx.query('COMMIT');
  });
  expect((await asUser(env,legacy.memberId,`/w/${legacy.workspaceId}/agents/${legacy.agentId}/context-notes`)).status).toBe(404);
});
