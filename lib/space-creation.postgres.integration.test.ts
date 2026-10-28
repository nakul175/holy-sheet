import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {createDatabase,type Database,type Sql} from './database';
import {Repository} from './repository';
import {createSpaceIntent} from './space-creation';
import {createWorkspaceIntent} from './workspace-creation';
const url=process.env.HS_TEST_POSTGRES_URL;
let db:Database,r:Repository;
const actor={id:'holy1-pg-'+crypto.randomUUID()},workspaceId='holy1-pg-workspace-'+crypto.randomUUID();
describe.skipIf(!url)('HOLY-1 real PostgreSQL creation intents',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.pathname!=='/holy_sheet_acceptance')throw Error('Use the dedicated loopback acceptance database');
  vi.stubEnv('DATABASE_URL',url!);db=await createDatabase();r=new Repository(db);
  await db.query('INSERT INTO hs_users(id,name) VALUES($1,$2)',[actor.id,'Synthetic HOLY-1 acceptance actor']);
  await db.query('INSERT INTO hs_workspaces(id,name) VALUES($1,$2)',[workspaceId,'Synthetic HOLY-1 acceptance workspace']);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,actor.id]);
 });
 afterAll(async()=>{await db?.close();vi.unstubAllEnvs();});
 it('serializes concurrent first-space and first-page retries and retains IDs across migration replay',async()=>{
  const operation=crypto.randomUUID(),name='Concurrent HOLY-1 space';
  const spaces=await Promise.all([createSpaceIntent(r,actor,name,workspaceId,operation),createSpaceIntent(r,actor,name,workspaceId,operation)]);
  expect(spaces[1].id).toBe(spaces[0].id);expect((await db.query('SELECT id FROM hs_spaces WHERE workspace_id=$1 AND name=$2',[workspaceId,name])).rows).toHaveLength(1);
  const pageOperation=crypto.randomUUID(),pages=await Promise.all([r.create(actor,'First HOLY-1 page',spaces[0].id,null,pageOperation),r.create(actor,'First HOLY-1 page',spaces[0].id,null,pageOperation)]);
  expect(pages[1].id).toBe(pages[0].id);expect(pages[0].workspaceId).toBe(workspaceId);
  const replayDb=await createDatabase();try{const replay=new Repository(replayDb);expect((await createSpaceIntent(replay,actor,name,workspaceId,operation)).id).toBe(spaces[0].id);expect((await replay.create(actor,'First HOLY-1 page',spaces[0].id,null,pageOperation)).id).toBe(pages[0].id);}finally{await replayDb.close();}
 });
 it('serializes Owner-only workspace retries and opens its first space and page without copying source memberships',async()=>{
  const command={name:'HOLY-1 Owner factory',sourceWorkspaceId:workspaceId,operationId:crypto.randomUUID()},results=await Promise.all([createWorkspaceIntent(r,actor,command),createWorkspaceIntent(r,actor,command)]);
  expect(results[1].workspace.id).toBe(results[0].workspace.id);expect(results.filter(v=>v.replayed)).toHaveLength(1);const created=results[0].workspace;
  expect((await db.query('SELECT user_id,role FROM hs_members WHERE workspace_id=$1',[created.id])).rows).toEqual([{user_id:actor.id,role:'owner'}]);expect((await db.query('SELECT correlation_id FROM hs_workspace_audit WHERE workspace_id=$1',[created.id])).rows).toEqual([{correlation_id:command.operationId}]);
  const space=await createSpaceIntent(r,actor,'First space',created.id,crypto.randomUUID()),page=await r.create(actor,'First page',space.id,null,crypto.randomUUID());expect(page.workspaceId).toBe(created.id);expect((await r.get(page.id,actor)).role).toBe('owner');
 });
 it('fences source Owner revocation against creation and denies fresh operations after revocation',async()=>{
  const source='holy1-owner-fence-'+crypto.randomUUID();await db.query('INSERT INTO hs_workspaces(id,name) VALUES($1,$2)',[source,'Synthetic source fence']);await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[source,actor.id]);
  let entered!:()=>void,release!:()=>void;const signal=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const paused=new Repository({...db,transaction:fn=>db.transaction(tx=>fn({query:async(sql,values)=>{if(sql.startsWith('INSERT INTO hs_workspaces(id,name,access_model_version)')){entered();await gate;}return tx.query(sql,values);}}))});
  const creation=createWorkspaceIntent(paused,actor,{name:'HOLY-1 fenced workspace',sourceWorkspaceId:source,operationId:crypto.randomUUID()});await signal;const revoke=db.query('UPDATE hs_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[source,actor.id]);
  try{let blocked=false;for(let i=0;i<100;i++){const locks=await db.query<{n:string}>('SELECT count(*) AS n FROM pg_locks WHERE granted=false');if(Number(locks.rows[0].n)>0){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);}finally{release();}
  const [created]=await Promise.all([creation,revoke]);expect(created.workspace.canCreateWorkspace).toBe(true);await expect(createWorkspaceIntent(r,actor,{name:'Denied after revoke',sourceWorkspaceId:source,operationId:crypto.randomUUID()})).rejects.toMatchObject({status:404});expect((await db.query("SELECT id FROM hs_workspaces WHERE name='Denied after revoke'")).rows).toEqual([]);
 });
 it('rolls back both space and intent on persistence failure and rechecks revoked membership on replay',async()=>{
  const name='Rolled back HOLY-1 space',broken=new Repository({...db,transaction:<T>(fn:(tx:Sql)=>Promise<T>)=>db.transaction(tx=>fn({query:async(sql,values)=>{if(sql.startsWith('INSERT INTO hs_space_creations'))throw Error('Controlled intent failure');return tx.query(sql,values);}}))});
  await expect(createSpaceIntent(broken,actor,name,workspaceId,crypto.randomUUID())).rejects.toThrow('Controlled intent failure');expect((await db.query('SELECT id FROM hs_spaces WHERE workspace_id=$1 AND name=$2',[workspaceId,name])).rows).toHaveLength(0);
  const operation=crypto.randomUUID();await createSpaceIntent(r,actor,'Before revocation',workspaceId,operation);await db.query('UPDATE hs_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[workspaceId,actor.id]);
  await expect(createSpaceIntent(r,actor,'Before revocation',workspaceId,operation)).rejects.toMatchObject({status:404});
 });
});
