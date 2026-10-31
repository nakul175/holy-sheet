'use client';
import {useEffect,useRef,useState,type FormEvent,type KeyboardEvent} from 'react';
import RecordLayout from './record-layout';
import type {FieldKind} from '../lib/shared-record-types';
import styles from './record-review.module.css';

type Choice={id:string;label:string;deprecated?:boolean};
type Field={key:string;label:string;kind:FieldKind;required:boolean;canWrite:boolean;sensitive?:boolean;calculated?:boolean;choices:Choice[]};
type Catalogue={schemaVersion:number;canManage:boolean;canEdit:boolean;canReview:boolean;fields:Field[]};
type Definition={instructions:string;fields:string[];commentRequired:boolean};
type Summary={id:string;name:string;version:number;available:boolean};
type QueueItem={id:string;workflowId:string;workflowName:string;recordId:string;recordName:string;recordVersion:number;submittedBySelf:boolean;canDecide:boolean};
type OpenReview={id:string;name:string;version:number;deprecated:boolean;definition:Definition;schemaVersion:number;canManage:boolean;canSubmit:boolean;canDecide:boolean;fields:Field[];record?:{id:string;version:number;name:string;state:string;values:Record<string,unknown>};review?:{id:string;status:string;version:number;workflowVersion:number;recordVersion:number;submittedBySelf:boolean;stale:boolean;comment:string|null}};
type Decision='approve'|'reject'|'request-changes';
const tabId='00000000-0000-4000-8000-0000000000b1',sectionId='00000000-0000-4000-8000-0000000000b2';
const decisionLabel:Record<Decision,string>={approve:'approval',reject:'rejection','request-changes':'request for changes'};

export default function RecordReview({workspaceId,tenantId,collection,recordId:initialRecordId}:{workspaceId:string;tenantId:string;collection:string;recordId?:string}){
 const base=`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-review`;
 const [catalogue,setCatalogue]=useState<Catalogue|undefined>(),[items,setItems]=useState<Summary[]>([]),[cursor,setCursor]=useState<string|null>(null),[queue,setQueue]=useState<QueueItem[]>([]),[queueCursor,setQueueCursor]=useState<string|null>(null),[form,setForm]=useState<OpenReview|undefined>(),[mode,setMode]=useState<'catalogue'|'manage'|'case'>('catalogue'),[name,setName]=useState(''),[instructions,setInstructions]=useState(''),[commentRequired,setCommentRequired]=useState(false),[selected,setSelected]=useState<string[]>([]),[recordId,setRecordId]=useState(initialRecordId??''),[comment,setComment]=useState(''),[armed,setArmed]=useState<Decision|undefined>(),[deprecateArmed,setDeprecateArmed]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const pending=useRef<{fingerprint:string;body:unknown}|undefined>(undefined),generation=useRef(0),confirmRef=useRef<HTMLButtonElement>(null);
 async function call(url:string,body?:unknown){
  const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if(!response.ok){
   if(response.status===401||response.status===403||response.status===404){generation.current++;setCatalogue(undefined);setItems([]);setQueue([]);setForm(undefined);setComment('');pending.current=undefined;}
   throw new Error(data.error??'Unable to complete this request. Your draft remains open.');
  }
  return data;
 }
 async function loadWorkflows(next?:string){
  const listed=await call(`${base}?collection=${encodeURIComponent(collection)}${next?`&cursor=${encodeURIComponent(next)}`:''}`);
  setItems(old=>next?[...old,...listed.workflows]:listed.workflows);setCursor(listed.nextCursor);
 }
 async function loadQueue(next?:string){
  const listed=await call(`${base}?collection=${encodeURIComponent(collection)}&queue=pending${next?`&cursor=${encodeURIComponent(next)}`:''}`);
  setQueue(old=>next?[...old,...listed.reviews]:listed.reviews);setQueueCursor(listed.nextCursor);
 }
 async function load(){
  setBusy(true);setError('');
  try{
   const stamp=generation.current;
   const [metadata,listed,queued]=await Promise.all([call(`${base}?collection=${encodeURIComponent(collection)}&form=1`),call(`${base}?collection=${encodeURIComponent(collection)}`),call(`${base}?collection=${encodeURIComponent(collection)}&queue=pending`)]);
   if(stamp!==generation.current)return;
   setCatalogue(metadata);setItems(listed.workflows);setCursor(listed.nextCursor);setQueue(queued.reviews);setQueueCursor(queued.nextCursor);
  }catch(reason){setError(reason instanceof Error?reason.message:'Unable to load review workflows.');}
  finally{setBusy(false);}
 }
 useEffect(()=>{void load();const revoke=()=>{generation.current++;setCatalogue(undefined);setItems([]);setQueue([]);setForm(undefined);setName('');setComment('');pending.current=undefined;};window.addEventListener('hs-session-lock',revoke);return()=>{revoke();window.removeEventListener('hs-session-lock',revoke);};},[base]);
 useEffect(()=>{if(armed)confirmRef.current?.focus();},[armed]);
 function begin(){setForm(undefined);setName('');setInstructions('');setCommentRequired(false);setSelected([]);setArmed(undefined);setDeprecateArmed(false);setMode('manage');pending.current=undefined;}
 function applyOpen(opened:OpenReview,next:typeof mode){setForm(opened);setName(opened.name);setInstructions(opened.definition.instructions);setCommentRequired(opened.definition.commentRequired);setSelected(opened.definition.fields);setRecordId(opened.record?.id??recordId);setComment('');setArmed(undefined);setDeprecateArmed(false);setMode(next);pending.current=undefined;}
 async function openWorkflow(item:Summary,action:'manage'|'case'){
  setBusy(true);setError('');
  try{
   const stamp=generation.current,idValue=recordId.trim(),opened:OpenReview=await call(`${base}?workflowId=${item.id}${action==='case'&&idValue?`&recordId=${encodeURIComponent(idValue)}`:''}`);
   if(stamp!==generation.current)return;
   applyOpen(opened,action);
  }catch(reason){setError(reason instanceof Error?reason.message:'Review workflow unavailable.');}
  finally{setBusy(false);}
 }
 async function openQueued(item:QueueItem){
  setBusy(true);setError('');
  try{const stamp=generation.current,opened:OpenReview=await call(`${base}?reviewId=${item.id}`);if(stamp!==generation.current)return;applyOpen(opened,'case');}
  catch(reason){setError(reason instanceof Error?reason.message:'That review is unavailable.');}
  finally{setBusy(false);}
 }
 async function loadRecord(){
  if(!form)return;setBusy(true);setError('');
  try{const stamp=generation.current,opened:OpenReview=await call(`${base}?workflowId=${form.id}&recordId=${encodeURIComponent(recordId.trim())}`);if(stamp!==generation.current)return;applyOpen(opened,'case');}
  catch(reason){setError(reason instanceof Error?reason.message:'That record is unavailable for this workflow.');}
  finally{setBusy(false);}
 }
 function draft():Definition{return {instructions,fields:selected,commentRequired};}
 async function save(action:'save'|'deprecate'){
  if(!catalogue?.canManage)return;
  setBusy(true);setError('');setNotice('');
  try{
   const input={kind:'save',id:form?.id??crypto.randomUUID(),collection,name,expectedVersion:form?.version??0,deprecated:action==='deprecate',definition:draft()};
   const fingerprint=JSON.stringify({...input,id:form?.id??'new'});
   const body=pending.current?.fingerprint===fingerprint?pending.current.body:{...input,operationId:crypto.randomUUID()};
   pending.current={fingerprint,body};
   const saved=await call(base,body);
   setForm(saved.workflow);setNotice(action==='deprecate'?'Review workflow deprecated. Existing records are unchanged.':'Review workflow saved.');pending.current=undefined;setDeprecateArmed(false);
   if(action==='deprecate'){setMode('catalogue');await load();}
  }catch(reason){setError(reason instanceof Error?reason.message:'Unable to save this workflow. Your draft remains open.');}
  finally{setBusy(false);}
 }
 async function submitReview(event:FormEvent){
  event.preventDefault();
  if(!form?.record||!form.canSubmit)return;
  setBusy(true);setError('');setNotice('');
  try{
   const input={kind:'submit',workflowId:form.id,workflowVersion:form.version,expectedSchemaVersion:form.schemaVersion,recordId:form.record.id,expectedRecordVersion:form.record.version};
   const fingerprint=JSON.stringify(input);
   const body=pending.current?.fingerprint===fingerprint?pending.current.body:{...input,operationId:crypto.randomUUID()};
   pending.current={fingerprint,body};
   const made=await call(base,body);
   setNotice(`Submitted ${form.record.name} for review.`);pending.current=undefined;setMode('catalogue');setForm(undefined);await load();
   void made;
  }catch(reason){setError(reason instanceof Error?reason.message:'Unable to submit this review. Your draft remains open.');}
  finally{setBusy(false);}
 }
 async function decide(event:FormEvent){
  event.preventDefault();
  if(!form?.review||!form.record||!armed||!form.canDecide)return;
  if(form.definition.commentRequired&&armed!=='approve'&&!comment.trim()){setError('Add a review comment before this decision.');return;}
  setBusy(true);setError('');setNotice('');
  try{
   const input={kind:'decide',reviewId:form.review.id,expectedVersion:form.review.version,expectedRecordVersion:form.record.version,expectedSchemaVersion:form.schemaVersion,workflowVersion:form.review.workflowVersion,decision:armed,comment:comment.trim()||undefined};
   const fingerprint=JSON.stringify(input);
   const body=pending.current?.fingerprint===fingerprint?pending.current.body:{...input,operationId:crypto.randomUUID()};
   pending.current={fingerprint,body};
   await call(base,body);
   setNotice(armed==='approve'?'Review approved.':armed==='reject'?'Review rejected.':'Changes requested.');
   pending.current=undefined;setArmed(undefined);setComment('');setMode('catalogue');setForm(undefined);await load();
  }catch(reason){setError(reason instanceof Error?reason.message:'Unable to record this decision. The review remains open.');}
  finally{setBusy(false);}
 }
 function cancelConfirm(event?:KeyboardEvent){if(event&&event.key!=='Escape')return;event?.preventDefault();setArmed(undefined);setDeprecateArmed(false);pending.current=undefined;}
 function cancel(){setMode('catalogue');setForm(undefined);setComment('');setArmed(undefined);setDeprecateArmed(false);setError('');pending.current=undefined;void load();}
 const layoutFields=(form?.fields??[]).map(field=>({key:field.key,label:field.sensitive?`${field.label} (sensitive)`:field.label,required:field.required,canWrite:false}));
 const layoutDefinition={tabs:[{id:tabId,label:form?.name||'Review',sections:[{id:sectionId,label:'Review packet',description:form?.definition.instructions||'',columns:1 as const,fields:[{field:'name',mode:'read' as const},...layoutFields.map(field=>({field:field.key,mode:'read' as const}))]}]}]};
 return <main className={styles.root}><h1>Record review</h1><p className={styles.help}>Signed-in workspace members submit records and decide reviews in this collection. A workflow does not grant access, and it is not a public link.</p>{error&&<p role="alert" className={styles.error}>{error}</p>}{notice&&<p role="status">{notice}</p>}
  {mode==='catalogue'?<>
   <div className={styles.actions}><button type="button" disabled={busy} onClick={()=>void load()}>Refresh reviews</button>{catalogue?.canManage&&<button type="button" disabled={busy} onClick={begin}>New review workflow</button>}</div>
   <label htmlFor="review-record">Record ID</label><input id="review-record" value={recordId} autoComplete="off" onChange={event=>{setRecordId(event.target.value);pending.current=undefined;}}/>
   <h2>Workflows</h2>
   <ul className={styles.list}>{items.map(item=><li key={item.id}><strong>{item.name}</strong><span>Revision {item.version}</span><button type="button" disabled={busy||!item.available} onClick={()=>void openWorkflow(item,'case')}>Review {item.name}</button>{catalogue?.canManage&&<button type="button" disabled={busy} onClick={()=>void openWorkflow(item,'manage')}>Edit {item.name}</button>}</li>)}</ul>
   {catalogue&&!items.length&&<p>No active review workflows are available in this collection.</p>}
   {cursor&&<button type="button" disabled={busy} onClick={()=>void loadWorkflows(cursor)}>Load more workflows</button>}
   <h2>Pending reviews</h2>
   <ul className={styles.list}>{queue.map(item=><li key={item.id}><strong>{item.recordName}</strong><span>{item.workflowName}{item.submittedBySelf?' · You submitted this':''}{item.canDecide?' · You can decide':''}</span><button type="button" disabled={busy} onClick={()=>void openQueued(item)}>Open {item.recordName}</button></li>)}</ul>
   {!queue.length&&<p>No pending reviews are waiting for you.</p>}
   {queueCursor&&<button type="button" disabled={busy} onClick={()=>void loadQueue(queueCursor)}>Load more reviews</button>}
  </>:mode==='manage'?<form onSubmit={event=>{event.preventDefault();void save('save');}}>
   <h2>{form?'Edit review workflow':'New review workflow'}</h2>
   <label htmlFor="review-name">Workflow name</label><input id="review-name" value={name} required maxLength={100} onChange={event=>{setName(event.target.value);pending.current=undefined;}}/>
   <label htmlFor="review-instructions">Instructions</label><textarea id="review-instructions" value={instructions} maxLength={500} onChange={event=>{setInstructions(event.target.value);pending.current=undefined;}}/>
   <label className={styles.check}><input type="checkbox" checked={commentRequired} onChange={event=>{setCommentRequired(event.target.checked);pending.current=undefined;}}/> Require a comment to reject or request changes</label>
   <fieldset><legend>Fields in the review packet</legend>{catalogue?.fields.filter(field=>!field.calculated).map(field=><label className={styles.check} key={field.key}><input type="checkbox" checked={selected.includes(field.key)} onChange={event=>{setSelected(current=>event.target.checked?[...current,field.key]:current.filter(key=>key!==field.key));pending.current=undefined;}}/> {field.label}{field.required?' (required)':''}{field.sensitive?' (sensitive)':''}</label>)}{catalogue?.fields.some(field=>field.calculated)&&<p className={styles.help}>Calculated fields stay off the review. They recompute on the record and are not part of the packet.</p>}</fieldset>
   {deprecateArmed?<div className={styles.actions} onKeyDown={cancelConfirm}><p id="review-deprecate-text">Deprecate this workflow? Records already stored are unchanged.</p><button type="button" disabled={busy} onClick={()=>void save('deprecate')}>Confirm deprecation</button><button type="button" disabled={busy} onClick={()=>setDeprecateArmed(false)}>Cancel</button></div>:<div className={styles.actions}><button type="submit" disabled={busy||!catalogue?.canManage}>Save review workflow</button>{form&&!form.deprecated&&<button type="button" disabled={busy} onClick={()=>setDeprecateArmed(true)}>Deprecate workflow</button>}<button type="button" disabled={busy} onClick={cancel}>Cancel</button></div>}
  </form>:<div>
   <h2>Review {form?.name}</h2>
   {form?.definition.instructions&&<p className={styles.help}>{form.definition.instructions}</p>}
   {form?.review?.submittedBySelf&&form.review.status==='pending'&&<p>You submitted this review. Another member decides it.</p>}
   {form?.review?.stale&&<p role="status">This review is out of date because the record or schema changed. Submit it again to replace the pending review.</p>}
   {form?.review?.comment&&<p>Decision comment: {form.review.comment}</p>}
   <div className={styles.actions}><button type="button" disabled={busy||!recordId.trim()} onClick={()=>void loadRecord()}>Load record</button></div>
   {form?.record&&<p>Record version {form.record.version}. Status {form.record.state}.</p>}
   {form?.record&&<RecordLayout scopeKey={`${form.id}:${form.record.id}:${form.version}`} snapshot={{publicationRevision:form.version,schemaVersion:form.schemaVersion,definition:layoutDefinition}} fields={[{key:'name',label:'Record name',required:false,canWrite:false},...layoutFields]} hasUnsavedChanges={comment.length>0||!!armed} renderField={(field,control)=>{
    if(field.key==='name')return <input id={control.id} value={form.record?.name??''} readOnly/>;
    const meta=form.fields.find(item=>item.key===field.key);if(!meta)return null;
    return <ReviewValue id={control.id} field={meta} value={form.record?.values[field.key]}/>;
   }}/>}
   {armed?<form className={styles.actions} aria-labelledby="review-confirm-text" onSubmit={decide} onKeyDown={cancelConfirm}><p id="review-confirm-text">Confirm {decisionLabel[armed]} of this review?</p><label htmlFor="review-comment">Comment{form?.definition.commentRequired&&armed!=='approve'?'':' (optional)'}</label><textarea id="review-comment" value={comment} required={!!form?.definition.commentRequired&&armed!=='approve'} maxLength={1000} onChange={event=>{setComment(event.target.value);pending.current=undefined;}}/><button ref={confirmRef} type="submit" disabled={busy}>Confirm {decisionLabel[armed]}</button><button type="button" disabled={busy} onClick={()=>cancelConfirm()}>Cancel</button></form>:form?.canDecide&&<div className={styles.actions}><button type="button" disabled={busy} onClick={()=>setArmed('approve')}>Approve</button><button type="button" disabled={busy} onClick={()=>setArmed('reject')}>Reject</button><button type="button" disabled={busy} onClick={()=>setArmed('request-changes')}>Request changes</button></div>}
   <form className={styles.actions} onSubmit={submitReview}>{form?.canSubmit&&<button type="submit" disabled={busy||!form.record}>Submit for review</button>}<button type="button" disabled={busy} onClick={cancel}>Back to reviews</button></form>
  </div>}
 </main>;
}
function held(value:unknown){if(typeof value==='string'&&value)return new Set([value]);if(Array.isArray(value))return new Set(value.filter((item):item is string=>typeof item==='string'));return new Set<string>();}
function ReviewValue({id,field,value}:{id:string;field:Field;value:unknown}){
 if(field.kind==='boolean')return <input id={id} type="checkbox" checked={value===true} disabled readOnly/>;
 if(field.kind==='single-select'||field.kind==='multi-select'){
  const options=field.choices.filter(choice=>!choice.deprecated||held(value).has(choice.id));
  return <select id={id} multiple={field.kind==='multi-select'} disabled value={field.kind==='multi-select'?Array.isArray(value)?value as string[]:[]:String(value??'')}>{field.kind==='single-select'&&<option value="">Not set</option>}{options.map(choice=><option key={choice.id} value={choice.id}>{choice.deprecated?`${choice.label} (deprecated)`:choice.label}</option>)}</select>;
 }
 const text=value==null?'':typeof value==='string'||typeof value==='number'?String(value):JSON.stringify(value);
 if(field.kind==='long-text')return <textarea id={id} readOnly value={text}/>;
 const type=field.kind==='number'?'text':field.kind==='date'?'date':field.kind==='email'?'email':field.kind==='phone'?'tel':'text';
 return <input id={id} type={type} inputMode={field.kind==='phone'?'tel':field.kind==='number'?'decimal':undefined} readOnly value={text}/>;
}
