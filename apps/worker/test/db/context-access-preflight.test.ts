import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { expect, it } from 'vitest';
import { checkContextAccess, validateWorkspace, disposition } from '../../scripts/context-access-preflight.mjs';
import { loadMigrations, applyMigrations } from '../../scripts/migration-lib.mjs';
import { SUPERUSER_URL, OWNER_URL } from '../../scripts/db-config.mjs';

it('CLI refuses missing configuration and redacts connection errors; staging gates before migrations',()=>{
  const script=fileURLToPath(new URL('../../scripts/context-access-preflight.mjs',import.meta.url));
  for (const env of [{},{CONTEXT_PREFLIGHT_WORKSPACE_ID:randomUUID()},{CONTEXT_PREFLIGHT_WORKSPACE_ID:randomUUID(),DATABASE_URL_OWNER:'not-a-url-SECRET_SENTINEL'}]) {
    const result=spawnSync(process.execPath,[script],{env,encoding:'utf8'});
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Context compatibility preflight failed');
    expect(result.stderr).not.toContain('SECRET_SENTINEL');
  }
  const staging=readFileSync(new URL('../../../../.github/workflows/deploy-staging.yml',import.meta.url),'utf8');
  expect(staging.indexOf('scripts/context-access-preflight.mjs')).toBeLessThan(staging.indexOf('- name: Apply migrations'));
  expect(staging).toContain('vars.CONTEXT_PREFLIGHT_WORKSPACE_ID');
  expect(readFileSync(new URL('../../../../.github/workflows/deploy-production.yml',import.meta.url),'utf8')).not.toContain('context-access-preflight');
});

it('fails closed on missing/invalid scope without making any query', async () => {
  for (const value of [undefined, '', 'all', "x'; DROP TABLE agents;--"]) {
    expect(() => validateWorkspace(value)).toThrow();
    await expect(checkContextAccess({ query: () => { throw new Error('must not query'); } },value)).rejects.toThrow('configuration required');
  }
});

it('classifies conflicting/inactive bindings, occupied private agents and empty pools', () => {
  const base={file_count:1,note_count:0,session_count:0,context_scope:'private'};
  expect(disposition(base)).toBe('unbound_in_use');
  expect(disposition({...base,file_count:0})).toBe('empty');
  expect(disposition({...base,owner_user_id:'a',owner_status:'inactive'})).toBe('inactive_owner');
  expect(disposition({...base,principal_user_id:'a',principal_status:'inactive'})).toBe('inactive_principal');
  expect(disposition({...base,owner_user_id:'a',owner_status:'active',principal_user_id:'b',principal_status:'active'})).toBe('conflicting_bindings');
  expect(disposition({...base,owner_user_id:'a',owner_status:'active',other_session_owner:true})).toBe('incompatible_session_owner');
});

it('runs read-only on real 0050 and current schemas, scoped to exactly one workspace', async () => {
  const name=`hermes_context_preflight_${randomUUID().replaceAll('-','')}`;
  const forDb=(url:string,db:string)=>{const parsed=new URL(url);parsed.pathname=`/${db}`;return parsed.toString();};
  const admin=new pg.Client({connectionString:forDb(SUPERUSER_URL,'postgres')});
  const owner=new pg.Client({connectionString:forDb(OWNER_URL,name)});
  let created=false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" OWNER "owner" TEMPLATE template0`); created=true;
    await owner.connect();
    const catalog=await loadMigrations();
    await applyMigrations(owner,catalog.slice(0,50),{allowEdit:false});
    const ws=randomUUID(),user=randomUUID(),agent=randomUUID(),pool=randomUUID(),file=randomUUID();
    const mutate=async(sql:string,args:unknown[]=[])=>{
      await owner.query('BEGIN');
      try {
        await owner.query("SELECT set_config('app.workspace_id',$1,true)",[ws]);
        await owner.query(sql,args); await owner.query('COMMIT');
      } catch(error) {await owner.query('ROLLBACK');throw error;}
    };
    await mutate('INSERT INTO users(id,email,name) VALUES($1,$2,$3)',[user,`${user}@example.test`,'Preflight']);
    await mutate('INSERT INTO workspaces(id,name,slug,created_by) VALUES($1,$2,$3,$4)',[ws,'Test',ws,user]);
    await mutate("INSERT INTO members(workspace_id,user_id,role) VALUES($1,$2,'admin')",[ws,user]);
    await mutate("INSERT INTO agents(id,workspace_id,name) VALUES($1,$3,'Iris'),($2,$3,'Empty pool')",[agent,pool,ws]);
    await mutate('INSERT INTO agent_owners(workspace_id,agent_id,member_id) SELECT $1,$2,id FROM members WHERE workspace_id=$1 AND user_id=$3',[ws,agent,user]);
    await mutate("INSERT INTO agent_files(id,workspace_id,agent_id,name) VALUES($1,$2,$3,'Private')",[file,ws,agent]);
    const seen:string[]=[];
    const readOnlyClient={query:async(sql:string,args?:unknown[])=>{
      seen.push(sql);
      if(sql.startsWith('SELECT id FROM workspaces')) expect((await owner.query('SHOW transaction_read_only')).rows[0].transaction_read_only).toBe('on');
      return owner.query(sql,args);
    }};
    expect(await checkContextAccess(readOnlyClient,ws)).toMatchObject({ok:true,counts:{bound:1,empty:1}});
    expect(seen.some(sql=>sql.includes('FROM agent_context_notes n'))).toBe(false);
    await expect(checkContextAccess(owner,randomUUID())).rejects.toThrow('workspace missing');
    await mutate('DELETE FROM agent_owners WHERE agent_id=$1',[agent]);
    const blocked=await checkContextAccess(owner,ws);
    expect(blocked).toMatchObject({ok:false,counts:{unbound_in_use:1,empty:1},affected_agents:[{agent_id:agent,disposition:'unbound_in_use'}]});
    expect(JSON.stringify(blocked)).not.toContain(user);
    expect(JSON.stringify(blocked)).not.toContain('Private');
    await mutate('UPDATE agent_files SET agent_id=NULL WHERE id=$1',[file]);
    expect(await checkContextAccess(owner,ws)).toMatchObject({ok:false,counts:{unassigned_files:1}});
    await mutate('UPDATE agent_files SET agent_id=$2 WHERE id=$1',[file,agent]);
    await applyMigrations(owner,catalog,{allowEdit:false});
    expect(await checkContextAccess(owner,ws)).toMatchObject({ok:false,counts:{unbound_in_use:1}});
    await mutate("UPDATE agents SET context_scope='workspace' WHERE id=$1",[agent]);
    expect(await checkContextAccess(owner,ws)).toMatchObject({ok:true,counts:{explicitly_shared:1,empty:1}});
    await mutate('INSERT INTO agent_context_notes(workspace_id,agent_id,title,text,author_id) VALUES($1,$2,$3,$4,$5)',[ws,pool,'Note','Not logged',user]);
    expect(await checkContextAccess(owner,ws)).toMatchObject({ok:false,counts:{unbound_in_use:1}});
  } finally {
    await owner.end().catch(()=>{});
    if(created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
});
