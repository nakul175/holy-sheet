"use client";
import {useEffect,useRef,useState} from "react";
import type {Page,Space} from "../lib/types";
import {Dialog} from "./editor/rich-editor";
import {ApiError,requestJson} from "./editor/use-document-session";

export default function CreatePage({spaces:allSpaces,parent,workspaceId,onClose,onCreated,onTemplates,initialAsChild=false}:{onTemplates:()=>void;spaces:Space[];parent?:Page;workspaceId:string;onClose:()=>void;onCreated:(p:Page)=>void;initialAsChild?:boolean}){
  const spaces=allSpaces.filter(space=>space.workspaceId===workspaceId);
  const [name,setName]=useState(''),[spaceId,setSpaceId]=useState(parent?.spaceId??spaces[0]?.id??''),[newSpace,setNewSpace]=useState(''),[asChild,setAsChild]=useState(initialAsChild),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setAsChild(initialAsChild);},[initialAsChild]);
  const running=useRef(false),attempt=useRef<{title:string;parentPageId:string|null;destination:string;spaceBody:string|null;pageBody:string|null}|null>(null);
  const [unconfirmed,setUnconfirmed]=useState(false);
  function close(){if(attempt.current&&!confirm('Page creation is unconfirmed. Close without retrying? Check your pages before creating another.'))return;onClose();}
  async function submit(e:React.FormEvent){
    e.preventDefault();if(running.current)return;running.current=true;setBusy(true);setError('');
    try{
      if(!attempt.current)attempt.current={title:name,parentPageId:asChild&&parent?parent.id:null,destination:spaceId,spaceBody:newSpace.trim()?JSON.stringify({name:newSpace,workspaceId,operationId:crypto.randomUUID()}):null,pageBody:null};
      const intent=attempt.current;
      if(intent.spaceBody){
        try{
          const d=await requestJson<{space:Space}>("/api/spaces",{method:'POST',headers:{'content-type':'application/json'},body:intent.spaceBody});
          intent.destination=d.space.id;intent.spaceBody=null;
        }catch(e){
          if(e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==408&&e.status!==429)attempt.current=null;
          throw e;
        }
      }
      intent.pageBody??=JSON.stringify({title:intent.title,spaceId:intent.destination,parentPageId:intent.parentPageId,operationId:crypto.randomUUID()});
      const d=await requestJson<{page:Page}>("/api/pages",{method:'POST',headers:{'content-type':'application/json'},body:intent.pageBody});
      attempt.current=null;setUnconfirmed(false);onCreated(d.page);
    }catch(e){setUnconfirmed(!!attempt.current);setError(attempt.current?'Creation is unconfirmed. Retry to confirm the same space and page.':e instanceof Error?e.message:'Page could not be created.');}
    finally{running.current=false;setBusy(false);}
  }
  return <Dialog title="Create a page" onClose={close}><button disabled={busy||unconfirmed||!spaces.length} onClick={onTemplates}>From template</button><form className="create-page-form" data-create-mode={initialAsChild?'subpage':'page'} onSubmit={submit}><fieldset style={{border:0,padding:0,margin:0,minWidth:0}} disabled={busy||unconfirmed}><label>Title<input maxLength={240} value={name} onChange={e=>setName(e.target.value)} placeholder="Untitled"/></label>{!!spaces.length&&<label>Space<select value={spaceId} onChange={e=>{setSpaceId(e.target.value);setAsChild(false);}}>{spaces.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}<div className="or">{spaces.length?'or create a new space':'Create a space for your first page'}</div><label>New space<input maxLength={80} value={newSpace} onChange={e=>{setNewSpace(e.target.value);setAsChild(false);}} placeholder="e.g. Operations"/></label>{parent&&<label className="check"><input type="checkbox" disabled={spaceId!==parent?.spaceId||!!newSpace.trim()} checked={asChild} onChange={e=>setAsChild(e.target.checked)}/>Create under “{parent.title}”</label>}</fieldset>{error&&<p role="alert" className="form-error">{error}</p>}<div className="actions"><button type="button" onClick={close}>Cancel</button><button className="primary" disabled={busy||(!spaceId&&!newSpace.trim())}>{busy?'Creating…':unconfirmed?'Retry confirmation':'Create page'}</button></div></form></Dialog>;
}
