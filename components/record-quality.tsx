'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {FieldKind} from '../lib/shared-record-types';
import styles from './record-quality.module.css';

type Choice={id:string;label:string;deprecated?:boolean};
type Field={key:string;label:string;kind:FieldKind;sensitive:boolean;choices:Choice[]};
type Catalogue={schemaVersion:number;canManage:boolean;hasCalculated:boolean;fields:Field[]};
type When={all?:Clause[];any?:Clause[]};
type Clause={field:string;operator:string;value?:unknown};
type Check={id:string;field:string;kind:'required'|'quality';predicate?:{operator:string;value?:unknown};when?:When};
type Definition={layoutId:string|null;enforcement:'advisory'|'block';checks:Check[]};
type Summary={id:string;name:string;version:number;available:boolean};
type OpenRule={id:string;name:string;version:number;deprecated:boolean;definition:Definition;canManage:boolean};
type ResultCheck={label:string;status:'pass'|'fail'|'skipped';detail:string};
type Result={record:{id:string;name:string;version:number};complete:boolean;blocked:boolean;withheld:boolean;message?:string;rules:{id:string;name:string;enforcement:'advisory'|'block';checks:ResultCheck[]}[]};
type Draft={id:string;field:string;kind:'required'|'quality';operator:string;value:string;whenField:string;whenOperator:string;whenValue:string;whenMode:'all'|'any';rawWhen?:When};
const operators=[['is-not-empty','Is not empty'],['equals','Equals'],['not-equals','Does not equal'],['min-length','Minimum length'],['max-length','Maximum length'],['greater-than','Greater than'],['less-than','Less than']] as const;
const whenOperators=[['equals','Equals'],['not-equals','Does not equal'],['is-empty','Is empty'],['is-not-empty','Is not empty']] as const;

export default function RecordQuality({workspaceId,tenantId,collection,recordId:initialRecordId}:{workspaceId:string;tenantId:string;collection:string;recordId?:string}){
 const base=`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-quality`;
 const [catalogue,setCatalogue]=useState<Catalogue|undefined>(),[items,setItems]=useState<Summary[]>([]),[cursor,setCursor]=useState<string|null>(null),[form,setForm]=useState<OpenRule|undefined>(),[mode,setMode]=useState<'catalogue'|'manage'>('catalogue'),[name,setName]=useState(''),[layoutId,setLayoutId]=useState(''),[enforcement,setEnforcement]=useState<'advisory'|'block'>('advisory'),[checks,setChecks]=useState<Draft[]>([blank()]),[recordId,setRecordId]=useState(initialRecordId??''),[result,setResult]=useState<Result|undefined>(),[deprecateArmed,setDeprecateArmed]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const pending=useRef<{fingerprint:string;body:unknown}|undefined>(undefined),ruleId=useRef<string|undefined>(undefined),generation=useRef(0);
 async function call(url:string,body?:unknown){
  const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if(!response.ok){
   if(response.status===401||response.status===403||response.status===404){generation.current++;setCatalogue(undefined);setItems([]);setForm(undefined);setResult(undefined);pending.current=undefined;}
   throw new Error(data.error??'Unable to complete this request. Your draft remains open.');
  }
  return data;
 }
 async function loadRules(next?:string){
  const listed=await call(`${base}?collection=${encodeURIComponent(collection)}${next?`&cursor=${encodeURIComponent(next)}`:''}`);
  setItems(old=>next?[...old,...listed.rules]:listed.rules);setCursor(listed.nextCursor);
 }
 async function load(){
  setBusy(true);setError('');
  try{
   const stamp=generation.current;
   const [metadata,listed]=await Promise.all([call(`${base}?collection=${encodeURIComponent(collection)}&form=1`),call(`${base}?collection=${encodeURIComponent(collection)}`)]);
   if(stamp!==generation.current)return;
   setCatalogue(metadata);setItems(listed.rules);setCursor(listed.nextCursor);
  }catch(reason){setError(reason instanceof Error?reason.message:'Unable to load quality rules.');}
  finally{setBusy(false);}
 }
 useEffect(()=>{void load();const revoke=()=>{generation.current++;setCatalogue(undefined);setItems([]);setForm(undefined);setResult(undefined);setName('');pending.current=undefined;};window.addEventListener('hs-session-lock',revoke);return()=>{revoke();window.removeEventListener('hs-session-lock',revoke);};},[base,collection]);
 function begin(){ruleId.current=undefined;setForm(undefined);setName('');setLayoutId('');setEnforcement('advisory');setChecks([blank()]);setDeprecateArmed(false);setMode('manage');pending.current=undefined;}
 function applyOpen(opened:OpenRule){ruleId.current=opened.id;setForm(opened);setName(opened.name);setLayoutId(opened.definition.layoutId??'');setEnforcement(opened.definition.enforcement);setChecks(opened.definition.checks.map(toDraft));setDeprecateArmed(false);setMode('manage');pending.current=undefined;}
 async function openRule(item:Summary){
  setBusy(true);setError('');
  try{const stamp=generation.current,opened:OpenRule=await call(`${base}?ruleId=${item.id}`);if(stamp!==generation.current)return;applyOpen(opened);}
  catch(reason){setError(reason instanceof Error?reason.message:'That quality rule is unavailable.');}
  finally{setBusy(false);}
 }
 function literal(fieldKey:string,operator:string,raw:string){
  if(operator==='is-empty'||operator==='is-not-empty')return undefined;
  const field=catalogue?.fields.find(item=>item.key===fieldKey);
  if(operator==='min-length'||operator==='max-length')return Number(raw);
  if((operator==='greater-than'||operator==='less-than')&&field?.kind!=='number')return raw;
  if(field?.kind==='boolean')return raw==='true';
  if(field?.kind==='number')return Number(raw);
  return raw;
 }
 function whenOf(check:Draft):When|undefined{
  if(check.rawWhen)return check.rawWhen;
  if(!check.whenField)return;
  const clause:Clause={field:check.whenField,operator:check.whenOperator};
  if(check.whenOperator!=='is-empty'&&check.whenOperator!=='is-not-empty')clause.value=literal(check.whenField,check.whenOperator,check.whenValue);
  return check.whenMode==='any'?{any:[clause]}:{all:[clause]};
 }
 function draft():Definition{
  return {layoutId:layoutId.trim()||null,enforcement,checks:checks.filter(check=>check.field).map(check=>{
   const when=whenOf(check);
   if(check.kind==='quality'){
    const predicate:Check['predicate']={operator:check.operator};
    if(check.operator!=='is-not-empty')predicate.value=literal(check.field,check.operator,check.value);
    return {id:check.id,field:check.field,kind:'quality' as const,predicate,...(when?{when}:{})};
   }
   return {id:check.id,field:check.field,kind:'required' as const,...(when?{when}:{})};
  })};
 }
 async function save(action:'save'|'deprecate'){
  if(!catalogue?.canManage)return;
  const definition=action==='deprecate'&&form?form.definition:draft();
  if(!definition.checks.length){setError('Choose at least one field you can view.');return;}
  setBusy(true);setError('');setNotice('');
  try{
   const id=form?.id??ruleId.current??crypto.randomUUID();
   ruleId.current=id;
   const input={kind:'save',id,collection,name:action==='deprecate'&&form?form.name:name,expectedVersion:form?.version??0,deprecated:action==='deprecate',definition};
   const fingerprint=JSON.stringify(input);
   const body=pending.current?.fingerprint===fingerprint?pending.current.body:{...input,operationId:crypto.randomUUID()};
   pending.current={fingerprint,body};
   await call(base,body);
   setNotice(action==='deprecate'?'Quality rule deprecated. Existing records are unchanged.':'Quality rule saved.');
   pending.current=undefined;setDeprecateArmed(false);setMode('catalogue');setForm(undefined);await load();
  }catch(reason){setError(reason instanceof Error?reason.message:'Unable to save this quality rule. Your draft remains open.');}
  finally{setBusy(false);}
 }
 async function evaluate(event:FormEvent){
  event.preventDefault();
  setBusy(true);setError('');setResult(undefined);
  try{const stamp=generation.current,evaluated:Result=await call(`${base}?collection=${encodeURIComponent(collection)}&recordId=${encodeURIComponent(recordId.trim())}`);if(stamp!==generation.current)return;setResult(evaluated);}
  catch(reason){setError(reason instanceof Error?reason.message:'That record is unavailable.');}
  finally{setBusy(false);}
 }
 function update(id:string,patch:Partial<Draft>){setChecks(current=>current.map(check=>check.id===id?{...check,...patch,rawWhen:undefined}:check));pending.current=undefined;}
 function cancel(){setMode('catalogue');setForm(undefined);setError('');setDeprecateArmed(false);pending.current=undefined;void load();}
 return <main className={styles.root}><h1>Record quality</h1><p className={styles.help}>Define completeness and quality checks for this collection, then review the current record. A check uses the permissions you already have. It does not grant access, and it does not change saving, intake, or review.</p>{error&&<p role="alert" className={styles.error}>{error}</p>}{notice&&<p role="status">{notice}</p>}
  {mode==='catalogue'?<>
   <div className={styles.actions}><button type="button" disabled={busy} onClick={()=>void load()}>Refresh rules</button>{catalogue?.canManage&&<button type="button" disabled={busy} onClick={begin}>New quality rule</button>}</div>
   <h2>Rules</h2>
   <ul className={styles.list}>{items.map(item=><li key={item.id}><strong>{item.name}</strong><span>Revision {item.version}</span>{catalogue?.canManage&&<button type="button" disabled={busy||!item.available} onClick={()=>void openRule(item)}>Edit {item.name}</button>}</li>)}</ul>
   {catalogue&&!items.length&&<p>No active quality rules are available in this collection.</p>}
   {cursor&&<button type="button" disabled={busy} onClick={()=>void loadRules(cursor)}>Load more rules</button>}
   <form onSubmit={evaluate}><h2>Check a record</h2><label htmlFor="quality-record">Record ID</label><input id="quality-record" value={recordId} autoComplete="off" required onChange={event=>{setRecordId(event.target.value);setResult(undefined);}}/><button type="submit" disabled={busy||!recordId.trim()}>Check completeness</button></form>
   {result&&<section aria-label="Completeness result"><h2>Completeness for {result.record.name}</h2><p role="status">{result.complete?'Every check you can view passes.':'Some checks you can view need attention.'}</p>{result.withheld&&<p>{result.message??'A field is restricted or unavailable.'}</p>}{result.blocked&&<p role="alert">An opt-in block rule has a visible failure. Saving the record is not changed.</p>}<ul className={styles.list}>{result.rules.map(rule=><li key={rule.id}><div><strong>{rule.name}</strong><span>{rule.enforcement==='block'?'Opt-in block':'Advisory'}</span><ul>{rule.checks.map(check=><li key={`${rule.id}:${check.label}:${check.detail}`} className={check.status==='fail'?styles.fail:check.status==='pass'?styles.pass:undefined}>{check.label}: {check.detail}</li>)}</ul></div></li>)}</ul></section>}
  </>: <form onSubmit={event=>{event.preventDefault();void save('save');}}>
   <h2>{form?'Edit quality rule':'New quality rule'}</h2>
   <label htmlFor="quality-name">Rule name</label><input id="quality-name" value={name} required maxLength={100} onChange={event=>{setName(event.target.value);pending.current=undefined;}}/>
   <label htmlFor="quality-layout">Layout tab or section</label><input id="quality-layout" value={layoutId} autoComplete="off" placeholder="Optional" onChange={event=>{setLayoutId(event.target.value);pending.current=undefined;}}/><p className={styles.help}>Leave this blank to check the whole collection. A field that is not on the selected layout is not treated as missing.</p>
   <label htmlFor="quality-enforcement">If a visible check fails</label><select id="quality-enforcement" aria-label="If a check fails" value={enforcement} onChange={event=>{setEnforcement(event.target.value==='block'?'block':'advisory');pending.current=undefined;}}><option value="advisory">Advisory</option><option value="block">Opt-in block (does not stop saving)</option></select>
   {checks.map((check,index)=><fieldset key={check.id}><legend>Check {index+1}</legend>
    <label htmlFor={`quality-field-${check.id}`}>Field</label><select id={`quality-field-${check.id}`} aria-label={`Field for check ${index+1}`} value={check.field} onChange={event=>update(check.id,{field:event.target.value})}><option value="">Choose a field</option>{catalogue?.fields.map(field=><option key={field.key} value={field.key}>{field.label}{field.sensitive?' (sensitive)':''}</option>)}</select>
    <label htmlFor={`quality-kind-${check.id}`}>Check</label><select id={`quality-kind-${check.id}`} aria-label={`Kind for check ${index+1}`} value={check.kind} onChange={event=>update(check.id,{kind:event.target.value==='quality'?'quality':'required'})}><option value="required">Required</option><option value="quality">Quality</option></select>
    {check.kind==='quality'&&<><label htmlFor={`quality-operator-${check.id}`}>Quality check</label><select id={`quality-operator-${check.id}`} aria-label={`Operator for check ${index+1}`} value={check.operator} onChange={event=>update(check.id,{operator:event.target.value})}>{operators.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>{check.operator!=='is-not-empty'&&<><label htmlFor={`quality-value-${check.id}`}>Comparison</label><input id={`quality-value-${check.id}`} value={check.value} onChange={event=>update(check.id,{value:event.target.value})}/></>}</>}
    <label htmlFor={`quality-when-${check.id}`}>Only when</label><select id={`quality-when-${check.id}`} aria-label={`Condition for check ${index+1}`} value={check.whenField} onChange={event=>update(check.id,{whenField:event.target.value})}><option value="">Always</option>{catalogue?.fields.map(field=><option key={field.key} value={field.key}>{field.label}</option>)}</select>
    {check.whenField&&<><label htmlFor={`quality-when-operator-${check.id}`}>Condition</label><select id={`quality-when-operator-${check.id}`} aria-label={`Condition operator for check ${index+1}`} value={check.whenOperator} onChange={event=>update(check.id,{whenOperator:event.target.value})}>{whenOperators.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>{check.whenOperator!=='is-empty'&&check.whenOperator!=='is-not-empty'&&<><label htmlFor={`quality-when-value-${check.id}`}>Condition value</label><input id={`quality-when-value-${check.id}`} value={check.whenValue} onChange={event=>update(check.id,{whenValue:event.target.value})}/></>}</>}
    {checks.length>1&&<button type="button" disabled={busy} onClick={()=>{setChecks(current=>current.filter(item=>item.id!==check.id));pending.current=undefined;}}>Remove check {index+1}</button>}
   </fieldset>)}
   {catalogue?.hasCalculated&&<p className={styles.help}>Calculated, attachment, and record-reference fields stay off these checks.</p>}
   <button type="button" disabled={busy} onClick={()=>{setChecks(current=>[...current,blank()]);pending.current=undefined;}}>Add check</button>
   {deprecateArmed?<div className={styles.actions}><p id="quality-deprecate-text">Deprecate this rule? Records already stored are unchanged, and the rule is ignored on the next check.</p><button type="button" disabled={busy} onClick={()=>void save('deprecate')}>Confirm deprecation</button><button type="button" disabled={busy} onClick={()=>setDeprecateArmed(false)}>Cancel</button></div>:<div className={styles.actions}><button type="submit" disabled={busy||!catalogue?.canManage}>Save quality rule</button>{form&&!form.deprecated&&<button type="button" disabled={busy} onClick={()=>setDeprecateArmed(true)}>Deprecate rule</button>}<button type="button" disabled={busy} onClick={cancel}>Cancel</button></div>}
  </form>}
 </main>;
}
function blank():Draft{return {id:crypto.randomUUID(),field:'',kind:'required',operator:'is-not-empty',value:'',whenField:'',whenOperator:'equals',whenValue:'',whenMode:'all'};}
function toDraft(check:Check):Draft{
 const single=check.when&&'all' in check.when&&check.when.all?.length===1?check.when.all[0]:check.when&&'any' in check.when&&check.when.any?.length===1?check.when.any[0]:undefined;
 const complex=!!check.when&&!single;
 return {id:check.id,field:check.field,kind:check.kind,operator:check.predicate?.operator??'is-not-empty',value:check.predicate?.value==null?'':String(check.predicate.value),whenField:single?.field??'',whenOperator:single?.operator??'equals',whenValue:single?.value==null?'':String(single.value),whenMode:check.when&&'any' in check.when?'any':'all',...(complex?{rawWhen:check.when}:{})};
}
