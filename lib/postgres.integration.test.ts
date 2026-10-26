import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { createDatabase,type Database } from './database';
import { Repository } from './repository';
import { localActor } from './auth';
import { ensureIds,plainText } from './document';
import { changeSharing } from './sharing';

const url=process.env.HS_TEST_POSTGRES_URL;
let db:Database,r:Repository;
describe.skipIf(!url)('real PostgreSQL isolated acceptance',()=>{
  beforeAll(async()=>{
    const parsed=new URL(url!);
    if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.pathname!=='/holy_sheet_acceptance')throw new Error('Integration tests require the dedicated loopback acceptance database');
    vi.stubEnv('DATABASE_URL',url!);db=await createDatabase();r=new Repository(db);await r.seedLocal();
  });
  afterAll(async()=>{await db?.close();vi.unstubAllEnvs();});
  it('serializes actual concurrent writers and merges independent blocks without lost edits',async()=>{
    const p=await r.create(localActor,'PostgreSQL concurrency','space-product');
    const document=ensureIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'A'}]},{type:'paragraph',content:[{type:'text',text:'B'}]}]});
    await r.save(p.id,localActor,{operationId:crypto.randomUUID(),baseVersion:p.version,title:p.title,document});
    const base=await r.get(p.id,localActor),left=structuredClone(base.document),right=structuredClone(base.document);
    left.content![0].content![0].text='Left';right.content![1].content![0].text='Right';
    const results=await Promise.all([left,right].map(document=>r.save(p.id,localActor,{operationId:crypto.randomUUID(),baseVersion:base.version,title:base.title,document})));
    const saved=await r.get(p.id,localActor);expect(saved.version).toBe(base.version+2);expect(plainText(saved.document)).toBe('Left\nRight');expect(results.filter(x=>x.merged)).toHaveLength(1);
  });
  it('deduplicates concurrent identical retries and persists after connection-pool restart',async()=>{
    const p=await r.create(localActor,'PostgreSQL retry','space-product');
    const op={operationId:crypto.randomUUID(),baseVersion:p.version,title:p.title,document:ensureIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Durable'}]}]})};
    const results=await Promise.all([r.save(p.id,localActor,op),r.save(p.id,localActor,op)]);expect(results.filter(x=>x.replayed)).toHaveLength(1);
    await db.close();db=await createDatabase();r=new Repository(db);const saved=await r.get(p.id,localActor);expect(saved.version).toBe(2);expect(saved.document).toEqual(op.document);
  });
  it('serializes inherited-grant revocation with an in-flight document commit',async()=>{
    const editor={id:crypto.randomUUID()};await db.query('INSERT INTO hs_users(id,name) VALUES($1,$1)',[editor.id]);await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)",[editor.id]);
    const parent=await r.create(localActor,'Concurrent permissions','space-product'),child=await r.create(localActor,'Inherited child','space-product',parent.id);
    await changeSharing(r,localActor,parent.id,{operationId:crypto.randomUUID(),expectedVersion:1,recipientId:editor.id,role:'editor'});
    let signal!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{signal=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const paused=new Repository({...db,transaction:fn=>db.transaction(tx=>fn({query:async(sql,values)=>{if(sql.startsWith('UPDATE hs_pages SET title')){signal();await gate;}return tx.query(sql,values);}}))});
    const edit=paused.save(child.id,editor,{operationId:crypto.randomUUID(),baseVersion:child.version,title:'Committed before revocation',document:child.document});await entered;
    const revoke=changeSharing(r,localActor,parent.id,{operationId:crypto.randomUUID(),expectedVersion:2,recipientId:editor.id,role:null});
    try{let blocked=false;for(let i=0;i<100;i++){const result=await db.query<{count:string}>("SELECT count(*) FROM pg_locks WHERE granted=false");if(Number(result.rows[0].count)>0){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);}finally{release();}
    await Promise.all([edit,revoke]);expect((await r.get(child.id,localActor)).title).toBe('Committed before revocation');await expect(r.get(child.id,editor)).rejects.toMatchObject({status:404});await expect(r.save(child.id,editor,{operationId:crypto.randomUUID(),baseVersion:2,title:'Must not commit',document:child.document})).rejects.toMatchObject({status:404});
  });
});
