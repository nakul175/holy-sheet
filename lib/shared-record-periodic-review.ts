import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Sql} from './database';
import {DocumentError} from './document';
import {recordLayoutDefinition,type RecordLayoutDefinition} from './record-layout-definition';
import {SharedRecordRepository,type RecordContext,type Stored} from './shared-records';
import {compileRecordView} from './shared-record-view-query';
import {recordHash,recordName,type RecordCapability,type RecordField} from './shared-record-types';

const id=z.string().uuid();
const filter=z.object({field:z.string().min(1).max(100),operator:z.enum(['equal','contains','prefix','greater','less','in','includes','empty']),value:z.unknown().optional()}).strict();
const definition=z.object({
 workflowId:id,
 intervalDays:z.number().int().min(1).max(3650),
 windowDays:z.number().int().min(0).max(3650),
 layoutId:z.string().uuid().nullable().default(null),
 filters:z.array(filter).max(5).default([]),
}).strict();
const reviewDefinition=z.object({instructions:z.string().max(500).default(''),fields:z.array(z.string().min(1).max(100)).min(1).max(40),commentRequired:z.boolean().default(false)}).strict();
const save=z.object({id,operationId:id,collection:z.string().min(1).max(100),name:z.string().min(1).max(200),expectedVersion:z.number().int().nonnegative(),deprecated:z.boolean().default(false),definition}).strict();
const start=z.object({scheduleId:id,recordId:id,expectedScheduleVersion:z.number().int().positive(),expectedRecordVersion:z.number().int().positive(),operationId:id}).strict();
type Definition=z.infer<typeof definition>;
type ScheduleRow={id:string;tenant_id:string;collection:string;name:string;name_search:string;version:number;deprecated:boolean;definition:unknown};
type ReviewRow={id:string;workflow_id:string;workflow_version:number;record_id:string;record_version:number;schema_version:number;status:string;version:number;submitted_by:string};
const messages:Record<string,string>={
 record_periodic_review_validation:'Review the periodic review schedule and try again.',
 record_periodic_review_field_unavailable:'A field is restricted or unavailable.',
 record_periodic_review_forbidden:'This record action is not permitted.',
 record_periodic_review_name_conflict:'A periodic review schedule with this name already exists.',
 record_periodic_review_limit:'This collection has reached its periodic review schedule limit.',
};
const fail=(code='record_periodic_review_conflict',status=409)=>new DocumentError(messages[code]??'The periodic review schedule is unavailable or changed. Review the current catalogue.',code,status);
const missing=()=>new DocumentError('Record is restricted or unavailable.','record_not_found',404);
const withheldMessage='A field is restricted or unavailable.';

/** `manage-reviews` already gates review workflow configuration. view, edit and review do not imply it.
 * Due evaluation is read-only. Starting a review inserts the existing review submission. */
export class SharedRecordPeriodicReviewRepository extends SharedRecordRepository {
 private async visible(tx:Sql,ctx:RecordContext,collection:string){
  const caps=await this.collectionCaps(tx,ctx,collection);
  if((await tx.query<{deprecated:boolean}>('SELECT deprecated FROM hs_data_collections WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,collection])).rows[0]?.deprecated)throw fail('record_periodic_review_unavailable',404);
  if(caps.includes('view'))return caps;
  const any=await tx.query(`SELECT 1 FROM hs_data_record_grants g JOIN hs_data_records r ON r.tenant_id=g.tenant_id AND r.id=g.record_id WHERE g.tenant_id=$1 AND g.user_id=$2 AND r.collection=$3 AND r.state<>'trashed' AND r.merged_into_id IS NULL AND 'view'=ANY(g.capabilities) LIMIT 1`,[ctx.tenantId,ctx.actor.id,collection]);
  if(!any.rows.length)throw fail('record_periodic_review_unavailable',404);
  return caps;
 }
 private async lock(tx:Sql,ctx:RecordContext,scheduleId:string){
  if(!id.safeParse(scheduleId).success)throw fail('record_periodic_review_unavailable',404);
  const row=(await tx.query<ScheduleRow>('SELECT * FROM hs_data_periodic_review_schedules WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.tenantId,scheduleId])).rows[0];
  if(!row)throw fail('record_periodic_review_unavailable',404);
  await this.visible(tx,ctx,row.collection);
  return {...row,version:Number(row.version)};
 }
 private async exact(tx:Sql,ctx:RecordContext,recordId:string,active:boolean){
  if(!id.safeParse(recordId).success)throw missing();
  const record=(await tx.query<Stored>("SELECT * FROM hs_data_records WHERE id=$1 AND tenant_id=$2 AND state<>'trashed' FOR UPDATE",[recordId,ctx.tenantId])).rows[0];
  if(!record)throw missing();
  record.version=Number(record.version);
  const caps=await this.caps(tx,ctx,record);
  if(!caps.includes('view'))throw missing();
  if(record.merged_into_id)throw new DocumentError('This record was merged. Open the current record.','record_merged',409);
  if(active&&record.state!=='active')throw missing();
  return {record,caps};
 }
 private parse(input:unknown){
  const parsed=definition.safeParse(typeof input==='string'?safeJson(input):input);
  if(!parsed.success||parsed.data.windowDays>parsed.data.intervalDays||Buffer.byteLength(JSON.stringify(parsed.data))>64000)throw fail('record_periodic_review_unavailable',503);
  return parsed.data;
 }
 private async publishedLayout(tx:Sql,ctx:RecordContext,collection:string){
  const row=(await tx.query<{definition:unknown}>('SELECT v.definition FROM hs_data_layouts l JOIN hs_data_layout_versions v ON v.tenant_id=l.tenant_id AND v.collection=l.collection AND v.version=l.published_version WHERE l.tenant_id=$1 AND l.collection=$2 AND l.published_version IS NOT NULL',[ctx.tenantId,collection])).rows[0];
  if(!row)return;
  const parsed=recordLayoutDefinition.safeParse(typeof row.definition==='string'?safeJson(row.definition):row.definition);
  return parsed.success?parsed.data:undefined;
 }
 private compile(form:Definition,fields:RecordField[],values:unknown[]){
  try{return compileRecordView({columns:['name'],filters:form.filters,sort:[],includeArchived:false},fields,values);}
  catch(error){if(error instanceof DocumentError)throw fail('record_periodic_review_validation',400);throw error;}
 }
 private async assess(tx:Sql,ctx:RecordContext,collection:string,input:unknown){
  const parsed=definition.safeParse(typeof input==='string'?safeJson(input):input);
  if(!parsed.success||parsed.data.windowDays>parsed.data.intervalDays||Buffer.byteLength(JSON.stringify(parsed.data))>64000)throw fail('record_periodic_review_validation',400);
  const form=parsed.data;
  const fields=await this.fields(tx,ctx,collection);
  const formulas=new Set((await this.formulaRows(tx,ctx,collection)).map(row=>row.field_key));
  for(const item of form.filters){
   if(item.field==='name')continue;
   if(formulas.has(item.field))throw fail('record_periodic_review_field_unavailable',403);
   const field=fields.find(candidate=>candidate.key===item.field);
   if(!field||field.deprecated||field.kind==='attachment'||field.kind==='record'||!await this.fieldAllowed(tx,ctx,collection,field,'view'))throw fail('record_periodic_review_field_unavailable',403);
  }
  this.compile(form,fields,[]);
  const published=form.layoutId?await this.publishedLayout(tx,ctx,collection):undefined;
  const layoutOk=!form.layoutId||!!published&&!!layoutFields(published,form.layoutId);
  const workflow=(await tx.query<{collection:string;deprecated:boolean}>('SELECT collection,deprecated FROM hs_data_review_workflows WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,form.workflowId])).rows[0];
  const runnable=layoutOk&&!!workflow&&workflow.collection===collection&&!workflow.deprecated;
  return {form,runnable};
 }
 private async workflowPacket(tx:Sql,ctx:RecordContext,collection:string,workflowId:string){
  if(!id.safeParse(workflowId).success)throw fail('record_periodic_review_validation',400);
  const row=(await tx.query<{id:string;collection:string;deprecated:boolean;version:number;definition:unknown}>('SELECT id,collection,deprecated,version,definition FROM hs_data_review_workflows WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.tenantId,workflowId])).rows[0];
  if(!row||row.collection!==collection||row.deprecated)throw fail('record_periodic_review_validation',400);
  const parsed=reviewDefinition.safeParse(typeof row.definition==='string'?safeJson(row.definition):row.definition);
  if(!parsed.success)throw fail('record_periodic_review_validation',400);
  const packet=parsed.data;
  packet.instructions=packet.instructions.trim().normalize('NFC');
  if(packet.instructions.length>500||/[\p{Cc}]/u.test(packet.instructions)||new Set(packet.fields).size!==packet.fields.length)throw fail('record_periodic_review_validation',400);
  const fields=await this.fields(tx,ctx,collection);
  const formulas=new Set((await this.formulaRows(tx,ctx,collection)).map(item=>item.field_key));
  for(const key of packet.fields){
   if(formulas.has(key))throw fail('record_periodic_review_field_unavailable',403);
   const field=fields.find(item=>item.key===key);
   if(!field||field.deprecated||field.kind==='attachment'||field.kind==='record'||!await this.fieldAllowed(tx,ctx,collection,field,'view'))throw fail('record_periodic_review_field_unavailable',403);
  }
  return {id:row.id,version:Number(row.version)};
 }
 private shell(row:ScheduleRow,form?:Definition){
  return {id:row.id,name:row.name,version:Number(row.version),...(form?{intervalDays:form.intervalDays,windowDays:form.windowDays}:{})};
 }
 private present(row:ScheduleRow,form:Definition){return {id:row.id,collection:row.collection,name:row.name,version:Number(row.version),deprecated:row.deprecated,definition:form};}
 private async dependencies(tx:Sql,ctx:RecordContext,collection:string,scheduleId:string,form:Definition,deprecated:boolean){
  await tx.query('DELETE FROM hs_data_schema_dependencies WHERE tenant_id=$1 AND periodic_schedule_id=$2',[ctx.tenantId,scheduleId]);
  if(deprecated)return;
  const keys=new Set(form.filters.map(item=>item.field));
  for(const field of await this.fields(tx,ctx,collection))if(!field.core&&keys.has(field.key))await tx.query('INSERT INTO hs_data_schema_dependencies(id,tenant_id,collection,field_key,kind,label,periodic_schedule_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),ctx.tenantId,collection,field.key,'periodic-review','Periodic record review',scheduleId]);
 }
 private async bump(tx:Sql,ctx:RecordContext,collection:string){
  await tx.query('INSERT INTO hs_data_periodic_review_catalogues(tenant_id,collection) VALUES($1,$2) ON CONFLICT(tenant_id,collection) DO UPDATE SET revision=hs_data_periodic_review_catalogues.revision+1',[ctx.tenantId,collection]);
 }
 private async bumpReviews(tx:Sql,ctx:RecordContext,collection:string){
  await tx.query('INSERT INTO hs_data_review_catalogues(tenant_id,collection) VALUES($1,$2) ON CONFLICT(tenant_id,collection) DO UPDATE SET revision=hs_data_review_catalogues.revision+1',[ctx.tenantId,collection]);
 }
 private async scopeOf(tx:Sql,ctx:RecordContext,tenant:{schema_version:number;policy_version:number;data_revision?:string|number},proof:{revision:string},collection:string,kind:string,extra:Record<string,unknown>={}){
  const revision=(await tx.query<{revision:number}>('SELECT revision FROM hs_data_periodic_review_catalogues WHERE tenant_id=$1 AND collection=$2',[ctx.tenantId,collection])).rows[0]?.revision??0;
  const reviewRevision=(await tx.query<{revision:number}>('SELECT revision FROM hs_data_review_catalogues WHERE tenant_id=$1 AND collection=$2',[ctx.tenantId,collection])).rows[0]?.revision??0;
  return recordHash({kind,collection,...extra,revision:Number(revision),reviewRevision:Number(reviewRevision),schema:Number(tenant.schema_version),policy:Number(tenant.policy_version),data:String(tenant.data_revision??0),authority:proof.revision});
 }
 private async place(tx:Sql,ctx:RecordContext,cursor:string|undefined,scope:string){
  if(!cursor)return {afterName:null as string|null,afterId:null as string|null};
  const current=(await tx.query<{last_name:string;last_id:string}>('SELECT last_name,last_id FROM hs_data_query_cursors WHERE token_hash=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 AND scope_hash=$5 AND expires_at>clock_timestamp()',[recordHash(cursor),ctx.tenantId,ctx.workspaceId,ctx.actor.id,scope])).rows[0];
  if(!current)throw fail('record_periodic_review_cursor');
  return {afterName:current.last_name,afterId:current.last_id};
 }
 private async next(tx:Sql,ctx:RecordContext,scope:string,lastName:string,lastId:string){
  const token=randomBytes(32).toString('base64url');
  await tx.query('INSERT INTO hs_data_query_cursors(token_hash,tenant_id,workspace_id,actor_id,scope_hash,last_name,last_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[recordHash(token),ctx.tenantId,ctx.workspaceId,ctx.actor.id,scope,lastName,lastId]);
  return token;
 }
 private async pending(tx:Sql,ctx:RecordContext,recordId:string){
  return (await tx.query<ReviewRow>("SELECT id,workflow_id,workflow_version,record_id,record_version,schema_version,status,version,submitted_by FROM hs_data_reviews WHERE tenant_id=$1 AND record_id=$2 AND status='pending' FOR UPDATE",[ctx.tenantId,recordId])).rows[0];
 }
 private async outcome(tx:Sql,ctx:RecordContext,reviewId:string,appliedVersion:number,replayed:boolean,reused:boolean){
  const review=(await tx.query<ReviewRow>('SELECT id,workflow_id,workflow_version,record_id,record_version,schema_version,status,version,submitted_by FROM hs_data_reviews WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.tenantId,reviewId])).rows[0];
  if(!review)throw fail('record_periodic_review_unavailable',404);
  await this.exact(tx,ctx,review.record_id,false);
  return {review:{id:review.id,status:review.status,version:Number(review.version),workflowId:review.workflow_id,workflowVersion:Number(review.workflow_version),recordId:review.record_id,recordVersion:Number(review.record_version),schemaVersion:Number(review.schema_version)},appliedVersion:Number(appliedVersion),replayed,reused};
 }
 private async supersede(tx:Sql,ctx:RecordContext,row:ReviewRow){
  const version=Number(row.version)+1;
  const updated=await tx.query("UPDATE hs_data_reviews SET status=$3,version=$4 WHERE tenant_id=$1 AND id=$2 AND status='pending' AND version=$5 RETURNING version",[ctx.tenantId,row.id,'superseded',version,Number(row.version)]);
  if(!updated.rows[0])throw fail();
  await tx.query('INSERT INTO hs_data_review_events(tenant_id,review_id,event_version,kind,actor_id,record_version,schema_version,workflow_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,row.id,version,'supersede',ctx.actor.id,Number(row.record_version),Number(row.schema_version),Number(row.workflow_version)]);
 }
 private async dueNow(tx:Sql,ctx:RecordContext,record:Stored,form:Definition,schemaVersion:number){
  const fields=await this.fields(tx,ctx,record.collection);
  const values:unknown[]=[record.id,ctx.tenantId,schemaVersion,form.workflowId,form.intervalDays-form.windowDays];
  const compiled=this.compile(form,fields,values);
  const predicates=compiled.predicates.length?` AND ${compiled.predicates.join(' AND ')}`:'';
  const row=await tx.query(`SELECT 1 AS due FROM hs_data_records r WHERE r.id=$1 AND r.tenant_id=$2 AND r.state='active' AND r.merged_into_id IS NULL AND NOT EXISTS (SELECT 1 FROM hs_data_reviews rv WHERE rv.tenant_id=r.tenant_id AND rv.record_id=r.id AND rv.status='pending' AND rv.record_version=r.version AND rv.schema_version=$3) AND COALESCE((SELECT max(rv.decided_at) FROM hs_data_reviews rv WHERE rv.tenant_id=r.tenant_id AND rv.record_id=r.id AND rv.workflow_id=$4 AND rv.status IN ('approved','rejected','changes_requested')),r.created_at)<=clock_timestamp()-($5::int * interval '1 day')${predicates}`,compiled.values);
  return !!row.rows.length;
 }
 private ignored(row:ScheduleRow,form?:Definition){return {schedule:this.shell(row,form),records:[],nextCursor:null,withheld:false,ignored:true};}
 async savePeriodicSchedule(ctx:RecordContext,input:z.input<typeof save>){
  const parsed=save.safeParse(input);
  if(!parsed.success)throw fail('record_periodic_review_validation',400);
  const command=parsed.data;
  let name:string;
  try{name=recordName(command.name);}catch(error){if(error instanceof DocumentError)throw fail('record_periodic_review_validation',400);throw error;}
  if(Array.from(name).length>100)throw fail('record_periodic_review_validation',400);
  return this.transaction(ctx,async(tx,tenant)=>{
   const caps=await this.collectionCaps(tx,ctx,command.collection);
   if(!caps.includes('view')||!caps.includes('manage-reviews'))throw fail('record_periodic_review_forbidden',403);
   if((await tx.query<{deprecated:boolean}>('SELECT deprecated FROM hs_data_collections WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,command.collection])).rows[0]?.deprecated)throw fail('record_periodic_review_unavailable',404);
   const assessed=await this.assess(tx,ctx,command.collection,command.definition);
   if(!command.deprecated&&!assessed.runnable)throw fail('record_periodic_review_validation',400);
   if(!command.deprecated)await this.workflowPacket(tx,ctx,command.collection,assessed.form.workflowId);
   const form=assessed.form,hash=recordHash({...command,name,definition:form});
   const existing=(await tx.query<{request_hash:string;schedule_id:string;applied_version:number}>('SELECT request_hash,schedule_id,applied_version FROM hs_data_periodic_review_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3',[ctx.tenantId,ctx.actor.id,command.operationId])).rows[0];
   if(existing){
    if(existing.request_hash!==hash)throw fail('operation_mismatch');
    const saved=await this.lock(tx,ctx,existing.schedule_id);
    return {schedule:this.present(saved,form),appliedVersion:Number(existing.applied_version),replayed:true};
   }
   const previous=(await tx.query<ScheduleRow>('SELECT * FROM hs_data_periodic_review_schedules WHERE id=$1 FOR UPDATE',[command.id])).rows[0];
   if(previous&&(previous.tenant_id!==ctx.tenantId||previous.collection!==command.collection))throw fail('record_periodic_review_unavailable',404);
   if(Number(previous?.version??0)!==command.expectedVersion)throw fail();
   if(!previous){const count=(await tx.query<{n:string}>('SELECT count(*)::text AS n FROM hs_data_periodic_review_schedules WHERE tenant_id=$1 AND collection=$2',[ctx.tenantId,command.collection])).rows[0];if(Number(count?.n)>=100)throw fail('record_periodic_review_limit',429);}
   if((await tx.query('SELECT id FROM hs_data_periodic_review_schedules WHERE tenant_id=$1 AND collection=$2 AND name_search=lower($3) AND id<>$4',[ctx.tenantId,command.collection,name,command.id])).rows.length)throw fail('record_periodic_review_name_conflict',409);
   const version=command.expectedVersion+1,stored=JSON.stringify(form);
   if(previous)await tx.query('UPDATE hs_data_periodic_review_schedules SET name=$3,version=$4,deprecated=$5,definition=$6 WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,command.id,name,version,command.deprecated,stored]);
   else await tx.query('INSERT INTO hs_data_periodic_review_schedules(id,tenant_id,collection,name,version,deprecated,definition,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[command.id,ctx.tenantId,command.collection,name,version,command.deprecated,stored,ctx.actor.id]);
   await tx.query('INSERT INTO hs_data_periodic_review_versions(tenant_id,schedule_id,version,name,deprecated,definition,schema_version,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,command.id,version,name,command.deprecated,stored,tenant.schema_version,ctx.actor.id]);
   await tx.query('INSERT INTO hs_data_periodic_review_operations(tenant_id,actor_id,operation_id,request_hash,schedule_id,applied_version) VALUES($1,$2,$3,$4,$5,$6)',[ctx.tenantId,ctx.actor.id,command.operationId,hash,command.id,version]);
   await this.dependencies(tx,ctx,command.collection,command.id,form,command.deprecated);
   await this.bump(tx,ctx,command.collection);
   await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,'shared-record.periodic-review-saved',JSON.stringify({tenantId:ctx.tenantId,scheduleId:command.id,collection:command.collection,version,deprecated:command.deprecated,sourceApp:'holy-sheet'}),command.operationId]);
   return {schedule:this.present(await this.lock(tx,ctx,command.id),form),appliedVersion:version,replayed:false};
  });
 }
 async periodicReviewCatalogue(ctx:RecordContext,collection:string){
  if(typeof collection!=='string'||!collection||collection.length>100)throw fail('record_periodic_review_validation',400);
  return this.transaction(ctx,async(tx,tenant)=>{
   const caps=await this.visible(tx,ctx,collection),fields=[];
   for(const field of await this.fields(tx,ctx,collection)){
    if(field.deprecated||field.kind==='attachment'||field.kind==='record'||!await this.fieldAllowed(tx,ctx,collection,field,'view'))continue;
    fields.push({key:field.key,label:field.label,kind:field.kind,sensitive:field.sensitive});
   }
   fields.unshift({key:'name',label:'Name',kind:'text',sensitive:false});
   const workflows=[];
   for(const row of (await tx.query<{id:string;name:string;version:number}>('SELECT id,name,version FROM hs_data_review_workflows WHERE tenant_id=$1 AND collection=$2 AND deprecated=false ORDER BY name_search COLLATE "C",id LIMIT 100',[ctx.tenantId,collection])).rows){
    let available=true;
    try{await this.workflowPacket(tx,ctx,collection,row.id);}catch(error){if(!(error instanceof DocumentError))throw error;available=false;}
    workflows.push({id:row.id,name:row.name,version:Number(row.version),available});
   }
   return {schemaVersion:Number(tenant.schema_version),canManage:caps.includes('view')&&caps.includes('manage-reviews'),canEdit:caps.includes('edit'),workflows,fields};
  });
 }
 async listPeriodicSchedules(ctx:RecordContext,collection:string,cursor?:string){
  if(typeof collection!=='string'||!collection||collection.length>100||cursor&&!/^[A-Za-z0-9_-]{43}$/.test(cursor))throw fail('record_periodic_review_validation',400);
  return this.transaction(ctx,async(tx,tenant,proof)=>{
   await this.visible(tx,ctx,collection);
   const scope=await this.scopeOf(tx,ctx,tenant,proof,collection,'record-periodic-catalogue');
   const place=await this.place(tx,ctx,cursor,scope);
   const rows=(await tx.query<ScheduleRow>('SELECT * FROM hs_data_periodic_review_schedules WHERE tenant_id=$1 AND collection=$2 AND deprecated=false AND ($3::text IS NULL OR (name_search COLLATE "C",id)>($3 COLLATE "C",$4::uuid)) ORDER BY name_search COLLATE "C",id LIMIT 51',[ctx.tenantId,collection,place.afterName,place.afterId])).rows;
   const page=rows.slice(0,50),schedules=[];
   for(const row of page){
    let available=true;
    try{const assessed=await this.assess(tx,ctx,collection,row.definition);available=assessed.runnable;if(available)await this.workflowPacket(tx,ctx,collection,assessed.form.workflowId);}catch(error){if(!(error instanceof DocumentError))throw error;available=false;}
    schedules.push({id:row.id,name:row.name,version:Number(row.version),available});
   }
   const last=page.at(-1);
   return {schedules,nextCursor:rows.length>50&&last?await this.next(tx,ctx,scope,last.name_search,last.id):null};
  });
 }
 async openPeriodicSchedule(ctx:RecordContext,scheduleId:string){
  return this.transaction(ctx,async(tx,tenant)=>{
   const row=await this.lock(tx,ctx,scheduleId);
   const assessed=await this.assess(tx,ctx,row.collection,row.definition);
   const caps=await this.collectionCaps(tx,ctx,row.collection);
   return {...this.present(row,assessed.form),schemaVersion:Number(tenant.schema_version),runnable:assessed.runnable,canManage:caps.includes('view')&&caps.includes('manage-reviews')};
  });
 }
 async listDueRecords(ctx:RecordContext,collection:string,scheduleId:string,cursor?:string){
  if(typeof collection!=='string'||!collection||collection.length>100||!id.safeParse(scheduleId).success||cursor&&!/^[A-Za-z0-9_-]{43}$/.test(cursor))throw fail('record_periodic_review_validation',400);
  return this.transaction(ctx,async(tx,tenant,proof)=>{
   const caps=await this.visible(tx,ctx,collection);
   const row=await this.lock(tx,ctx,scheduleId);
   if(row.collection!==collection)throw fail('record_periodic_review_unavailable',404);
   if(row.deprecated)return this.ignored(row);
   let form:Definition;
   try{form=this.parse(row.definition);}catch(error){if(error instanceof DocumentError)return this.ignored(row);throw error;}
   let assessed:{form:Definition;runnable:boolean};
   try{assessed=await this.assess(tx,ctx,collection,form);}catch(error){if(error instanceof DocumentError&&error.code==='record_periodic_review_field_unavailable')return {schedule:this.shell(row,form),records:[],nextCursor:null,withheld:true,ignored:false,message:withheldMessage};throw error;}
   if(!assessed.runnable)return this.ignored(row,form);
   const scope=await this.scopeOf(tx,ctx,tenant,proof,collection,'record-periodic-due',{scheduleId,scheduleVersion:row.version});
   const place=await this.place(tx,ctx,cursor,scope);
   const fields=await this.fields(tx,ctx,collection);
   const lead=form.intervalDays-form.windowDays;
   const values:unknown[]=[ctx.tenantId,collection,caps.includes('view'),ctx.actor.id,Number(tenant.schema_version),form.workflowId,lead,place.afterName,place.afterId];
   const compiled=this.compile(form,fields,values);
   const predicates=compiled.predicates.length?` AND ${compiled.predicates.join(' AND ')}`:'';
   const rows=(await tx.query<{id:string;name:string;name_search:string;version:number}>(`SELECT r.id,r.name,r.name_search,r.version FROM hs_data_records r WHERE r.tenant_id=$1 AND r.collection=$2 AND r.state='active' AND r.merged_into_id IS NULL AND ($3::boolean OR r.id IN(SELECT g.record_id FROM hs_data_record_grants g WHERE g.tenant_id=$1 AND g.user_id=$4 AND 'view'=ANY(g.capabilities))) AND NOT EXISTS (SELECT 1 FROM hs_data_reviews rv WHERE rv.tenant_id=r.tenant_id AND rv.record_id=r.id AND rv.status='pending' AND rv.record_version=r.version AND rv.schema_version=$5) AND COALESCE((SELECT max(rv.decided_at) FROM hs_data_reviews rv WHERE rv.tenant_id=r.tenant_id AND rv.record_id=r.id AND rv.workflow_id=$6 AND rv.status IN ('approved','rejected','changes_requested')),r.created_at)<=clock_timestamp()-($7::int * interval '1 day') AND ($8::text IS NULL OR (r.name_search COLLATE "C",r.id)>($8 COLLATE "C",$9::uuid))${predicates} ORDER BY r.name_search COLLATE "C",r.id LIMIT 51`,compiled.values)).rows;
   const page=rows.slice(0,50),records=[];
   for(const item of page){
    const grant=(await tx.query<{capabilities:RecordCapability[]}>('SELECT capabilities FROM hs_data_record_grants WHERE tenant_id=$1 AND record_id=$2 AND user_id=$3',[ctx.tenantId,item.id,ctx.actor.id])).rows[0];
    const recordCaps=new Set<RecordCapability>([...caps,...(grant?.capabilities??[])]);
    records.push({id:item.id,name:item.name,version:Number(item.version),canStart:recordCaps.has('edit')});
   }
   const last=page.at(-1);
   return {schedule:this.shell(row,form),records,nextCursor:rows.length>50&&last?await this.next(tx,ctx,scope,last.name_search,last.id):null,withheld:false,ignored:false};
  });
 }
 async startPeriodicReview(ctx:RecordContext,input:z.input<typeof start>){
  const parsed=start.safeParse(input);
  if(!parsed.success)throw fail('record_periodic_review_validation',400);
  const command=parsed.data,hash=recordHash(command);
  return this.transaction(ctx,async(tx,tenant)=>{
   const prior=(await tx.query<{request_hash:string;kind:string;review_id:string;applied_version:number}>('SELECT request_hash,kind,review_id,applied_version FROM hs_data_review_actions WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3',[ctx.tenantId,ctx.actor.id,command.operationId])).rows[0];
   if(prior){
    if(prior.request_hash!==hash||prior.kind!=='submit')throw fail('operation_mismatch');
    return this.outcome(tx,ctx,prior.review_id,prior.applied_version,true,false);
   }
   const schedule=await this.lock(tx,ctx,command.scheduleId);
   if(schedule.deprecated||schedule.version!==command.expectedScheduleVersion)throw fail();
   let assessed:{form:Definition;runnable:boolean};
   try{assessed=await this.assess(tx,ctx,schedule.collection,schedule.definition);}catch(error){if(error instanceof DocumentError&&error.code==='record_periodic_review_field_unavailable')throw error;throw error;}
   if(!assessed.runnable)throw fail();
   const {record,caps}=await this.exact(tx,ctx,command.recordId,true);
   if(record.collection!==schedule.collection)throw missing();
   if(!caps.includes('edit'))throw fail('record_periodic_review_forbidden',403);
   if(record.version!==command.expectedRecordVersion)throw fail();
   const schemaVersion=Number(tenant.schema_version);
   const open=await this.pending(tx,ctx,record.id);
   const current=!!open&&Number(open.record_version)===record.version&&Number(open.schema_version)===schemaVersion;
   if(current&&open)return this.outcome(tx,ctx,open.id,open.version,false,true);
   const workflow=await this.workflowPacket(tx,ctx,schedule.collection,assessed.form.workflowId);
   if(!await this.dueNow(tx,ctx,record,assessed.form,schemaVersion))throw fail();
   if(open)await this.supersede(tx,ctx,open);
   const reviewId=randomUUID();
   await tx.query('INSERT INTO hs_data_reviews(id,tenant_id,workflow_id,workflow_version,record_id,record_version,schema_version,status,version,submitted_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9)',[reviewId,ctx.tenantId,workflow.id,workflow.version,record.id,record.version,schemaVersion,'pending',ctx.actor.id]);
   await tx.query('INSERT INTO hs_data_review_events(tenant_id,review_id,event_version,kind,actor_id,record_version,schema_version,workflow_version) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[ctx.tenantId,reviewId,'submit',ctx.actor.id,record.version,schemaVersion,workflow.version]);
   await tx.query('INSERT INTO hs_data_review_actions(tenant_id,actor_id,operation_id,kind,request_hash,review_id,applied_version) VALUES($1,$2,$3,$4,$5,$6,1)',[ctx.tenantId,ctx.actor.id,command.operationId,'submit',hash,reviewId]);
   await this.bumpReviews(tx,ctx,record.collection);
   await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,'shared-record.review-submitted',JSON.stringify({tenantId:ctx.tenantId,workflowId:workflow.id,workflowVersion:workflow.version,reviewId,recordId:record.id,recordVersion:record.version,collection:record.collection,scheduleId:schedule.id,sourceApp:'holy-sheet-review'}),command.operationId]);
   return this.outcome(tx,ctx,reviewId,1,false,false);
  });
 }
}
function layoutFields(layout:RecordLayoutDefinition,layoutId:string){
 for(const tab of layout.tabs){
  if(tab.id===layoutId)return new Set(tab.sections.flatMap(section=>section.fields.map(slot=>slot.field)));
  for(const section of tab.sections)if(section.id===layoutId)return new Set(section.fields.map(slot=>slot.field));
 }
}
function safeJson(value:string){try{return JSON.parse(value) as unknown;}catch{return undefined;}}
