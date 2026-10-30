import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {resolveRecordReferenceFields} from './record-reference-fields';
import {DocumentError} from './document';
import {SharedRecordRepository,type RecordContext} from './shared-records';
import {recordHash,recordWhitespaceSql,standardRecordFields,typedRecordValue,type RecordField} from './shared-record-types';
import {editableLayoutField,type RecordLayoutDefinition} from './record-layout-definition';
import type {Sql} from './database';
const uuid=z.string().uuid();
export const recordFieldDefinition=z.object({
 label:z.string().trim().min(1).max(100).refine(v=>!/[\p{Cc}]/u.test(v)),
 kind:z.enum(['text','long-text','number','currency','date','boolean','single-select','multi-select','email','phone','url','attachment','record']),
 required:z.boolean().default(false),defaultValue:z.unknown().optional(),choices:z.array(z.string().trim().min(1).max(100).refine(v=>!/[\p{Cc}]/u.test(v))).max(100).default([]),
 referenceListId:uuid.optional(),sensitive:z.boolean().default(false),unique:z.boolean().default(false),deprecated:z.boolean().default(false),
}).strict();
const definition=recordFieldDefinition;
const prepare=z.object({prepareId:uuid,collection:z.string().min(1).max(100),fieldKey:uuid.optional(),expectedSchemaVersion:z.number().int().positive(),definition}).strict();
const apply=z.object({previewId:uuid,operationId:uuid,reviewHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type SchemaPrepare=z.input<typeof prepare>;
type Revisions={schema_version:number;policy_version:number;data_revision:string|number;dependency_revision:string|number};
type Impact={recordCount:number;populatedCount:number;missingCount:number;duplicateValues:number;dependencies:{kind:string;label:string;version:number}[];blockers:string[];changes:string[];defaultBehavior:string};
type Preview={id:string;tenant_id:string;actor_id:string;workspace_id:string;collection:string;field_key:string;proposed:RecordField;review_hash:string;schema_version:number;policy_version:number;data_revision:string|number;dependency_revision:string|number;authority_revision:string;before_schema:RecordField|null;impact:Impact;expires_at:string;request_hash:string};
const fail=(message:string,code='record_schema_conflict',status=409)=>new DocumentError(message,code,status);
export function makeRecordField(input:unknown,key:string,version=1,reference?:RecordField['referenceList'],historicalDefault=false):RecordField {
 const parsed=definition.safeParse(input);if(!parsed.success)throw fail('Review the custom-field definition.','record_schema_validation',400);
 const proposed:RecordField={...parsed.data,key,core:false,version};
 const select=['single-select','multi-select'].includes(proposed.kind);
 if(proposed.referenceListId){
  if(!select||proposed.choices.length)throw fail('Bind reference lists to select fields without inline choices.','record_schema_validation',400);
  if(!reference||reference.id!==proposed.referenceListId)throw fail('Resolve the current permitted reference list first.','record_reference_unavailable',503);
  proposed.referenceList=reference;proposed.choices=reference.items.map(i=>i.id);
 }else if(new Set(proposed.choices).size!==proposed.choices.length||(select?!proposed.choices.length:!!proposed.choices.length))throw fail('Use distinct choices for select fields only.','record_schema_validation',400);
 if(proposed.defaultValue!==undefined)proposed.defaultValue=typedRecordValue(proposed,proposed.defaultValue,{historical:historicalDefault});
 if(['attachment','record'].includes(proposed.kind)&&proposed.defaultValue!==undefined&&proposed.defaultValue!==null)throw fail('Reference defaults require a qualified reference-policy adapter.','record_reference_unavailable',503);
 return proposed;
}
/** Resolve trusted current catalogue metadata before constructing a field.
 * historicalDefault is only for reconstructing an existing retry's identity;
 * callers must validate defaults normally before committing a fresh command. */
export async function prepareRecordField(tx:Sql,ctx:RecordContext,input:unknown,key:string,version=1,historicalDefault=false){
 const parsed=definition.safeParse(input);if(!parsed.success)throw fail('Review the custom-field definition.','record_schema_validation',400);
 const d=parsed.data,reference=d.referenceListId?(await resolveRecordReferenceFields(tx,ctx,[{...d,key,core:false,version}]))[0].referenceList:undefined;
 return makeRecordField(d,key,version,reference,historicalDefault);
}
export class SharedRecordSchemaRepository extends SharedRecordRepository {
 private async permission(tx:Sql,ctx:RecordContext,key:string,admin:boolean){
  if(!admin||!(await this.collectionCaps(tx,ctx,key)).includes('schema'))throw fail('Tenant administrator and schema permission are required.','record_schema_forbidden',403);
 }
 private async revisions(tx:Sql,ctx:RecordContext){return (await tx.query<Revisions>('SELECT schema_version,policy_version,data_revision,dependency_revision FROM hs_data_tenants WHERE id=$1',[ctx.tenantId])).rows[0];}
 private catalogueField(field:RecordField){return {key:field.key,label:field.label,kind:field.kind,required:field.required,...(field.defaultValue!==undefined?{defaultValue:field.defaultValue}:{}),choices:field.referenceListId?[]:field.choices,...(field.referenceListId?{referenceListId:field.referenceListId}:{}),sensitive:field.sensitive,unique:field.unique,deprecated:field.deprecated,core:field.core,version:field.version};}
 async describeSchema(ctx:RecordContext,collectionKey:string){
  if(!z.string().min(1).max(100).safeParse(collectionKey).success)throw fail('Review the schema request.','record_schema_validation',400);
  return this.transaction(ctx,async(tx,t,proof)=>{
   await this.permission(tx,ctx,collectionKey,proof.tenantAdministrator);
   const rows=await tx.query<{field_key:string;label:string;kind:RecordField['kind'];required:boolean;default_value:unknown;choices:unknown;sensitive:boolean;unique_value:boolean;deprecated:boolean;version:number;reference_list_id:string|null}>('SELECT field_key,label,kind,required,default_value,choices,sensitive,unique_value,deprecated,version,reference_list_id FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 ORDER BY field_key',[ctx.tenantId,collectionKey]);
   const custom=rows.rows.map(row=>this.catalogueField({key:row.field_key,label:row.label,kind:row.kind,required:row.required,...(row.default_value!==null&&row.default_value!==undefined?{defaultValue:row.default_value}:{}),choices:Array.isArray(row.choices)?row.choices.filter((item):item is string=>typeof item==='string'):[],...(row.reference_list_id?{referenceListId:row.reference_list_id}:{}),sensitive:row.sensitive,unique:row.unique_value,deprecated:row.deprecated,core:false,version:Number(row.version)}));
   return {schemaVersion:t.schema_version,canManage:true,customFieldCount:custom.length,limits:{maxFields:100,maxChoices:100},fields:[...standardRecordFields(collectionKey).map(field=>this.catalogueField(field)),...custom]};
  });
 }
 private visiblePreview(p:Preview){return {previewId:p.id,collection:p.collection,fieldKey:p.field_key,proposed:p.proposed,reviewHash:p.review_hash,schemaVersion:p.schema_version,impact:p.impact,expiresAt:new Date(p.expires_at).toISOString()};}
 async previewSchema(ctx:RecordContext,input:SchemaPrepare){
  const parsed=prepare.safeParse(input);if(!parsed.success)throw fail('Review the custom-field definition.','record_schema_validation',400);
  const c=parsed.data,requestHash=recordHash(c);
  return this.transaction(ctx,async(tx,_t,proof)=>{
   await this.permission(tx,ctx,c.collection,proof.tenantAdministrator);
   const prior=(await tx.query<Preview>('SELECT * FROM hs_data_schema_previews WHERE tenant_id=$1 AND actor_id=$2 AND prepare_id=$3',[ctx.tenantId,ctx.actor.id,c.prepareId])).rows[0];
   if(prior){if(prior.request_hash!==requestHash||prior.workspace_id!==ctx.workspaceId)throw fail('Preview identity was reused with different input.','operation_mismatch');if(new Date(prior.expires_at).getTime()<=Date.now())throw fail('The schema preview expired. Prepare it again.','schema_preview_expired',410);return this.visiblePreview(prior);}
   const rev=await this.revisions(tx,ctx);if(rev.schema_version!==c.expectedSchemaVersion)throw fail('The schema changed. Review the current definition.');
   const fields=await this.fields(tx,ctx,c.collection),before=c.fieldKey?fields.find(f=>f.key===c.fieldKey):undefined;
   if(c.fieldKey&&!before)throw fail('The custom field is unavailable.','schema_field_unavailable',404);
   if(!before&&fields.filter(f=>!f.core).length>=100)throw fail('A collection supports at most 100 custom fields.','schema_field_limit',400);
   const fieldKey=before?.key??randomUUID();
   const proposed=await prepareRecordField(tx,ctx,c.definition,fieldKey,(before?.version??0)+1);
   const stats=(await tx.query<{total:string;populated:string;missing:string}>(`SELECT count(*)::text AS total,count(*) FILTER(WHERE field_values ? $3 AND field_values->$3 <> 'null'::jsonb AND field_values->$3 <> '""'::jsonb AND field_values->$3 <> '[]'::jsonb AND NOT(jsonb_typeof(field_values->$3)='string' AND btrim(field_values->>$3,${recordWhitespaceSql})=''))::text AS populated,count(*) FILTER(WHERE NOT(field_values ? $3) OR field_values->$3 = 'null'::jsonb OR field_values->$3 = '""'::jsonb OR field_values->$3 = '[]'::jsonb OR (jsonb_typeof(field_values->$3)='string' AND btrim(field_values->>$3,${recordWhitespaceSql})=''))::text AS missing FROM hs_data_records WHERE tenant_id=$1 AND collection=$2`,[ctx.tenantId,c.collection,proposed.key])).rows[0];
   const dependencies=before?(await tx.query<{kind:string;label:string;version:number}>('SELECT kind,label,version FROM hs_data_schema_dependencies WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 AND active=true ORDER BY id LIMIT 201',[ctx.tenantId,c.collection,proposed.key])).rows:[];
   const impact:Impact={recordCount:Number(stats.total),populatedCount:Number(stats.populated),missingCount:Number(stats.missing),duplicateValues:0,dependencies:dependencies.slice(0,200),blockers:[],changes:[],defaultBehavior:'Defaults apply to future creates only. Existing records are not rewritten.'};
   const properties=['label','kind','required','defaultValue','choices','referenceListId','sensitive','unique','deprecated'] as const;
   for(const property of properties)if(!before||recordHash(before[property]??null)!==recordHash(proposed[property]??null))impact.changes.push(property);
   const incompatible=!!before&&(before.referenceListId!==proposed.referenceListId||before.kind!==proposed.kind||before.choices.some(v=>!proposed.choices.includes(v))||!before.deprecated&&proposed.deprecated||!before.required&&proposed.required||!before.unique&&proposed.unique);
   if(before&&before.referenceListId!==proposed.referenceListId&&impact.populatedCount)impact.blockers.push('Populated values require a separately reviewed reference-list conversion.');
   if(before?.sensitive&&!proposed.sensitive)impact.blockers.push('Sensitive classification cannot be lowered through this workflow.');
   if(before&&before.kind!==proposed.kind&&impact.populatedCount)impact.blockers.push('Populated values require a separately reviewed conversion.');
   if(before&&before.choices.some(v=>!proposed.choices.includes(v))&&impact.populatedCount)impact.blockers.push('Existing select values must be resolved before choices are removed.');
   if(proposed.required&&!before?.required&&impact.missingCount)impact.blockers.push('Existing records have missing values. Backfill them through permitted record edits first.');
   if(incompatible&&dependencies.length)impact.blockers.push('Resolve the listed views, import mappings or integrations before this change.');
   if(dependencies.length>200)impact.blockers.push('Too many dependencies for this bounded review.');
   if(proposed.required&&!proposed.deprecated){const layout=(await tx.query<{definition:RecordLayoutDefinition}>('SELECT v.definition FROM hs_data_layouts l JOIN hs_data_layout_versions v ON v.tenant_id=l.tenant_id AND v.collection=l.collection AND v.version=l.published_version WHERE l.tenant_id=$1 AND l.collection=$2',[ctx.tenantId,c.collection])).rows[0];if(layout&&!editableLayoutField(layout.definition,proposed.key))impact.blockers.push('Place the optional field in the published editable layout before making it required.');}
   if(proposed.deprecated&&proposed.required)impact.blockers.push('A deprecated field cannot remain required for new records.');
   if(proposed.unique&&!before?.unique&&impact.populatedCount>5000)impact.blockers.push('Uniqueness backfill above 5,000 populated records requires a separately qualified bounded migration.');
   if(proposed.unique){const duplicates=await tx.query<{n:string}>(`SELECT count(*)::text AS n FROM (SELECT field_values->$3 AS v FROM hs_data_records WHERE tenant_id=$1 AND collection=$2 AND state<>'trashed' AND merged_into_id IS NULL AND field_values ? $3 AND field_values->$3 <> 'null'::jsonb AND field_values->$3 <> '""'::jsonb AND field_values->$3 <> '[]'::jsonb AND NOT(jsonb_typeof(field_values->$3)='string' AND btrim(field_values->>$3,${recordWhitespaceSql})='') GROUP BY field_values->$3 HAVING count(*)>1) q`,[ctx.tenantId,c.collection,proposed.key]);impact.duplicateValues=Number(duplicates.rows[0].n);if(impact.duplicateValues)impact.blockers.push('Resolve duplicate values before enabling uniqueness.');}
   const previewId=randomUUID(),reviewHash=recordHash({proposed,before:before??null,impact,rev,authority:proof.revision});
   await tx.query('INSERT INTO hs_data_schema_previews(id,tenant_id,actor_id,workspace_id,prepare_id,request_hash,collection,field_key,proposed,review_hash,schema_version,policy_version,data_revision,dependency_revision,authority_revision,before_schema,impact) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',[previewId,ctx.tenantId,ctx.actor.id,ctx.workspaceId,c.prepareId,requestHash,c.collection,proposed.key,JSON.stringify(proposed),reviewHash,rev.schema_version,rev.policy_version,rev.data_revision,rev.dependency_revision,proof.revision,before?JSON.stringify(before):null,JSON.stringify(impact)]);
   return this.visiblePreview((await tx.query<Preview>('SELECT * FROM hs_data_schema_previews WHERE id=$1',[previewId])).rows[0]);
  });
 }
 async applySchema(ctx:RecordContext,input:z.input<typeof apply>){
  const parsed=apply.safeParse(input);if(!parsed.success)throw fail('Invalid schema approval.','record_schema_validation',400);const c=parsed.data,requestHash=recordHash(c);
  return this.transaction(ctx,async(tx,_t,proof)=>{
   const prior=(await tx.query<{request_hash:string;collection:string;field_key:string;applied_schema_version:number}>('SELECT * FROM hs_data_schema_operations WHERE tenant_id=$1 AND actor_id=$2 AND operation_id=$3',[ctx.tenantId,ctx.actor.id,c.operationId])).rows[0];
   if(prior){await this.permission(tx,ctx,prior.collection,proof.tenantAdministrator);if(prior.request_hash!==requestHash)throw fail('Operation identity was reused.','operation_mismatch');return {fieldKey:prior.field_key,appliedSchemaVersion:prior.applied_schema_version,currentSchemaVersion:(await this.revisions(tx,ctx)).schema_version,replayed:true};}
   const p=(await tx.query<Preview>('SELECT * FROM hs_data_schema_previews WHERE id=$1 AND tenant_id=$2 AND actor_id=$3 AND workspace_id=$4',[c.previewId,ctx.tenantId,ctx.actor.id,ctx.workspaceId])).rows[0];
   if(!p)throw fail('The schema preview is unavailable.','schema_preview_unavailable',404);await this.permission(tx,ctx,p.collection,proof.tenantAdministrator);
   if(new Date(p.expires_at).getTime()<=Date.now())throw fail('The schema preview expired.','schema_preview_expired',410);
   const rev=await this.revisions(tx,ctx);
   if(p.review_hash!==c.reviewHash||p.authority_revision!==proof.revision||rev.schema_version!==p.schema_version||rev.policy_version!==p.policy_version||String(rev.data_revision)!==String(p.data_revision)||String(rev.dependency_revision)!==String(p.dependency_revision))throw fail('The reviewed schema, data, dependencies or authority changed. Prepare another preview.');
   if(p.impact.blockers.length)throw fail('Resolve the schema preview blockers before applying.','schema_change_blocked');
   const f=p.proposed;
   if(f.referenceListId){const current=(await resolveRecordReferenceFields(tx,ctx,[f]))[0];if(recordHash(current.referenceList)!==recordHash(f.referenceList))throw fail('The reference list changed. Prepare another schema preview.');if(f.defaultValue!==undefined)typedRecordValue(current,f.defaultValue);}
   await tx.query('INSERT INTO hs_data_fields(tenant_id,collection,field_key,label,kind,required,default_value,choices,sensitive,unique_value,deprecated,version,created_by,reference_list_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(tenant_id,collection,field_key) DO UPDATE SET label=EXCLUDED.label,kind=EXCLUDED.kind,required=EXCLUDED.required,default_value=EXCLUDED.default_value,choices=EXCLUDED.choices,sensitive=EXCLUDED.sensitive,unique_value=EXCLUDED.unique_value,deprecated=EXCLUDED.deprecated,version=EXCLUDED.version,reference_list_id=EXCLUDED.reference_list_id',[ctx.tenantId,p.collection,f.key,f.label,f.kind,f.required,f.defaultValue===undefined?null:JSON.stringify(f.defaultValue),JSON.stringify(f.referenceListId?[]:f.choices),f.sensitive,f.unique,f.deprecated,f.version,ctx.actor.id,f.referenceListId??null]);
   if(f.unique!==!!p.before_schema?.unique){await tx.query('DELETE FROM hs_data_unique_values WHERE tenant_id=$1 AND collection=$2 AND field_key=$3',[ctx.tenantId,p.collection,f.key]);
   if(f.unique){const rows=await tx.query<{id:string;value:unknown}>(`SELECT id,field_values->$3 AS value FROM hs_data_records WHERE tenant_id=$1 AND collection=$2 AND state<>'trashed' AND merged_into_id IS NULL AND field_values ? $3 AND field_values->$3 <> 'null'::jsonb AND field_values->$3 <> '""'::jsonb AND field_values->$3 <> '[]'::jsonb AND NOT(jsonb_typeof(field_values->$3)='string' AND btrim(field_values->>$3,${recordWhitespaceSql})='')`,[ctx.tenantId,p.collection,f.key]);for(const r of rows.rows)await tx.query('INSERT INTO hs_data_unique_values(tenant_id,collection,field_key,value_hash,record_id) VALUES($1,$2,$3,$4,$5)',[ctx.tenantId,p.collection,f.key,recordHash(r.value),r.id]);}
   }
   const next=rev.schema_version+1;await tx.query('UPDATE hs_data_tenants SET schema_version=$2 WHERE id=$1',[ctx.tenantId,next]);
   await tx.query('INSERT INTO hs_data_schema_versions(tenant_id,collection,field_key,version,schema_version,definition,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,p.collection,f.key,f.version,next,JSON.stringify(f),ctx.actor.id,c.operationId]);
   await tx.query('INSERT INTO hs_data_schema_operations(tenant_id,actor_id,operation_id,request_hash,preview_id,collection,field_key,applied_schema_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[ctx.tenantId,ctx.actor.id,c.operationId,requestHash,p.id,p.collection,f.key,next]);
   await tx.query('INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)',[randomUUID(),ctx.actor.id,'shared-record.schema',JSON.stringify({tenantId:ctx.tenantId,collection:p.collection,fieldKey:f.key,schemaVersion:next}),c.operationId]);
   return {fieldKey:f.key,appliedSchemaVersion:next,currentSchemaVersion:next,replayed:false};
  });
 }
}
