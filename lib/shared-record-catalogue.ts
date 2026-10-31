import {z} from 'zod';
import {compileReferenceList} from './record-reference-list';
import {DocumentError} from './document';
import {SharedRecordRepository,type RecordContext} from './shared-records';
import {standardRecordFields,type FieldKind,type RecordField} from './shared-record-types';
import type {Sql} from './database';

const collectionKey=z.string().min(1).max(100);
const unavailable=()=>new DocumentError('Record is restricted or unavailable.','record_not_found',404);
const invalid=()=>new DocumentError('Review the catalogue request.','record_catalogue_validation',400);

type CatalogueCollection={id:string;name:string;core:boolean;deprecated:boolean;version:number;description:string};
type CatalogueItem={id:string;label:string;deprecated:boolean};
type CatalogueReference={id:string;name:string;version:number;items:CatalogueItem[]};
export type CatalogueField={key:string;label:string;kind:FieldKind;required:boolean;sensitive:boolean;deprecated:boolean;core:boolean;version:number;choices:string[];referenceListId?:string;referenceList?:CatalogueReference};
type FieldRow={field_key:string;label:string;kind:FieldKind;required:boolean;choices:unknown;sensitive:boolean;deprecated:boolean;version:number|string;reference_list_id:string|null};
type CollectionRow={id:string;name:string;core:boolean;deprecated:boolean;version:number|string;description:string|null};

/** Browsable collection and field definitions for a member with collection view.
 * Every read rechecks the current grant. Schema changes stay on SharedRecordSchemaRepository. */
export class SharedRecordCatalogueRepository extends SharedRecordRepository {
 async listCatalogue(ctx:RecordContext){
  return this.transaction(ctx,async(tx,tenant)=>{
   const rows=await tx.query<CollectionRow>(`SELECT c.id,c.name,c.core,c.deprecated,c.version,s.description FROM hs_data_collections c LEFT JOIN hs_data_collection_settings s ON s.tenant_id=c.tenant_id AND s.collection=c.id WHERE c.tenant_id=$1 AND s.removed_at IS NULL AND EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=c.tenant_id AND g.collection=c.id AND g.user_id=$2 AND 'view'=ANY(g.capabilities)) ORDER BY c.name_search COLLATE "C",c.id LIMIT 206`,[ctx.tenantId,ctx.actor.id]);
   return {schemaVersion:tenant.schema_version,collections:rows.rows.slice(0,205).map(collectionOf),truncated:rows.rows.length>205};
  });
 }
 async describeCatalogue(ctx:RecordContext,key:string){
  if(!collectionKey.safeParse(key).success)throw invalid();
  return this.transaction(ctx,async(tx,tenant)=>{
   const caps=await this.collectionCaps(tx,ctx,key);
   if(!caps.includes('view'))throw unavailable();
   const collection=await this.collection(tx,ctx,key);
   const rows=await tx.query<FieldRow>('SELECT field_key,label,kind,required,choices,sensitive,deprecated,version,reference_list_id FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 ORDER BY field_key',[ctx.tenantId,key]);
   const custom=rows.rows.map(fieldOf);
   const visible:RecordField[]=[];
   for(const field of [...standardRecordFields(key),...custom])if(await this.fieldAllowed(tx,ctx,key,field,'view'))visible.push(field);
   const references=await this.references(tx,ctx,visible);
   return {schemaVersion:tenant.schema_version,collection,fields:visible.map(field=>project(field,references.get(field.referenceListId??'')))};
  });
 }
 private async collection(tx:Sql,ctx:RecordContext,key:string){
  const row=(await tx.query<CollectionRow>('SELECT c.id,c.name,c.core,c.deprecated,c.version,s.description FROM hs_data_collections c LEFT JOIN hs_data_collection_settings s ON s.tenant_id=c.tenant_id AND s.collection=c.id WHERE c.tenant_id=$1 AND c.id=$2 AND s.removed_at IS NULL',[ctx.tenantId,key])).rows[0];
  if(!row)throw unavailable();
  return collectionOf(row);
 }
 private async references(tx:Sql,ctx:RecordContext,fields:RecordField[]){
  const ids=[...new Set(fields.flatMap(field=>field.referenceListId?[field.referenceListId]:[]))];
  const found=new Map<string,CatalogueReference>();
  if(!ids.length)return found;
  const permission=await tx.query<{can_read:boolean}>('SELECT can_read FROM hs_data_reference_list_permissions WHERE tenant_id=$1 AND user_id=$2',[ctx.tenantId,ctx.actor.id]);
  if(!permission.rows[0]?.can_read)return found;
  const rows=await tx.query<{id:string;version:number|string;definition:unknown}>('SELECT id,version,definition FROM hs_data_reference_lists WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[ctx.tenantId,ids]);
  for(const row of rows.rows){
   const binding=referenceOf(row.definition,ctx.tenantId,row.id,Number(row.version));
   if(binding)found.set(binding.id,binding);
  }
  return found;
 }
}

function collectionOf(row:CollectionRow):CatalogueCollection{
 return {id:row.id,name:row.name,core:row.core,deprecated:row.deprecated,version:Number(row.version),description:typeof row.description==='string'?row.description:''};
}
function choicesOf(value:unknown){const parsed=typeof value==='string'?parsedJson(value):value;return Array.isArray(parsed)?parsed.filter((item):item is string=>typeof item==='string'):[];}
function parsedJson(value:string){try{return JSON.parse(value);}catch{return [];}}
function fieldOf(row:FieldRow):RecordField{
 return {key:row.field_key,label:row.label,kind:row.kind,required:row.required,choices:row.reference_list_id?[]:choicesOf(row.choices),...(row.reference_list_id?{referenceListId:row.reference_list_id}:{}),sensitive:row.sensitive,unique:false,deprecated:row.deprecated,core:false,version:Number(row.version)};
}
function referenceOf(definition:unknown,tenantId:string,id:string,version:number):CatalogueReference|undefined{
 try{
  const list=compileReferenceList(typeof definition==='string'?JSON.parse(definition):definition);
  if(list.tenantId!==tenantId||list.id!==id||list.version!==version)return;
  return {id:list.id,name:list.name,version:list.version,items:list.items.map(item=>({id:item.id,label:item.label,deprecated:item.deprecated}))};
 }catch{return;}
}
function project(field:RecordField,reference?:CatalogueReference):CatalogueField{
 const shown=reference&&reference.id===field.referenceListId?reference:undefined;
 return {key:field.key,label:field.label,kind:field.kind,required:field.required,sensitive:field.sensitive,deprecated:field.deprecated,core:field.core,version:field.version,choices:shown?[]:field.choices,...(shown?{referenceListId:shown.id,referenceList:shown}:{})};
}
