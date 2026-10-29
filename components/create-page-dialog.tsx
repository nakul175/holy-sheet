"use client";
import {useEffect,useRef,useState} from "react";
import type {Page,Space} from "../lib/types";
import {Dialog} from "./editor/rich-editor";
import {requestJson} from "./editor/use-document-session";

export default function CreatePage({spaces,parent,onClose,onCreated,onTemplates,initialAsChild=false}:{onTemplates:()=>void;spaces:Space[];parent:Page;onClose:()=>void;onCreated:(p:Page)=>void;initialAsChild?:boolean}){
  const [name,setName]=useState(''),[spaceId,setSpaceId]=useState(parent.spaceId),[newSpace,setNewSpace]=useState(''),[asChild,setAsChild]=useState(initialAsChild),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{setAsChild(initialAsChild);},[initialAsChild]);
  const running=useRef(false),attempt=useRef<string|null>(null);
  const [unconfirmed,setUnconfirmed]=useState(false);
  function close(){if(attempt.current&&!confirm('Page creation is unconfirmed. Close without retrying? Check your pages before creating another.'))return;onClose();}
  async function submit(e:React.FormEvent){
    e.preventDefault();if(running.current)return;running.current=true;setBusy(true);setError('');
    try{
      if(!attempt.current){
        let destination=spaceId;
        if(newSpace.trim()){
          const d=await requestJson<{space:Space}>("/api/spaces",{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:newSpace,workspaceId:parent.workspaceId})});
          destination=d.space.id;
        }
        // Keep the exact request after an uncertain response, including the newly
        // created destination. The server replays the committed creation intent.
        attempt.current=JSON.stringify({title:name,spaceId:destination,parentPageId:asChild?parent.id:null,operationId:crypto.randomUUID()});
      }
      const d=await requestJson<{page:Page}>("/api/pages",{method:'POST',headers:{'content-type':'application/json'},body:attempt.current});
      attempt.current=null;setUnconfirmed(false);onCreated(d.page);
    }catch(e){setUnconfirmed(!!attempt.current);setError(attempt.current?'Page creation is unconfirmed. Retry to confirm the same page.':e instanceof Error?e.message:'Page could not be created.');}
    finally{running.current=false;setBusy(false);}
  }
  return <Dialog title="Create a page" onClose={close}><button disabled={busy||unconfirmed} onClick={onTemplates}>From template</button><form className="create-page-form" data-create-mode={initialAsChild?'subpage':'page'} onSubmit={submit}><fieldset disabled={busy||unconfirmed}><label>Title<input maxLength={240} value={name} onChange={e=>setName(e.target.value)} placeholder="Untitled"/></label><label>Space<select value={spaceId} onChange={e=>{setSpaceId(e.target.value);setAsChild(false);}}>{spaces.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><div className="or">or create a new space</div><label>New space<input maxLength={80} value={newSpace} onChange={e=>{setNewSpace(e.target.value);setAsChild(false);}} placeholder="e.g. Operations"/></label><label className="check"><input type="checkbox" disabled={spaceId!==parent.spaceId||!!newSpace.trim()} checked={asChild} onChange={e=>setAsChild(e.target.checked)}/>Create under “{parent.title}”</label></fieldset>{error&&<p role="alert" className="form-error">{error}</p>}<div className="actions"><button type="button" onClick={close}>Cancel</button><button className="primary" disabled={busy}>{busy?'Creating…':unconfirmed?'Retry confirmation':'Create page'}</button></div></form></Dialog>;
}
