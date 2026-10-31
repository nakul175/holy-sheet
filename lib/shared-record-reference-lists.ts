import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {DocumentError} from './document';
import type {Sql} from './database';
import {SharedRecordRepository,type RecordContext} from './shared-records';
import {recordHash} from './shared-record-types';
import {compileReferenceList,nextReferenceList,resolveReferenceItem,RecordReferenceListError,type RecordReferenceList} from './record-reference-list';
const uuid=z.string().uuid();
const proposal=z.object({expectedVersion:z.number().int().nonnegative(),definition:z.unknown()}).strict();
const command=z.object({previewId:uuid,reviewHash:z.string().regex(/^[a-f0-9]{64}$/),operationId:uuid,selection:proposal}).strict();
const fail=(code='record_reference_list_conflict',status=409)=>new DocumentError('The reference list is unavailable or changed. Review the current configuration.',code,status);
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
type Stored={id:string;version:number;definition:RecordReferenceList};
type Revisions={schema_version:number;policy_version:number;data_revision:string};
/** Configuration service. Callers pass the current suite-tenant authority.
 * Explicit read/manage rows never grant business-record access. */
export class SharedRecordReferenceListRepository extends SharedRecordRepository {
 private async permission(tx:Sql,ctx:RecordContext,manage=false,admin=false){
  const p=(await tx.query<{can_read:boolean;can_manage:boolean;version:number}>('SELECT * FROM hs_data_reference_list_permissions WHERE tenant_id=$1 AND user_id=$2',[ctx.tenantId,ctx.actor.id])).rows[0];
  if(!p?.can_read||manage&&(!p.can_manage||!admin))throw fail('record_reference_list_forbidden',403);
  return p.version;
 }
 private async row(tx:Sql,ctx:RecordContext,id:string){return (await tx.query<Stored>('SELECT id,version,definition FROM hs_data_reference_lists WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,id])).rows[0];}
 private async revisions(tx:Sql,ctx:RecordContext){return (await tx.query<Revisions>('SELECT schema_version,policy_version,data_revision FROM hs_data_tenants WHERE id=$1',[ctx.tenantId])).rows[0];}
 private async prepare(tx:Sql,ctx:RecordContext,input:unknown){
  const p=proposal.safeParse(input);if(!p.success)throw fail('record_reference_list_validation',400);
  let definition:RecordReferenceList;
  try{definition=compileReferenceList(p.data.definition);}catch(e){if(e instanceof RecordReferenceListError)throw fail('record_reference_list_validation',422);throw e;}
  if(definition.tenantId!==ctx.tenantId)throw fail('record_reference_list_unavailable',404);
  const old=await this.row(tx,ctx,definition.id);
  if((old?.version??0)!==p.data.expectedVersion||definition.version!==p.data.expectedVersion+1)throw fail();
  if(old)try{definition=nextReferenceList(old.definition,definition);}catch(e){if(e instanceof RecordReferenceListError)throw fail('record_reference_list_validation',422);throw e;}
  const duplicate=await tx.query('SELECT id FROM hs_data_reference_lists WHERE tenant_id=$1 AND name_search=lower($2) AND id<>$3',[ctx.tenantId,definition.name,definition.id]);
  if(duplicate.rows.length)throw fail('record_reference_list_name_conflict');
  if(!old){const n=(await tx.query<{n:string}>('SELECT count(*)::text AS n FROM hs_data_reference_lists WHERE tenant_id=$1',[ctx.tenantId])).rows[0];if(Number(n.n)>=200)throw fail('record_reference_list_limit',429);}
  return {definition,expectedVersion:p.data.expectedVersion};
 }
 async previewReferenceList(ctx:RecordContext,input:z.input<typeof proposal>){
  return this.transaction(ctx,async(tx,_t,p)=>{
   const permissionVersion=await this.permission(tx,ctx,true,p.tenantAdministrator),c=await this.prepare(tx,ctx,input),rev=await this.revisions(tx,ctx),previewId=randomUUID(),reviewHash=randomBytes(32).toString('hex');
   await tx.query('INSERT INTO hs_data_reference_list_previews(id,tenant_id,workspace_id,actor_id,list_id,expected_version,definition_hash,review_hash,schema_version,policy_version,data_revision,authority_revision,permission_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[previewId,ctx.tenantId,ctx.workspaceId,ctx.actor.id,c.definition.id,c.expectedVersion,recordHash(c.definition),reviewHash,rev.schema_version,rev.policy_version,rev.data_revision,p.revision,permissionVersion]);
   return {previewId,reviewHash,definition:c.definition,storedValueHandling:'Stable IDs are retained; labels are configuration metadata only.' as const};
  },async tx=>{await this.permission(tx,ctx,true,true);});
 }
 async applyReferenceList(ctx:RecordContext,input:z.input<typeof command>){
  const parsed=command.safeParse(input);if(!parsed.success)throw fail('record_reference_list_validation',400);
  const c=parsed.data,hash=recordHash(c);let fresh=false;
  return this.transaction(ctx,async(tx,_t,p)=>{
   const permissionVersion=await this.permission(tx,ctx,true,p.tenantAdministrator);
   const prior=(await tx.query<{request_hash:string;list_id:string;applied_version:number}>('SELECT * FROM hs_data_reference_list_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3',[ctx.tenantId,ctx.actor.id,c.operationId])).rows[0];
   if(prior){if(prior.request_hash!==hash)throw fail('operation_mismatch');const list=await this.row(tx,ctx,prior.list_id);if(!list)throw fail('record_reference_list_unavailable',404);return {definition:list.definition,appliedVersion:prior.applied_version,replayed:true};}
   const preview=(await tx.query<{list_id:string;expected_version:number;definition_hash:string;schema_version:number;policy_version:number;data_revision:string;authority_revision:string;permission_version:number}>('SELECT * FROM hs_data_reference_list_previews WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 AND review_hash=$5 AND expires_at>clock_timestamp()',[c.previewId,ctx.tenantId,ctx.workspaceId,ctx.actor.id,c.reviewHash])).rows[0];
   if(!preview)throw fail();const {definition:d,expectedVersion}=await this.prepare(tx,ctx,c.selection),rev=await this.revisions(tx,ctx);
   if(preview.list_id!==d.id||preview.expected_version!==expectedVersion||preview.definition_hash!==recordHash(d)||preview.authority_revision!==p.revision||preview.permission_version!==permissionVersion||preview.schema_version!==rev.schema_version||preview.policy_version!==rev.policy_version||String(preview.data_revision)!==String(rev.data_revision))throw fail();
   await tx.query('INSERT INTO hs_data_reference_lists(tenant_id,id,name,version,definition,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,id) DO UPDATE SET name=excluded.name,version=excluded.version,definition=excluded.definition',[ctx.tenantId,d.id,d.name,d.version,JSON.stringify(d),ctx.actor.id]);
   await tx.query('INSERT INTO hs_data_reference_list_versions(tenant_id,list_id,version,definition,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,$6)',[ctx.tenantId,d.id,d.version,JSON.stringify(d),ctx.actor.id,c.operationId]);
   await tx.query('INSERT INTO hs_data_reference_list_operations(tenant_id,actor_id,operation_id,list_id,request_hash,applied_version) VALUES($1,$2,$3,$4,$5,$6)',[ctx.tenantId,ctx.actor.id,c.operationId,d.id,hash,d.version]);
   await tx.query('UPDATE hs_data_tenants SET schema_version=schema_version+1,policy_version=policy_version+1 WHERE id=$1',[ctx.tenantId]);
   await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,'shared-record.reference-list-saved',JSON.stringify({tenantId:ctx.tenantId,listId:d.id,version:d.version,sourceApp:'holy-sheet'}),c.operationId]);
   fresh=true;return {definition:d,appliedVersion:d.version,replayed:false};
  },async tx=>{await this.permission(tx,ctx,true,true);if(fresh&&!(await tx.query('SELECT id FROM hs_data_reference_list_previews WHERE id=$1 AND expires_at>clock_timestamp()',[c.previewId])).rows.length)throw fail('record_reference_list_preview_expired',410);});
 }
 async getReferenceList(ctx:RecordContext,listId:string){
  if(!uuid.safeParse(listId).success)throw fail('record_reference_list_validation',400);
  return this.transaction(ctx,async tx=>{await this.permission(tx,ctx);const list=await this.row(tx,ctx,listId);if(!list)throw fail('record_reference_list_unavailable',404);return list.definition;},async tx=>{await this.permission(tx,ctx);});
 }
 async referenceListHistory(ctx:RecordContext,listId:string,beforeVersion?:number){
  if(!uuid.safeParse(listId).success||beforeVersion!==undefined&&(!Number.isSafeInteger(beforeVersion)||beforeVersion<1))throw fail('record_reference_list_validation',400);
  return this.transaction(ctx,async(tx,_t,p)=>{
   await this.permission(tx,ctx,true,p.tenantAdministrator);if(!await this.row(tx,ctx,listId))throw fail('record_reference_list_unavailable',404);
   const rows=(await tx.query<{version:number;definition:RecordReferenceList;actor_id:string;source_app:string;created_at:string}>('SELECT version,definition,actor_id,source_app,created_at FROM hs_data_reference_list_versions WHERE tenant_id=$1 AND list_id=$2 AND ($3::integer IS NULL OR version<$3) ORDER BY version DESC LIMIT 51',[ctx.tenantId,listId,beforeVersion??null])).rows;
   const page=rows.slice(0,50);return {versions:page.map(v=>({version:v.version,definition:v.definition,actorId:v.actor_id,sourceApp:v.source_app,createdAt:new Date(v.created_at).toISOString()})),nextBeforeVersion:rows.length>50?page.at(-1)!.version:null};
  },async tx=>{await this.permission(tx,ctx,true,true);});
 }
 async resolveReferenceValue(ctx:RecordContext,listId:string,lookup:{by:'id'|'code'|'label';value:string},newSelection=true){
  if(!uuid.safeParse(listId).success)throw fail('record_reference_list_validation',400);
  return this.transaction(ctx,async tx=>{await this.permission(tx,ctx);const list=await this.row(tx,ctx,listId);if(!list)throw fail('record_reference_list_unavailable',404);try{return {itemId:resolveReferenceItem(list.definition,ctx.tenantId,lookup,newSelection),listVersion:list.version};}catch(e){if(e instanceof RecordReferenceListError)throw fail('record_reference_value_unavailable',422);throw e;}},async tx=>{await this.permission(tx,ctx);});
 }
 async listReferenceLists(ctx:RecordContext,cursor?:string){
  if(cursor&&!/^[A-Za-z0-9_-]{43}$/.test(cursor))throw fail('record_reference_list_validation',400);
  return this.transaction(ctx,async(tx,t,p)=>{
   const permission=await this.permission(tx,ctx),scope=recordHash({kind:'reference-list-catalogue',schema:t.schema_version,policy:t.policy_version,authority:p.revision,permission});let afterName:string|null=null,afterId:string|null=null;
   if(cursor){const c=(await tx.query<{last_name:string;last_id:string}>('SELECT last_name,last_id FROM hs_data_query_cursors WHERE token_hash=$1 AND tenant_id=$2 AND workspace_id=$3 AND actor_id=$4 AND scope_hash=$5 AND expires_at>clock_timestamp()',[sha(cursor),ctx.tenantId,ctx.workspaceId,ctx.actor.id,scope])).rows[0];if(!c)throw fail('record_reference_list_cursor');afterName=c.last_name;afterId=c.last_id;}
   const rows=(await tx.query<{id:string;name:string;name_search:string;version:number}>('SELECT id,name,name_search,version FROM hs_data_reference_lists WHERE tenant_id=$1 AND ($2::text IS NULL OR (name_search COLLATE "C",id)>($2 COLLATE "C",$3::uuid)) ORDER BY name_search COLLATE "C",id LIMIT 51',[ctx.tenantId,afterName,afterId])).rows,page=rows.slice(0,50);let nextCursor:string|null=null;
   if(rows.length>50){nextCursor=randomBytes(32).toString('base64url');const last=page.at(-1)!;await tx.query('INSERT INTO hs_data_query_cursors(token_hash,tenant_id,workspace_id,actor_id,scope_hash,last_name,last_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[sha(nextCursor),ctx.tenantId,ctx.workspaceId,ctx.actor.id,scope,last.name_search,last.id]);}
   return {lists:page.map(({name_search:_,...v})=>v),nextCursor};
  },async tx=>{await this.permission(tx,ctx);});
 }
}
