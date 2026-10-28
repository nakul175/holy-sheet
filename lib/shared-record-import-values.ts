import {z} from 'zod';import {DocumentError} from './document';import {typedRecordValue,type RecordField} from './shared-record-types';
const column=z.number().int().min(0).max(99);
export const recordImportMapping=z.object({mode:z.enum(['create','update']),nameColumn:column.optional(),idColumn:column.optional(),parentOrganisationColumn:column.optional(),legalOrganisationColumn:column.optional(),accountColumn:column.optional(),fields:z.array(z.object({column,fieldKey:z.string().min(1).max(100),currency:z.object({code:z.string().regex(/^[A-Z]{3}$/),scale:z.number().int().min(0).max(4)}).strict().optional()}).strict()).max(100)}).strict();
export type RecordImportMapping=z.output<typeof recordImportMapping>;
export type ImportRowIssue={code:string;fieldKey?:string};
export function importIds(value:string){const trimmed=value.trim();let list:unknown;if(!trimmed)return [];try{list=trimmed.startsWith('[')?JSON.parse(trimmed):trimmed.split(';').map(v=>v.trim());}catch{throw new DocumentError('Use immutable relationship IDs.','record_import_relationship');}const parsed=z.array(z.string().uuid()).max(100).safeParse(list);if(!parsed.success||new Set(parsed.data).size!==parsed.data.length)throw new DocumentError('Use distinct immutable relationship IDs.','record_import_relationship');return parsed.data;}
export function coerceRecordImportValue(field:RecordField,raw:string,currency?:{code:string;scale:number}){
 const text=raw.trim();if(!text)return typedRecordValue(field,null);let value:unknown=raw;
 switch(field.kind){
  case 'number':if(!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new DocumentError('Use an unambiguous number.','record_import_number');value=Number(text);break;
  case 'boolean':if(!/^(true|false|0|1)$/i.test(text))throw new DocumentError('Use true, false, 1 or 0.','record_import_boolean');value=/^(true|1)$/i.test(text);break;
  case 'date':case 'email':case 'phone':case 'url':case 'single-select':value=text;break;
  case 'multi-select':try{value=text.startsWith('[')?JSON.parse(text):text.split(';').map(v=>v.trim());}catch{throw new DocumentError('Use a JSON string list or semicolon-separated choices.','record_import_list');}break;
  case 'attachment':case 'record':value=importIds(text);break;
  case 'currency':{
   const portable=/^([A-Z]{3}):(-?(?:0|[1-9]\d{0,17})):(\d)$/.exec(text);if(portable){value={currency:portable[1],minorUnits:portable[2],scale:Number(portable[3])};break;}
   const qualified=/^([A-Z]{3})\s+(-?(?:0|[1-9]\d*)(?:\.\d+)?)$/.exec(text),code=currency?.code??qualified?.[1],amount=qualified?.[2]??text,match=/^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(amount),scale=currency?.scale??match?.[3]?.length??0;
   if(!code||!match||scale>4||(match[3]?.length??0)>scale||qualified&&currency&&qualified[1]!==currency.code)throw new DocumentError('Use CODE:minorUnits:scale or an explicit currency mapping.','record_import_currency');const digits=match[2]+(match[3]??'').padEnd(scale,'0'),minor=BigInt((match[1]??'')+digits).toString();value={currency:code,minorUnits:minor,scale};break;
  }
 }
 return typedRecordValue(field,value);
}
