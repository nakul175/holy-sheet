import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {createDatabase,type Database,type Sql} from './database';
import {Repository} from './repository';
import {createSpaceIntent} from './space-creation';
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
 it('rolls back both space and intent on persistence failure and rechecks revoked membership on replay',async()=>{
  const name='Rolled back HOLY-1 space',broken=new Repository({...db,transaction:<T>(fn:(tx:Sql)=>Promise<T>)=>db.transaction(tx=>fn({query:async(sql,values)=>{if(sql.startsWith('INSERT INTO hs_space_creations'))throw Error('Controlled intent failure');return tx.query(sql,values);}}))});
  await expect(createSpaceIntent(broken,actor,name,workspaceId,crypto.randomUUID())).rejects.toThrow('Controlled intent failure');expect((await db.query('SELECT id FROM hs_spaces WHERE workspace_id=$1 AND name=$2',[workspaceId,name])).rows).toHaveLength(0);
  const operation=crypto.randomUUID();await createSpaceIntent(r,actor,'Before revocation',workspaceId,operation);await db.query('UPDATE hs_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[workspaceId,actor.id]);
  await expect(createSpaceIntent(r,actor,'Before revocation',workspaceId,operation)).rejects.toMatchObject({status:404});
 });
});
