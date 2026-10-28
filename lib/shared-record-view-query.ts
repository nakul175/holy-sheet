import {z} from 'zod';
import {DocumentError} from './document';
import {typedRecordValue,type RecordField} from './shared-record-types';
const field=z.string().min(1).max(100);
export const recordViewDefinition=z.object({
 columns:z.array(field).min(1).max(100),
 filters:z.array(z.object({field,operator:z.enum(['equal','contains','prefix','greater','less','in','includes','empty']),value:z.unknown().optional()}).strict()).max(12).default([]),
 sort:z.array(z.object({field,direction:z.enum(['asc','desc'])}).strict()).max(3).default([]),
 includeArchived:z.boolean().default(false),
}).strict();
export type RecordViewDefinition=z.output<typeof recordViewDefinition>;
type SortExpression={sql:string;cast:'text'|'numeric'|'boolean'|'uuid';direction:'asc'|'desc'};
const invalid=()=>new DocumentError('A view field, filter or sort is unavailable.','record_view_validation',400);
const pattern=(v:string)=>v.replace(/[\\%_]/g,'\\$&');
/** All field identities, operators, casts and order directions are validated here.
 * SQL values and JSON keys use parameters. No caller-supplied SQL is interpolated. */
export function compileRecordView(def:RecordViewDefinition,fields:RecordField[],startValues:unknown[]=[]){
 const values=[...startValues],bind=(value:unknown)=>{values.push(value);return '$'+values.length;};
 const known=new Map(fields.map(f=>[f.key,f]));
 for(const key of [...def.columns,...def.filters.map(f=>f.field),...def.sort.map(s=>s.field)])if(key!=='name'&&!known.has(key))throw invalid();
 if(new Set(def.columns).size!==def.columns.length||new Set(def.sort.map(s=>s.field)).size!==def.sort.length)throw invalid();
 const expression=(key:string):{sql:string;cast:SortExpression['cast'];kind:string;definition?:RecordField;jsonSql?:string}=>{
  if(key==='name')return {sql:'r.name COLLATE "C"',cast:'text',kind:'text'};
  const f=known.get(key);if(!f)throw invalid();const keyParam=bind(key),jsonSql=`r.field_values->${keyParam}`;
  if(f.kind==='number')return {sql:`(r.field_values->>${keyParam})::numeric`,cast:'numeric',kind:f.kind,definition:f,jsonSql};
  if(f.kind==='boolean')return {sql:`(r.field_values->>${keyParam})::boolean`,cast:'boolean',kind:f.kind,definition:f,jsonSql};
  return {sql:`(r.field_values->>${keyParam}) COLLATE "C"`,cast:'text',kind:f.kind,definition:f,jsonSql};
 };
 const predicates:string[]=[];
 for(const f of def.filters){
  const e=expression(f.field),base=e.definition;
  if(f.operator==='empty'){if(f.value!==undefined)throw invalid();predicates.push(`(${e.sql} IS NULL OR ${e.sql}::text='')`);continue;}
  if(f.operator==='contains'||f.operator==='prefix'){
   if(!['text','long-text','email','phone','url'].includes(e.kind)||typeof f.value!=='string'||f.value.length>200)throw invalid();
   const text=pattern(f.value);predicates.push(`${e.sql} ILIKE ${bind((f.operator==='contains'?'%':'')+text+'%')} ESCAPE '\\'`);continue;
  }
  if(f.operator==='in'){
   if(!['single-select','text','email','phone','date'].includes(e.kind)||!Array.isArray(f.value)||!f.value.length||f.value.length>100)throw invalid();
   const list=f.value.map(v=>base?typedRecordValue(base,v,{historical:true}):typeof v==='string'&&v.length<=200?v:(()=>{throw invalid();})());predicates.push(`${e.sql}=ANY(${bind(list)}::text[])`);continue;
  }
  if(f.operator==='includes'){
   if(!base||!['multi-select','record','attachment'].includes(base.kind)||typeof f.value!=='string')throw invalid();
   if(base.kind==='multi-select'?!base.choices.includes(f.value):!z.string().uuid().safeParse(f.value).success)throw invalid();
   predicates.push(`(${e.jsonSql}) @> ${bind(JSON.stringify([f.value]))}::jsonb`);continue;
  }
  if(['currency','attachment','record','multi-select'].includes(e.kind))throw invalid();
  if((f.operator==='greater'||f.operator==='less')&&!['number','date'].includes(e.kind))throw invalid();
  if(f.value===null||f.value===undefined)throw invalid();
  const value=base?typedRecordValue(base,f.value,{historical:true}):typeof f.value==='string'&&f.value.length<=200?f.value:(()=>{throw invalid();})();
  const op=f.operator==='equal'?'=':f.operator==='greater'?'>':'<';predicates.push(`${e.sql}${op}${bind(value)}::${e.cast}`);
 }
 const sort:SortExpression[]=[];
 for(const item of def.sort.length?def.sort:[{field:'name',direction:'asc' as const}]){
  const e=expression(item.field);if(['currency','attachment','record','multi-select','long-text'].includes(e.kind))throw invalid();sort.push({...e,direction:item.direction});
 }
 sort.push({sql:'r.id',cast:'uuid',direction:'asc'});
 return {values,predicates,sort};
}
export function recordViewKeyset(sort:SortExpression[],last:unknown[],values:unknown[]){
 if(last.length!==sort.length)throw new DocumentError('The view cursor is invalid.','record_view_cursor_invalid',400);
 const branches:string[]=[],prefix:string[]=[];
 for(let i=0;i<sort.length;i++){
  const s=sort[i],v=last[i];if(v!==null&&(typeof v!=='string'&&typeof v!=='number'&&typeof v!=='boolean'))throw new DocumentError('The view cursor is invalid.','record_view_cursor_invalid',400);
  values.push(v);const p='$'+values.length+'::'+s.cast;
  const after=v===null?'false':`(${s.sql}${s.direction==='asc'?'>':'<'}${p} OR ${s.sql} IS NULL)`;
  branches.push('('+[...prefix,after].join(' AND ')+')');prefix.push(`${s.sql} IS NOT DISTINCT FROM ${p}`);
 }
 return '('+branches.join(' OR ')+')';
}
