'use client';
import {useRef,useState} from 'react';
import {Dialog} from './editor/rich-editor';
import {ApiError,requestJson} from './editor/use-document-session';
import type {WorkspaceSummary} from '../lib/workspace-navigation';
export default function CreateWorkspaceDialog({source,onClose,onCreated}:{source:WorkspaceSummary;onClose:()=>void;onCreated:(workspace:WorkspaceSummary)=>void}){
 const [name,setName]=useState(''),[busy,setBusy]=useState(false),[unconfirmed,setUnconfirmed]=useState(false),[error,setError]=useState('');
 const running=useRef(false),pending=useRef<string|null>(null);
 function close(){if(running.current)return;if(pending.current&&!confirm('Workspace creation is unconfirmed. Close and check your workspaces before creating another?'))return;onClose();}
 async function submit(e:React.FormEvent){e.preventDefault();if(running.current)return;running.current=true;setBusy(true);setError('');const retrying=!!pending.current;
  try{
   pending.current??=JSON.stringify({name,sourceWorkspaceId:source.id,operationId:crypto.randomUUID()});
   const result=await requestJson<{workspace:WorkspaceSummary;acknowledgedOperationId:string}>('/api/v1/workspace-creations',{method:'POST',headers:{'content-type':'application/json'},body:pending.current});
   if(result.acknowledgedOperationId!==JSON.parse(pending.current).operationId||!result.workspace?.id)throw Error('Workspace acknowledgement did not match');
   pending.current=null;setUnconfirmed(false);onCreated(result.workspace);
  }catch(e){if(!retrying&&e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==408&&e.status!==429)pending.current=null;setUnconfirmed(!!pending.current);setError(pending.current?'Workspace creation is unconfirmed. Retry to confirm the same workspace.':e instanceof Error?e.message:'Workspace could not be created.');}
  finally{running.current=false;setBusy(false);}
 }
 return <Dialog title="Create a workspace" onClose={close}><p>You will own the new workspace. Add a space and your first page after creating it.</p><form onSubmit={submit}><label>Workspace name<input value={name} maxLength={80} disabled={busy||unconfirmed} onChange={e=>setName(e.target.value)} autoFocus/></label>{error&&<p role="alert">{error}</p>}<div className="actions"><button type="button" disabled={busy} onClick={close}>Cancel</button><button disabled={busy||!name.trim()}>{busy?'Creating…':unconfirmed?'Retry confirmation':'Create workspace'}</button></div></form></Dialog>;
}
