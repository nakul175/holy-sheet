import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {createDatabase,type Database} from './database';
import {Repository} from './repository';
import {localActor as owner,type Actor} from './auth';
import {SharedRecordResponsibilityRepository} from './shared-record-responsibility';
import {SharedRecordRepository,type RecordContext} from './shared-records';
import {recordCapabilities} from './shared-record-types';

let db:Database,pages:Repository,ctx:RecordContext;
const viewer:Actor={id:'responsibility-viewer'},hidden:Actor={id:'responsibility-hidden'},editOnly:Actor={id:'responsibility-edit-only'},outsider:Actor={id:'responsibility-outsider'},editor:Actor={id:'responsibility-editor'};
const authority={verify:vi.fn(async(c:RecordContext)=>({subject:c.actor.id,tenantId:c.tenantId,workspaceId:c.workspaceId,active:true,tenantAdministrator:c.actor.id===owner.id,revision:'synthetic-responsibility-authority-v1'}))};
const responsibility=()=>new SharedRecordResponsibilityRepository(pages,authority);
const records=()=>new SharedRecordRepository(pages,authority);
const as=(actor:Actor)=>({...ctx,actor});
beforeAll(async()=>{db=await createDatabase(':memory:');pages=new Repository(db);await pages.seedLocal();for(const [actor,name] of [[viewer,'Ada Viewer'],[hidden,'Secret colleague'],[editOnly,'Edit Only'],[outsider,'Outside Person'],[editor,'Eden Editor']] as const)await db.query('INSERT INTO hs_users(id,name) VALUES($1,$2)',[actor.id,name]);});
beforeEach(async()=>{vi.mocked(authority.verify).mockClear();ctx={actor:owner,tenantId:crypto.randomUUID(),workspaceId:'responsibility-'+crypto.randomUUID()};await db.query('INSERT INTO hs_workspaces(id,name) VALUES($1,$1)',[ctx.workspaceId]);for(const actor of [owner,viewer,hidden,editOnly,editor])await db.query('INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)',[ctx.workspaceId,actor.id]);await db.query('INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)',[ctx.tenantId,'Synthetic tenant']);await db.query('INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)',[ctx.workspaceId,ctx.tenantId,'Synthetic fixture only']);await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Organisations',true)",[ctx.tenantId]);await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)",[ctx.tenantId,owner.id,[...recordCapabilities]]);await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)",[ctx.tenantId,viewer.id,['view']]);});
afterAll(async()=>db.close());

async function organisation(){return (await records().create(ctx,{operationId:crypto.randomUUID(),collection:'organisations',name:'Northwind',schemaVersion:1,values:{}})).record;}
async function grant(recordId:string,actor:Actor,capabilities:string[]){await db.query('INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)',[ctx.tenantId,recordId,actor.id,capabilities]);}
async function grantCounts(){const rows=await db.query<{collection:string;record:string;field:string}>('SELECT (SELECT count(*) FROM hs_data_collection_grants WHERE tenant_id=$1)::int AS collection,(SELECT count(*) FROM hs_data_record_grants WHERE tenant_id=$1)::int AS record,(SELECT count(*) FROM hs_data_field_permissions WHERE tenant_id=$1)::int AS field',[ctx.tenantId]);return {collection:Number(rows.rows[0].collection),record:Number(rows.rows[0].record),field:Number(rows.rows[0].field)};}
async function storedUser(recordId:string){return (await db.query<{user_id:string|null}>('SELECT user_id FROM hs_data_record_responsibility WHERE tenant_id=$1 AND record_id=$2',[ctx.tenantId,recordId])).rows[0]?.user_id??null;}
async function handoverCount(recordId:string){return Number((await db.query<{n:number}>('SELECT count(*)::int AS n FROM hs_data_record_handovers WHERE tenant_id=$1 AND record_id=$2',[ctx.tenantId,recordId])).rows[0].n);}

it('hands responsibility to a member who can already view, without grants or a record change',async()=>{
 const record=await organisation(),before=await grantCounts(),version=record.version;
 expect((await responsibility().state(ctx,record.id)).responsible).toMatchObject({id:owner.id,name:'Your workspace'});
 expect((await responsibility().state(as(viewer),record.id)).canOffer).toBe(false);
 await expect(responsibility().offer(as(viewer),record.id,{operationId:crypto.randomUUID(),toUserId:owner.id})).rejects.toMatchObject({code:'record_handover_forbidden',status:403});
 const input={operationId:crypto.randomUUID(),toUserId:viewer.id};
 const offered=await responsibility().offer(ctx,record.id,input);
 expect(offered.replayed).toBe(false);
 expect(offered.pending).toMatchObject({from:{id:owner.id},to:{id:viewer.id,name:'Ada Viewer'}});
 expect(offered.canAccept).toBe(false);
 expect(offered.canCancel).toBe(true);
 expect(offered.responsible?.id).toBe(owner.id);
 const replayed=await responsibility().offer(ctx,record.id,input);
 expect(replayed.replayed).toBe(true);
 expect(replayed.pending?.id).toBe(offered.pending?.id);
 expect(await handoverCount(record.id)).toBe(1);
 await expect(responsibility().offer(ctx,record.id,{operationId:input.operationId,toUserId:editor.id})).rejects.toMatchObject({code:'operation_mismatch',status:409});
 await expect(responsibility().accept(ctx,record.id,{operationId:crypto.randomUUID()})).rejects.toMatchObject({code:'record_handover_forbidden',status:403});
 const waiting=await responsibility().state(as(viewer),record.id);
 expect(waiting.canAccept).toBe(true);
 expect(waiting.canOffer).toBe(false);
 expect(Object.keys(waiting).sort()).toEqual(['canAccept','canCancel','canOffer','pending','responsible']);
 const acceptId=crypto.randomUUID();
 const accepted=await responsibility().accept(as(viewer),record.id,{operationId:acceptId});
 expect(accepted.replayed).toBe(false);
 expect(accepted.responsible).toEqual({id:viewer.id,name:'Ada Viewer'});
 expect(accepted.pending).toBeNull();
 expect(accepted.canOffer).toBe(true);
 const again=await responsibility().accept(as(viewer),record.id,{operationId:acceptId});
 expect(again.replayed).toBe(true);
 expect(again.responsible?.id).toBe(viewer.id);
 expect(await storedUser(record.id)).toBe(viewer.id);
 expect(await handoverCount(record.id)).toBe(1);
 expect((await records().get(as(viewer),record.id)).version).toBe(version);
 expect((await records().get(as(viewer),record.id)).capabilities).toEqual(['view']);
 expect(await grantCounts()).toEqual(before);
 const audit=(await db.query<{action:string;value:string}>("SELECT action,after_value::text AS value FROM hs_audit WHERE action LIKE 'shared-record.responsibility-%' ORDER BY created_at")).rows;
 expect(audit.map(row=>row.action)).toEqual(['shared-record.responsibility-offer','shared-record.responsibility-accept']);
 expect(audit.every(row=>row.value.includes(record.id)&&!row.value.includes('capabilities')&&!row.value.includes('secret'))).toBe(true);
 const cancelled=await responsibility().offer(as(viewer),record.id,{operationId:crypto.randomUUID(),toUserId:owner.id});
 expect(await responsibility().cancel(as(viewer),record.id,{operationId:crypto.randomUUID()})).toMatchObject({pending:null,responsible:{id:viewer.id},replayed:false});
 expect(cancelled.pending?.id).not.toBe((await responsibility().state(as(viewer),record.id)).pending?.id);
});

it('denies responsibility actions without current view',async()=>{
 const record=await organisation();
 await grant(record.id,editOnly,['edit']);
 for(const actor of [hidden,editOnly,outsider]){
  await expect(responsibility().state(as(actor),record.id)).rejects.toMatchObject({code:'record_not_found',status:404});
  await expect(responsibility().offer(as(actor),record.id,{operationId:crypto.randomUUID(),toUserId:viewer.id})).rejects.toMatchObject({status:404});
  await expect(responsibility().accept(as(actor),record.id,{operationId:crypto.randomUUID()})).rejects.toMatchObject({status:404});
  await expect(responsibility().cancel(as(actor),record.id,{operationId:crypto.randomUUID()})).rejects.toMatchObject({status:404});
 }
 expect(await handoverCount(record.id)).toBe(0);
 await db.query('UPDATE hs_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[ctx.workspaceId,viewer.id]);
 await expect(responsibility().state(as(viewer),record.id)).rejects.toMatchObject({status:404});
 await expect(responsibility().accept(as(viewer),record.id,{operationId:crypto.randomUUID()})).rejects.toMatchObject({status:404});
});

it('rejects an invalid handover target and does not store it',async()=>{
 const record=await organisation();
 for(const toUserId of [owner.id,hidden.id,editOnly.id,outsider.id,'missing-person',viewer.id+' ']){
  await expect(responsibility().offer(ctx,record.id,{operationId:crypto.randomUUID(),toUserId})).rejects.toMatchObject({code:'handover_target_unavailable',status:422});
 }
 await grant(record.id,editOnly,['edit']);
 await expect(responsibility().offer(ctx,record.id,{operationId:crypto.randomUUID(),toUserId:editOnly.id})).rejects.toMatchObject({code:'handover_target_unavailable'});
 await db.query('UPDATE hs_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[ctx.workspaceId,viewer.id]);
 await expect(responsibility().offer(ctx,record.id,{operationId:crypto.randomUUID(),toUserId:viewer.id})).rejects.toMatchObject({code:'handover_target_unavailable'});
 expect(await handoverCount(record.id)).toBe(0);
 expect(await storedUser(record.id)).toBeNull();
 const people=await responsibility().people(ctx,record.id,'Ada');
 expect(people.people).toEqual([]);
 expect(JSON.stringify(people)).not.toContain('secret');
});

it('accepts a record-grant viewer and refuses a second holder, a bystander, and a stolen offer',async()=>{
 const record=await organisation(),before=await grantCounts();
 await grant(record.id,hidden,['view']);
 const offered=await responsibility().offer(ctx,record.id,{operationId:crypto.randomUUID(),toUserId:hidden.id});
 expect(offered.pending?.to).toEqual({id:hidden.id,name:'Secret colleague'});
 await expect(responsibility().offer(as(viewer),record.id,{operationId:crypto.randomUUID(),toUserId:viewer.id})).rejects.toMatchObject({code:'handover_pending',status:409});
 await expect(responsibility().accept(as(viewer),record.id,{operationId:crypto.randomUUID()})).rejects.toMatchObject({code:'record_handover_forbidden',status:403});
 await expect(responsibility().cancel(as(viewer),record.id,{operationId:crypto.randomUUID()})).rejects.toMatchObject({code:'record_handover_forbidden',status:403});
 const accepted=await responsibility().accept(as(hidden),record.id,{operationId:crypto.randomUUID()});
 expect(accepted.responsible?.id).toBe(hidden.id);
 expect((await records().get(as(hidden),record.id)).capabilities).toEqual(['view']);
 expect(await grantCounts()).toEqual({...before,record:before.record+1});
 await expect(responsibility().offer(ctx,record.id,{operationId:crypto.randomUUID(),toUserId:viewer.id})).rejects.toMatchObject({code:'record_handover_forbidden',status:403});
 const found=await responsibility().people(as(hidden),record.id,'Ada');
 expect(found.people).toEqual([{id:viewer.id,name:'Ada Viewer'}]);
 expect(JSON.stringify(found)).not.toContain('@');
});

it('clears stored responsibility and a pending handover when access disappears',async()=>{
 const record=await organisation();
 await responsibility().offer(ctx,record.id,{operationId:crypto.randomUUID(),toUserId:viewer.id});
 await db.query('DELETE FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2',[ctx.tenantId,viewer.id]);
 const afterTarget=await responsibility().state(ctx,record.id);
 expect(afterTarget.pending).toBeNull();
 expect(afterTarget.responsible?.id).toBe(owner.id);
 expect((await db.query<{state:string}>('SELECT state FROM hs_data_record_handovers WHERE tenant_id=$1 AND record_id=$2',[ctx.tenantId,record.id])).rows[0].state).toBe('cancelled');
 await expect(responsibility().accept(as(viewer),record.id,{operationId:crypto.randomUUID()})).rejects.toMatchObject({status:404});
 await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)",[ctx.tenantId,viewer.id,['view']]);
 const restored=await responsibility().offer(ctx,record.id,{operationId:crypto.randomUUID(),toUserId:viewer.id});
 await responsibility().accept(as(viewer),record.id,{operationId:crypto.randomUUID()});
 expect(restored.pending?.to.id).toBe(viewer.id);
 await db.query('DELETE FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2',[ctx.tenantId,viewer.id]);
 const cleared=await responsibility().state(ctx,record.id);
 expect(cleared.responsible).toBeNull();
 expect(cleared.canOffer).toBe(true);
 expect(JSON.stringify(cleared)).not.toContain('Ada Viewer');
 expect(await storedUser(record.id)).toBeNull();
 await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)",[ctx.tenantId,viewer.id,['view']]);
 expect((await responsibility().state(as(viewer),record.id)).responsible).toBeNull();
 expect((await responsibility().state(as(viewer),record.id)).canOffer).toBe(false);
 const phrase='orchid-responsibility-secret';
 await db.query('INSERT INTO hs_data_record_responsibility(tenant_id,record_id,user_id) VALUES($1,$2,$3) ON CONFLICT(tenant_id,record_id) DO UPDATE SET user_id=excluded.user_id',[ctx.tenantId,record.id,hidden.id]);
 await db.query("UPDATE hs_users SET name=$2 WHERE id=$1",[hidden.id,phrase]);
 const hiddenRead=await responsibility().state(ctx,record.id);
 expect(hiddenRead.responsible).toBeNull();
 expect(JSON.stringify(hiddenRead)).not.toContain(phrase);
 await expect(records().get(as(hidden),record.id)).rejects.toMatchObject({status:404});
});

it('lets an editor offer a vacant record and keeps an implicit creator when access returns',async()=>{
 const record=await organisation();
 await db.query('DELETE FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2',[ctx.tenantId,owner.id]);
 await grant(record.id,editor,['view','edit']);
 const vacant=await responsibility().state(as(editor),record.id);
 expect(vacant.responsible).toBeNull();
 expect(vacant.canOffer).toBe(true);
 expect((await responsibility().state(as(viewer),record.id)).canOffer).toBe(false);
 await expect(responsibility().offer(as(editor),record.id,{operationId:crypto.randomUUID(),toUserId:owner.id})).rejects.toMatchObject({code:'handover_target_unavailable'});
 const offered=await responsibility().offer(as(editor),record.id,{operationId:crypto.randomUUID(),toUserId:viewer.id});
 expect(offered.pending).toMatchObject({from:{id:editor.id},to:{id:viewer.id}});
 expect(offered.responsible).toBeNull();
 const accepted=await responsibility().accept(as(viewer),record.id,{operationId:crypto.randomUUID()});
 expect(accepted.responsible?.id).toBe(viewer.id);
 expect(accepted.canOffer).toBe(true);
 expect((await records().get(as(editor),record.id)).capabilities.sort()).toEqual(['edit','view']);
 await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)",[ctx.tenantId,owner.id,[...recordCapabilities]]);
 const fresh=await organisation();
 await db.query('DELETE FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2',[ctx.tenantId,owner.id]);
 expect((await responsibility().state(as(viewer),fresh.id)).responsible).toBeNull();
 await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)",[ctx.tenantId,owner.id,[...recordCapabilities]]);
 expect((await responsibility().state(ctx,fresh.id)).responsible?.id).toBe(owner.id);
 expect(await storedUser(fresh.id)).toBeNull();
});
