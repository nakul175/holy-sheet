'use client';
import {useId,useState,type ReactNode,type KeyboardEvent} from 'react';
import type {RecordLayoutDefinition} from '../lib/record-layout-definition';
import styles from './record-layout.module.css';
export type LayoutField={key:string;label:string;required:boolean;canWrite:boolean};
export type LayoutSnapshot={publicationRevision:number;schemaVersion:number;definition:RecordLayoutDefinition};
type Props={scopeKey:string;snapshot:LayoutSnapshot;fields:LayoutField[];hasUnsavedChanges:boolean;conditions?:{field:string;visible:boolean;required:boolean}[];renderField:(field:LayoutField,control:{id:string;readOnly:boolean})=>ReactNode};
export default function RecordLayout(props:Props){return <FrozenLayout key={props.scopeKey} {...props}/>;}
function FrozenLayout({snapshot,fields,conditions=[],hasUnsavedChanges,renderField}:Props){
 const [opened,setOpened]=useState(snapshot),[active,setActive]=useState(snapshot.definition.tabs[0]?.id),prefix=useId();
 const states=new Map(conditions.map(c=>[c.field,c])),retaining=fields.some(f=>states.get(f.key)?.visible===false),currentFields=new Map(fields.filter(f=>states.get(f.key)?.visible!==false).map(f=>[f.key,{...f,required:f.required||!!states.get(f.key)?.required}])),tabs=opened.definition.tabs.map(t=>({...t,sections:t.sections.map(s=>({...s,fields:s.fields.filter(f=>currentFields.has(f.field))})).filter(s=>s.fields.length)})).filter(t=>t.sections.length),activeId=tabs.some(t=>t.id===active)?active:tabs[0]?.id;
 const changed=opened.publicationRevision!==snapshot.publicationRevision||opened.schemaVersion!==snapshot.schemaVersion;
 const keyboard=(event:KeyboardEvent<HTMLButtonElement>,index:number)=>{const length=tabs.length;let next:number|undefined;if(event.key==='ArrowRight')next=(index+1)%length;else if(event.key==='ArrowLeft')next=(index+length-1)%length;else if(event.key==='Home')next=0;else if(event.key==='End')next=length-1;if(next!==undefined){event.preventDefault();setActive(tabs[next].id);const controls=event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');controls?.[next]?.focus();}};
 return <div className={styles.root}>
  {retaining&&<p className={styles.help} role="note">Hidden fields retain their values. Clear them only with an explicit permitted edit.</p>}
  {changed&&<div className={styles.notice}><p role="status">An updated layout is available. Your current form is unchanged.</p><button type="button" disabled={hasUnsavedChanges} onClick={()=>{setOpened(snapshot);setActive(snapshot.definition.tabs[0]?.id);}}>Use updated layout</button>{hasUnsavedChanges&&<p className={styles.help}>Save or discard your changes before switching layouts.</p>}</div>}
  {!tabs.length?<p role="status">No fields are currently available.</p>:<>
   <div className={styles.tabs} role="tablist" aria-label="Record sections">{tabs.map((tab,index)=><button key={tab.id} type="button" role="tab" id={prefix+'-tab-'+tab.id} aria-controls={prefix+'-panel-'+tab.id} aria-selected={tab.id===activeId} tabIndex={tab.id===activeId?0:-1} onClick={()=>setActive(tab.id)} onKeyDown={e=>keyboard(e,index)}>{tab.label}</button>)}</div>
   {tabs.map(tab=><div key={tab.id} role="tabpanel" id={prefix+'-panel-'+tab.id} aria-labelledby={prefix+'-tab-'+tab.id} hidden={tab.id!==activeId} tabIndex={0}>{tab.sections.map(section=><fieldset key={section.id} className={styles.section}><legend>{section.label}</legend>{section.description&&<p className={styles.help}>{section.description}</p>}<div className={section.columns===2?styles.two:styles.one}>{section.fields.map(slot=>{const field=currentFields.get(slot.field)!,id=prefix+'-field-'+field.key;return <div className={styles.field} key={field.key}><label htmlFor={id}>{field.label}{field.required&&<span aria-hidden="true"> *</span>}</label>{renderField(field,{id,readOnly:slot.mode==='read'||!field.canWrite})}</div>;})}</div></fieldset>)}</div>)}
  </>}
 </div>;
}
