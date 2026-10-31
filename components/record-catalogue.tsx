'use client';
import {useEffect,useRef,useState} from 'react';
import type {FieldKind} from '../lib/shared-record-types';
import styles from './record-catalogue.module.css';

type Collection={id:string;name:string;core:boolean;deprecated:boolean;version:number;description:string};
type Item={id:string;label:string;deprecated:boolean};
type Reference={id:string;name:string;version:number;items:Item[]};
type Field={key:string;label:string;kind:FieldKind;required:boolean;sensitive:boolean;deprecated:boolean;core:boolean;version:number;choices:string[];referenceListId?:string;referenceList?:Reference};
type Listed={schemaVersion:number;collections:Collection[];truncated:boolean};
type Described={schemaVersion:number;collection:Collection;fields:Field[]};
const kindLabels:Record<FieldKind,string>={text:'Text','long-text':'Long text',number:'Number',currency:'Currency',date:'Date',boolean:'Yes or no','single-select':'Single select','multi-select':'Multiple select',email:'Email',phone:'Phone',url:'URL',attachment:'Attachment',record:'Record reference'};

export default function RecordCatalogue({workspaceId,tenantId,collection:initialCollection}:{workspaceId:string;tenantId:string;collection?:string}){
 const base=`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-catalogue`;
 const recordsHref=`/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/records`;
 const [schemaVersion,setSchemaVersion]=useState<number|undefined>(),[collections,setCollections]=useState<Collection[]>([]),[truncated,setTruncated]=useState(false),[openId,setOpenId]=useState<string|undefined>(),[fields,setFields]=useState<Field[]|undefined>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const generation=useRef(0),openRef=useRef<string|undefined>(undefined);
 function clear(){generation.current++;openRef.current=undefined;setSchemaVersion(undefined);setCollections([]);setTruncated(false);setOpenId(undefined);setFields(undefined);}
 async function call<T>(url:string):Promise<T>{
  const response=await fetch(url,{credentials:'same-origin',cache:'no-store'});
  const data=await response.json();
  if(!response.ok){
   if(response.status===401||response.status===403||response.status===404)clear();
   throw new Error(typeof data.error==='string'?data.error:'The data catalogue is unavailable.');
  }
  return data as T;
 }
 async function load(){
  const stamp=++generation.current;
  setBusy(true);setError('');setFields(undefined);
  try{
   const listed=await call<Listed>(base);
   if(stamp!==generation.current)return;
   setSchemaVersion(listed.schemaVersion);setCollections(listed.collections);setTruncated(listed.truncated);
   const preferred=openRef.current&&listed.collections.some(item=>item.id===openRef.current)?openRef.current:undefined;
   const requested=preferred??(initialCollection&&listed.collections.some(item=>item.id===initialCollection)?initialCollection:undefined);
   if(!requested){openRef.current=undefined;setOpenId(undefined);setFields(undefined);return;}
   const described=await call<Described>(`${base}?collection=${encodeURIComponent(requested)}`);
   if(stamp!==generation.current)return;
   openRef.current=requested;setSchemaVersion(described.schemaVersion);setOpenId(requested);setFields(described.fields);
  }catch(reason){setError(reason instanceof Error?reason.message:'The data catalogue is unavailable.');}
  finally{setBusy(false);}
 }
 async function toggle(id:string){
  if(openId===id){generation.current++;openRef.current=undefined;setOpenId(undefined);setFields(undefined);return;}
  const stamp=++generation.current;
  setBusy(true);setError('');
  try{
   const described=await call<Described>(`${base}?collection=${encodeURIComponent(id)}`);
   if(stamp!==generation.current)return;
   openRef.current=id;setSchemaVersion(described.schemaVersion);setOpenId(id);setFields(described.fields);
  }catch(reason){setError(reason instanceof Error?reason.message:'That collection is unavailable.');}
  finally{setBusy(false);}
 }
 useEffect(()=>{void load();const revoke=()=>clear();window.addEventListener('hs-session-lock',revoke);return()=>{revoke();window.removeEventListener('hs-session-lock',revoke);};},[base,initialCollection]);
 const open=collections.find(item=>item.id===openId);
 return <main className={styles.root}>
  <p className={styles.help}>Holy Sheet · shared data</p>
  <h1>Data catalogue</h1>
  <p className={styles.help}>Collections and field definitions you can view. Each opening checks the current collection and field permissions. Restricted definitions are omitted, and this catalogue does not show record values or grant access.</p>
  <p><a href={recordsHref}>Back to records</a></p>
  <div className={styles.actions}><button type="button" disabled={busy} onClick={()=>void load()}>Refresh catalogue</button></div>
  {schemaVersion!==undefined?<p className={styles.help}>Schema version {schemaVersion}</p>:null}
  {error?<p className={styles.error} role="alert">{error}</p>:null}
  <ul className={styles.list}>{collections.map(item=>{
   const expanded=item.id===openId;
   return <li key={item.id}>
    <button type="button" aria-expanded={expanded} disabled={busy} onClick={()=>void toggle(item.id)}>{expanded?`Hide fields for ${item.name}`:`Show fields for ${item.name}`}</button>
    <strong>{item.name}</strong>
    <span>{item.core?'Built-in collection':'Custom collection'}{item.deprecated?' · deprecated':''}</span>
    {item.description?<p className={styles.help}>{item.description}</p>:null}
    {expanded&&open&&fields?<section aria-label={`Fields for ${open.name}`}>
     {fields.length?<ul className={styles.fields}>{fields.map(field=><li key={field.key}>
      <h2>{field.label}</h2>
      <dl>
       <dt>Field ID</dt><dd><code>{field.key}</code></dd>
       <dt>Type</dt><dd>{kindLabels[field.kind]}</dd>
       <dt>Required</dt><dd>{field.required?'Required':'Optional'}</dd>
       <dt>Definition</dt><dd>{field.core?'Built-in':'Custom'} · version {field.version}{field.deprecated?' · deprecated':''}{field.sensitive?' · sensitive':''}</dd>
       {field.referenceList?<><dt>Reference list</dt><dd>{field.referenceList.name}</dd><dt>List ID</dt><dd><code>{field.referenceList.id}</code></dd><dt>Reference choices</dt><dd><ul>{field.referenceList.items.map(choice=><li key={choice.id}><code>{choice.id}</code> {choice.label}{choice.deprecated?' (deprecated)':''}</li>)}</ul></dd></>:null}
       {!field.referenceList&&field.choices.length?<><dt>Choices</dt><dd><ul>{field.choices.map(choice=><li key={choice}>{choice}</li>)}</ul></dd></>:null}
      </dl>
     </li>)}</ul>:<p>No field definitions are available in this collection.</p>}
    </section>:null}
   </li>;
  })}</ul>
  {!busy&&!collections.length&&!error?<p>No collections are available in this catalogue.</p>:null}
  {truncated?<p className={styles.help}>More collections you can view are not shown on this page.</p>:null}
 </main>;
}
