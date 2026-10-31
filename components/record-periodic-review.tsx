'use client';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import type {FieldKind} from '../lib/shared-record-types';
import styles from './record-periodic-review.module.css';

type Field={key:string;label:string;kind:FieldKind;sensitive:boolean};
type Workflow={id:string;name:string;version:number;available:boolean};
type Catalogue={schemaVersion:number;canManage:boolean;canEdit:boolean;workflows:Workflow[];fields:Field[]};
type Filter={field:string;operator:string;value?:unknown};
type Definition={workflowId:string;intervalDays:number;windowDays:number;layoutId:string|null;filters:Filter[]};
type Summary={id:string;name:string;version:number;available:boolean};
type OpenSchedule={id:string;name:string;version:number;deprecated:boolean;definition:Definition;canManage:boolean;runnable:boolean};
type DueRecord={id:string;name:string;version:number;canStart:boolean};
type Due={schedule:{id:string;name:string;version:number;intervalDays?:number;windowDays?:number};records:DueRecord[];nextCursor:string|null;withheld:boolean;ignored:boolean;message?:string};
const operators=[['equal','Equals'],['empty','Is empty']] as const;

export default function RecordPeriodicReview({workspaceId,tenantId,collection}:{workspaceId:string;tenantId:string;collection:string}){
 const base=`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-periodic-review`;
 const reviewBase=`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/collections/${encodeURIComponent(collection)}/review`;
 const [catalogue,setCatalogue]=useState<Catalogue|undefined>(),[items,setItems]=useState<Summary[]>([]),[cursor,setCursor]=useState<string|null>(null),[form,setForm]=useState<OpenSchedule|undefined>(),[mode,setMode]=useState<'catalogue'|'manage'>('catalogue'),[name,setName]=useState(''),[workflowId,setWorkflowId]=useState(''),[intervalDays,setIntervalDays]=useState('30'),[windowDays,setWindowDays]=useState('0'),[layoutId,setLayoutId]=useState(''),[filterField,setFilterField]=useState(''),[filterOperator,setFilterOperator]=useState('equal'),[filterValue,setFilterValue]=useState(''),[due,setDue]=useState<Due|undefined>(),[dueCursor,setDueCursor]=useState<string|null>(null),[deprecateArmed,setDeprecateArmed]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const pending=useRef<{fingerprint:string;body:unknown}|undefined>(undefined),generation=useRef(0);
 async function call(url:string,body?:unknown){
  const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if(!response.ok){
   if(response.status===401||response.status===403||response.status===404){generation.current++;setCatalogue(undefined);setItems([]);setForm(undefined);setDue(undefined);pending.current=undefined;}
   throw new Error(data.error??'Unable to complete this request. Your draft remains open.');
  }
  return data;
 }
 async function loadDue(scheduleId:string,next?:string){
  const listed:Due=await call(`${base}?collection=${encodeURIComponent(collection)}&scheduleId=${encodeURIComponent(scheduleId)}&due=1${next?`&cursor=${encodeURIComponent(next)}`:''}`);
  setDue(current=>next&&current?{...listed,records:[...current.records,...listed.records]}:listed);
  setDueCursor(listed.nextCursor);
 }
 async function loadSchedules(next?:string){
  const listed=await call(`${base}?collection=${encodeURIComponent(collection)}${next?`&cursor=${encodeURIComponent(next)}`:''}`);
  setItems(old=>next?[...old,...listed.schedules]:listed.schedules);setCursor(listed.nextCursor);return listed.schedules as Summary[];
 }
 async function load(){
  setBusy(true);setError('');
  try{
   const stamp=generation.current;
   const [metadata,schedules]=await Promise.all([call(`${base}?collection=${encodeURIComponent(collection)}&form=1`),loadSchedules()]);
   if(stamp!==generation.current)return;
   setCatalogue(metadata);
   const first=schedules[0];
   if(first)await loadDue(first.id);
   else {setDue(undefined);setDueCursor(null);}
  }catch(reason){setError(reason instanceof Error?reason.message:'Unable to load periodic reviews.');}
  finally{setBusy(false);}
 }
 useEffect(()=>{void load();const revoke=()=>{generation.current++;setCatalogue(undefined);setItems([]);setForm(undefined);setDue(undefined);setName('');pending.current=undefined;};window.addEventListener('hs-session-lock',revoke);return()=>{revoke();window.removeEventListener('hs-session-lock',revoke);};},[base,collection]);
 function begin(){setForm(undefined);setName('');setWorkflowId('');setIntervalDays('30');setWindowDays('0');setLayoutId('');setFilterField('');setFilterOperator('equal');setFilterValue('');setDeprecateArmed(false);setMode('manage');pending.current=undefined;}
 function applyOpen(opened:OpenSchedule){
  const single=opened.definition.filters.length===1?opened.definition.filters[0]:undefined;
  setForm(opened);setName(opened.name);setWorkflowId(opened.definition.workflowId);setIntervalDays(String(opened.definition.intervalDays));setWindowDays(String(opened.definition.windowDays));setLayoutId(opened.definition.layoutId??'');setFilterField(single?.field??'');setFilterOperator(single?.operator==='empty'?'empty':'equal');setFilterValue(single?.value==null?'':String(single.value));setDeprecateArmed(false);setMode('manage');pending.current=undefined;
 }
 async function openSchedule(item:Summary){
  setBusy(true);setError('');
  try{const stamp=generation.current,opened:OpenSchedule=await call(`${base}?scheduleId=${item.id}`);if(stamp!==generation.current)return;applyOpen(opened);}
  catch(reason){setError(reason instanceof Error?reason.message:'That periodic review schedule is unavailable.');}
  finally{setBusy(false);}
 }
 function draft():Definition{
  const filters:Filter[]=[];
  if(filterField){
   const item:Filter={field:filterField,operator:filterOperator};
   if(filterOperator!=='empty')item.value=filterValue;
   filters.push(item);
  }
  return {workflowId,intervalDays:Number(intervalDays),windowDays:Number(windowDays),layoutId:layoutId.trim()||null,filters};
 }
 async function save(action:'save'|'deprecate'){
  if(!catalogue?.canManage)return;
  const definition=action==='deprecate'&&form?form.definition:draft();
  if(!definition.workflowId){setError('Choose a review workflow.');return;}
  setBusy(true);setError('');setNotice('');
  try{
   const id=form?.id??crypto.randomUUID();
   const input={kind:'save',id,collection,name:action==='deprecate'&&form?form.name:name,expectedVersion:form?.version??0,deprecated:action==='deprecate',definition};
   const fingerprint=JSON.stringify(input);
   const body=pending.current?.fingerprint===fingerprint?pending.current.body:{...input,operationId:crypto.randomUUID()};
   pending.current={fingerprint,body};
   await call(base,body);
   setNotice(action==='deprecate'?'Periodic review schedule deprecated. It is ignored and does not start reviews.':'Periodic review schedule saved.');
   pending.current=undefined;setDeprecateArmed(false);setMode('catalogue');setForm(undefined);await load();
  }catch(reason){setError(reason instanceof Error?reason.message:'Unable to save this periodic review schedule. Your draft remains open.');}
  finally{setBusy(false);}
 }
 async function start(record:DueRecord,event:FormEvent){
  event.preventDefault();
  if(!due?.schedule||!record.canStart)return;
  setBusy(true);setError('');setNotice('');
  try{
   const input={kind:'start',scheduleId:due.schedule.id,recordId:record.id,expectedScheduleVersion:due.schedule.version,expectedRecordVersion:record.version};
   const fingerprint=JSON.stringify(input);
   const body=pending.current?.fingerprint===fingerprint?pending.current.body:{...input,operationId:crypto.randomUUID()};
   pending.current={fingerprint,body};
   await call(base,body);
   pending.current=undefined;
   setNotice(`Review started for ${record.name}.`);
   await loadDue(due.schedule.id);
  }catch(reason){setError(reason instanceof Error?reason.message:'Unable to start this review.');}
  finally{setBusy(false);}
 }
 function showDue(item:Summary){setError('');setNotice('');void loadDue(item.id).catch(reason=>setError(reason instanceof Error?reason.message:'Those due records are unavailable.'));}
 function cancel(){setMode('catalogue');setForm(undefined);setError('');setDeprecateArmed(false);pending.current=undefined;void load();}
 const workflows=catalogue?.workflows.filter(item=>item.available)??[];
 return <main className={styles.root}><h1>Periodic record review</h1><p className={styles.help}>Schedule a recurring review for this collection. Starting a review uses the existing review workflow and rechecks the permissions you already have. It does not grant access.</p>{error?<p role="alert" className={styles.error}>{error}</p>:null}{notice?<p role="status">{notice}</p>:null}
  {mode==='catalogue'?<>
   <div className={styles.actions}><button type="button" disabled={busy} onClick={()=>void load()}>Refresh schedules</button>{catalogue?.canManage?<button type="button" disabled={busy} onClick={begin}>New periodic review</button>:null}</div>
   <h2>Schedules</h2>
   <ul className={styles.list}>{items.map(item=><li key={item.id}><strong>{item.name}</strong><span>Revision {item.version}</span><button type="button" disabled={busy} onClick={()=>showDue(item)}>Show records due for {item.name}</button>{catalogue?.canManage?<button type="button" disabled={busy||!item.available} onClick={()=>void openSchedule(item)}>Edit {item.name}</button>:null}</li>)}</ul>
   {catalogue&&!items.length?<p>No active periodic review schedules are available in this collection.</p>:null}
   {cursor?<button type="button" disabled={busy} onClick={()=>void loadSchedules(cursor)}>Load more schedules</button>:null}
   <section aria-label="Records due for review"><h2>Records due for review</h2>
    {due?.withheld?<p>{due.message??'A field is restricted or unavailable.'}</p>:null}
    {due&&!due.withheld&&due.ignored?<p>This schedule is ignored and does not start reviews.</p>:null}
    {due&&!due.withheld&&!due.ignored&&!due.records.length?<p>No records you can view are due for this schedule.</p>:null}
    {due&&!due.withheld&&due.records.length?<ul className={styles.list}>{due.records.map(record=><li key={record.id}><strong>{record.name}</strong><span>Revision {record.version}</span><a href={`${reviewBase}?record=${encodeURIComponent(record.id)}`}>Open {record.name} in review</a>{record.canStart?<form onSubmit={event=>void start(record,event)}><button type="submit" disabled={busy}>Start review for {record.name}</button></form>:null}</li>)}</ul>:null}
    {dueCursor&&due?<button type="button" disabled={busy} onClick={()=>void loadDue(due.schedule.id,dueCursor)}>Load more due records</button>:null}
   </section>
  </>: <form onSubmit={event=>{event.preventDefault();void save('save');}}>
   <h2>{form?'Edit periodic review':'New periodic review'}</h2>
   <label htmlFor="periodic-name">Schedule name</label><input id="periodic-name" value={name} required maxLength={100} onChange={event=>{setName(event.target.value);pending.current=undefined;}}/>
   <label htmlFor="periodic-workflow">Review workflow</label><select id="periodic-workflow" value={workflowId} required onChange={event=>{setWorkflowId(event.target.value);pending.current=undefined;}}><option value="">Choose a workflow</option>{workflows.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select>
   <label htmlFor="periodic-interval">Review every (days)</label><input id="periodic-interval" type="number" min={1} max={3650} required value={intervalDays} onChange={event=>{setIntervalDays(event.target.value);pending.current=undefined;}}/>
   <label htmlFor="periodic-window">Due this many days before the period ends</label><input id="periodic-window" type="number" min={0} max={3650} required value={windowDays} onChange={event=>{setWindowDays(event.target.value);pending.current=undefined;}}/>
   <label htmlFor="periodic-layout">Layout tab or section</label><input id="periodic-layout" value={layoutId} autoComplete="off" placeholder="Optional" onChange={event=>{setLayoutId(event.target.value);pending.current=undefined;}}/><p className={styles.help}>Leave layout and filters blank to include every record in the collection that you can view.</p>
   <label htmlFor="periodic-filter-field">Only records where</label><select id="periodic-filter-field" value={filterField} onChange={event=>{setFilterField(event.target.value);pending.current=undefined;}}><option value="">Whole collection</option>{catalogue?.fields.map(field=><option key={field.key} value={field.key}>{field.label}{field.sensitive?' (sensitive)':''}</option>)}</select>
   {filterField?<><label htmlFor="periodic-filter-operator">Comparison</label><select id="periodic-filter-operator" value={filterOperator} onChange={event=>{setFilterOperator(event.target.value);pending.current=undefined;}}>{operators.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select>{filterOperator!=='empty'?<><label htmlFor="periodic-filter-value">Value</label><input id="periodic-filter-value" value={filterValue} onChange={event=>{setFilterValue(event.target.value);pending.current=undefined;}}/></>:null}</>:null}
   {deprecateArmed?<div className={styles.actions}><p id="periodic-deprecate-text">Deprecate this schedule? It is ignored, and no new review is started from it.</p><button type="button" disabled={busy} onClick={()=>void save('deprecate')}>Confirm deprecation</button><button type="button" disabled={busy} onClick={()=>setDeprecateArmed(false)}>Cancel</button></div>:<div className={styles.actions}><button type="submit" disabled={busy||!catalogue?.canManage}>Save periodic review</button>{form&&!form.deprecated?<button type="button" disabled={busy} onClick={()=>setDeprecateArmed(true)}>Deprecate schedule</button>:null}<button type="button" disabled={busy} onClick={cancel}>Cancel</button></div>}
  </form>}
 </main>;
}
