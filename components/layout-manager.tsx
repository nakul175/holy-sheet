'use client';
import {useCallback,useEffect,useState} from 'react';
import RecordLayout,{type LayoutField} from './record-layout';
import type {RecordLayoutDefinition} from '../lib/record-layout-definition';
import styles from './layout-manager.module.css';

type Field={key:string;label:string;required:boolean;canWrite:boolean};
type Preview={previewId:string;reviewHash:string;definition:RecordLayoutDefinition};
type DraftResponse={draft:{definition:RecordLayoutDefinition}|null;draft_version:number;publication_revision:number};
type PublishedResponse={schemaVersion:number;fields:Field[];definition:RecordLayoutDefinition};

const limits={tabs:10,sections:20,slots:110};

function blank():RecordLayoutDefinition{
 return {tabs:[{id:crypto.randomUUID(),label:'General',sections:[{id:crypto.randomUUID(),label:'Details',description:'',columns:1,fields:[]}]}]};
}
function normalize(source:RecordLayoutDefinition):RecordLayoutDefinition{
 return {tabs:source.tabs.map(tab=>({...tab,sections:tab.sections.map(section=>({...section,description:section.description??'',columns:section.columns===2?2:1,fields:section.fields.map(slot=>({field:slot.field,mode:slot.mode==='read'?'read':'edit'}))}))}))};
}
function slots(definition:RecordLayoutDefinition){return definition.tabs.flatMap(tab=>tab.sections.flatMap(section=>section.fields));}
function draftProblem(definition:RecordLayoutDefinition){
 const sections=definition.tabs.flatMap(tab=>tab.sections);
 if(!definition.tabs.length||definition.tabs.length>limits.tabs||sections.length>limits.sections||slots(definition).length>limits.slots)return 'Stay within ten tabs, twenty sections and 110 slots.';
 if(definition.tabs.some(tab=>!tab.label.trim()||!tab.sections.length)||sections.some(section=>!section.label.trim()||!section.fields.length))return 'Every tab and section needs a label and at least one field.';
 if(new Set(slots(definition).map(slot=>slot.field)).size!==slots(definition).length)return 'Each field can be placed once.';
 return '';
}

export default function LayoutManager({workspaceId,tenantId,collection}:{workspaceId:string;tenantId:string;collection:string}){
 const base=`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-layouts`;
 const [fields,setFields]=useState<Field[]>([]);
 const [definition,setDefinition]=useState<RecordLayoutDefinition>(blank);
 const [draftVersion,setDraftVersion]=useState(0);
 const [publicationRevision,setPublicationRevision]=useState(0);
 const [schemaVersion,setSchemaVersion]=useState(1);
 const [preview,setPreview]=useState<Preview|null>(null);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [busy,setBusy]=useState(false);

 const call=useCallback(async(body?:unknown)=>{
  const url=body?base:`${base}?collection=${encodeURIComponent(collection)}&includeDraft=1`;
  const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const payload=await response.json();
  if(!response.ok)throw Error(payload.error??'Layout request failed.');
  return payload;
 },[base,collection]);
 const load=useCallback(async()=>{
  setBusy(true);
  try{
   const payload=await call() as {draft:DraftResponse;published:PublishedResponse};
   if(!payload.draft||!Array.isArray(payload.published?.fields))throw Error('Unable to load layout.');
   setFields(payload.published.fields);
   setSchemaVersion(payload.published.schemaVersion);
   setPublicationRevision(payload.draft.publication_revision);
   setDraftVersion(payload.draft.draft_version);
   const source=payload.draft.draft?.definition??payload.published.definition;
   setDefinition(source?.tabs?.length?normalize(source):blank());
  }catch(cause){setError(cause instanceof Error?cause.message:'Unable to load layout.');}
  finally{setBusy(false);}
 },[call]);
 useEffect(()=>{void load();},[load]);

 function edit(recipe:(current:RecordLayoutDefinition)=>void){
  setPreview(null);
  setDefinition(current=>{const next=structuredClone(current);recipe(next);return next;});
 }
 const placed=new Set(slots(definition).map(slot=>slot.field));
 const unplaced=fields.filter(field=>!placed.has(field.key));
 const sectionCount=definition.tabs.reduce((count,tab)=>count+tab.sections.length,0);
 const slotCount=slots(definition).length;
 const catalogue:LayoutField[]=fields.map(field=>({key:field.key,label:field.label,required:field.required,canWrite:field.canWrite}));

 async function save(){
  const problem=draftProblem(definition);
  setError(problem);
  setNotice('');
  if(problem)return;
  setBusy(true);
  try{
   const payload=await call({kind:'save',collection,expectedVersion:draftVersion,expectedSchemaVersion:schemaVersion,operationId:crypto.randomUUID(),definition});
   setDraftVersion(payload.version);
   setPreview(null);
   setNotice('Layout draft saved. Record values were not changed.');
  }catch(cause){setError(cause instanceof Error?cause.message:'Unable to save layout.');}
  finally{setBusy(false);}
 }
 async function review(){
  setBusy(true);
  setError('');
  try{setPreview(await call({kind:'preview',collection,sourceVersion:draftVersion,expectedPublicationRevision:publicationRevision,expectedSchemaVersion:schemaVersion}));}
  catch(cause){setPreview(null);setError(cause instanceof Error?cause.message:'Unable to review publication.');}
  finally{setBusy(false);}
 }
 async function publish(){
  if(!preview)return;
  setBusy(true);
  setError('');
  try{
   const payload=await call({kind:'publish',previewId:preview.previewId,reviewHash:preview.reviewHash,operationId:crypto.randomUUID(),confirm:'publish-record-layout'});
   setPublicationRevision(payload.publicationRevision);
   setPreview(null);
   setNotice('Layout published. Open forms keep their current layout until safely switched.');
  }catch(cause){setError(cause instanceof Error?cause.message:'Unable to publish layout.');}
  finally{setBusy(false);}
 }

 return <main className={styles.root}>
  <h1>Record layout</h1>
  <p className={styles.intro}>Arrange stable field IDs into tabs, sections and slots. Drafts can be incomplete. Publishing checks that every active required field is editable and reachable. This screen does not store or rewrite record values, and arranging a field does not grant access.</p>
  {error&&<p className={styles.alert} role="alert">{error}</p>}
  {notice&&<p role="status">{notice}</p>}
  <fieldset disabled={busy}>
   <legend>Draft arrangement</legend>
   {definition.tabs.map((tab,tabIndex)=><section className={styles.tab} key={tab.id} aria-label={`Tab ${tab.label||tabIndex+1}`}>
    <div className={styles.row}>
     <label>Tab label <input aria-label={`Tab ${tabIndex+1} label`} maxLength={100} value={tab.label} onChange={event=>edit(next=>{next.tabs[tabIndex].label=event.target.value;})} /></label>
     <button type="button" disabled={definition.tabs.length<=1} onClick={()=>edit(next=>{next.tabs.splice(tabIndex,1);})}>Remove tab</button>
    </div>
    {tab.sections.map((section,sectionIndex)=><fieldset className={styles.section} key={section.id} aria-label={`Section ${section.label||sectionIndex+1}`}>
     <legend>Section</legend>
     <div className={styles.stack}>
      <label>Section label <input aria-label={`Tab ${tabIndex+1} section ${sectionIndex+1} label`} maxLength={100} value={section.label} onChange={event=>edit(next=>{next.tabs[tabIndex].sections[sectionIndex].label=event.target.value;})} /></label>
      <label>Description <textarea aria-label={`Tab ${tabIndex+1} section ${sectionIndex+1} description`} maxLength={500} value={section.description} onChange={event=>edit(next=>{next.tabs[tabIndex].sections[sectionIndex].description=event.target.value;})} /></label>
      <label>Columns <select aria-label={`Tab ${tabIndex+1} section ${sectionIndex+1} columns`} value={section.columns} onChange={event=>edit(next=>{next.tabs[tabIndex].sections[sectionIndex].columns=Number(event.target.value)===2?2:1;})}><option value={1}>One column</option><option value={2}>Two columns</option></select></label>
     </div>
     {section.fields.map((slot,fieldIndex)=>{
      const field=fields.find(item=>item.key===slot.field);
      return <div className={styles.slot} key={slot.field}>
       <strong>{field?.label??slot.field}{field?.required?' (required)':''}</strong>
       <label>Mode <select aria-label={`Mode for ${field?.label??slot.field}`} value={slot.mode} onChange={event=>edit(next=>{next.tabs[tabIndex].sections[sectionIndex].fields[fieldIndex].mode=event.target.value==='read'?'read':'edit';})}><option value="edit">Editable</option><option value="read">Read only</option></select></label>
       <button type="button" disabled={fieldIndex===0} onClick={()=>edit(next=>{const list=next.tabs[tabIndex].sections[sectionIndex].fields;[list[fieldIndex-1],list[fieldIndex]]=[list[fieldIndex],list[fieldIndex-1]];})}>Move up</button>
       <button type="button" disabled={fieldIndex===section.fields.length-1} onClick={()=>edit(next=>{const list=next.tabs[tabIndex].sections[sectionIndex].fields;[list[fieldIndex+1],list[fieldIndex]]=[list[fieldIndex],list[fieldIndex+1]];})}>Move down</button>
       <button type="button" onClick={()=>edit(next=>{next.tabs[tabIndex].sections[sectionIndex].fields.splice(fieldIndex,1);})}>Remove field</button>
      </div>;
     })}
     <div className={styles.row}>
      <label>Add field <select aria-label={`Add field to ${section.label||`section ${sectionIndex+1}`}`} defaultValue="" onChange={event=>{const key=event.target.value;event.currentTarget.value='';if(!key||placed.has(key)||slotCount>=limits.slots)return;edit(next=>{next.tabs[tabIndex].sections[sectionIndex].fields.push({field:key,mode:'edit'});});}}><option value="">Choose a field</option>{unplaced.map(field=><option key={field.key} value={field.key}>{field.label}{field.required?' (required)':''}</option>)}</select></label>
      <button type="button" disabled={tab.sections.length<=1} onClick={()=>edit(next=>{next.tabs[tabIndex].sections.splice(sectionIndex,1);})}>Remove section</button>
     </div>
    </fieldset>)}
    <button type="button" disabled={sectionCount>=limits.sections} onClick={()=>edit(next=>{next.tabs[tabIndex].sections.push({id:crypto.randomUUID(),label:'New section',description:'',columns:1,fields:[]});})}>Add section</button>
   </section>)}
   <button type="button" disabled={definition.tabs.length>=limits.tabs} onClick={()=>edit(next=>{next.tabs.push({id:crypto.randomUUID(),label:'New tab',sections:[{id:crypto.randomUUID(),label:'New section',description:'',columns:1,fields:[]}]});})}>Add tab</button>
  </fieldset>
  {!!unplaced.length&&<p className={styles.meta}>Not placed: {unplaced.map(field=>`${field.label}${field.required?' (required)':''}`).join(', ')}. Required fields must be editable before publication.</p>}
  <p className={styles.meta}>Draft {draftVersion} · publication {publicationRevision}</p>
  <div className={styles.actions}>
   <button type="button" disabled={busy} onClick={()=>void save()}>Save draft</button>
   <button type="button" disabled={busy||draftVersion===0} onClick={()=>void review()}>Review publication</button>
  </div>
  {preview&&<section className={styles.preview} aria-label="Publication confirmation">
   <h2>Confirm publication</h2>
   <p>This publishes the reviewed draft. Open forms keep the layout they already loaded. Record values and permissions stay unchanged.</p>
   <RecordLayout scopeKey={`${collection}:layout-preview:${preview.previewId}`} snapshot={{publicationRevision,schemaVersion,definition:preview.definition}} fields={catalogue} hasUnsavedChanges={false} renderField={(field,control)=><input id={control.id} readOnly value="" aria-label={field.label} />} />
   <button type="button" disabled={busy} onClick={()=>void publish()}>Publish reviewed layout</button>
  </section>}
 </main>;
}
