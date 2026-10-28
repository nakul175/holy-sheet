import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {readFile} from 'node:fs/promises';
import {createDatabase,type Database} from './database';
import {Repository} from './repository';
import {localActor} from './auth';
import {ensureIds,validateDocument} from './document';
import {workspaceSearch} from './workspace-search';
import {searchPages} from './search';
const url=process.env.HS_TEST_POSTGRES_URL;
let db:Database,r:Repository;
describe.skipIf(!url)('HOLY-2 real PostgreSQL projection and candidate parity',()=>{
 beforeAll(async()=>{
  const parsed=new URL(url!);if(!['127.0.0.1','localhost'].includes(parsed.hostname)||parsed.pathname!=='/holy_sheet_acceptance')throw new Error('Requires dedicated disposable loopback acceptance database');
  vi.stubEnv('DATABASE_URL',url!);db=await createDatabase();r=new Repository(db);await r.seedLocal();
 },60000);
 afterAll(async()=>{await db?.close();vi.unstubAllEnvs();});
 it('keeps email, components, domains, dotted versions and long-word prefixes in the actual SQL candidate set',async()=>{
  const p=await r.create(localActor,'HOLY2 punctuation parity','space-product');
  const long='z'.repeat(300)+'endmarker',astral='a'+'\u{10428}'.repeat(180);
  const text='foo@example.com service.example.org v1.2.3 version 1.2.3 release-2026_10_28 foo+tag@example.com price² review ΟΣ İreview a\u1c89 '+long+' '+astral;
  const saved=await r.save(p.id,localActor,{operationId:crypto.randomUUID(),baseVersion:1,title:p.title,document:ensureIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]})});
  for(const query of ['foo@example.com','foo','example','example.com','service.example.org','v1.2.3','1.2','release-2026_10_28','foo+tag@example.com','z'.repeat(250),'"foo@example.com"','a'+'\u{10428}'.repeat(150),'price²','price² review','ΟΣ','ος','İreview','a\u1c89','a\u1c8a']){
   expect(searchPages([saved.page],query).map(x=>x.id),query).toContain(p.id);
   expect((await workspaceSearch(r,localActor,{workspaceId:p.workspaceId,query})).results.map(x=>x.id),query).toContain(p.id);
  }
 });
 it('reclassifies saved text, restore and additive backfill without stale Unicode coverage',async()=>{
  const p=await r.create(localActor,'HOLY2 classification transition','space-product');
  const save=async(text:string)=>{const current=await r.get(p.id,localActor);await r.save(p.id,localActor,{operationId:crypto.randomUUID(),baseVersion:current.version,title:current.title,document:ensureIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]})});};
  const flag=async()=>(await db.query<{ascii_only:boolean}>('SELECT ascii_only FROM hs_workspace_search WHERE page_id=$1',[p.id])).rows[0].ascii_only;
  await save('classificationascii');expect(await flag()).toBe(true);
  await save('classification² ΟΣ İreview');expect(await flag()).toBe(false);
  await db.query('UPDATE hs_pages SET deleted_at=now() WHERE id=$1',[p.id]);
  expect((await workspaceSearch(r,localActor,{workspaceId:p.workspaceId,query:'classification²'})).results.map(x=>x.id)).not.toContain(p.id);
  await db.query('UPDATE hs_pages SET deleted_at=NULL WHERE id=$1',[p.id]);
  expect((await workspaceSearch(r,localActor,{workspaceId:p.workspaceId,query:'classification²'})).results.map(x=>x.id)).toContain(p.id);
  await db.query('DELETE FROM hs_workspace_search WHERE page_id=$1',[p.id]);await db.query(await readFile('db/086_workspace_search.sql','utf8'));
  expect(await flag()).toBe(false);expect((await workspaceSearch(r,localActor,{workspaceId:p.workspaceId,query:'classification²'})).results.map(x=>x.id)).toContain(p.id);
  await save('classificationascii');expect(await flag()).toBe(true);
 });
 it('saves and backfills a valid near-limit lexically diverse page without an oversized vector or lost tail coverage',async()=>{
  const words=Array.from({length:180000},(_,i)=>'word'+i.toString(36).padStart(8,'0')+'x'.repeat(116));
  const text=words.join(' '),document=ensureIds({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});
  expect(Buffer.byteLength(JSON.stringify(document))).toBeLessThan(25000000);expect(Buffer.byteLength(text)).toBeGreaterThan(23000000);validateDocument(document);
  // Reproduce the published draft's unsafe full-vector boundary on real PostgreSQL.
  await expect(db.query("SELECT to_tsvector('simple',$1)",[text])).rejects.toThrow(/tsvector|string is too long/i);
  const p=await r.create(localActor,'HOLY2 large valid projection','space-product');
  await r.save(p.id,localActor,{operationId:crypto.randomUUID(),baseVersion:1,title:p.title,document});
  const check=async()=>{
   const sizes=(await db.query<{count:number;max:number}>("SELECT count(*)::integer AS count,max(pg_column_size(search_vector))::integer AS max FROM hs_workspace_search_terms WHERE page_id=$1",[p.id])).rows[0];
   expect(sizes.count).toBeGreaterThan(1);expect(sizes.max).toBeLessThan(1048576);
   for(const query of [words[0],words[90000],words.at(-1)!])expect((await workspaceSearch(r,localActor,{workspaceId:p.workspaceId,query})).results.map(x=>x.id)).toContain(p.id);
   expect((await db.query<{body:string}>('SELECT body FROM hs_workspace_search WHERE page_id=$1',[p.id])).rows[0].body).toBe(text);
  };
  await check();
  await db.query('DELETE FROM hs_workspace_search WHERE page_id=$1',[p.id]);
  await db.query(await readFile('db/086_workspace_search.sql','utf8'));
  await check();
 },120000);
});
