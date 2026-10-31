import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Sql} from './database';
import {DocumentError} from './document';
import {referenceChoices} from './record-reference-fields';
import {SharedRecordRepository,type RecordContext,type Stored} from './shared-records';
import {recordHash,recordName,type RecordCapability} from './shared-record-types';

const id=z.string().uuid();
const definition=z.object({
 instructions:z.string().max(500).default(''),
 fields:z.array(z.string().min(1).max(100)).min(1).max(40),
 commentRequired:z.boolean().default(false),
}).strict();
const save=z.object({
 id,operationId:id,collection:z.string().min(1).max(100),name:z.string().min(1).max(200),
 expectedVersion:z.number().int().nonnegative(),deprecated:z.boolean().default(false),definition,
}).strict();
const submit=z.object({
 workflowId:id,workflowVersion:z.number().int().positive(),expectedSchemaVersion:z.number().int().positive(),
 recordId:id,expectedRecordVersion:z.number().int().positive(),operationId:id,
}).strict();
const decide=z.object({
 reviewId:id,expectedVersion:z.number().int().positive(),expectedRecordVersion:z.number().int().positive(),
 expectedSchemaVersion:z.number().int().positive(),workflowVersion:z.number().int().positive(),
 decision:z.enum(['approve','reject','request-changes']),comment:z.string().max(1000).optional(),operationId:id,
}).strict();
type Definition=z.infer<typeof definition>;
type WorkflowRow={id:string;tenant_id:string;collection:string;name:string;name_search:string;version:number;deprecated:boolean;definition:unknown};
type VersionRow={workflow_id:string;version:number;name:string;deprecated:boolean;definition:unknown};
type ReviewRow={id:string;tenant_id:string;workflow_id:string;workflow_version:number;record_id:string;record_version:number;schema_version:number;status:'pending'|'approved'|'rejected'|'changes_requested'|'superseded';version:number;submitted_by:string;decided_by:string|null;decision_note:string|null};
const message='The review workflow is unavailable or changed. Review the current catalogue.';
const fail=(code='record_review_conflict',status=409)=>new DocumentError(message,code,status);
const forbidden=()=>new DocumentError('This record action is not permitted.','record_review_forbidden',403);
const missing=()=>new DocumentError('Record is restricted or unavailable.','record_not_found',404);
const decisions={approve:'approved',reject:'rejected','request-changes':'changes_requested'} as const;

export class SharedRecordReviewRepository extends SharedRecordRepository {
 private async visible(tx:Sql,ctx:RecordContext,collection:string){
  const caps=await this.collectionCaps(tx,ctx,collection);
  if((await tx.query<{deprecated:boolean}>('SELECT deprecated FROM hs_data_collections WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,collection])).rows[0]?.deprecated)throw fail('record_review_unavailable',404);
  if(caps.includes('view'))return caps;
  const any=await tx.query(`SELECT 1 FROM hs_data_record_grants g JOIN hs_data_records r ON r.tenant_id=g.tenant_id AND r.id=g.record_id WHERE g.tenant_id=$1 AND g.user_id=$2 AND r.collection=$3 AND r.state<>'trashed' AND r.merged_into_id IS NULL AND 'view'=ANY(g.capabilities) LIMIT 1`,[ctx.tenantId,ctx.actor.id,collection]);
  if(!any.rows.length)throw fail('record_review_unavailable',404);
  return caps;
 }
 private async lock(tx:Sql,ctx:RecordContext,workflowId:string){
  if(!id.safeParse(workflowId).success)throw fail('record_review_unavailable',404);
  const row=(await tx.query<WorkflowRow>('SELECT * FROM hs_data_review_workflows WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.tenantId,workflowId])).rows[0];
  if(!row)throw fail('record_review_unavailable',404);
  await this.visible(tx,ctx,row.collection);
  return {...row,version:Number(row.version)};
 }
 private async lockReview(tx:Sql,ctx:RecordContext,reviewId:string){
  if(!id.safeParse(reviewId).success)throw fail('record_review_unavailable',404);
  const row=(await tx.query<ReviewRow>('SELECT * FROM hs_data_reviews WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.tenantId,reviewId])).rows[0];
  if(!row)throw fail('record_review_unavailable',404);
  return row;
 }
 private async pending(tx:Sql,ctx:RecordContext,recordId:string){
  return (await tx.query<ReviewRow>("SELECT * FROM hs_data_reviews WHERE tenant_id=$1 AND record_id=$2 AND status='pending' FOR UPDATE",[ctx.tenantId,recordId])).rows[0];
 }
 private async exact(tx:Sql,ctx:RecordContext,recordId:string,active:boolean){
  if(!id.safeParse(recordId).success)throw missing();
  const record=(await tx.query<Stored>("SELECT * FROM hs_data_records WHERE id=$1 AND tenant_id=$2 AND state<>'trashed' FOR UPDATE",[recordId,ctx.tenantId])).rows[0];
  if(!record)throw missing();
  record.version=Number(record.version);
  record.field_values=asObject(record.field_values);
  const caps=await this.caps(tx,ctx,record);
  if(!caps.includes('view'))throw missing();
  if(record.merged_into_id)throw new DocumentError('This record was merged. Open the current record.','record_merged',409);
  if(active&&record.state!=='active')throw missing();
  return {record,caps};
 }
 private async definitionOf(tx:Sql,ctx:RecordContext,collection:string,input:unknown){
  const parsed=definition.safeParse(typeof input==='string'?safeJson(input):input);
  if(!parsed.success)throw fail('record_review_validation',400);
  const form=parsed.data;
  form.instructions=form.instructions.trim().normalize('NFC');
  if(form.instructions.length>500||/[\p{Cc}]/u.test(form.instructions)||new Set(form.fields).size!==form.fields.length)throw fail('record_review_validation',400);
  const fields=await this.fields(tx,ctx,collection);
  const formulas=new Set((await this.formulaRows(tx,ctx,collection)).map(row=>row.field_key));
  for(const key of form.fields){
   if(formulas.has(key))throw fail('record_review_field_unavailable',403);
   const field=fields.find(item=>item.key===key);
   if(!field||field.deprecated||field.kind==='attachment'||field.kind==='record'||!await this.fieldAllowed(tx,ctx,collection,field,'view'))throw fail('record_review_field_unavailable',403);
  }
  return form;
 }
 private async project(tx:Sql,ctx:RecordContext,collection:string,keys:string[]){
  const fields=await this.fields(tx,ctx,collection),shown=[];
  for(const key of keys){
   const field=fields.find(item=>item.key===key);
   if(!field)throw fail('record_review_field_unavailable',403);
   const catalogue=referenceChoices(field);
   shown.push({key:field.key,label:field.label,kind:field.kind,required:field.required,canWrite:false,sensitive:field.sensitive,choices:catalogue??field.choices.map(value=>({id:value,label:value}))});
  }
  return shown;
 }
 private async present(tx:Sql,ctx:RecordContext,row:WorkflowRow){
  const form=await this.definitionOf(tx,ctx,row.collection,row.definition);
  return {id:row.id,collection:row.collection,name:row.name,version:Number(row.version),deprecated:row.deprecated,definition:form};
 }
 private async dependencies(tx:Sql,ctx:RecordContext,collection:string,workflowId:string,form:Definition,deprecated:boolean){
  await tx.query('DELETE FROM hs_data_schema_dependencies WHERE tenant_id=$1 AND review_workflow_id=$2',[ctx.tenantId,workflowId]);
  if(deprecated)return;
  for(const field of await this.fields(tx,ctx,collection))if(!field.core&&form.fields.includes(field.key))await tx.query('INSERT INTO hs_data_schema_dependencies(id,tenant_id,collection,field_key,kind,label,review_workflow_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),ctx.tenantId,collection,field.key,'review','Record review workflow',workflowId]);
 }
 private async bump(tx:Sql,ctx:RecordContext,collection:string){
  await tx.query('INSERT INTO hs_data_review_catalogues(tenant_id,collection) VALUES($1,$2) ON CONFLICT(tenant_id,collection) DO UPDATE SET revision=hs_data_review_catalogues.revision+1',[ctx.tenantId,collection]);
 }
 private async scopeOf(tx:Sql,ctx:RecordContext,tenant:{schema_version:number;policy_version:number},proof:{revision:string},collection:string,kind:string){
  const revision=(await tx.query<{revision:number}>('SELECT revision FROM hs_data_review_catalogues WHERE tenant_id=$1 AND collection=$2',[ctx.tenantId,collection])).rows[0]?.revision??0;
  return recordHash({kind,collection,revision:Number(revision),schema:Number(tenant.schema_version),policy:Number(tenant.policy_version),authority:proof.revision});
 }
 private async place(tx:Sql,ctx:RecordContext,cursor:string|undefined,scope:string){
  if(!cursor)return {afterName:null as string|null,afterId:null as string|null};
  const current=(await tx.query<{last_name:string;last_id:string}>('SELECT last_name,last_id FROM hs_data_query_cursors WHERE token_hash=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 AND scope_hash=$5 AND expires_at>clock_timestamp()',[sha(cursor),ctx.tenantId,ctx.workspaceId,ctx.actor.id,scope])).rows[0];
  if(!current)throw fail('record_review_cursor');
  return {afterName:current.last_name,afterId:current.last_id};
 }
 private async next(tx:Sql,ctx:RecordContext,scope:string,lastName:string,lastId:string){
  const token=randomBytes(32).toString('base64url');
  await tx.query('INSERT INTO hs_data_query_cursors(token_hash,tenant_id,workspace_id,actor_id,scope_hash,last_name,last_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[sha(token),ctx.tenantId,ctx.workspaceId,ctx.actor.id,scope,lastName,lastId]);
  return token;
 }
 private note(value:string|undefined,form:Definition,decision:z.infer<typeof decide>['decision']){
  const text=(value??'').trim().normalize('NFC');
  if(!text){if(form.commentRequired&&decision!=='approve')throw new DocumentError('Add a review comment before this decision.','record_review_validation',400);return null;}
  if(Array.from(text).length>1000||/[\p{Cc}]/u.test(text))throw fail('record_review_validation',400);
  return text;
 }
 private reviewOf(row:ReviewRow,actorId:string,record:Stored,schemaVersion:number){
  const stale=row.status==='pending'&&(Number(row.record_version)!==record.version||Number(row.schema_version)!==schemaVersion||record.state!=='active');
  return {id:row.id,status:row.status,version:Number(row.version),workflowId:row.workflow_id,workflowVersion:Number(row.workflow_version),recordVersion:Number(row.record_version),schemaVersion:Number(row.schema_version),submittedBySelf:row.submitted_by===actorId,stale,comment:row.decision_note};
 }
 private async outcome(tx:Sql,ctx:RecordContext,reviewId:string,appliedVersion:number,replayed:boolean){
  const review=await this.lockReview(tx,ctx,reviewId);
  await this.exact(tx,ctx,review.record_id,false);
  return {review:{id:review.id,status:review.status,version:Number(review.version),workflowId:review.workflow_id,workflowVersion:Number(review.workflow_version),recordId:review.record_id,recordVersion:Number(review.record_version),schemaVersion:Number(review.schema_version),submittedBySelf:review.submitted_by===ctx.actor.id,comment:review.decision_note},appliedVersion:Number(appliedVersion),replayed};
 }
 private async remembered(tx:Sql,ctx:RecordContext,operationId:string,hash:string,kind:'submit'|'decide'){
  const prior=(await tx.query<{request_hash:string;kind:string;review_id:string;applied_version:number}>('SELECT request_hash,kind,review_id,applied_version FROM hs_data_review_actions WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3',[ctx.tenantId,ctx.actor.id,operationId])).rows[0];
  if(!prior)return;
  if(prior.request_hash!==hash||prior.kind!==kind)throw fail('operation_mismatch');
  return this.outcome(tx,ctx,prior.review_id,prior.applied_version,true);
 }
 private async supersede(tx:Sql,ctx:RecordContext,row:ReviewRow){
  const version=Number(row.version)+1;
  const updated=await tx.query('UPDATE hs_data_reviews SET status=$3,version=$4 WHERE tenant_id=$1 AND id=$2 AND status=\'pending\' AND version=$5 RETURNING version',[ctx.tenantId,row.id,'superseded',version,Number(row.version)]);
  if(!updated.rows[0])throw fail();
  await tx.query('INSERT INTO hs_data_review_events(tenant_id,review_id,event_version,kind,actor_id,record_version,schema_version,workflow_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,row.id,version,'supersede',ctx.actor.id,Number(row.record_version),Number(row.schema_version),Number(row.workflow_version)]);
 }
 private async describe(tx:Sql,ctx:RecordContext,tenant:{schema_version:number},head:WorkflowRow,record?:{record:Stored;caps:RecordCapability[]},focus?:ReviewRow){
  const schemaVersion=Number(tenant.schema_version);
  const pending=record?await this.pending(tx,ctx,record.record.id):undefined;
  const stale=!!pending&&!!record&&(Number(pending.record_version)!==record.record.version||Number(pending.schema_version)!==schemaVersion||record.record.state!=='active');
  const current=pending&&!stale?pending:undefined;
  const workflow=current&&current.workflow_id!==head.id?await this.lock(tx,ctx,current.workflow_id):head;
  const packet=current?await this.version(tx,ctx,current.workflow_id,Number(current.workflow_version)):undefined;
  const form=await this.definitionOf(tx,ctx,workflow.collection,packet?.definition??head.definition);
  const caps=record?.caps??await this.collectionCaps(tx,ctx,head.collection);
  const canDecide=!!current&&!!record&&record.record.state==='active'&&caps.includes('review')&&current.submitted_by!==ctx.actor.id;
  const canSubmit=!!record&&record.record.state==='active'&&!head.deprecated&&caps.includes('edit')&&(!pending||stale);
  const values=record?Object.fromEntries(form.fields.filter(key=>Object.hasOwn(record.record.field_values,key)).map(key=>[key,record.record.field_values[key]])):undefined;
  let shown=current??(pending&&stale?pending:focus);
  let review=shown&&record?this.reviewOf(shown,ctx.actor.id,record.record,schemaVersion):undefined;
  if(!review&&record){
   const latest=(await tx.query<ReviewRow>('SELECT * FROM hs_data_reviews WHERE tenant_id=$1 AND record_id=$2 AND workflow_id=$3 AND status<>\'pending\' ORDER BY created_at DESC,id DESC LIMIT 1',[ctx.tenantId,record.record.id,head.id])).rows[0];
   if(latest)review=this.reviewOf(latest,ctx.actor.id,record.record,schemaVersion);
  }
  const label=packet??head;
  return {id:workflow.id,collection:workflow.collection,name:label.name,version:Number(label.version),deprecated:workflow.deprecated,definition:form,schemaVersion,canManage:caps.includes('view')&&caps.includes('manage-reviews'),canSubmit,canDecide,fields:await this.project(tx,ctx,workflow.collection,form.fields),...(record?{record:{id:record.record.id,version:record.record.version,name:record.record.name,state:record.record.state,values}}:{}),...(review?{review}:{})};
 }
 private async version(tx:Sql,ctx:RecordContext,workflowId:string,version:number){
  const row=(await tx.query<VersionRow>('SELECT workflow_id,version,name,deprecated,definition FROM hs_data_review_workflow_versions WHERE tenant_id=$1 AND workflow_id=$2 AND version=$3',[ctx.tenantId,workflowId,version])).rows[0];
  if(!row)throw fail();
  return {...row,version:Number(row.version)};
 }
 async saveReviewWorkflow(ctx:RecordContext,input:z.input<typeof save>){
  const parsed=save.safeParse(input);
  if(!parsed.success)throw fail('record_review_validation',400);
  const command=parsed.data;
  let name:string;
  try{name=recordName(command.name);}catch(error){if(error instanceof DocumentError)throw fail('record_review_validation',400);throw error;}
  if(Array.from(name).length>100)throw fail('record_review_validation',400);
  return this.transaction(ctx,async(tx,tenant)=>{
   const caps=await this.collectionCaps(tx,ctx,command.collection);
   if(!caps.includes('view')||!caps.includes('manage-reviews'))throw forbidden();
   if((await tx.query<{deprecated:boolean}>('SELECT deprecated FROM hs_data_collections WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,command.collection])).rows[0]?.deprecated)throw fail('record_review_unavailable',404);
   const form=await this.definitionOf(tx,ctx,command.collection,command.definition);
   const hash=recordHash({...command,name,definition:form});
   const existing=(await tx.query<{request_hash:string;workflow_id:string;applied_version:number}>('SELECT request_hash,workflow_id,applied_version FROM hs_data_review_workflow_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3',[ctx.tenantId,ctx.actor.id,command.operationId])).rows[0];
   if(existing){if(existing.request_hash!==hash)throw fail('operation_mismatch');return {workflow:await this.present(tx,ctx,await this.lock(tx,ctx,existing.workflow_id)),appliedVersion:Number(existing.applied_version),replayed:true};}
   const previous=(await tx.query<WorkflowRow>('SELECT * FROM hs_data_review_workflows WHERE id=$1 FOR UPDATE',[command.id])).rows[0];
   if(previous&&(previous.tenant_id!==ctx.tenantId||previous.collection!==command.collection))throw fail('record_review_unavailable',404);
   if(Number(previous?.version??0)!==command.expectedVersion)throw fail();
   if(!previous){const count=(await tx.query<{n:string}>('SELECT count(*)::text AS n FROM hs_data_review_workflows WHERE tenant_id=$1 AND collection=$2',[ctx.tenantId,command.collection])).rows[0];if(Number(count?.n)>=100)throw new DocumentError('This collection has reached its review workflow limit.','record_review_limit',429);}
   if((await tx.query('SELECT id FROM hs_data_review_workflows WHERE tenant_id=$1 AND collection=$2 AND name_search=lower($3) AND id<>$4',[ctx.tenantId,command.collection,name,command.id])).rows.length)throw new DocumentError('A review workflow with this name already exists.','record_review_name_conflict',409);
   const version=command.expectedVersion+1,stored=JSON.stringify(form);
   if(previous)await tx.query('UPDATE hs_data_review_workflows SET name=$3,version=$4,deprecated=$5,definition=$6 WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,command.id,name,version,command.deprecated,stored]);
   else await tx.query('INSERT INTO hs_data_review_workflows(id,tenant_id,collection,name,version,deprecated,definition,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[command.id,ctx.tenantId,command.collection,name,version,command.deprecated,stored,ctx.actor.id]);
   await tx.query('INSERT INTO hs_data_review_workflow_versions(tenant_id,workflow_id,version,name,deprecated,definition,schema_version,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,command.id,version,name,command.deprecated,stored,tenant.schema_version,ctx.actor.id]);
   await tx.query('INSERT INTO hs_data_review_workflow_operations(tenant_id,actor_id,operation_id,request_hash,workflow_id,applied_version) VALUES($1,$2,$3,$4,$5,$6)',[ctx.tenantId,ctx.actor.id,command.operationId,hash,command.id,version]);
   await this.dependencies(tx,ctx,command.collection,command.id,form,command.deprecated);
   await this.bump(tx,ctx,command.collection);
   await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,'shared-record.review-saved',JSON.stringify({tenantId:ctx.tenantId,workflowId:command.id,collection:command.collection,version,deprecated:command.deprecated,sourceApp:'holy-sheet'}),command.operationId]);
   return {workflow:await this.present(tx,ctx,await this.lock(tx,ctx,command.id)),appliedVersion:version,replayed:false};
  });
 }
 async reviewFieldCatalogue(ctx:RecordContext,collection:string){
  if(typeof collection!=='string'||!collection||collection.length>100)throw fail('record_review_validation',400);
  return this.transaction(ctx,async(tx,tenant)=>{
   const caps=await this.visible(tx,ctx,collection),fields=[];
   for(const field of await this.fields(tx,ctx,collection)){
    if(field.deprecated||field.kind==='attachment'||field.kind==='record'||!await this.fieldAllowed(tx,ctx,collection,field,'view'))continue;
    const catalogue=referenceChoices(field);
    fields.push({key:field.key,label:field.label,kind:field.kind,required:field.required,canWrite:false,sensitive:field.sensitive,calculated:false,choices:catalogue??field.choices.map(value=>({id:value,label:value}))});
   }
   for(const calculated of await this.visibleCalculatedFields(tx,ctx,collection,await this.fields(tx,ctx,collection)))fields.push({key:calculated.key,label:calculated.label,kind:calculated.kind,required:false,canWrite:false,sensitive:calculated.sensitive,calculated:true,choices:[]});
   return {schemaVersion:Number(tenant.schema_version),canManage:caps.includes('view')&&caps.includes('manage-reviews'),canEdit:caps.includes('edit'),canReview:caps.includes('review'),fields};
  });
 }
 async listReviewWorkflows(ctx:RecordContext,collection:string,cursor?:string){
  if(typeof collection!=='string'||!collection||collection.length>100||cursor&&!/^[A-Za-z0-9_-]{43}$/.test(cursor))throw fail('record_review_validation',400);
  return this.transaction(ctx,async(tx,tenant,proof)=>{
   await this.visible(tx,ctx,collection);
   const scope=await this.scopeOf(tx,ctx,tenant,proof,collection,'record-review-catalogue');
   const place=await this.place(tx,ctx,cursor,scope);
   const rows=(await tx.query<WorkflowRow>('SELECT * FROM hs_data_review_workflows WHERE tenant_id=$1 AND collection=$2 AND deprecated=false AND ($3::text IS NULL OR (name_search COLLATE "C",id)>($3 COLLATE "C",$4::uuid)) ORDER BY name_search COLLATE "C",id LIMIT 51',[ctx.tenantId,collection,place.afterName,place.afterId])).rows;
   const page=rows.slice(0,50),workflows=[];
   for(const row of page){
    let available=true;
    try{await this.definitionOf(tx,ctx,collection,row.definition);}catch(error){if(!(error instanceof DocumentError))throw error;available=false;}
    workflows.push({id:row.id,name:row.name,version:Number(row.version),available});
   }
   const last=page.at(-1);
   return {workflows,nextCursor:rows.length>50&&last?await this.next(tx,ctx,scope,last.name_search,last.id):null};
  });
 }
 async listReviewQueue(ctx:RecordContext,collection:string,cursor?:string){
  if(typeof collection!=='string'||!collection||collection.length>100||cursor&&!/^[A-Za-z0-9_-]{43}$/.test(cursor))throw fail('record_review_validation',400);
  return this.transaction(ctx,async(tx,tenant,proof)=>{
   const caps=await this.visible(tx,ctx,collection);
   const scope=await this.scopeOf(tx,ctx,tenant,proof,collection,'record-review-queue');
   const place=await this.place(tx,ctx,cursor,scope);
   const rows=(await tx.query<ReviewRow&{record_name:string;name_search:string;live_version:number;state:Stored['state'];workflow_name:string;definition:unknown}>("SELECT rv.*,r.name AS record_name,r.name_search,r.version AS live_version,r.state,w.name AS workflow_name,v.definition FROM hs_data_reviews rv JOIN hs_data_records r ON r.tenant_id=rv.tenant_id AND r.id=rv.record_id JOIN hs_data_review_workflows w ON w.tenant_id=rv.tenant_id AND w.id=rv.workflow_id JOIN hs_data_review_workflow_versions v ON v.tenant_id=rv.tenant_id AND v.workflow_id=rv.workflow_id AND v.version=rv.workflow_version WHERE rv.tenant_id=$1 AND r.collection=$2 AND rv.status='pending' AND r.state='active' AND r.merged_into_id IS NULL AND ($3::boolean OR r.id IN(SELECT g.record_id FROM hs_data_record_grants g WHERE g.tenant_id=$1 AND g.user_id=$4 AND 'view'=ANY(g.capabilities))) AND ($5::text IS NULL OR (r.name_search COLLATE \"C\",rv.id)>($5 COLLATE \"C\",$6::uuid)) ORDER BY r.name_search COLLATE \"C\",rv.id LIMIT 51",[ctx.tenantId,collection,caps.includes('view'),ctx.actor.id,place.afterName,place.afterId])).rows;
   const page=rows.slice(0,50),reviews=[];
   for(const row of page){
    const grant=(await tx.query<{capabilities:RecordCapability[]}>('SELECT capabilities FROM hs_data_record_grants WHERE tenant_id=$1 AND record_id=$2 AND user_id=$3',[ctx.tenantId,row.record_id,ctx.actor.id])).rows[0];
    const recordCaps=new Set<RecordCapability>([...caps,...(grant?.capabilities??[])]);
    let readable=true;
    try{await this.definitionOf(tx,ctx,collection,row.definition);}catch(error){if(!(error instanceof DocumentError))throw error;readable=false;}
    const current=Number(row.record_version)===Number(row.live_version)&&Number(row.schema_version)===Number(tenant.schema_version);
    reviews.push({id:row.id,workflowId:row.workflow_id,workflowName:row.workflow_name,recordId:row.record_id,recordName:row.record_name,recordVersion:Number(row.live_version),submittedBySelf:row.submitted_by===ctx.actor.id,canDecide:readable&&current&&recordCaps.has('review')&&row.submitted_by!==ctx.actor.id});
   }
   const last=page.at(-1);
   return {reviews,nextCursor:rows.length>50&&last?await this.next(tx,ctx,scope,last.name_search,last.id):null};
  });
 }
 async openReviewWorkflow(ctx:RecordContext,workflowId:string,recordId?:string){
  if(recordId&&!id.safeParse(recordId).success)throw fail('record_review_validation',400);
  return this.transaction(ctx,async(tx,tenant)=>{
   const head=await this.lock(tx,ctx,workflowId);
   if(!recordId)return this.describe(tx,ctx,tenant,head);
   const record=await this.exact(tx,ctx,recordId,false);
   if(record.record.collection!==head.collection)throw missing();
   const open=await this.pending(tx,ctx,record.record.id);
   return this.describe(tx,ctx,tenant,open?await this.lock(tx,ctx,open.workflow_id):head,record,open);
  });
 }
 async openReview(ctx:RecordContext,reviewId:string){
  return this.transaction(ctx,async(tx,tenant)=>{
   if(!id.safeParse(reviewId).success)throw fail('record_review_unavailable',404);
   const peek=(await tx.query<{record_id:string;workflow_id:string}>('SELECT record_id,workflow_id FROM hs_data_reviews WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,reviewId])).rows[0];
   if(!peek)throw fail('record_review_unavailable',404);
   const record=await this.exact(tx,ctx,peek.record_id,false);
   const review=await this.lockReview(tx,ctx,reviewId);
   const head=await this.lock(tx,ctx,review.workflow_id);
   if(head.collection!==record.record.collection)throw missing();
   return this.describe(tx,ctx,tenant,head,record,review);
  });
 }
 async submitReview(ctx:RecordContext,input:z.input<typeof submit>){
  const parsed=submit.safeParse(input);
  if(!parsed.success)throw fail('record_review_validation',400);
  const command=parsed.data,hash=recordHash(command);
  return this.transaction(ctx,async(tx,tenant)=>{
   const replay=await this.remembered(tx,ctx,command.operationId,hash,'submit');
   if(replay)return replay;
   const {record,caps}=await this.exact(tx,ctx,command.recordId,true);
   if(!caps.includes('edit'))throw forbidden();
   const workflow=await this.lock(tx,ctx,command.workflowId);
   if(workflow.collection!==record.collection)throw missing();
   if(workflow.deprecated||workflow.version!==command.workflowVersion||Number(tenant.schema_version)!==command.expectedSchemaVersion||record.version!==command.expectedRecordVersion)throw fail();
   await this.definitionOf(tx,ctx,workflow.collection,workflow.definition);
   const open=await this.pending(tx,ctx,record.id);
   if(open&&Number(open.record_version)===record.version&&Number(open.schema_version)===Number(tenant.schema_version))throw fail();
   if(open)await this.supersede(tx,ctx,open);
   const reviewId=randomUUID();
   await tx.query('INSERT INTO hs_data_reviews(id,tenant_id,workflow_id,workflow_version,record_id,record_version,schema_version,status,version,submitted_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9)',[reviewId,ctx.tenantId,workflow.id,workflow.version,record.id,record.version,Number(tenant.schema_version),'pending',ctx.actor.id]);
   await tx.query('INSERT INTO hs_data_review_events(tenant_id,review_id,event_version,kind,actor_id,record_version,schema_version,workflow_version) VALUES($1,$2,1,$3,$4,$5,$6,$7)',[ctx.tenantId,reviewId,'submit',ctx.actor.id,record.version,Number(tenant.schema_version),workflow.version]);
   await tx.query('INSERT INTO hs_data_review_actions(tenant_id,actor_id,operation_id,kind,request_hash,review_id,applied_version) VALUES($1,$2,$3,$4,$5,$6,1)',[ctx.tenantId,ctx.actor.id,command.operationId,'submit',hash,reviewId]);
   await this.bump(tx,ctx,record.collection);
   await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,'shared-record.review-submitted',JSON.stringify({tenantId:ctx.tenantId,workflowId:workflow.id,workflowVersion:workflow.version,reviewId,recordId:record.id,recordVersion:record.version,collection:record.collection,sourceApp:'holy-sheet-review'}),command.operationId]);
   return this.outcome(tx,ctx,reviewId,1,false);
  });
 }
 async decideReview(ctx:RecordContext,input:z.input<typeof decide>){
  const parsed=decide.safeParse(input);
  if(!parsed.success)throw fail('record_review_validation',400);
  const command=parsed.data,hash=recordHash(command);
  return this.transaction(ctx,async(tx,tenant)=>{
   const replay=await this.remembered(tx,ctx,command.operationId,hash,'decide');
   if(replay)return replay;
   const peek=(await tx.query<{record_id:string}>('SELECT record_id FROM hs_data_reviews WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,command.reviewId])).rows[0];
   if(!peek)throw fail('record_review_unavailable',404);
   const {record,caps}=await this.exact(tx,ctx,peek.record_id,true);
   const review=await this.lockReview(tx,ctx,command.reviewId);
   if(!caps.includes('review'))throw forbidden();
   if(review.submitted_by===ctx.actor.id)throw forbidden();
   if(review.status!=='pending'||Number(review.version)!==command.expectedVersion)throw fail();
   if(Number(review.record_version)!==record.version||record.version!==command.expectedRecordVersion)throw fail();
   if(Number(review.schema_version)!==Number(tenant.schema_version)||Number(tenant.schema_version)!==command.expectedSchemaVersion)throw fail();
   if(Number(review.workflow_version)!==command.workflowVersion)throw fail();
   const version=await this.version(tx,ctx,review.workflow_id,Number(review.workflow_version));
   const form=await this.definitionOf(tx,ctx,record.collection,version.definition);
   const note=this.note(command.comment,form,command.decision);
   const status=decisions[command.decision],next=Number(review.version)+1;
   const updated=await tx.query('UPDATE hs_data_reviews SET status=$3,version=$4,decided_by=$5,decision_note=$6,decided_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status=\'pending\' AND version=$7 RETURNING version',[ctx.tenantId,review.id,status,next,ctx.actor.id,note,Number(review.version)]);
   if(!updated.rows[0])throw fail();
   await tx.query('INSERT INTO hs_data_review_events(tenant_id,review_id,event_version,kind,actor_id,record_version,schema_version,workflow_version,decision_note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[ctx.tenantId,review.id,next,command.decision,ctx.actor.id,record.version,Number(tenant.schema_version),Number(review.workflow_version),note]);
   await tx.query('INSERT INTO hs_data_review_actions(tenant_id,actor_id,operation_id,kind,request_hash,review_id,applied_version) VALUES($1,$2,$3,$4,$5,$6,$7)',[ctx.tenantId,ctx.actor.id,command.operationId,'decide',hash,review.id,next]);
   await this.bump(tx,ctx,record.collection);
   await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,'shared-record.review-decided',JSON.stringify({tenantId:ctx.tenantId,reviewId:review.id,workflowId:review.workflow_id,recordId:record.id,decision:command.decision,collection:record.collection,sourceApp:'holy-sheet-review'}),command.operationId]);
   return this.outcome(tx,ctx,review.id,next,false);
  });
 }
}
function safeJson(value:string){try{return JSON.parse(value) as unknown;}catch{return undefined;}}
function asObject(value:unknown):Record<string,unknown>{if(typeof value==='string'){const parsed=safeJson(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};}return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function sha(value:string){return recordHash(value);}
