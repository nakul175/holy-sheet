import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {createDatabase,type Database} from './database';
import {Repository} from './repository';
import {localActor as owner} from './auth';
import {prepareImport,readImport,changeImport,importFilename,type ImportRequest} from './document-imports';
import {ensureIds,plainText} from './document';
import type {ImportConversion} from './import-conversion';
import {maintainStorage} from './maintenance';
let db:Database,r:Repository;const other={id:'import-other'};
const conversion=():ImportConversion=>({document:ensureIds({type:'doc',content:[{type:'heading',attrs:{level:1},content:[{type:'text',text:'Imported heading'}]},{type:'paragraph',content:[{type:'text',text:'Preserved source body'}]}]}),warnings:[],omittedImages:0,blocks:2,expandedBytes:21});
const input=():ImportRequest=>({id:crypto.randomUUID(),spaceId:'space-product',title:'Independent imported page',filename:'example.md'});
const source=Buffer.from('source test');
beforeAll(async()=>{db=await createDatabase(':memory:');r=new Repository(db);await r.seedLocal();await db.query('INSERT INTO hs_users(id,name) VALUES($1,$1)',[other.id]);await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)",[other.id]);});afterAll(async()=>db.close());
it('previews without creating a page, then commits one private independent page with fresh block IDs',async()=>{
 const before=await db.query<{count:string}>('SELECT count(*)::text AS count FROM hs_pages'),converted=conversion(),p=await prepareImport(r,owner,input(),source,async()=>converted);expect(p.state).toBe('preview');expect(p.document?.content).toHaveLength(2);expect(await db.query('SELECT count(*)::text AS count FROM hs_pages')).toEqual(before);expect(p.document!.content![0].attrs!.id).not.toBe(converted.document.content![0].attrs!.id);
 const result=await changeImport(r,owner,p.id,{action:'commit',reviewHash:p.reviewHash}),page=await r.get(result.pageId!,owner);expect(page.title).toBe(p.title);expect(page.visibility).toBe('private');expect(page.version).toBe(1);expect(plainText(page.document)).toContain('Preserved source body');expect(page.document.content![0].attrs!.id).not.toBe(p.document!.content![0].attrs!.id);expect((await db.query('SELECT * FROM hs_grants WHERE page_id=$1',[page.id])).rows).toEqual([]);expect((await readImport(r,owner,p.id)).document).toBeNull();
});
it('replays prepared and committed retries without parsing or creating another page',async()=>{
 const i=input(),parse=vi.fn(async()=>conversion()),p=await prepareImport(r,owner,i,source,parse);expect((await prepareImport(r,owner,i,source,parse)).reviewHash).toBe(p.reviewHash);expect(parse).toHaveBeenCalledOnce();const first=await changeImport(r,owner,p.id,{action:'commit',reviewHash:p.reviewHash}),again=await changeImport(r,owner,p.id,{action:'commit',reviewHash:p.reviewHash});expect(again).toEqual({...first,replayed:true});expect((await db.query('SELECT * FROM hs_audit WHERE action=$1 AND correlation_id=$2',['import.commit',p.id])).rows).toHaveLength(1);await expect(prepareImport(r,owner,{...i,title:'changed'},source,parse)).rejects.toMatchObject({code:'operation_mismatch'});
});
it('does not reveal previews or allow actions across accounts, even another workspace member',async()=>{
 const p=await prepareImport(r,owner,input(),source,async()=>conversion());await expect(readImport(r,other,p.id)).rejects.toMatchObject({status:404});await expect(changeImport(r,other,p.id,{action:'commit',reviewHash:p.reviewHash})).rejects.toMatchObject({status:404});await expect(prepareImport(r,other,{...input(),id:p.id},source,async()=>conversion())).rejects.toMatchObject({status:404});
});
it('requires the reviewed digest and explicit image omission without changing any existing page',async()=>{
 const i=input(),p=await prepareImport(r,owner,i,source,async()=>({...conversion(),omittedImages:2,warnings:['Two images omitted.']}));await expect(changeImport(r,owner,p.id,{action:'commit',reviewHash:'f'.repeat(64),omitImages:true})).rejects.toMatchObject({code:'import_review'});await expect(changeImport(r,owner,p.id,{action:'commit',reviewHash:p.reviewHash})).rejects.toMatchObject({code:'import_omission'});expect((await readImport(r,owner,p.id)).state).toBe('preview');const result=await changeImport(r,owner,p.id,{action:'commit',reviewHash:p.reviewHash,omitImages:true});expect((await r.get(result.pageId!,owner)).title).toBe(i.title);expect((await r.get('welcome',owner)).title).not.toBe(i.title);
});
it('cancels idempotently, clears preview content, and never commits the cancelled job',async()=>{
 const p=await prepareImport(r,owner,input(),source,async()=>conversion());await changeImport(r,owner,p.id,{action:'cancel',reviewHash:p.reviewHash});expect((await changeImport(r,owner,p.id,{action:'cancel',reviewHash:p.reviewHash})).replayed).toBe(true);expect((await readImport(r,owner,p.id)).document).toBeNull();await expect(changeImport(r,owner,p.id,{action:'commit',reviewHash:p.reviewHash})).rejects.toMatchObject({status:410});
});
it('expires previews by server clock and the existing manual lifecycle clears abandoned content',async()=>{
 const p=await prepareImport(r,owner,input(),source,async()=>conversion());await db.query("UPDATE hs_import_jobs SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[p.id]);await expect(readImport(r,owner,p.id)).rejects.toMatchObject({status:410});await expect(changeImport(r,owner,p.id,{action:'commit',reviewHash:p.reviewHash})).rejects.toMatchObject({status:410});await maintainStorage(r,async()=>{});expect((await db.query<{state:string;document:unknown}>('SELECT state,document FROM hs_import_jobs WHERE id=$1',[p.id])).rows[0]).toEqual({state:'expired',document:null});
});
it('rechecks membership after parsing and before commit/retrieval',async()=>{
 const i=input();await expect(prepareImport(r,other,i,source,async()=>{await db.query("UPDATE hs_members SET active=false WHERE workspace_id='ws-aplyd' AND user_id=$1",[other.id]);return conversion();})).rejects.toMatchObject({status:404});expect((await db.query('SELECT id FROM hs_import_jobs WHERE id=$1',[i.id])).rows).toEqual([]);await db.query("UPDATE hs_members SET active=true WHERE workspace_id='ws-aplyd' AND user_id=$1",[other.id]);const p=await prepareImport(r,other,input(),source,async()=>conversion());await db.query("UPDATE hs_members SET active=false WHERE workspace_id='ws-aplyd' AND user_id=$1",[other.id]);await expect(readImport(r,other,p.id)).rejects.toMatchObject({status:404});await expect(changeImport(r,other,p.id,{action:'commit',reviewHash:p.reviewHash})).rejects.toMatchObject({status:404});await db.query("UPDATE hs_members SET active=true WHERE workspace_id='ws-aplyd' AND user_id=$1",[other.id]);
});
it('rechecks current page access when replaying an old committed result',async()=>{
 const p=await prepareImport(r,owner,input(),source,async()=>conversion()),done=await changeImport(r,owner,p.id,{action:'commit',reviewHash:p.reviewHash});await db.query('UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1',[done.pageId]);await expect(changeImport(r,owner,p.id,{action:'commit',reviewHash:p.reviewHash})).rejects.toMatchObject({status:404});await expect(readImport(r,owner,p.id)).rejects.toMatchObject({status:404});
});
it('rejects unsafe filenames, missing title/destination and invalid parser output before saving a preview',async()=>{
 for(const filename of ['../private.docx','C:\\private.docx','bad\u0000.md','macro.docm','old.doc','data.pdf'])expect(()=>importFilename(filename)).toThrow();expect(importFilename('Report.DOCX').format).toBe('docx');await expect(prepareImport(r,owner,{...input(),title:'   '},source,async()=>conversion())).rejects.toMatchObject({code:'import_title'});await expect(prepareImport(r,owner,{...input(),spaceId:'unknown'},source,async()=>conversion())).rejects.toMatchObject({status:404});await expect(prepareImport(r,owner,input(),source,async()=>({...conversion(),document:{type:'doc',content:[{type:'image',attrs:{src:'https://remote.invalid'}}]}}))).rejects.toThrow();
});
it('records safe audit metadata without source bytes, converted content or borrowed permissions',async()=>{
 const p=await prepareImport(r,owner,input(),source,async()=>conversion()),rows=await db.query('SELECT after_value FROM hs_audit WHERE correlation_id=$1',[p.id]),audit=JSON.stringify(rows.rows);expect(audit).toContain('example.md');expect(audit).not.toContain('Preserved source body');expect(audit).not.toContain('source test');expect((await db.query('SELECT column_name FROM information_schema.columns WHERE table_name=$1',['hs_import_jobs'])).rows.map(v=>v.column_name)).not.toContain('source');
});
