import {z} from 'zod';
import type {FieldKind,RecordField} from './shared-record-types';
const field=z.object({kind:z.literal('field'),field:z.string().min(1).max(100)}).strict(),literal=z.object({kind:z.literal('literal'),value:z.union([z.string().max(2000),z.number().finite(),z.boolean(),z.null()])}).strict();
const operators=['add','subtract','multiply','divide','concat','equals','greater-than','less-than','date-difference-days'] as const;
export type FormulaOperator=typeof operators[number];
const expression:z.ZodType<FormulaExpression>=z.lazy(()=>z.union([field,literal,z.object({kind:z.enum(operators),left:expression,right:expression}).strict()]));
export type FormulaExpression={kind:'field';field:string}|{kind:'literal';value:string|number|boolean|null}|{kind:FormulaOperator;left:FormulaExpression;right:FormulaExpression};
export type FormulaDefinition={id:string;label:string;returnKind:'number'|'text'|'boolean';expression:FormulaExpression;rounding?:number;timezone?:string;asOfDate?:string};
export type CalculatedValue={fieldKey:string;label:string;value:unknown;sensitive:boolean;stale:boolean;readOnly:true;version:number;error?:string};
export class RecordFormulaError extends Error {constructor(readonly code:string,message:string){super(message);}}
const fail=(code:string,message:string):never=>{throw new RecordFormulaError(code,message);},empty=(v:unknown)=>v===null||v===undefined||v==='';
type FormulaKind=FieldKind|'null';
export function formulaFields(e:FormulaExpression):string[]{return e.kind==='field'?[e.field]:e.kind==='literal'?[]:[...new Set([...formulaFields(e.left),...formulaFields(e.right)])];}
export function orderedFormulaDefinitions(formulas:FormulaDefinition[]):FormulaDefinition[]{const ids=new Set(formulas.map(f=>f.id)),graph=new Map(formulas.map(f=>[f.id,formulaFields(f.expression).filter(k=>ids.has(k))])),visiting=new Set<string>(),done=new Set<string>(),order:string[]=[];function visit(k:string){if(visiting.has(k))fail('formula_cycle','Calculated-field cycles are not supported.');if(done.has(k))return;visiting.add(k);for(const n of graph.get(k)??[])visit(n);visiting.delete(k);done.add(k);order.push(k);}for(const f of formulas)visit(f.id);const byId=new Map(formulas.map(f=>[f.id,f]));return order.map(id=>byId.get(id)!);}
export function formulaSensitive(definition:FormulaDefinition,fields:{key:string;sensitive:boolean}[],formulas:FormulaDefinition[],seen=new Set<string>()):boolean{if(seen.has(definition.id))return false;seen.add(definition.id);return formulaFields(definition.expression).some(key=>{const source=fields.find(f=>f.key===key);if(source)return source.sensitive;const nested=formulas.find(f=>f.id===key);return nested?formulaSensitive(nested,fields,formulas,seen):false;});}
export function compileFormula(input:unknown,fields:RecordField[],calculated:FormulaDefinition[]=[]):FormulaDefinition{
 const parsed=z.object({id:z.string().uuid(),label:z.string().trim().min(1).max(100),returnKind:z.enum(['number','text','boolean']),expression,rounding:z.number().int().min(0).max(12).optional(),timezone:z.string().min(1).max(100).optional(),asOfDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()}).strict().safeParse(input);
 if(!parsed.success||JSON.stringify(input).length>64_000)fail('formula_invalid','Review the bounded typed formula.');
 const d=parsed.data!,active=fields.filter(f=>!f.deprecated);
 if(active.some(f=>f.key===d.id)||calculated.some(f=>active.some(field=>field.key===f.id)))fail('formula_field_unavailable','A formula field is unavailable.');
 const all=new Map<string,FormulaKind>([...active.map(f=>[f.key,f.kind] as const),...calculated.map(f=>[f.id,f.returnKind] as const)]),deps=new Set<string>();
 let nodes=0;
 function kind(e:FormulaExpression):FormulaKind{
  if(++nodes>100)fail('formula_too_complex','Use at most 100 expression nodes.');
  if(e.kind==='field'){const k=all.get(e.field);if(!k)fail('formula_field_unavailable','A formula field is unavailable.');deps.add(e.field);return k!;}
  if(e.kind==='literal')return e.value===null?'null':typeof e.value==='string'?'text':typeof e.value==='number'?'number':'boolean';
  const l=kind(e.left),r=kind(e.right);
  if(e.kind==='add'||e.kind==='subtract'||e.kind==='multiply'||e.kind==='divide'){if(l!=='number'||r!=='number')fail('formula_type','Arithmetic requires number inputs.');return 'number';}
  if(e.kind==='concat'){if((l!=='text'&&l!=='null')||(r!=='text'&&r!=='null'))fail('formula_type','Concatenation requires text inputs.');return 'text';}
  if(e.kind==='date-difference-days'){if(l!=='date'||r!=='date')fail('formula_type','Date difference requires date inputs.');return 'number';}
  if(l!==r&&l!=='null'&&r!=='null')fail('formula_type','Comparisons require matching input types.');
  if((e.kind==='greater-than'||e.kind==='less-than')&&(l==='boolean'||r==='boolean'))fail('formula_type','Order comparisons require number, text or date inputs.');
  return 'boolean';
 }
 const result=kind(d.expression);
 if(result!==d.returnKind)fail('formula_return_type','The expression result does not match its declared type.');
 if(d.rounding!==undefined&&d.returnKind!=='number')fail('formula_type','Rounding is available only for numbers.');
 const ids=new Set([...calculated.map(f=>f.id),d.id]),graph=new Map(calculated.map(f=>[f.id,formulaFields(f.expression).filter(k=>ids.has(k))]));
 graph.set(d.id,[...deps].filter(k=>ids.has(k)));
 const visiting=new Set<string>(),done=new Set<string>();
 function visit(k:string){if(visiting.has(k))fail('formula_cycle','Calculated-field cycles are not supported.');if(done.has(k))return;visiting.add(k);for(const n of graph.get(k)??[])visit(n);visiting.delete(k);done.add(k);}
 visit(d.id);
 return d;
}
function finiteNumber(v:unknown){if(typeof v!=='number'||!Number.isFinite(v))fail('formula_type','Arithmetic requires number inputs.');return v as number;}
function textValue(v:unknown):string{if(typeof v==='string')return v;return fail('formula_type','Concatenation requires text inputs.');}
function calendarDay(v:unknown){if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v))fail('formula_date','A date input is invalid.');const parsed=new Date(`${v}T00:00:00Z`);if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==v)fail('formula_date','A date input is invalid.');return parsed.getTime();}
function orderValue(v:unknown):number|string{if(typeof v==='number'&&Number.isFinite(v)||typeof v==='string')return v;return fail('formula_type','Order comparisons require number, text or date inputs.');}
export function evaluateFormula(d:FormulaDefinition,values:Record<string,unknown>){
 function value(e:FormulaExpression):unknown{
  if(e.kind==='field')return values[e.field];
  if(e.kind==='literal')return e.value;
  const l=value(e.left),r=value(e.right);
  if(empty(l)||empty(r))return null;
  switch(e.kind){
   case'add':return finiteNumber(l)+finiteNumber(r);
   case'subtract':return finiteNumber(l)-finiteNumber(r);
   case'multiply':return finiteNumber(l)*finiteNumber(r);
   case'divide':{const right=finiteNumber(r);if(right===0)fail('formula_divide_by_zero','Division by zero has no value.');return finiteNumber(l)/right;}
   case'concat':return textValue(l)+textValue(r);
   case'equals':if(typeof l!==typeof r||typeof l==='object')fail('formula_type','Comparisons require matching input types.');return Object.is(l,r);
   case'greater-than':return orderValue(l)>orderValue(r);
   case'less-than':return orderValue(l)<orderValue(r);
   case'date-difference-days':return Math.trunc((calendarDay(l)-calendarDay(r))/86400000);
  }
 }
 const result=value(d.expression);
 return typeof result==='number'&&d.rounding!==undefined?Number(result.toFixed(d.rounding)):result;
}
