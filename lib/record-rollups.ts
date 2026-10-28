import {z} from 'zod';
import {typedRecordValue,type RecordField} from './shared-record-types';

export type RollupAggregate='count'|'sum'|'min'|'max';
export type RollupDefinition={id:string;label:string;relationshipField:string;relatedCollection:string;aggregate:RollupAggregate;valueField?:string;filter?:{field:string;equals:string|number|boolean|null};currency?:string;currencyScale?:number};
export class RecordRollupError extends Error{constructor(readonly code:string,message:string){super(message);}}
const fail=(code:string,message:string):never=>{throw new RecordRollupError(code,message);};
const schema=z.object({id:z.string().uuid(),label:z.string().trim().min(1).max(100),relationshipField:z.string().min(1).max(100),relatedCollection:z.string().min(1).max(100),aggregate:z.enum(['count','sum','min','max']),valueField:z.string().min(1).max(100).optional(),filter:z.object({field:z.string().min(1).max(100),equals:z.union([z.string().max(2000),z.number().finite(),z.boolean(),z.null()])}).strict().optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),currencyScale:z.number().int().min(0).max(4).optional()}).strict();

export function compileRollup(input:unknown,ownerFields:RecordField[],relatedFields:RecordField[]):RollupDefinition{
 const parsed=schema.safeParse(input);if(!parsed.success||JSON.stringify(input).length>16_000)fail('rollup_invalid','Review the bounded rollup definition.');const d=parsed.data!;
 if(ownerFields.find(f=>f.key===d.relationshipField)?.kind!=='record')fail('rollup_relationship_type','Choose a record relationship field.');
 if(d.aggregate==='count'){if(d.valueField||d.currency||d.currencyScale!==undefined)fail('rollup_type','Count does not use a value field or currency.');}
 else{const found=relatedFields.find(v=>v.key===d.valueField);if(!found||!['number','currency','date'].includes(found.kind))fail('rollup_value_type','Sum, minimum and maximum require a compatible field.');const f=found!;if(d.aggregate==='sum'&&f.kind==='date')fail('rollup_value_type','Dates cannot be summed.');if(f.kind==='currency'&&(!d.currency||d.currencyScale===undefined))fail('rollup_currency','Currency rollups require an explicit ISO currency and scale.');if(f.kind!=='currency'&&(d.currency||d.currencyScale!==undefined))fail('rollup_currency','Currency applies only to currency fields.');}
 if(d.filter){const found=relatedFields.find(f=>f.key===d.filter!.field);if(!found)fail('rollup_filter_field','The filter field is unavailable.');const filter=found!;if(d.filter.equals!==null)try{typedRecordValue(filter,d.filter.equals,{historical:true});}catch{fail('rollup_filter_type','The filter value does not match its field type.');}}return d;
}

export function evaluateRollup(d:RollupDefinition,rows:{values:Record<string,unknown>}[]):number|string|null{
 const selected=d.filter?rows.filter(r=>Object.is(r.values[d.filter!.field],d.filter!.equals)):rows;if(d.aggregate==='count')return selected.length;
 const values:(number|string|bigint)[]=[];for(const row of selected){const v=row.values[d.valueField!];if(v===null||v===undefined)continue;if(d.currency){if(typeof v!=='object'||Array.isArray(v)||v===null)continue;const c=v as {currency?:unknown;minorUnits?:unknown;scale?:unknown};if(c.currency!==d.currency||c.scale!==d.currencyScale||typeof c.minorUnits!=='string'||!/^-?\d+$/.test(c.minorUnits))continue;values.push(BigInt(c.minorUnits));}else if(typeof v==='number'&&Number.isFinite(v)||typeof v==='string')values.push(v as number|string);}
 if(!values.length)return null;if(d.currency){const nums=values as bigint[],result=d.aggregate==='sum'?nums.reduce((a,b)=>a+b,0n):d.aggregate==='min'?nums.reduce((a,b)=>a<b?a:b):nums.reduce((a,b)=>a>b?a:b);return result.toString();}
 if(d.aggregate==='sum')return (values as number[]).reduce((a,b)=>a+Number(b),0);return (values as (number|string)[]).reduce((a,b)=>d.aggregate==='min'?(a<b?a:b):(a>b?a:b));
}
