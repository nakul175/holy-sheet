import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Sql} from './database';
import {DocumentError} from './document';
import {recordHash,recordCapabilities,recordGrantCapabilities,type RecordCapability,type RecordGrantCapability} from './shared-record-types';
import {SharedRecordRepository,type RecordContext,type SuiteTenantProof} from './shared-records';

const uuid=z.string().uuid();
const subjectId=z.string().min(1).max(200);
const collection=z.string().min(1).max(100);
const fieldGrant=z.object({
 key:z.string().min(1).max(100),
 expectedVersion:z.number().int().nonnegative(),
 canView:z.boolean(),
 canWrite:z.boolean(),
 canHistory:z.boolean(),
}).strict();
export const recordPermissionCommand=z.object({
 operationId:uuid,
 collection,
 subjectId,
 collectionGrant:z.object({
  expectedVersion:z.number().int().nonnegative(),
  capabilities:z.array(z.enum(recordCapabilities)).max(recordCapabilities.length),
 }).strict().optional(),
 recordGrant:z.object({
  recordId:uuid,
  expectedVersion:z.number().int().nonnegative(),
  capabilities:z.array(z.enum(recordGrantCapabilities)).max(recordGrantCapabilities.length),
 }).strict().optional(),
 fields:z.array(fieldGrant).max(100).optional(),
}).strict();
export type RecordPermissionCommand=z.input<typeof recordPermissionCommand>;
type FieldState={key:string;canView:boolean;canWrite:boolean;canHistory:boolean;version:number};

const validation=()=>new DocumentError('Review the permission change.','record_permission_validation',400);
const conflict=()=>new DocumentError('Permissions changed. Review them again.','record_permission_conflict',409);
const forbidden=()=>new DocumentError('This record action is not permitted.','record_forbidden',403);
const missing=()=>new DocumentError('Record is restricted or unavailable.','record_not_found',404);

export class SharedRecordPermissionRepository extends SharedRecordRepository {
 private async manager(tx:Sql,ctx:RecordContext,proof:SuiteTenantProof,key:string){
  if(!proof.tenantAdministrator)throw forbidden();
  const caps=await this.collectionCaps(tx,ctx,key);
  if(!caps.includes('manage-permissions'))throw forbidden();
  return caps;
 }
 private async visible(tx:Sql,ctx:RecordContext,key:string,recordId?:string){
  const caps=await this.collectionCaps(tx,ctx,key);
  if(caps.includes('view')&&!recordId)return {caps,recordCaps:[] as RecordGrantCapability[]};
  if(recordId){
   const record=await tx.query('SELECT id FROM hs_data_records WHERE tenant_id=$1 AND id=$2 AND collection=$3 AND state<>\'trashed\'',[ctx.tenantId,recordId,key]);
   if(!record.rows.length)throw missing();
   const grant=await tx.query<{capabilities:RecordGrantCapability[]}>('SELECT capabilities FROM hs_data_record_grants WHERE tenant_id=$1 AND record_id=$2 AND user_id=$3',[ctx.tenantId,recordId,ctx.actor.id]);
   const recordCaps=grant.rows[0]?.capabilities??[];
   if(!caps.includes('view')&&!recordCaps.includes('view'))throw missing();
   return {caps,recordCaps};
  }
  const any=await tx.query('SELECT 1 FROM hs_data_record_grants g JOIN hs_data_records r ON r.tenant_id=g.tenant_id AND r.id=g.record_id WHERE g.tenant_id=$1 AND g.user_id=$2 AND r.collection=$3 AND r.state<>\'trashed\' AND \'view\'=ANY(g.capabilities) LIMIT 1',[ctx.tenantId,ctx.actor.id,key]);
  if(!any.rows.length)throw missing();
  return {caps,recordCaps:[] as RecordGrantCapability[]};
 }
 async describe(ctx:RecordContext,collectionKey:string,recordId?:string){
  if(!collection.safeParse(collectionKey).success||recordId!==undefined&&!uuid.safeParse(recordId).success)throw validation();
  return this.transaction(ctx,async(tx,t,proof)=>{
   const access=await this.visible(tx,ctx,collectionKey,recordId);
   const effective=[...new Set<RecordCapability>([...access.caps,...access.recordCaps])];
   const fields=[];
   for(const field of await this.fields(tx,ctx,collectionKey)){
    if(field.deprecated||!await this.fieldAllowed(tx,ctx,collectionKey,field,'view'))continue;
    fields.push({key:field.key,label:field.label,kind:field.kind,sensitive:field.sensitive,choices:field.choices,canWrite:await this.fieldAllowed(tx,ctx,collectionKey,field,'write'),canHistory:await this.fieldAllowed(tx,ctx,collectionKey,field,'history')});
   }
   return {schemaVersion:t.schema_version,collectionCapabilities:access.caps,capabilities:effective,canManage:proof.tenantAdministrator&&access.caps.includes('manage-permissions'),fields};
  });
 }
 async readMatrix(ctx:RecordContext,collectionKey:string,recordId?:string){
  if(!collection.safeParse(collectionKey).success||recordId!==undefined&&!uuid.safeParse(recordId).success)throw validation();
  return this.transaction(ctx,async(tx,_t,proof)=>{
   await this.manager(tx,ctx,proof,collectionKey);
   let record:{id:string;name:string}|null=null;
   if(recordId){
    const row=await tx.query<{id:string;name:string}>('SELECT id,name FROM hs_data_records WHERE tenant_id=$1 AND id=$2 AND collection=$3 AND state<>\'trashed\'',[ctx.tenantId,recordId,collectionKey]);
    if(!row.rows[0])throw missing();
    record={id:row.rows[0].id,name:row.rows[0].name};
   }
   const sensitive:{key:string;label:string;kind:string}[]=[];
   for(const field of await this.fields(tx,ctx,collectionKey))if(field.sensitive&&!field.deprecated)sensitive.push({key:field.key,label:field.label,kind:field.kind});
   const members=await tx.query<{id:string;name:string}>('SELECT u.id,u.name FROM hs_members m JOIN hs_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.active=true ORDER BY u.name,u.id LIMIT 101',[ctx.workspaceId]);
   const shown=members.rows.slice(0,100),ids=shown.map(member=>member.id);
   const collectionGrants=ids.length?await tx.query<{user_id:string;capabilities:RecordCapability[];version:number}>('SELECT user_id,capabilities,version FROM hs_data_collection_grants WHERE tenant_id=$1 AND collection=$2 AND user_id=ANY($3::text[])',[ctx.tenantId,collectionKey,ids]):{rows:[]};
   const recordGrants=ids.length&&record?await tx.query<{user_id:string;capabilities:RecordGrantCapability[];version:number}>('SELECT user_id,capabilities,version FROM hs_data_record_grants WHERE tenant_id=$1 AND record_id=$2 AND user_id=ANY($3::text[])',[ctx.tenantId,record.id,ids]):{rows:[]};
   const fieldGrants=ids.length?await tx.query<{user_id:string;field_key:string;can_view:boolean;can_write:boolean;can_history:boolean;version:number}>('SELECT user_id,field_key,can_view,can_write,can_history,version FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND user_id=ANY($3::text[])',[ctx.tenantId,collectionKey,ids]):{rows:[]};
   return {record,sensitiveFields:sensitive,truncated:members.rows.length>100,members:shown.map(member=>{
    const collectionGrant=collectionGrants.rows.find(grant=>grant.user_id===member.id);
    const recordGrant=recordGrants.rows.find(grant=>grant.user_id===member.id);
    const fields:FieldState[]=sensitive.map(field=>{
     const grant=fieldGrants.rows.find(item=>item.user_id===member.id&&item.field_key===field.key);
     return {key:field.key,canView:!!grant?.can_view,canWrite:!!grant?.can_write,canHistory:!!grant?.can_history,version:grant?.version??0};
    });
    return {id:member.id,name:member.name,collection:{capabilities:collectionGrant?.capabilities??[],version:collectionGrant?.version??0},record:record?{capabilities:recordGrant?.capabilities??[],version:recordGrant?.version??0}:null,fields};
   })};
  });
 }
 async apply(ctx:RecordContext,input:RecordPermissionCommand){
  const parsed=recordPermissionCommand.safeParse(input);
  if(!parsed.success||!parsed.data.collectionGrant&&!parsed.data.recordGrant&&!parsed.data.fields?.length)throw validation();
  const change=parsed.data;
  if(change.collectionGrant&&new Set(change.collectionGrant.capabilities).size!==change.collectionGrant.capabilities.length)throw validation();
  if(change.recordGrant&&(new Set(change.recordGrant.capabilities).size!==change.recordGrant.capabilities.length||change.recordGrant.capabilities.length>0&&!change.recordGrant.capabilities.includes('view')))throw validation();
  if(change.fields&&(new Set(change.fields.map(field=>field.key)).size!==change.fields.length||change.fields.some(field=>(field.canWrite||field.canHistory)&&!field.canView)))throw validation();
  const hash=recordHash(change);
  return this.transaction(ctx,async(tx,_t,proof)=>{
   await this.manager(tx,ctx,proof,change.collection);
   if(change.subjectId===ctx.actor.id)throw new DocumentError('Choose another member.','record_permission_subject',403);
   const prior=await tx.query<{request_hash:string;response:Record<string,unknown>}>('SELECT request_hash,response FROM hs_data_permission_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3',[ctx.tenantId,ctx.actor.id,change.operationId]);
   if(prior.rows[0]){if(prior.rows[0].request_hash!==hash)throw new DocumentError('Operation identity was reused with changed fields.','operation_mismatch',409);const stored=typeof prior.rows[0].response==='string'?JSON.parse(prior.rows[0].response):prior.rows[0].response;return {...stored,replayed:true};}
   const member=await tx.query('SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true',[ctx.workspaceId,change.subjectId]);
   if(!member.rows.length)throw missing();
   const response:Record<string,unknown>={};
   if(change.collectionGrant)response.collectionVersion=await this.writeCapabilities(tx,'collection',change.collectionGrant.expectedVersion,[ctx.tenantId,change.subjectId,change.collection,change.collectionGrant.capabilities]);
   if(change.recordGrant){
    const record=await tx.query('SELECT id FROM hs_data_records WHERE tenant_id=$1 AND id=$2 AND collection=$3 AND state<>\'trashed\'',[ctx.tenantId,change.recordGrant.recordId,change.collection]);
    if(!record.rows.length)throw missing();
    response.recordVersion=await this.writeCapabilities(tx,'record',change.recordGrant.expectedVersion,[ctx.tenantId,change.recordGrant.recordId,change.subjectId,change.recordGrant.capabilities]);
   }
   if(change.fields){
    const known=await this.fields(tx,ctx,change.collection);
    const versions:Record<string,number>={};
    for(const fieldChange of change.fields){
     const field=known.find(item=>item.key===fieldChange.key);
     if(!field||field.deprecated||!field.sensitive)throw new DocumentError('That field cannot take a separate permission.','record_permission_field',400);
     const written=await tx.query<{version:number}>('INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view,can_write,can_history,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,collection,field_key,user_id) DO UPDATE SET can_view=EXCLUDED.can_view,can_write=EXCLUDED.can_write,can_history=EXCLUDED.can_history,version=hs_data_field_permissions.version+1 WHERE hs_data_field_permissions.version=$9 RETURNING version',[ctx.tenantId,change.collection,field.key,change.subjectId,fieldChange.canView,fieldChange.canWrite,fieldChange.canHistory,fieldChange.expectedVersion+1,fieldChange.expectedVersion]);
     if(!written.rows[0])throw conflict();
     versions[field.key]=Number(written.rows[0].version);
    }
    response.fieldVersions=versions;
   }
   await tx.query('INSERT INTO hs_data_permission_operations(tenant_id,actor_id,operation_id,request_hash,response) VALUES($1,$2,$3,$4,$5)',[ctx.tenantId,ctx.actor.id,change.operationId,hash,JSON.stringify(response)]);
   await tx.query('INSERT INTO hs_audit(id,actor_id,action,subject_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),ctx.actor.id,'shared-record.permission',change.subjectId,JSON.stringify({tenantId:ctx.tenantId,collection:change.collection,...(change.recordGrant?{recordId:change.recordGrant.recordId,recordCapabilities:change.recordGrant.capabilities}:{}),...(change.collectionGrant?{collectionCapabilities:change.collectionGrant.capabilities}:{}),...(change.fields?{fields:change.fields.map(({key,canView,canWrite,canHistory})=>({key,canView,canWrite,canHistory}))}:{})}),change.operationId]);
   return {...response,replayed:false};
  });
 }
 private async writeCapabilities(tx:Sql,kind:'collection'|'record',expected:number,values:unknown[]){
  const sql=kind==='collection'
   ?'INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities,version) VALUES($1,$2,$3,$4,$5+1) ON CONFLICT(tenant_id,user_id,collection) DO UPDATE SET capabilities=EXCLUDED.capabilities,version=hs_data_collection_grants.version+1 WHERE hs_data_collection_grants.version=$5 RETURNING version'
   :'INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities,version) VALUES($1,$2,$3,$4,$5+1) ON CONFLICT(tenant_id,record_id,user_id) DO UPDATE SET capabilities=EXCLUDED.capabilities,version=hs_data_record_grants.version+1 WHERE hs_data_record_grants.version=$5 RETURNING version';
  const written=await tx.query<{version:number}>(sql,[...values,expected]);
  const version=Number(written.rows[0]?.version);
  if(!written.rows[0]||version!==expected+1)throw conflict();
  return version;
 }
}
