import type {Sql} from './database';
import type {RecordContext} from './shared-records';
import type {RecordField} from './shared-record-types';
import {compileReferenceList} from './record-reference-list';
import {DocumentError} from './document';

/** Called only within the record repository's current-authority transaction.
 * Resolve fresh catalogue metadata; never copy labels into stored values. */
export async function resolveRecordReferenceFields(tx:Sql,ctx:RecordContext,fields:RecordField[]):Promise<RecordField[]>{
 const ids=[...new Set(fields.flatMap(f=>f.referenceListId?[f.referenceListId]:[]))];
 if(!ids.length)return fields;
 const permission=await tx.query<{can_read:boolean}>('SELECT can_read FROM hs_data_reference_list_permissions WHERE tenant_id=$1 AND user_id=$2 FOR SHARE',[ctx.tenantId,ctx.actor.id]);
 if(!permission.rows[0]?.can_read)throw new DocumentError('Reference choices are restricted or unavailable.','record_reference_list_forbidden',403);
 const rows=await tx.query<{id:string;version:number;definition:unknown}>('SELECT id,version,definition FROM hs_data_reference_lists WHERE tenant_id=$1 AND id=ANY($2::uuid[]) FOR SHARE',[ctx.tenantId,ids]);
 const lists=new Map(rows.rows.map(row=>{
  let list;try{list=compileReferenceList(row.definition);}catch{throw new DocumentError('Reference choices require review.','record_reference_unavailable',503);}
  if(list.tenantId!==ctx.tenantId||list.id!==row.id||list.version!==row.version)throw new DocumentError('Reference choices require review.','record_reference_unavailable',503);
  return [list.id,list] as const;
 }));
 return fields.map(field=>{
  if(!field.referenceListId)return field;
  const list=lists.get(field.referenceListId);
  if(!list||!['single-select','multi-select'].includes(field.kind))throw new DocumentError('Reference choices are restricted or unavailable.','record_reference_unavailable',503);
  return {...field,choices:list.items.map(i=>i.id),referenceList:{id:list.id,version:list.version,items:list.items.map(({order:_,...item})=>item)}};
 });
}

/** Labels for a catalogue already resolved in the current-authority transaction.
 * Item IDs stay the stored values; codes and translations stay off this projection. */
export function referenceChoices(field:Pick<RecordField,'referenceList'>):{id:string;label:string;deprecated:boolean}[]|undefined{
 if(!field.referenceList)return undefined;
 return field.referenceList.items.map(({id,label,deprecated})=>({id,label,deprecated}));
}
