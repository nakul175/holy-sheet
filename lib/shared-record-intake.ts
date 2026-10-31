import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import type {Sql} from './database';
import {Repository} from './repository';
import {DocumentError} from './document';
import {referenceChoices} from './record-reference-fields';
import {SharedRecordRepository,type RecordContext,type CreateRecordInput,type UpdateRecordInput} from './shared-records';
import {recordHash,recordName} from './shared-record-types';

const id=z.string().uuid();
const relationships=z.object({
 parentOrganisation:z.boolean().default(false),
 legalOrganisations:z.boolean().default(false),
 accounts:z.boolean().default(false),
}).strict();
const definition=z.object({
 purpose:z.enum(['create','update']),
 instructions:z.string().max(500).default(''),
 rename:z.boolean().default(false),
 fields:z.array(z.string().min(1).max(100)).min(1).max(40),
 relationships:relationships.default({parentOrganisation:false,legalOrganisations:false,accounts:false}),
}).strict();
const save=z.object({
 id,operationId:id,collection:z.string().min(1).max(100),name:z.string().min(1).max(200),
 expectedVersion:z.number().int().nonnegative(),deprecated:z.boolean().default(false),definition,
}).strict();
const submit=z.object({
 formId:id,formVersion:z.number().int().positive(),expectedSchemaVersion:z.number().int().positive(),operationId:id,
 name:z.string().optional(),values:z.record(z.string(),z.unknown()).default({}),
 record:z.object({id,expectedVersion:z.number().int().positive()}).strict().optional(),
 parentOrganisationId:id.optional(),legalOrganisationIds:z.array(id).min(1).max(100).optional(),accountIds:z.array(id).max(100).optional(),
}).strict();
type Definition=z.infer<typeof definition>;
type IntakeRow={id:string;tenant_id:string;collection:string;name:string;name_search:string;version:number;deprecated:boolean;definition:unknown};
const message='The intake form is unavailable or changed. Review the current catalogue.';
const fail=(code='record_intake_conflict',status=409)=>new DocumentError(message,code,status);
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const missing=()=>new DocumentError('Record is restricted or unavailable.','record_not_found',404);

export class SharedRecordIntakeRepository extends SharedRecordRepository {
 private async locked(tx:Sql,ctx:RecordContext,formId:string){
  if(!id.safeParse(formId).success)throw fail('record_intake_unavailable',404);
  const row=(await tx.query<IntakeRow>('SELECT * FROM hs_data_intake_forms WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[ctx.tenantId,formId])).rows[0];
  if(!row)throw fail('record_intake_unavailable',404);
  const caps=await this.collectionCaps(tx,ctx,row.collection);
  if(!caps.includes('view'))throw fail('record_intake_unavailable',404);
  if((await tx.query<{deprecated:boolean}>('SELECT deprecated FROM hs_data_collections WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,row.collection])).rows[0]?.deprecated)throw fail('record_intake_unavailable',404);
  return {...row,version:Number(row.version)};
 }
 private async normalize(tx:Sql,ctx:RecordContext,collection:string,input:unknown,write:boolean){
  const parsed=definition.safeParse(typeof input==='string'?safeJson(input):input);
  if(!parsed.success)throw fail('record_intake_validation',400);
  const form=parsed.data;
  form.instructions=form.instructions.trim().normalize('NFC');
  if(form.instructions.length>500||/[\p{Cc}]/u.test(form.instructions)||new Set(form.fields).size!==form.fields.length)throw fail('record_intake_validation',400);
  if(form.relationships.parentOrganisation&&collection!=='accounts'||(form.relationships.legalOrganisations||form.relationships.accounts)&&collection!=='contracts')throw fail('record_intake_validation',400);
  if(form.purpose==='create'&&collection==='accounts'&&!form.relationships.parentOrganisation)throw fail('record_intake_validation',400);
  if(form.purpose==='create'&&collection==='contracts'&&!form.relationships.legalOrganisations)throw fail('record_intake_validation',400);
  if(form.purpose==='update'&&(form.relationships.parentOrganisation||form.relationships.legalOrganisations||form.relationships.accounts))throw fail('record_intake_validation',400);
  if(form.purpose==='create')form.rename=false;
  const fields=await this.fields(tx,ctx,collection);
  const formulas=new Set((await this.formulaRows(tx,ctx,collection)).map(row=>row.field_key));
  for(const key of form.fields){
   if(formulas.has(key))throw fail('record_intake_field_unavailable',403);
   const field=fields.find(item=>item.key===key);
   if(!field||field.deprecated||field.kind==='attachment'||field.kind==='record'||!await this.fieldAllowed(tx,ctx,collection,field,'view')||write&&!await this.fieldAllowed(tx,ctx,collection,field,'write'))throw fail('record_intake_field_unavailable',403);
  }
  return form;
 }
 private async projectFields(tx:Sql,ctx:RecordContext,collection:string,keys:string[],canWrite:boolean){
  const fields=await this.fields(tx,ctx,collection),shown=[];
  for(const key of keys){
   const field=fields.find(item=>item.key===key);
   if(!field)throw fail('record_intake_field_unavailable',403);
   const catalogue=referenceChoices(field);
   shown.push({key:field.key,label:field.label,kind:field.kind,required:field.required,canWrite:canWrite&&await this.fieldAllowed(tx,ctx,collection,field,'write'),sensitive:field.sensitive,choices:catalogue??field.choices.map(value=>({id:value,label:value}))});
  }
  return shown;
 }
 private async present(tx:Sql,ctx:RecordContext,row:IntakeRow,write:boolean){
  const form=await this.normalize(tx,ctx,row.collection,row.definition,write);
  return {id:row.id,collection:row.collection,name:row.name,version:Number(row.version),deprecated:row.deprecated,definition:form};
 }
 private async dependencies(tx:Sql,ctx:RecordContext,collection:string,formId:string,form:Definition,deprecated:boolean){
  await tx.query('DELETE FROM hs_data_schema_dependencies WHERE tenant_id=$1 AND intake_form_id=$2',[ctx.tenantId,formId]);
  if(deprecated)return;
  const fields=await this.fields(tx,ctx,collection);
  for(const field of fields)if(!field.core&&form.fields.includes(field.key))await tx.query('INSERT INTO hs_data_schema_dependencies(id,tenant_id,collection,field_key,kind,label,intake_form_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),ctx.tenantId,collection,field.key,'intake','Record intake form',formId]);
 }
 async saveIntakeForm(ctx:RecordContext,input:z.input<typeof save>){
  const parsed=save.safeParse(input);
  if(!parsed.success)throw fail('record_intake_validation',400);
  const command=parsed.data,name=recordName(command.name);
  if(Array.from(name).length>100)throw fail('record_intake_validation',400);
  return this.transaction(ctx,async(tx,tenant)=>{
   const caps=await this.collectionCaps(tx,ctx,command.collection);
   if(!caps.includes('view')||!caps.includes('manage-forms'))throw fail('record_forbidden',403);
   if((await tx.query<{deprecated:boolean}>('SELECT deprecated FROM hs_data_collections WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,command.collection])).rows[0]?.deprecated)throw fail('record_intake_unavailable',404);
   const form=await this.normalize(tx,ctx,command.collection,command.definition,true);
   const hash=recordHash({...command,name,definition:form});
   const existing=(await tx.query<{request_hash:string;form_id:string;applied_version:number}>('SELECT * FROM hs_data_intake_form_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3',[ctx.tenantId,ctx.actor.id,command.operationId])).rows[0];
   if(existing){if(existing.request_hash!==hash)throw fail('operation_mismatch');return {form:await this.present(tx,ctx,await this.locked(tx,ctx,existing.form_id),true),appliedVersion:existing.applied_version,replayed:true};}
   const previous=(await tx.query<IntakeRow>('SELECT * FROM hs_data_intake_forms WHERE id=$1 FOR UPDATE',[command.id])).rows[0];
   if(previous&&(previous.tenant_id!==ctx.tenantId||previous.collection!==command.collection))throw fail('record_intake_unavailable',404);
   if(Number(previous?.version??0)!==command.expectedVersion)throw fail();
   if(!previous){const count=(await tx.query<{n:string}>('SELECT count(*)::text AS n FROM hs_data_intake_forms WHERE tenant_id=$1 AND collection=$2',[ctx.tenantId,command.collection])).rows[0];if(Number(count.n)>=100)throw fail('record_intake_limit',429);}
   if((await tx.query('SELECT id FROM hs_data_intake_forms WHERE tenant_id=$1 AND collection=$2 AND name_search=lower($3) AND id<>$4',[ctx.tenantId,command.collection,name,command.id])).rows.length)throw fail('record_intake_name_conflict');
   const version=command.expectedVersion+1,stored=JSON.stringify(form);
   if(previous)await tx.query('UPDATE hs_data_intake_forms SET name=$3,version=$4,deprecated=$5,definition=$6 WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,command.id,name,version,command.deprecated,stored]);
   else await tx.query('INSERT INTO hs_data_intake_forms(id,tenant_id,collection,name,version,deprecated,definition,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[command.id,ctx.tenantId,command.collection,name,version,command.deprecated,stored,ctx.actor.id]);
   await tx.query('INSERT INTO hs_data_intake_form_versions(tenant_id,form_id,version,name,deprecated,definition,schema_version,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,command.id,version,name,command.deprecated,stored,tenant.schema_version,ctx.actor.id]);
   await tx.query('INSERT INTO hs_data_intake_form_operations(tenant_id,actor_id,operation_id,request_hash,form_id,applied_version) VALUES($1,$2,$3,$4,$5,$6)',[ctx.tenantId,ctx.actor.id,command.operationId,hash,command.id,version]);
   await this.dependencies(tx,ctx,command.collection,command.id,form,command.deprecated);
   await tx.query('INSERT INTO hs_data_intake_catalogues(tenant_id,collection) VALUES($1,$2) ON CONFLICT(tenant_id,collection) DO UPDATE SET revision=hs_data_intake_catalogues.revision+1',[ctx.tenantId,command.collection]);
   await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,'shared-record.intake-saved',JSON.stringify({tenantId:ctx.tenantId,formId:command.id,collection:command.collection,version,deprecated:command.deprecated,sourceApp:'holy-sheet'}),command.operationId]);
   return {form:await this.present(tx,ctx,await this.locked(tx,ctx,command.id),true),appliedVersion:version,replayed:false};
  });
 }
 async intakeFieldCatalogue(ctx:RecordContext,collection:string){
  if(typeof collection!=='string'||!collection||collection.length>100)throw fail('record_intake_validation',400);
  return this.transaction(ctx,async(tx,tenant)=>{
   const caps=await this.collectionCaps(tx,ctx,collection);
   if(!caps.includes('view'))throw fail('record_intake_unavailable',404);
   const fields=[];
   for(const field of await this.fields(tx,ctx,collection)){
    if(field.deprecated||field.kind==='attachment'||field.kind==='record'||!await this.fieldAllowed(tx,ctx,collection,field,'view'))continue;
    const catalogue=referenceChoices(field);
    fields.push({key:field.key,label:field.label,kind:field.kind,required:field.required,canWrite:await this.fieldAllowed(tx,ctx,collection,field,'write'),sensitive:field.sensitive,calculated:false,choices:catalogue??field.choices.map(value=>({id:value,label:value}))});
   }
   for(const calculated of await this.visibleCalculatedFields(tx,ctx,collection,await this.fields(tx,ctx,collection)))fields.push({key:calculated.key,label:calculated.label,kind:calculated.kind,required:false,canWrite:false,sensitive:calculated.sensitive,calculated:true,choices:[]});
   return {schemaVersion:tenant.schema_version,canCreate:caps.includes('create'),canEdit:caps.includes('edit'),canManage:caps.includes('manage-forms'),fields};
  });
 }
 async listIntakeForms(ctx:RecordContext,collection:string,cursor?:string){
  if(typeof collection!=='string'||!collection||collection.length>100||cursor&&!/^[A-Za-z0-9_-]{43}$/.test(cursor))throw fail('record_intake_validation',400);
  return this.transaction(ctx,async(tx,tenant,proof)=>{
   const caps=await this.collectionCaps(tx,ctx,collection);
   if(!caps.includes('view'))throw fail('record_intake_unavailable',404);
   if((await tx.query<{deprecated:boolean}>('SELECT deprecated FROM hs_data_collections WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,collection])).rows[0]?.deprecated)return {forms:[],nextCursor:null};
   const revision=(await tx.query<{revision:number}>('SELECT revision FROM hs_data_intake_catalogues WHERE tenant_id=$1 AND collection=$2',[ctx.tenantId,collection])).rows[0]?.revision??0;
   const scope=recordHash({kind:'record-intake-catalogue',collection,revision,schema:tenant.schema_version,policy:tenant.policy_version,authority:proof.revision});
   let afterName:string|null=null,afterId:string|null=null;
   if(cursor){
    const current=(await tx.query<{last_name:string;last_id:string}>('SELECT last_name,last_id FROM hs_data_query_cursors WHERE token_hash=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 AND scope_hash=$5 AND expires_at>clock_timestamp()',[sha(cursor),ctx.tenantId,ctx.workspaceId,ctx.actor.id,scope])).rows[0];
    if(!current)throw fail('record_intake_cursor');
    afterName=current.last_name;afterId=current.last_id;
   }
   const rows=(await tx.query<IntakeRow>('SELECT * FROM hs_data_intake_forms WHERE tenant_id=$1 AND collection=$2 AND deprecated=false AND ($3::text IS NULL OR (name_search COLLATE "C",id)>($3 COLLATE "C",$4::uuid)) ORDER BY name_search COLLATE "C",id LIMIT 51',[ctx.tenantId,collection,afterName,afterId])).rows;
   const page=rows.slice(0,50),forms=[];
   for(const row of page){
    let available=true;
    try{await this.normalize(tx,ctx,collection,row.definition,true);}catch(error){if(!(error instanceof DocumentError))throw error;available=false;}
    const stored=typeof row.definition==='string'?safeJson(row.definition):row.definition;
    const purpose=stored&&typeof stored==='object'&&!Array.isArray(stored)&&(stored as {purpose?:unknown}).purpose==='update'?'update':'create' as const;
    forms.push({id:row.id,name:row.name,version:Number(row.version),purpose,available});
   }
   let nextCursor:string|null=null;
   if(rows.length>50){
    nextCursor=randomBytes(32).toString('base64url');
    const last=page.at(-1)!;
    await tx.query('INSERT INTO hs_data_query_cursors(token_hash,tenant_id,workspace_id,actor_id,scope_hash,last_name,last_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[sha(nextCursor),ctx.tenantId,ctx.workspaceId,ctx.actor.id,scope,last.name_search,last.id]);
   }
   return {forms,nextCursor};
  });
 }
 async openIntakeForm(ctx:RecordContext,formId:string,recordId?:string){
  if(recordId&&!id.safeParse(recordId).success)throw fail('record_intake_validation',400);
  return this.transaction(ctx,async(tx,tenant)=>{
   const row=await this.locked(tx,ctx,formId);
   const form=await this.normalize(tx,ctx,row.collection,row.definition,true);
   if(recordId&&form.purpose!=='update')throw fail('record_intake_validation',400);
   const caps=await this.collectionCaps(tx,ctx,row.collection);
   let record:StoredRecord|undefined,recordCaps=caps;
   if(recordId){
    const stored=await this.raw(tx,ctx,recordId);
    if(stored.collection!==row.collection)throw missing();
    recordCaps=await this.caps(tx,ctx,stored);
    const values=Object.fromEntries(form.fields.filter(key=>Object.hasOwn(stored.field_values,key)).map(key=>[key,stored.field_values[key]]));
    record={id:stored.id,version:stored.version,name:stored.name,state:stored.state,values};
   }
   const canSubmit=!row.deprecated&&(form.purpose==='create'?caps.includes('create'):record?record.state==='active'&&recordCaps.includes('edit'):true);
   return {...await this.present(tx,ctx,row,true),schemaVersion:tenant.schema_version,canSubmit,canManage:caps.includes('manage-forms'),fields:await this.projectFields(tx,ctx,row.collection,form.fields,canSubmit),...(record?{record}:{})};
  });
 }
 async submitIntakeForm(ctx:RecordContext,input:z.input<typeof submit>){
  const parsed=submit.safeParse(input);
  if(!parsed.success)throw fail('record_intake_validation',400);
  const command=parsed.data,{operationId:_,...body}=command,hash=recordHash(body);
  return this.transaction(ctx,async(tx,tenant)=>{
   const row=await this.locked(tx,ctx,command.formId);
   const prior=(await tx.query<{request_hash:string;form_id:string;form_version:number;record_id:string;applied_version:number}>('SELECT * FROM hs_data_intake_submissions WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3',[ctx.tenantId,ctx.actor.id,command.operationId])).rows[0];
   if(prior){
    if(prior.request_hash!==hash||prior.form_id!==command.formId||prior.form_version!==command.formVersion)throw fail('operation_mismatch');
    return {record:await this.view(tx,ctx,await this.raw(tx,ctx,prior.record_id),tenant),appliedVersion:prior.applied_version,replayed:true,formVersion:prior.form_version};
   }
   if(row.deprecated||row.version!==command.formVersion||tenant.schema_version!==command.expectedSchemaVersion)throw fail();
   const form=await this.normalize(tx,ctx,row.collection,row.definition,true);
   const caps=await this.collectionCaps(tx,ctx,row.collection);
   for(const key of Object.keys(command.values))if(!form.fields.includes(key))throw fail('record_intake_field_unavailable',403);
   const bound=new Repository({query:tx.query.bind(tx),transaction:fn=>fn(tx),close:async()=>{}});
   const records=new SharedRecordRepository(bound,this.authority,this.valueAuthority,{sourceApp:'holy-sheet-intake'});
   if(form.purpose==='update'){
    if(!command.record||command.parentOrganisationId||command.legalOrganisationIds||command.accountIds)throw fail('record_intake_validation',400);
    if(form.rename&&command.name===undefined)throw new DocumentError('Enter a record name.','record_validation');
    if(!form.rename&&command.name!==undefined)throw fail('record_intake_field_unavailable',403);
    const existing=await this.raw(tx,ctx,command.record.id,'edit',true);
    if(existing.collection!==row.collection)throw missing();
    if(!caps.includes('edit')&&!(await this.caps(tx,ctx,existing)).includes('edit'))throw fail('record_forbidden',403);
    const change:UpdateRecordInput={operationId:command.operationId,expectedVersion:command.record.expectedVersion,schemaVersion:command.expectedSchemaVersion,values:command.values,...(form.rename?{name:command.name}:{})};
    const made=await records.update(ctx,command.record.id,change);
    await this.rememberSubmission(tx,ctx,command,hash,row.collection,row.version,made.record.id,made.appliedVersion);
    return {record:made.record,appliedVersion:made.appliedVersion,replayed:made.replayed,formVersion:row.version};
   }
   if(command.record||!caps.includes('create'))throw fail(command.record?'record_intake_validation':'record_forbidden',command.record?400:403);
   if(!form.relationships.parentOrganisation&&command.parentOrganisationId||!form.relationships.legalOrganisations&&command.legalOrganisationIds||!form.relationships.accounts&&command.accountIds)throw fail('record_intake_field_unavailable',403);
   const creation:CreateRecordInput={operationId:command.operationId,collection:row.collection,name:command.name??'',schemaVersion:command.expectedSchemaVersion,values:command.values,...(command.parentOrganisationId?{parentOrganisationId:command.parentOrganisationId}:{}),...(command.legalOrganisationIds?{legalOrganisationIds:command.legalOrganisationIds}:{}),...(command.accountIds?{accountIds:command.accountIds}:{})};
   const made=await records.create(ctx,creation);
   await this.rememberSubmission(tx,ctx,command,hash,row.collection,row.version,made.record.id,made.appliedVersion);
   return {record:made.record,appliedVersion:made.appliedVersion,replayed:made.replayed,formVersion:row.version};
  });
 }
 private async rememberSubmission(tx:Sql,ctx:RecordContext,command:z.infer<typeof submit>,hash:string,collection:string,formVersion:number,recordId:string,appliedVersion:number){
  await tx.query('INSERT INTO hs_data_intake_submissions(tenant_id,actor_id,operation_id,request_hash,form_id,form_version,record_id,applied_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,ctx.actor.id,command.operationId,hash,command.formId,formVersion,recordId,appliedVersion]);
  await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,'shared-record.intake-submitted',JSON.stringify({tenantId:ctx.tenantId,formId:command.formId,formVersion,recordId,collection,sourceApp:'holy-sheet-intake'}),command.operationId]);
 }
}
function safeJson(value:string){try{return JSON.parse(value) as unknown;}catch{return undefined;}}
type StoredRecord={id:string;version:number;name:string;state:'active'|'archived'|'trashed';values:Record<string,unknown>};
