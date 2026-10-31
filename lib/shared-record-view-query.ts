import {z} from 'zod';
import {DocumentError} from './document';
import {typedRecordValue,type RecordField} from './shared-record-types';
const field=z.string().min(1).max(100);
const widgetLabel=z.string().trim().min(1).max(80).refine(value=>!/[\p{Cc}]/u.test(value));
const dashboardWidget=z.discriminatedUnion('metric',[
 z.object({id:z.string().uuid(),label:widgetLabel,metric:z.literal('count')}).strict(),
 z.object({id:z.string().uuid(),label:widgetLabel,metric:z.literal('sum'),field}).strict(),
 z.object({id:z.string().uuid(),label:widgetLabel,metric:z.literal('group'),field}).strict(),
]);
const presentation=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('table')}).strict(),
 z.object({kind:z.literal('board'),groupBy:field}).strict(),
 z.object({kind:z.literal('calendar'),dateField:field}).strict(),
 z.object({kind:z.literal('dashboard'),widgets:z.array(dashboardWidget).min(1).max(6)}).strict(),
]);
export const recordViewDefinition=z.object({
 columns:z.array(field).min(1).max(100),
 filters:z.array(z.object({field,operator:z.enum(['equal','contains','prefix','greater','less','in','includes','empty']),value:z.unknown().optional()}).strict()).max(12).default([]),
 sort:z.array(z.object({field,direction:z.enum(['asc','desc'])}).strict()).max(3).default([]),
 includeArchived:z.boolean().default(false),
 presentation:presentation.optional(),
}).strict();
export type RecordViewDefinition=z.output<typeof recordViewDefinition>;
export type DashboardWidget=Extract<RecordViewDefinition['presentation'],{kind:'dashboard'}>['widgets'][number];
export type DashboardMetricSource={key:string;kind:string};
export type BoardColumnRef={kind:'unassigned'}|{kind:'choice';value:string};
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
/** Select fields and single-select reference catalogues can group a board.
 * Multi-value fields, free text, and deprecated fields cannot. */
export function assertRecordBoard(def:RecordViewDefinition,fields:RecordField[]){
 const presentation=def.presentation;
 if(!presentation||presentation.kind!=='board')return;
 const group=fields.find(item=>item.key===presentation.groupBy);
 if(!group||group.deprecated||group.kind!=='single-select')throw invalid();
}
/** Dashboard metrics use only current permitted fields. Counts have no field.
 * Sums are numbers or number formulas. Groups are single selects. Deprecated,
 * restricted, currency and multi-value fields are a generic unavailable configuration. */
export function assertRecordDashboard(def:RecordViewDefinition,fields:RecordField[],calculated:DashboardMetricSource[]=[]){
 const presentation=def.presentation;
 if(!presentation||presentation.kind!=='dashboard')return;
 const ids=new Set<string>();
 for(const widget of presentation.widgets){
  if(ids.has(widget.id))throw invalid();
  ids.add(widget.id);
  if(widget.metric==='count')continue;
  if(widget.metric==='sum'){
   const stored=fields.find(item=>item.key===widget.field);
   if(stored){if(stored.deprecated||stored.kind!=='number')throw invalid();continue;}
   const derived=calculated.find(item=>item.key===widget.field);
   if(!derived||derived.kind!=='number')throw invalid();
   continue;
  }
  const group=fields.find(item=>item.key===widget.field);
  if(!group||group.deprecated||group.kind!=='single-select')throw invalid();
 }
}
/** True when a stored dashboard mentions a metric the caller cannot currently use.
 * The caller receives no field identity from this check. */
export function dashboardConfigurationBlocked(def:RecordViewDefinition,visibleKeys:Set<string>,fields:RecordField[],calculated:DashboardMetricSource[]){
 const presentation=def.presentation;
 if(!presentation||presentation.kind!=='dashboard')return false;
 const ids=new Set<string>();
 if(presentation.widgets.length>6)return true;
 for(const widget of presentation.widgets){
  if(!widget||typeof widget.id!=='string'||typeof widget.label!=='string'||typeof widget.metric!=='string'||ids.has(widget.id))return true;
  ids.add(widget.id);
  if(widget.metric==='count')continue;
  if(widget.metric==='group'){
   const group=fields.find(item=>item.key===widget.field);
   if(!visibleKeys.has(widget.field)||!group||group.deprecated||group.kind!=='single-select')return true;
   continue;
  }
  if(widget.metric!=='sum'||typeof widget.field!=='string')return true;
  const stored=fields.find(item=>item.key===widget.field);
  if(stored){if(!visibleKeys.has(widget.field)||stored.deprecated||stored.kind!=='number')return true;continue;}
  const derived=calculated.find(item=>item.key===widget.field);
  if(!derived||derived.kind!=='number')return true;
 }
 return false;
}
/** Field keys are parameters. Caller-supplied text is never SQL. */
export function dashboardSumExpression(fieldKey:string,values:unknown[]){
 values.push(fieldKey);const param='$'+values.length,text=`(r.field_values->>${param})`;
 return `COALESCE(SUM(CASE WHEN ${text} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN ${text}::numeric END),0)::text`;
}
export function dashboardGroupExpression(fieldKey:string,values:unknown[]){
 values.push(fieldKey);return `(r.field_values->>$${values.length})`;
}
/** A calendar is keyed by one current date field. Text, numbers, selects and deprecated fields cannot. */
export function assertRecordCalendar(def:RecordViewDefinition,fields:RecordField[]){
 const presentation=def.presentation;
 if(!presentation||presentation.kind!=='calendar')return;
 const dateField=fields.find(item=>item.key===presentation.dateField);
 if(!dateField||dateField.deprecated||dateField.kind!=='date')throw invalid();
}
export function calendarDate(value:string){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
 const parsed=new Date(`${value}T00:00:00Z`);
 if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value)return null;
 return value;
}
/** Inclusive calendar windows stay within one month grid. Invalid or inverted ranges are refused. */
export function calendarSpan(from:string,to:string){
 const start=calendarDate(from),end=calendarDate(to);
 if(!start||!end||start>end)return null;
 const days=Math.round((Date.parse(`${end}T00:00:00Z`)-Date.parse(`${start}T00:00:00Z`))/86400000)+1;
 if(days<1||days>42)return null;
 return {from:start,to:end,days};
}
/** Labels for select fields and reference catalogues. Codes and translations stay off this projection. */
export function referenceChoiceLabels(field:RecordField){
 if(field.deprecated||(field.kind!=='single-select'&&field.kind!=='multi-select'))return [];
 if(field.referenceList)return field.referenceList.items.filter(item=>!item.deprecated).map(item=>({id:item.id,label:item.label}));
 return field.choices.map(choice=>({id:choice,label:choice}));
}
/** Field keys and range bounds are parameters. Caller-supplied text is never SQL. */
export function bindCalendarDate(fieldKey:string,values:unknown[]){
 values.push(fieldKey);const param='$'+values.length;
 return {text:`(r.field_values->>${param})`,ordered:`(r.field_values->>${param}) COLLATE "C"`};
}
export function calendarRangePredicate(bound:{text:string;ordered:string},from:string,to:string,values:unknown[]){
 values.push(from,to);
 return `${bound.text} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND ${bound.ordered} >= $${values.length-1}::text AND ${bound.ordered} <= $${values.length}::text`;
}
export function calendarDateOrder(sort:{sql:string;cast:'text'|'numeric'|'boolean'|'uuid';direction:'asc'|'desc'}[],dateSql:string,alreadySorted:boolean){
 if(!alreadySorted)sort.unshift({sql:dateSql,cast:'text',direction:'asc'});
}
export function boardChoiceLabels(field:RecordField){
 if(field.kind!=='single-select'||field.deprecated)return [];
 if(field.referenceList)return field.referenceList.items.filter(item=>!item.deprecated).map(item=>({id:item.id,label:item.label}));
 return field.choices.map(choice=>({id:choice,label:choice}));
}
export function boardColumnKey(column:BoardColumnRef){return column.kind==='unassigned'?'unassigned':`choice:${encodeURIComponent(column.value)}`;}
export function parseBoardColumnKey(key:string):BoardColumnRef|null{
 if(key==='unassigned')return {kind:'unassigned'};
 if(!key.startsWith('choice:'))return null;
 let value='';
 try{value=decodeURIComponent(key.slice(7));}catch{return null;}
 if(!value||value.length>200)return null;
 return {kind:'choice',value};
}
/** Field keys and choice ids are parameters. Caller-supplied text is never SQL. */
export function boardColumnPredicate(fieldKey:string,column:BoardColumnRef,choiceIds:string[],values:unknown[]){
 values.push(fieldKey);const key='$'+values.length,text=`(r.field_values->>${key})`;
 if(column.kind==='choice'){values.push(column.value);return `${text} COLLATE "C" = $${values.length}::text`;}
 values.push(choiceIds);return `(${text} IS NULL OR ${text}='' OR NOT (${text}=ANY($${values.length}::text[])))`;
}
