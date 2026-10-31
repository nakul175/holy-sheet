import {beforeAll,afterAll,it,expect} from 'vitest';
import {createDatabase,type Database} from './database';
import {Repository} from './repository';
import {localActor as owner} from './auth';
import {fromLegacy} from './document';
import {workspaceSearch,type WorkspaceSearchInput} from './workspace-search';
import type {Actor} from './auth';
import type {SearchKind} from './types';
let db:Database,r:Repository;
const viewer:Actor={id:'holy58-viewer'},limited:Actor={id:'holy58-limited'},other:Actor={id:'holy58-other'};
const kinds:SearchKind[]=['page','block','record','field','attachment'];
const search=(actor:Actor,query:string,patch:Partial<WorkspaceSearchInput>={})=>workspaceSearch(r,actor,{query,workspaceId:'ws-aplyd',kinds,...patch});
let tenantId='';
beforeAll(async()=>{
 db=await createDatabase(':memory:');r=new Repository(db);await r.seedLocal();
 for(const actor of [viewer,limited,other]){await db.query('INSERT INTO hs_users(id,name) VALUES($1,$1)',[actor.id]);await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)",[actor.id]);}
 tenantId=crypto.randomUUID();
 await db.query('INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)',[tenantId,'Synthetic search tenant']);
 await db.query('INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)',['ws-aplyd',tenantId,'Synthetic search link']);
 for(const [key,name] of [['organisations','Organisations'],['contacts','Contacts']] as const)await db.query('INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,$2,$3,true)',[tenantId,key,name]);
 await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',ARRAY['view'])",[tenantId,viewer.id]);
});
afterAll(async()=>db.close());
async function record(collection:string,name:string,values:Record<string,unknown>,actor=owner.id){
 const id=crypto.randomUUID();
 await db.query('INSERT INTO hs_data_records(id,tenant_id,collection,name,field_values,created_by,updated_by) VALUES($1,$2,$3,$4,$5::jsonb,$6,$6)',[id,tenantId,collection,name,JSON.stringify(values),actor]);
 return id;
}
async function page(title:string,text:string,grant=viewer.id){
 const made=await r.create(owner,title,'space-product');
 await db.transaction(tx=>r.writeDocument(tx,made.id,fromLegacy([{id:crypto.randomUUID(),pageId:made.id,parentBlockId:null,type:'paragraph',text,position:0}]),2,title,owner.id));
 if(grant)await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer')",[made.id,grant]);
 return made;
}

it('ranks permitted pages and records together and omits forbidden records the same way as unknown terms',async()=>{
 const secret='sekretphrasevalue',notes='notesplainvalue';
 const visible=await record('organisations','Shared list needle',{'core:notes':notes});
 const hidden=await record('contacts','Hidden contact',{'core:email':secret});
 const made=await page('Shared list needle','page body needle');
 const found=await search(viewer,'shared list needle');
 expect(found.results.map(item=>item.kind).sort()).toEqual(['page','record']);
 expect(found.results.map(item=>item.id).sort()).toEqual([made.id,`record:${visible}`].sort());
 expect(JSON.stringify(found)).not.toContain(secret);expect(JSON.stringify(found)).not.toContain(hidden);
 const denied=await search(viewer,secret),missing=await search(viewer,'zzzznoterm');
 expect(denied).toEqual(missing);expect(JSON.stringify(denied)).not.toContain(secret);
});

it('keeps field matches behind field view rights and fresh across edit, trash and restore',async()=>{
 const secretKey=crypto.randomUUID(),secret='fieldsecretneedle',plain='fieldplainneedle';
 await db.query("INSERT INTO hs_data_fields(tenant_id,collection,field_key,label,kind,sensitive,created_by) VALUES($1,'organisations',$2,'Secret label','text',true,$3)",[tenantId,secretKey,owner.id]);
 const id=await record('organisations','Field host',{'core:notes':plain,[secretKey]:secret});
 const blocked=await search(viewer,secret);
 expect(blocked.results).toEqual([]);expect(JSON.stringify(blocked)).not.toContain(secret);expect(JSON.stringify(blocked)).not.toContain('Secret label');
 const plainHit=await search(viewer,plain);
 expect(plainHit.results.map(item=>item.kind)).toEqual(['field']);expect(JSON.stringify(plainHit)).not.toContain(secret);
 await db.query('INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view) VALUES($1,$2,$3,$4,true)',[tenantId,'organisations',secretKey,viewer.id]);
 const allowed=await search(viewer,secret);
 expect(allowed.results.map(item=>item.id)).toEqual([`field:${id}:${secretKey}`]);expect(allowed.results[0].preview).toContain(secret);expect(JSON.stringify(allowed)).not.toContain(plain);
 await db.query('UPDATE hs_data_field_permissions SET can_view=false WHERE tenant_id=$1 AND field_key=$2 AND user_id=$3',[tenantId,secretKey,viewer.id]);
 expect(JSON.stringify(await search(viewer,secret))).not.toContain(secret);
 await db.query('UPDATE hs_data_records SET name=$2 WHERE id=$1',[id,'Renamed catalogue entry']);
 expect((await search(viewer,'field host')).results).toEqual([]);
 expect((await search(viewer,'renamed catalogue')).results.map(item=>item.kind)).toContain('record');
 await db.query("UPDATE hs_data_records SET state='trashed',deleted_at=now(),trash_deadline=now()+interval '30 days',deleted_by=$2,before_trash_state='active' WHERE id=$1",[id,owner.id]);
 expect((await search(viewer,'renamed catalogue')).results).toEqual([]);
 await db.query("UPDATE hs_data_records SET state='active',deleted_at=NULL,trash_deadline=NULL,deleted_by=NULL,before_trash_state=NULL WHERE id=$1",[id]);
 expect((await search(viewer,'renamed catalogue')).results.map(item=>item.id)).toContain(`record:${id}`);
});

it('uses record grants without letting a field grant reveal a hidden record',async()=>{
 const secretKey=crypto.randomUUID();
 await db.query("INSERT INTO hs_data_fields(tenant_id,collection,field_key,label,kind,sensitive,created_by) VALUES($1,'organisations',$2,'Limited secret','text',true,$3)",[tenantId,secretKey,owner.id]);
 const allowed=await record('organisations','Grant only record',{[secretKey]:'grantsecretneedle'}),hidden=await record('organisations','Sibling hidden record',{'core:notes':'siblinghiddenneedle'});
 await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,ARRAY['view'])",[tenantId,allowed,limited.id]);
 await db.query('INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view) VALUES($1,$2,$3,$4,true)',[tenantId,'organisations',secretKey,limited.id]);
 await db.query('INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view) VALUES($1,$2,$3,$4,true)',[tenantId,'organisations',secretKey,other.id]);
 expect((await search(limited,'grantsecretneedle')).results.map(item=>item.id)).toEqual([`field:${allowed}:${secretKey}`]);
 expect(JSON.stringify(await search(limited,'siblinghiddenneedle'))).not.toContain(hidden);
 expect(JSON.stringify(await search(other,'grantsecretneedle'))).not.toContain('grantsecretneedle');
});

it('filters by type, collection, owner, date and space without widening record visibility',async()=>{
 const early=await record('organisations','Early datefilternote',{'core:notes':'early note'},owner.id);
 const late=await record('contacts','Late datefilternote',{'core:notes':'late note'},viewer.id);
 await db.query('UPDATE hs_data_records SET updated_at=$2 WHERE id=$1',[early,'2020-01-15T00:00:00Z']);
 await db.query('UPDATE hs_data_records SET updated_at=$2 WHERE id=$1',[late,'2024-06-01T00:00:00Z']);
 await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'contacts',ARRAY['view'])",[tenantId,viewer.id]);
 const made=await page('Space filter page','spacefilternote');
 expect((await search(viewer,'datefilternote',{kinds:['record']})).results.every(item=>item.kind==='record')).toBe(true);
 expect((await search(viewer,'datefilternote',{collection:'contacts'})).results.map(item=>item.id)).toEqual([`record:${late}`]);
 expect((await search(viewer,'datefilternote',{ownerId:viewer.id})).results.map(item=>item.id)).toEqual([`record:${late}`]);
 expect((await search(viewer,'datefilternote',{updatedFrom:'2024-01-01',updatedTo:'2024-12-31'})).results.map(item=>item.id)).toEqual([`record:${late}`]);
 expect((await search(viewer,'datefilternote',{collection:'not-a-real-collection'})).results).toEqual([]);
 expect((await search(viewer,'spacefilternote',{spaceId:'space-product'})).results.map(item=>item.kind).sort()).toEqual(['block','page']);
 expect(JSON.stringify(await search(viewer,'spacefilternote',{spaceId:'space-product'}))).not.toContain('datefilternote');
});

it('refreshes block and attachment hits and does not read governed draft text',async()=>{
 const made=await page('Block host','blockfreshstart');
 expect((await search(viewer,'blockfreshstart',{kinds:['block']})).results.every(item=>item.kind==='block'&&item.preview.includes('blockfreshstart'))).toBe(true);
 await db.query('UPDATE hs_blocks SET node=$2 WHERE page_id=$1 AND parent_id IS NULL',[made.id,JSON.stringify({type:'paragraph',content:[{type:'text',text:'blockfreshnext'}]})]);
 expect((await search(viewer,'blockfreshstart')).results).toEqual([]);
 expect((await search(viewer,'blockfreshnext',{kinds:['block']})).results).toHaveLength(1);
 const media=crypto.randomUUID(),hiddenMedia=crypto.randomUUID(),hidden=await r.create(owner,'Hidden attachment page','space-product');
 await db.query("INSERT INTO hs_media(id,page_id,uploader_id,operation_id,name,mime,size,object_key,state,sha256,scanned_at) VALUES($1::uuid,$2,$3,$4,'readyfile.pdf','text/plain',4,$1::text,'ready',$5,clock_timestamp()),($6::uuid,$7,$3,$8,'hiddenfile.pdf','text/plain',4,$6::text,'ready',$5,clock_timestamp())",[media,made.id,owner.id,crypto.randomUUID(),'a'.repeat(64),hiddenMedia,hidden.id,crypto.randomUUID()]);
 await db.query('UPDATE hs_blocks SET type=$2,node=$3 WHERE page_id=$1 AND parent_id IS NULL',[made.id,'file',JSON.stringify({type:'file',attrs:{attachmentId:media,title:'readyfile.pdf'}})]);
 expect((await search(viewer,'readyfile',{kinds:['attachment']})).results.map(item=>item.id)).toEqual([`attachment:${media}`]);
 expect(JSON.stringify(await search(viewer,'hiddenfile'))).not.toContain('hiddenfile');
 await db.query('UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1',[made.id]);
 expect((await search(viewer,'readyfile')).results).toEqual([]);
 await db.query('UPDATE hs_pages SET deleted_at=NULL WHERE id=$1',[made.id]);
 expect((await search(viewer,'readyfile',{kinds:['attachment']})).results).toHaveLength(1);
 await db.query("INSERT INTO hs_document_workflows(page_id,version,reviewers) VALUES($1,1,'[]'::jsonb)",[made.id]);
 await db.query('UPDATE hs_blocks SET node=$2 WHERE page_id=$1 AND parent_id IS NULL',[made.id,JSON.stringify({type:'paragraph',content:[{type:'text',text:'governeddraftneedle'}]})]);
 const governed=await search(viewer,'governeddraftneedle');
 expect(governed.results).toEqual([]);expect(JSON.stringify(governed)).not.toContain('governeddraftneedle');
});
