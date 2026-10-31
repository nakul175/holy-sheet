'use client';
import {useEffect,useState} from 'react';
type Summary={id:string;name:string;version:number};
type Item={id:string;code:string;label:string;order:number;deprecated:boolean;translations:Record<string,string>};
type Definition={tenantId:string;id:string;version:number;name:string;items:Item[]};
type Preview={previewId:string;reviewHash:string};
type SchemaPreview={previewId:string;reviewHash:string;impact:{blockers:string[]}};
type HistoryVersion={version:number;definition:Definition};
const blank=(tenantId:string):Definition=>({tenantId,id:crypto.randomUUID(),version:1,name:'',items:[]});
export default function ReferenceListManager({workspaceId,tenantId}:{workspaceId:string;tenantId:string}){
 const base=`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}`;
 const [lists,setLists]=useState<Summary[]>([]);
 const [definition,setDefinition]=useState<Definition>(()=>blank(tenantId));
 const [persisted,setPersisted]=useState(false);
 const [preview,setPreview]=useState<Preview|null>(null);
 const [collection,setCollection]=useState('organisations');
 const [fieldLabel,setFieldLabel]=useState('');
 const [fieldKind,setFieldKind]=useState<'single-select'|'multi-select'>('single-select');
 const [schemaPreview,setSchemaPreview]=useState<SchemaPreview|null>(null);
 const [history,setHistory]=useState<HistoryVersion[]|null>(null);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [busy,setBusy]=useState(false);
 async function json(url:string,body?:unknown){
  const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const data=await response.json();
  if(!response.ok)throw Error(data.error??'Request failed.');
  return data;
 }
 async function load(){
  setBusy(true);
  try{const data=await json(`${base}/reference-lists`);setLists(data.lists??[]);}
  catch(e){setError(e instanceof Error?e.message:'Unable to load reference lists.');}
  finally{setBusy(false);}
 }
 useEffect(()=>{void load();},[base]);
 function resetDraft(){setDefinition(blank(tenantId));setPersisted(false);setPreview(null);setSchemaPreview(null);setHistory(null);}
 async function open(id:string){
  setBusy(true);setError('');
  try{
   const data=await json(`${base}/reference-lists?listId=${encodeURIComponent(id)}`);
   setDefinition({...data,version:data.version+1});
   setPersisted(true);setPreview(null);setSchemaPreview(null);setHistory(null);
  }catch(e){setError(e instanceof Error?e.message:'Unable to open the list.');}
  finally{setBusy(false);}
 }
 function add(){
  setPreview(null);
  setDefinition(current=>({...current,items:[...current.items,{id:crypto.randomUUID(),code:'ITEM_'+(current.items.length+1),label:'New item',order:current.items.length,deprecated:false,translations:{}}]}));
 }
 function editItem(index:number,patch:Partial<Item>){
  setPreview(null);
  setDefinition(current=>({...current,items:current.items.map((item,itemIndex)=>itemIndex===index?{...item,...patch}:item)}));
 }
 function selection(){return {expectedVersion:definition.version-1,definition};}
 async function review(){
  setBusy(true);setError('');setNotice('');
  try{setPreview(await json(`${base}/reference-lists`,{kind:'preview',selection:selection()}));}
  catch(e){setError(e instanceof Error?e.message:'Unable to review the list.');}
  finally{setBusy(false);}
 }
 async function publish(){
  if(!preview)return;
  setBusy(true);setError('');
  try{
   const data=await json(`${base}/reference-lists`,{kind:'apply',previewId:preview.previewId,reviewHash:preview.reviewHash,operationId:crypto.randomUUID(),selection:selection()});
   setDefinition({...data.definition,version:data.definition.version+1});
   setPersisted(true);setPreview(null);setHistory(null);
   setNotice('Reference list published. Stable item IDs were retained.');
   await load();
  }catch(e){setError(e instanceof Error?e.message:'Unable to publish the list.');}
  finally{setBusy(false);}
 }
 async function showHistory(){
  setBusy(true);setError('');
  try{const data=await json(`${base}/reference-lists?listId=${encodeURIComponent(definition.id)}&history=1`);setHistory(data.versions??[]);}
  catch(e){setHistory(null);setError(e instanceof Error?e.message:'Unable to read configuration history.');}
  finally{setBusy(false);}
 }
 async function reviewField(){
  setBusy(true);setError('');
  try{
   const schema=await json(`${base}/record-schema?collection=${encodeURIComponent(collection)}`);
   setSchemaPreview(await json(`${base}/record-schema`,{kind:'preview',prepareId:crypto.randomUUID(),collection,expectedSchemaVersion:schema.schemaVersion,definition:{label:fieldLabel,kind:fieldKind,required:false,choices:[],referenceListId:definition.id,sensitive:false,unique:false,deprecated:false}}));
  }catch(e){setError(e instanceof Error?e.message:'Unable to review the field binding.');}
  finally{setBusy(false);}
 }
 async function bind(){
  if(!schemaPreview||schemaPreview.impact.blockers.length)return;
  setBusy(true);setError('');
  try{
   await json(`${base}/record-schema`,{kind:'apply',previewId:schemaPreview.previewId,reviewHash:schemaPreview.reviewHash,operationId:crypto.randomUUID()});
   setSchemaPreview(null);setFieldLabel('');
   setNotice('Reference-backed field created after review. Stored values use item IDs.');
  }catch(e){setError(e instanceof Error?e.message:'Unable to create the field.');}
  finally{setBusy(false);}
 }
 return <main>
  <h1>Reference lists</h1>
  <p>Manage tenant-qualified choices. Saved values use stable item IDs; renaming labels never rewrites records. Deprecating an item blocks new choices and keeps values a record already holds.</p>
  {error&&<p role="alert">{error}</p>}
  {notice&&<p role="status">{notice}</p>}
  <nav aria-label="Reference lists"><button type="button" disabled={busy} onClick={resetDraft}>New list</button>{lists.map(list=><button type="button" disabled={busy} key={list.id} onClick={()=>void open(list.id)}>{list.name} (v{list.version})</button>)}</nav>
  <section>
   <h2>List definition</h2>
   <label>Name <input value={definition.name} maxLength={200} onChange={event=>{setPreview(null);setDefinition(current=>({...current,name:event.target.value}));}}/></label>
   <ol>{definition.items.map((item,index)=><li key={item.id}>
    <label>Code <input aria-label={`Item ${index+1} code`} value={item.code} onChange={event=>editItem(index,{code:event.target.value.toUpperCase()})}/></label>
    <label>Label <input aria-label={`Item ${index+1} label`} value={item.label} onChange={event=>editItem(index,{label:event.target.value})}/></label>
    <label><input aria-label={`Item ${index+1} deprecated`} type="checkbox" checked={item.deprecated} onChange={event=>editItem(index,{deprecated:event.target.checked})}/> Deprecated</label>
    <span>Stable ID {item.id}</span>
   </li>)}</ol>
   <button type="button" disabled={busy||definition.items.length>=1000} onClick={add}>Add item</button>
   <button type="button" disabled={busy||!definition.name.trim()} onClick={()=>void review()}>Review list</button>
   {preview&&<section aria-label="List confirmation"><p>Publishing preserves every existing item identity and code.</p><button type="button" disabled={busy} onClick={()=>void publish()}>Publish reviewed list</button></section>}
  </section>
  {persisted&&<section aria-label="Configuration history"><h2>Configuration history</h2><p>History is for list managers. It does not grant access to business records.</p><button type="button" disabled={busy} onClick={()=>void showHistory()}>Show history</button>{history&&<ol>{history.map(version=><li key={version.version}>Version {version.version}<ul>{version.definition.items.map(item=><li key={item.id}>{item.code} · {item.label}{item.deprecated?' · deprecated':''} · {item.id}</li>)}</ul></li>)}</ol>}</section>}
  {persisted&&<section>
   <h2>Create a reference-backed field</h2>
   <label>Collection <input value={collection} maxLength={100} onChange={event=>setCollection(event.target.value)}/></label>
   <label>Field label <input value={fieldLabel} maxLength={100} onChange={event=>setFieldLabel(event.target.value)}/></label>
   <label>Selection type <select value={fieldKind} onChange={event=>setFieldKind(event.target.value as typeof fieldKind)}><option value="single-select">Single select</option><option value="multi-select">Multi select</option></select></label>
   <button type="button" disabled={busy||!collection.trim()||!fieldLabel.trim()} onClick={()=>void reviewField()}>Review field binding</button>
   {schemaPreview&&<section aria-label="Field binding confirmation">{schemaPreview.impact.blockers.length?<p role="alert">{schemaPreview.impact.blockers.join(' ')}</p>:<button type="button" disabled={busy} onClick={()=>void bind()}>Create reviewed field</button>}</section>}
  </section>}
 </main>;
}
