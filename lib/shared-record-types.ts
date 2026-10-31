import {z} from 'zod';
import {DocumentError,stableStringify} from './document';
import {createHash} from 'node:crypto';
export const standardCollections=['organisations','accounts','contacts','employees','contracts'] as const;
export type StandardCollection=typeof standardCollections[number];
export const recordCapabilities=['view','create','edit','link','import','export','bulk','archive','delete','restore','merge','schema','manage-views','history','restore-values','manage-templates','manage-permissions','manage-forms'] as const;
export type RecordCapability=typeof recordCapabilities[number];
/** Record grants cannot invent collection administration. Matches the record-grant check. */
export const recordGrantCapabilities=['view','edit','link','import','export','bulk','archive','delete','restore','merge','history','restore-values'] as const;
export type RecordGrantCapability=typeof recordGrantCapabilities[number];
export type FieldKind='text'|'long-text'|'number'|'currency'|'date'|'boolean'|'single-select'|'multi-select'|'email'|'phone'|'url'|'attachment'|'record';
export type RecordField={key:string;label:string;kind:FieldKind;required:boolean;defaultValue?:unknown;choices:string[];referenceListId?:string;referenceList?:{id:string;version:number;items:{id:string;code:string;label:string;deprecated:boolean;translations:Record<string,string>}[]};sensitive:boolean;unique:boolean;deprecated:boolean;core:boolean;version:number};
export function recordValueEmpty(value:unknown){return value===undefined||value===null||typeof value==='string'&&!value.trim()||Array.isArray(value)&&!value.length;}
// Exact ECMAScript trim set, for schema preview/unique SQL to share input semantics.
export const recordWhitespaceSql="U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF'";
export const recordHash=(value:unknown)=>createHash('sha256').update(stableStringify(value)).digest('hex');
export function recordName(value:unknown){if(typeof value!=='string')throw new DocumentError('Enter a record name.','record_validation');const name=value.trim().normalize('NFC');if(!name||Array.from(name).length>200||/[\p{Cc}]/u.test(name))throw new DocumentError('Use a record name of 1–200 characters without control characters.','record_validation');return name;}
const f=(key:string,label:string,kind:FieldKind,sensitive=false,choices:string[]=[]):RecordField=>({key:'core:'+key,label,kind,sensitive,choices,required:false,unique:false,deprecated:false,core:true,version:1});
export function standardRecordFields(collection:string):RecordField[]{switch(collection){
 case 'organisations':return [f('domain','Domain','url'),f('registration','Registration reference','text'),f('notes','Notes','long-text')];
 case 'accounts':return [f('status','Account status','single-select',false,['active','inactive']),f('notes','Notes','long-text')];
 case 'contacts':return [f('email','Email','email',true),f('phone','Phone','phone',true),f('job-title','Job title','text')];
 case 'employees':return [f('email','Work email','email',true),f('phone','Phone','phone',true),f('job-title','Job title','text'),f('start-date','Start date','date',true),f('active','Active staff','boolean')];
 case 'contracts':return [f('reference','Contract reference','text'),f('start-date','Start date','date'),f('end-date','End date','date'),f('amount','Contract amount','currency',true),f('status','Contract status','single-select',false,['draft','active','closed']),f('notes','Notes','long-text')];
 default:return [];
}}
function invalid(field:RecordField):never{throw new DocumentError('Review the value for '+field.label+'.','record_validation');}
export function typedRecordValue(field:RecordField,value:unknown,selection:{historical?:boolean;previous?:unknown}={}):unknown{
 if(field.required&&recordValueEmpty(value))invalid(field);
 if(value===null){if(field.required)invalid(field);return null;}
 const allowedChoice=(v:string)=>field.choices.includes(v)&&(!field.referenceList||selection.historical||!field.referenceList.items.find(i=>i.id===v)?.deprecated||selection.previous===v||Array.isArray(selection.previous)&&selection.previous.includes(v));
 switch(field.kind){
  case 'text':case 'long-text':{if(typeof value!=='string'||Array.from(value).length>(field.kind==='text'?2000:20000)||value.includes('\0'))invalid(field);return value.normalize('NFC');}
  case 'number':if(typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e15)invalid(field);return value;
  case 'boolean':if(typeof value!=='boolean')invalid(field);return value;
  case 'date':{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))invalid(field);const d=new Date(value+'T00:00:00Z');if(!Number.isFinite(d.getTime())||d.toISOString().slice(0,10)!==value)invalid(field);return value;}
  case 'email':{const r=z.string().trim().max(320).email().safeParse(value);if(!r.success)invalid(field);return r.data;}
  case 'phone':if(typeof value!=='string'||value.trim().length>40||!/^\+?[0-9 ().\-x]{3,40}$/.test(value.trim()))invalid(field);return value.trim();
  case 'url':{if(typeof value!=='string'||value.length>2000)invalid(field);try{const url=new URL(value.trim());if(!['https:','http:'].includes(url.protocol)||url.username||url.password)invalid(field);return url.href;}catch{invalid(field);}}
  case 'currency':{const result=z.object({currency:z.string().regex(/^[A-Z]{3}$/),minorUnits:z.string().regex(/^-?(0|[1-9]\d{0,17})$/),scale:z.number().int().min(0).max(4)}).strict().safeParse(value);if(!result.success)invalid(field);return result.data;}
  case 'single-select':if(typeof value!=='string'||!allowedChoice(value))invalid(field);return value;
  case 'multi-select':if(!Array.isArray(value)||value.length>100||value.some(v=>typeof v!=='string'||!allowedChoice(v))||new Set(value).size!==value.length)invalid(field);return [...value].sort();
  case 'attachment':case 'record':{const result=z.array(z.string().uuid()).max(100).safeParse(value);if(!result.success||new Set(result.data).size!==result.data.length)invalid(field);return [...result.data].sort();}
 }
}
export function recordInputValues(fields:RecordField[],patch:unknown,existing:Record<string,unknown>={},creating=false){if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).length>fields.length)throw new DocumentError('Use a bounded field-value object.','record_validation');const data={...existing},changed=new Set<string>();for(const [key,value] of Object.entries(patch)){const field=fields.find(f=>f.key===key);if(!field||field.deprecated)throw new DocumentError('A supplied field is unavailable for editing.','record_field_unavailable');data[key]=typedRecordValue(field,value,creating?{}:{previous:existing[key]});changed.add(key);}for(const field of fields){if(!field.deprecated&&creating&&data[field.key]===undefined&&field.defaultValue!==undefined){data[field.key]=typedRecordValue(field,field.defaultValue);changed.add(field.key);}if(!field.deprecated&&field.required&&recordValueEmpty(data[field.key]))throw new DocumentError('A required permitted field is missing.','record_validation');}if(Buffer.byteLength(stableStringify(data))>200000)throw new DocumentError('Record field values exceed 200 KB.','record_size',413);return {data,changed:[...changed]};}
