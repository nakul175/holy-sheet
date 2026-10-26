import { beforeAll,afterAll,describe,it,expect,vi } from 'vitest';
import { createDatabase,type Database } from './database';
import { Repository } from './repository';
import { localActor } from './auth';
import { ensureIds,plainText } from './document';

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
});
