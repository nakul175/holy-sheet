import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {createDatabase,type Database} from './database';
import {Repository} from './repository';
// Extracted from HOLY-1 hotfix1a5f4a6; standalone from unmerged creation features.
// Only real dedicated loopback PostgreSQL; default host runs explicitly skip.
const url=process.env.HS_TEST_POSTGRES_URL;let db:Database,r:Repository;
describe.skipIf(!url)('Observer ceiling real PostgreSQL creation/demotion fencing',()=>{
 beforeAll(async()=>{const parsed=new URL(url!);if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.pathname!=='/holy_sheet_acceptance')throw Error('Use the dedicated loopback acceptance database');vi.stubEnv('DATABASE_URL',url!);db=await createDatabase();r=new Repository(db);});
 afterAll(async()=>{await db?.close();vi.unstubAllEnvs();});
 it.each(['page','space'] as const)('serializes %s creation against Observer demotion and then enforces the read-only ceiling',async kind=>{
  const member={id:'holy1-demotion-'+crypto.randomUUID()},ws='holy1-demotion-ws-'+crypto.randomUUID(),space='holy1-demotion-space-'+crypto.randomUUID();
  await db.query('INSERT INTO hs_users(id,name) VALUES($1,$1)',[member.id]);await db.query('INSERT INTO hs_workspaces(id,name) VALUES($1,$1)',[ws]);await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'member')",[ws,member.id]);await db.query('INSERT INTO hs_spaces(id,workspace_id,name) VALUES($1,$2,$1)',[space,ws]);
  let entered!:()=>void,release!:()=>void;const signal=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const paused=new Repository({...db,transaction:fn=>db.transaction(tx=>fn({query:async(sql,values)=>{if(sql.startsWith(kind==='page'?'INSERT INTO hs_pages':'INSERT INTO hs_spaces')){entered();await gate;}return tx.query(sql,values);}}))});
  const creation=kind==='page'?paused.create(member,'Before demotion',space):paused.createSpace(member,'Before demotion',ws);await signal;
  let demotionPid:number|undefined;const demote=db.transaction(async tx=>{demotionPid=(await tx.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;await tx.query("UPDATE hs_members SET role='observer' WHERE workspace_id=$1 AND user_id=$2",[ws,member.id]);});
  try{let blocked=false;for(let i=0;i<100;i++){const locks=await db.query<{n:string}>('SELECT count(*) AS n FROM pg_locks WHERE granted=false AND pid=$1',[demotionPid??null]);if(Number(locks.rows[0].n)>0){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);}finally{release();}
  const [created]=await Promise.all([creation,demote]);
  await expect(r.create(member,'Forbidden after demotion',space)).rejects.toMatchObject({status:403,code:'read_only'});await expect(r.createSpace(member,'Forbidden after demotion',ws)).rejects.toMatchObject({status:403,code:'read_only'});
  if(kind==='page'){const page=await r.get(created.id,member);expect(page.role).toBe('viewer');await expect(r.save(page.id,member,{operationId:crypto.randomUUID(),baseVersion:page.version,title:'Forbidden owner edit',document:page.document})).rejects.toMatchObject({status:403,code:'read_only'});expect((await db.query('SELECT owner_id FROM hs_pages WHERE id=$1',[page.id])).rows[0].owner_id).toBe(member.id);}
  await db.query('UPDATE hs_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[ws,member.id]);await expect(r.create(member,'Inactive creation',space)).rejects.toMatchObject({status:404});await expect(r.createSpace(member,'Inactive creation',ws)).rejects.toMatchObject({status:404});
 });
});
