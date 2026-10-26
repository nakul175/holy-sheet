'use client';
import { useEffect,useRef,useState } from 'react';
import type { SharingState,ShareChange } from '../lib/sharing';
import type { GrantRole } from '../lib/types';
import { Dialog } from './editor/rich-editor';
import { ApiError,requestJson } from './editor/use-document-session';

export default function SharingDialog({pageId,onClose}:{pageId:string;onClose:()=>void}){
  const [state,setState]=useState<SharingState|null>(null),[recipient,setRecipient]=useState(''),[role,setRole]=useState<GrantRole>('viewer'),[review,setReview]=useState<{id:string;name:string;role:GrantRole|null}|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const intent=useRef<ShareChange|null>(null);
  const load=async()=>{try{setState(await requestJson<SharingState>(`/api/v1/pages/${pageId}/sharing`));setError('');intent.current=null;}catch(e){setError(e instanceof Error?e.message:'Sharing could not be loaded');}};
  useEffect(()=>{void load();},[pageId]);
  async function apply(){if(!state||!review)return;setBusy(true);setError('');intent.current??={operationId:crypto.randomUUID(),expectedVersion:state.version,recipientId:review.id,role:review.role};
    try{const data=await requestJson<{state:SharingState;effectiveRole?:string|null}>(`/api/v1/pages/${pageId}/sharing`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(intent.current)});setState(data.state);intent.current=null;setReview(null);setNotice(data.effectiveRole?`Confirmed. ${review.name} has ${data.effectiveRole} access, including inherited sources.`:`Confirmed. ${review.name} has no remaining access to this page.`);}
    catch(e){setError(e instanceof Error?e.message:'Could not confirm the sharing change. Retry.');if(e instanceof ApiError&&e.status<500)intent.current=null;}
    finally{setBusy(false);}
  }
  return <Dialog title="Share this page" onClose={onClose}><p>Sharing applies to this page and its existing and future subpages. Parent and sibling pages stay outside this grant.</p>
    {notice&&<p role="status">{notice}</p>}{error&&<div role="alert"><p>{error}</p><button disabled={busy} onClick={()=>void load()}>Refresh access and review</button></div>}
    {!state?<p role="status">Loading current access…</p>:<>
      <form onSubmit={e=>{e.preventDefault();const person=state.members.find(m=>m.id===recipient);if(person){setReview({id:person.id,name:person.name,role});setNotice('');}}}><label>Workspace member<select value={recipient} disabled={busy||!!review} required onChange={e=>setRecipient(e.target.value)}><option value="">Choose a person</option>{state.members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label><label>Role<select value={role} disabled={busy||!!review} onChange={e=>setRole(e.target.value as GrantRole)}><option value="viewer">Viewer — read and download</option><option value="commenter">Commenter — discuss without editing content</option><option value="editor">Editor — edit content and create subpages</option></select></label><button disabled={busy||!!review||!recipient}>Review sharing</button></form>
      {review&&<section className="sharing-review" aria-label="Confirm sharing change"><h3>Review before applying</h3><p><strong>{review.name}</strong>: {review.role===null?'remove the direct grant':`grant ${review.role} access`} to this page and its subpages.</p><p>Inherited grants and ownership remain effective. Removing a direct grant may leave access through another source.</p><div className="actions"><button disabled={busy} onClick={()=>{intent.current=null;setReview(null);}}>Back</button><button className="primary" disabled={busy} onClick={()=>void apply()}>{busy?'Applying…':error?'Retry this change':'Confirm change'}</button></div></section>}
      <h3>Direct recipients</h3>{state.direct.length?<ul className="sharing-list">{state.direct.map(p=><li key={p.id}><span>{p.name} · {p.role}{!p.active?' · inactive member':''}</span><button disabled={busy||!!review} onClick={()=>setReview({id:p.id,name:p.name,role:p.role==='viewer'?'editor':'viewer'})}>Change to {p.role==='viewer'?'Editor':'Viewer'}</button><button disabled={busy||!!review} onClick={()=>setReview({id:p.id,name:p.name,role:null})}>Remove direct grant</button></li>)}</ul>:<p>No direct recipients.</p>}
      <h3>Inherited access</h3>{state.inherited.length?<ul className="sharing-list">{state.inherited.map((g,i)=><li key={`${g.sourceId}:${g.recipientId}:${i}`}><span>{g.recipientName} · {g.role} from {g.sourceTitle}</span>{g.sourceReadable&&<a href={`/pages/${encodeURIComponent(g.sourceId)}`}>Open source page</a>}<small>Change inherited access at its source.</small></li>)}</ul>:<p>No ancestor grants apply.</p>}
    </>}
    <p>Copying a page link does not grant access. Recipients must already have permission.</p>
  </Dialog>;
}
