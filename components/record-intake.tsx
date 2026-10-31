'use client';
import {useEffect,useRef,useState} from 'react';
import RecordLayout from './record-layout';
import type {FieldKind} from '../lib/shared-record-types';
import styles from './record-intake.module.css';

type Choice={id:string;label:string;deprecated?:boolean};
type Field={key:string;label:string;kind:FieldKind;required:boolean;canWrite:boolean;sensitive?:boolean;calculated?:boolean;choices:Choice[]};
type Catalogue={schemaVersion:number;canCreate:boolean;canEdit:boolean;canManage:boolean;fields:Field[]};
type Relationships={parentOrganisation:boolean;legalOrganisations:boolean;accounts:boolean};
type Definition={purpose:'create'|'update';instructions:string;rename:boolean;fields:string[];relationships:Relationships};
type Summary={id:string;name:string;version:number;purpose:'create'|'update';available:boolean};
type OpenForm={id:string;name:string;version:number;deprecated:boolean;definition:Definition;schemaVersion:number;canSubmit:boolean;canManage:boolean;fields:Field[];record?:{id:string;version:number;name:string;state:string;values:Record<string,unknown>}};
const emptyRelationships=():Relationships=>({parentOrganisation:false,legalOrganisations:false,accounts:false});
const tabId='00000000-0000-4000-8000-0000000000a1',sectionId='00000000-0000-4000-8000-0000000000a2';

export default function RecordIntake({workspaceId,tenantId,collection}:{workspaceId:string;tenantId:string;collection:string}){
 const base=`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-intake`;
 const [catalogue,setCatalogue]=useState<Catalogue|undefined>(undefined),[items,setItems]=useState<Summary[]>([]),[cursor,setCursor]=useState<string|null>(null),[form,setForm]=useState<OpenForm|undefined>(undefined),[mode,setMode]=useState<'catalogue'|'manage'|'fill'>('catalogue'),[name,setName]=useState(''),[instructions,setInstructions]=useState(''),[purpose,setPurpose]=useState<'create'|'update'>('create'),[rename,setRename]=useState(false),[selected,setSelected]=useState<string[]>([]),[relationships,setRelationships]=useState<Relationships>(emptyRelationships()),[recordName,setRecordName]=useState(''),[values,setValues]=useState<Record<string,unknown>>({}),[recordId,setRecordId]=useState(''),[recordVersion,setRecordVersion]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const pending=useRef<{fingerprint:string;body:unknown}|undefined>(undefined),generation=useRef(0);
 const needsParent=collection==='accounts',needsLegal=collection==='contracts';
 async function call(url:string,body?:unknown){
  const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if(!response.ok){
   if(response.status===401||response.status===403||response.status===404){generation.current++;setCatalogue(undefined);setItems([]);setForm(undefined);setValues({});setRecordName('');setName('');pending.current=undefined;}
   throw new Error(data.error??'Unable to complete this request. Your draft remains open.');
  }
  return data;
 }
 async function load(next?:string){
  setBusy(true);setError('');
  try{
   const stamp=generation.current;
   const [metadata,listed]=await Promise.all([call(`${base}?collection=${encodeURIComponent(collection)}&form=1`),call(`${base}?collection=${encodeURIComponent(collection)}${next?`&cursor=${encodeURIComponent(next)}`:''}`)]);
   if(stamp!==generation.current)return;
   setCatalogue(metadata);setItems(old=>next?[...old,...listed.forms]:listed.forms);setCursor(listed.nextCursor);
  }catch(reason){setError(reason instanceof Error?reason.message:'Unable to load intake forms.');}
  finally{setBusy(false);}
 }
 useEffect(()=>{void load();const revoke=()=>{generation.current++;setCatalogue(undefined);setItems([]);setForm(undefined);setValues({});setName('');setRecordName('');pending.current=undefined;};window.addEventListener('hs-session-lock',revoke);return()=>{revoke();window.removeEventListener('hs-session-lock',revoke);};},[base]);
 function begin(){setForm(undefined);setName('');setInstructions('');setPurpose('create');setRename(false);setSelected([]);setRelationships({...emptyRelationships(),parentOrganisation:needsParent,legalOrganisations:needsLegal});setMode('manage');pending.current=undefined;}
 async function open(item:Summary,action:'manage'|'fill'){
  setBusy(true);setError('');
  try{
   const stamp=generation.current,opened:OpenForm=await call(`${base}?formId=${item.id}`);
   if(stamp!==generation.current)return;
   setForm(opened);setName(opened.name);setInstructions(opened.definition.instructions);setPurpose(opened.definition.purpose);setRename(opened.definition.rename);setSelected(opened.definition.fields);setRelationships(opened.definition.relationships);setRecordName(opened.record?.name??'');setValues({...(opened.record?.values??{})});setRecordId(opened.record?.id??'');setRecordVersion(opened.record?String(opened.record.version):'');setMode(action);pending.current=undefined;
  }catch(reason){setError(reason instanceof Error?reason.message:'Intake form unavailable.');}
  finally{setBusy(false);}
 }
 async function loadRecord(){
  if(!form)return;setBusy(true);setError('');
  try{
   const stamp=generation.current,opened:OpenForm=await call(`${base}?formId=${form.id}&recordId=${encodeURIComponent(recordId)}`);
   if(stamp!==generation.current)return;
   setForm(opened);setRecordName(opened.record?.name??'');setValues({...(opened.record?.values??{})});setRecordVersion(opened.record?String(opened.record.version):'');pending.current=undefined;
  }catch(reason){setError(reason instanceof Error?reason.message:'That record is unavailable for this form.');}
  finally{setBusy(false);}
 }
 function draftDefinition():Definition{
  return {purpose,instructions,rename:purpose==='update'&&rename,fields:selected,relationships:purpose==='update'?emptyRelationships():{parentOrganisation:needsParent||relationships.parentOrganisation,legalOrganisations:needsLegal||relationships.legalOrganisations,accounts:needsLegal&&relationships.accounts}};
 }
 async function submit(action:'save'|'deprecate'|'submit'){
  if(!catalogue&&action!=='submit'||action==='submit'&&!form)return;
  setBusy(true);setError('');setNotice('');
  try{
   let body:unknown;
   if(action==='save'||action==='deprecate'){
    const input={kind:'save',id:form?.id??crypto.randomUUID(),collection,name,expectedVersion:form?.version??0,deprecated:action==='deprecate',definition:draftDefinition()};
    const fingerprint=JSON.stringify({...input,id:form?.id??'new'});
    if(pending.current?.fingerprint===fingerprint)body=pending.current.body;else{body={...input,operationId:crypto.randomUUID()};pending.current={fingerprint,body};}
    const saved=await call(base,body);
    setForm(saved.form);setNotice(action==='deprecate'?'Intake form deprecated. Existing records are unchanged.':'Intake form saved.');pending.current=undefined;
    if(action==='deprecate'){setMode('catalogue');await load();}
   }else if(form&&catalogue){
    const valuesToStore=Object.fromEntries(Object.entries(values).filter(([key])=>form.fields.some(field=>field.key===key&&!field.calculated)));
    const parentOrganisationId=typeof values.parentOrganisationId==='string'?values.parentOrganisationId:'';
    const legalOrganisationIds=listValue(values.legalOrganisationIds),accountIds=listValue(values.accountIds);
    const input={kind:'submit',formId:form.id,formVersion:form.version,expectedSchemaVersion:form.schemaVersion,name:form.definition.purpose==='create'||form.definition.rename?recordName:undefined,values:valuesToStore,...(form.definition.purpose==='update'?{record:{id:recordId,expectedVersion:Number(recordVersion)}}:{}),...(form.definition.relationships.parentOrganisation&&parentOrganisationId?{parentOrganisationId}:{}),...(form.definition.relationships.legalOrganisations&&legalOrganisationIds.length?{legalOrganisationIds}:{}),...(form.definition.relationships.accounts&&accountIds.length?{accountIds}:{})};
    const fingerprint=JSON.stringify(input);
    if(pending.current?.fingerprint===fingerprint)body=pending.current.body;else{body={...input,operationId:crypto.randomUUID()};pending.current={fingerprint,body};}
    const made=await call(base,body);
    setNotice(`${form.definition.purpose==='create'?'Created':'Updated'} ${made.record.name}. Record version ${made.record.version}.`);
    setMode('catalogue');setForm(undefined);setValues({});setRecordName('');pending.current=undefined;await load();
   }
  }catch(reason){setError(reason instanceof Error?reason.message:'Unable to submit. Your draft remains open.');}
  finally{setBusy(false);}
 }
 function cancel(){setMode('catalogue');setForm(undefined);setValues({});setRecordName('');setError('');pending.current=undefined;void load();}
 const layoutFields=(form?.fields??[]).map(field=>({key:field.key,label:field.sensitive?`${field.label} (sensitive)`:field.label,required:field.required,canWrite:field.canWrite}));
 const layoutDefinition={tabs:[{id:tabId,label:form?.name||'Intake',sections:[{id:sectionId,label:'Fields',description:form?.definition.instructions||'',columns:1 as const,fields:[{field:'name',mode:(form?.definition.purpose==='update'&&!form.definition.rename?'read':'edit') as 'edit'|'read'},...layoutFields.map(field=>({field:field.key,mode:(field.canWrite?'edit':'read') as 'edit'|'read'}))]}]}]};
 return <main className={styles.root}><h1>Internal intake</h1><p className={styles.help}>Signed-in workspace members use these forms to create or update records in this collection. A form does not grant access, and it is not a public link.</p>{error&&<p role="alert" className={styles.error}>{error}</p>}{notice&&<p role="status">{notice}</p>}
  {mode==='catalogue'?<>
   <div className={styles.actions}><button type="button" disabled={busy} onClick={()=>void load()}>Refresh forms</button>{catalogue?.canManage&&<button type="button" disabled={busy} onClick={begin}>New intake form</button>}</div>
   <ul className={styles.list}>{items.map(item=><li key={item.id}><strong>{item.name}</strong><span>{item.purpose==='create'?'Creates a record':'Updates a record'} · Revision {item.version}</span><button type="button" disabled={busy||!item.available} onClick={()=>void open(item,'fill')}>Fill {item.name}</button>{catalogue?.canManage&&<button type="button" disabled={busy} onClick={()=>void open(item,'manage')}>Edit {item.name}</button>}</li>)}</ul>
   {catalogue&&!items.length&&<p>No active intake forms are available in this collection.</p>}
   {cursor&&<button type="button" disabled={busy} onClick={()=>void load(cursor)}>Load more forms</button>}
  </>:mode==='manage'?<form onSubmit={event=>{event.preventDefault();void submit('save');}}>
   <h2>{form?'Edit intake form':'New intake form'}</h2>
   <label htmlFor="intake-name">Form name</label><input id="intake-name" value={name} required maxLength={100} onChange={event=>{setName(event.target.value);pending.current=undefined;}}/>
   <label htmlFor="intake-instructions">Instructions</label><textarea id="intake-instructions" value={instructions} maxLength={500} onChange={event=>{setInstructions(event.target.value);pending.current=undefined;}}/>
   <fieldset><legend>What this form does</legend>
    <label className={styles.check}><input type="radio" name="intake-purpose" value="create" checked={purpose==='create'} onChange={()=>{setPurpose('create');setRelationships(current=>({...current,parentOrganisation:needsParent||current.parentOrganisation,legalOrganisations:needsLegal||current.legalOrganisations}));pending.current=undefined;}}/> Create a record</label>
    <label className={styles.check}><input type="radio" name="intake-purpose" value="update" checked={purpose==='update'} onChange={()=>{setPurpose('update');setRelationships(emptyRelationships());pending.current=undefined;}}/> Update a record</label>
    {purpose==='update'&&<label className={styles.check}><input type="checkbox" checked={rename} onChange={event=>{setRename(event.target.checked);pending.current=undefined;}}/> Allow the form to rename the record</label>}
   </fieldset>
   <fieldset><legend>Fields on this form</legend>{catalogue?.fields.filter(field=>!field.calculated).map(field=><label className={styles.check} key={field.key}><input type="checkbox" checked={selected.includes(field.key)} disabled={!field.canWrite} onChange={event=>{setSelected(current=>event.target.checked?[...current,field.key]:current.filter(key=>key!==field.key));pending.current=undefined;}}/> {field.label}{field.required?' (required)':''}{field.sensitive?' (sensitive)':''}</label>)}{catalogue?.fields.some(field=>field.calculated)&&<p className={styles.help}>Calculated fields stay off the form. They recompute after the record is saved.</p>}</fieldset>
   {purpose==='create'&&(needsParent||needsLegal)&&<fieldset><legend>Required relationships</legend>{needsParent&&<label className={styles.check}><input type="checkbox" checked disabled/> Parent organisation</label>}{needsLegal&&<label className={styles.check}><input type="checkbox" checked disabled/> Legal organisation</label>}{needsLegal&&<label className={styles.check}><input type="checkbox" checked={relationships.accounts} onChange={event=>{setRelationships(current=>({...current,accounts:event.target.checked}));pending.current=undefined;}}/> Covered accounts</label>}</fieldset>}
   <div className={styles.actions}><button type="submit" disabled={busy||!catalogue?.canManage}>Save intake form</button>{form&&!form.deprecated&&<button type="button" disabled={busy} onClick={()=>void submit('deprecate')}>Deprecate form</button>}<button type="button" disabled={busy} onClick={cancel}>Cancel</button></div>
  </form>:<form onSubmit={event=>{event.preventDefault();void submit('submit');}}>
   <h2>Fill {form?.name}</h2>
   {form?.definition.instructions&&<p className={styles.help}>{form.definition.instructions}</p>}
   {form?.definition.purpose==='update'&&<fieldset><legend>Record to update</legend><label htmlFor="intake-record">Record ID</label><input id="intake-record" value={recordId} required onChange={event=>{setRecordId(event.target.value);pending.current=undefined;}}/><label htmlFor="intake-version">Expected version</label><input id="intake-version" inputMode="numeric" value={recordVersion} required onChange={event=>{setRecordVersion(event.target.value);pending.current=undefined;}}/><button type="button" disabled={busy||!recordId} onClick={()=>void loadRecord()}>Load record</button></fieldset>}
   {form&&<RecordLayout scopeKey={form.id} snapshot={{publicationRevision:form.version,schemaVersion:form.schemaVersion,definition:layoutDefinition}} fields={[{key:'name',label:'Record name',required:form.definition.purpose==='create'||form.definition.rename,canWrite:form.definition.purpose==='create'||form.definition.rename},...layoutFields]} hasUnsavedChanges={recordName.length>0||Object.keys(values).length>0} renderField={(field,control)=>{
    if(field.key==='name')return <input id={control.id} value={recordName} required={form.definition.purpose==='create'||form.definition.rename} maxLength={200} readOnly={control.readOnly} onChange={event=>{if(!control.readOnly){setRecordName(event.target.value);pending.current=undefined;}}}/>;
    const meta=form.fields.find(item=>item.key===field.key);if(!meta)return null;
    return <IntakeValue id={control.id} field={meta} value={values[field.key]} readOnly={control.readOnly||!meta.canWrite} onChange={value=>{setValues(current=>({...current,[field.key]:value}));pending.current=undefined;}}/>;
   }}/>}
   {form?.definition.purpose==='create'&&form.definition.relationships.parentOrganisation&&<label htmlFor="intake-parent">Parent organisation ID<input id="intake-parent" value={String(values.parentOrganisationId??'')} required onChange={event=>{setValues(current=>({...current,parentOrganisationId:event.target.value}));pending.current=undefined;}}/></label>}
   {form?.definition.purpose==='create'&&form.definition.relationships.legalOrganisations&&<label htmlFor="intake-legal">Legal organisation IDs<input id="intake-legal" value={Array.isArray(values.legalOrganisationIds)?values.legalOrganisationIds.join(' '):''} required onChange={event=>{setValues(current=>({...current,legalOrganisationIds:event.target.value.split(/[\s,]+/).filter(Boolean)}));pending.current=undefined;}}/></label>}
   {form?.definition.purpose==='create'&&form.definition.relationships.accounts&&<label htmlFor="intake-accounts">Account IDs<input id="intake-accounts" value={Array.isArray(values.accountIds)?values.accountIds.join(' '):''} onChange={event=>{setValues(current=>({...current,accountIds:event.target.value.split(/[\s,]+/).filter(Boolean)}));pending.current=undefined;}}/></label>}
   <div className={styles.actions}><button type="submit" disabled={busy||!form?.canSubmit}>Submit intake</button><button type="button" disabled={busy} onClick={cancel}>Cancel</button></div>
  </form>}
 </main>;
}
function listValue(value:unknown){return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];}
function held(value:unknown){if(typeof value==='string'&&value)return new Set([value]);if(Array.isArray(value))return new Set(value.filter((item):item is string=>typeof item==='string'));return new Set<string>();}
function IntakeValue({id,field,value,readOnly,onChange}:{id:string;field:Field;value:unknown;readOnly:boolean;onChange:(value:unknown)=>void}){
 if(field.kind==='boolean')return <input id={id} type="checkbox" checked={value===true} disabled={readOnly} onChange={event=>onChange(event.target.checked)}/>;
 if(field.kind==='single-select'||field.kind==='multi-select'){
  const options=field.choices.filter(choice=>!choice.deprecated||held(value).has(choice.id));
  return <select id={id} multiple={field.kind==='multi-select'} disabled={readOnly} value={field.kind==='multi-select'?Array.isArray(value)?value as string[]:[]:String(value??'')} onChange={event=>onChange(field.kind==='multi-select'?Array.from(event.target.selectedOptions,option=>option.value):event.target.value)}>{field.kind==='single-select'&&<option value="">Choose</option>}{options.map(choice=><option key={choice.id} value={choice.id}>{choice.deprecated?`${choice.label} (deprecated)`:choice.label}</option>)}</select>;
 }
 if(field.kind==='long-text')return <textarea id={id} readOnly={readOnly} maxLength={20000} value={value==null?'':String(value)} onChange={event=>onChange(event.target.value)}/>;
 if(field.kind==='currency'){
  const current=value&&typeof value==='object'?value as {currency?:string;minorUnits?:string;scale?:number}:{};
  const next=(patch:Partial<{currency:string;minorUnits:string;scale:number}>)=>onChange({currency:current.currency??'',minorUnits:current.minorUnits??'',scale:current.scale??2,...patch});
  return <span><input id={id} aria-label="Currency code" readOnly={readOnly} maxLength={3} value={current.currency??''} onChange={event=>next({currency:event.target.value.toUpperCase()})}/> <input aria-label="Minor units" readOnly={readOnly} value={current.minorUnits??''} onChange={event=>next({minorUnits:event.target.value})}/> <input aria-label="Scale" readOnly={readOnly} inputMode="numeric" value={String(current.scale??2)} onChange={event=>next({scale:Number(event.target.value)})}/></span>;
 }
 const type=field.kind==='number'?'number':field.kind==='date'?'date':field.kind==='email'?'email':field.kind==='phone'?'tel':'text';
 return <input id={id} type={type} inputMode={field.kind==='phone'?'tel':undefined} readOnly={readOnly} maxLength={field.kind==='phone'?40:2000} value={value==null?'':String(value)} onChange={event=>onChange(field.kind==='number'?(event.target.value===''?null:Number(event.target.value)):event.target.value)}/>;
}
