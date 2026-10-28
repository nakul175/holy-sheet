import {z} from 'zod';

// Internal model only. Callers must first establish current tenant/list/field
// authority. This module neither grants access nor persists configuration.
const label=z.string().trim().min(1).max(200).refine(v=>!/[\p{Cc}]/u.test(v)).transform(v=>v.normalize('NFC'));
const code=z.string().regex(/^[A-Z][A-Z0-9_-]{0,63}$/);
const translation=z.record(z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/),label).refine(v=>Object.keys(v).length<=30);
const item=z.object({id:z.string().uuid(),code,label,order:z.number().int().min(0).max(1000000),deprecated:z.boolean(),translations:translation}).strict();
const definition=z.object({tenantId:z.string().uuid(),id:z.string().uuid(),version:z.number().int().positive(),name:label,items:z.array(item).max(1000)}).strict();
export type RecordReferenceList=z.infer<typeof definition>;
export class RecordReferenceListError extends Error {}
export function compileReferenceList(input:unknown):RecordReferenceList{
 const parsed=definition.safeParse(input);
 if(!parsed.success)throw new RecordReferenceListError('Review the bounded reference list definition.');
 const list=parsed.data;
 if(new Set(list.items.map(i=>i.id)).size!==list.items.length||new Set(list.items.map(i=>i.code)).size!==list.items.length)throw new RecordReferenceListError('Use distinct stable item IDs and codes.');
 return {...list,items:[...list.items].sort((a,b)=>a.order-b.order||(a.code<b.code?-1:a.code>b.code?1:0))};
}
/** All old identities remain reserved. Removal needs a separate qualified
 * dependency inventory and persistent transaction, neither implemented here. */
export function nextReferenceList(previous:RecordReferenceList,input:unknown):RecordReferenceList{
 const old=compileReferenceList(previous),next=compileReferenceList(input);
 if(next.id!==old.id||next.tenantId!==old.tenantId||next.version!==old.version+1)throw new RecordReferenceListError('Use the next version of the same tenant list.');
 const byId=new Map(next.items.map(i=>[i.id,i]));
 for(const prior of old.items){const current=byId.get(prior.id);if(!current||current.code!==prior.code)throw new RecordReferenceListError('Retain stable item identities and codes; deprecate unavailable choices.');}
 return next;
}
/** Explicit namespaces avoid a label that happens to equal another item's code.
 * Existing deprecated identities can render; all new selections reject them. */
export function resolveReferenceItem(list:RecordReferenceList,tenantId:string,lookup:{by:'id'|'code'|'label';value:string},newSelection=true):string{
 list=compileReferenceList(list);
 if(tenantId!==list.tenantId)throw new RecordReferenceListError('Reference value is unavailable.');
 if(!lookup||!['id','code','label'].includes(lookup.by)||typeof lookup.value!=='string')throw new RecordReferenceListError('Reference value is unavailable.');
 const value=lookup.by==='label'?lookup.value.trim().normalize('NFC'):lookup.value;
 const matches=list.items.filter(i=>i[lookup.by]===value);
 // Include deprecated matches when checking ambiguity: silently dropping one
 // would remap a historical label to a different identity during import.
 if(matches.length!==1||newSelection&&matches[0].deprecated)throw new RecordReferenceListError('Reference value is unavailable or ambiguous.');
 return matches[0].id;
}
