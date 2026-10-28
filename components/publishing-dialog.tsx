"use client";
import {useEffect,useRef,useState} from 'react';
import type {publishingState,publishedDocument} from '../lib/document-publishing';
import {plainText} from '../lib/document';
import RichEditor,{Dialog} from './editor/rich-editor';
import {ApiError,requestJson} from './editor/use-document-session';
type State=Awaited<ReturnType<typeof publishingState>>;
const ignore=()=>{};
export default function PublishingDialog({pageId,actorId,saved,onClose,onChanged}:{pageId:string;actorId:string;saved:boolean;onClose:()=>void;onChanged:()=>void}){
 const [state,setState]=useState<State|null>(null),[reviewers,setReviewers]=useState<string[]>([]),[selected,setSelected]=useState<string|null>(null),[reason,setReason]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false),[confirmation,setConfirmation]=useState(false);
 const pending=useRef<Record<string,unknown>|null>(null),running=useRef(false);
 const [published,setPublished]=useState<NonNullable<Awaited<ReturnType<typeof publishedDocument>>>|null>(null);
 const endpoint=`/api/v1/pages/${encodeURIComponent(pageId)}/publishing`;
 async function refresh(){const s=await requestJson<State>(endpoint);setState(s);setReviewers(s.reviewers);return s;}
 useEffect(()=>{let alive=true;requestJson<State>(endpoint).then(s=>{if(alive){setState(s);setReviewers(s.reviewers);}}).catch(e=>{if(alive)setError(e.message);});return()=>{alive=false;};},[endpoint]);
 const review=state?.reviews.find(r=>r.id===selected);
 async function send(fields:Record<string,unknown>){
  if(!state||running.current)return;
  if(!saved){setError('Save or resolve your document draft first. Your changes have been kept.');return;}
  const input=pending.current??{operationId:crypto.randomUUID(),expectedVersion:state.version,...fields};pending.current=input;running.current=true;setBusy(true);setError('');setNotice('');
  try{
   await requestJson(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
   pending.current=null;setUncertain(false);setConfirmation(false);setPublished(null);setNotice('Saved. Current permissions still apply.');onChanged();
   try{await refresh();}catch{setState(null);setError('The operation was confirmed, but the current state could not be refreshed. Close and reopen review and publishing.');}
  }catch(e){
   setError(e instanceof Error?e.message:'The result could not be confirmed. Retry the same operation.');
   if(e instanceof ApiError&&e.status<500){pending.current=null;setUncertain(false);setConfirmation(false);if([401,403,404].includes(e.status)){setState(null);setSelected(null);setReason('');}}
   else setUncertain(true);
  }finally{running.current=false;setBusy(false);}
 }
 function close(){if(running.current)return;if(uncertain&&!confirm('This operation is unconfirmed. Closing loses the retry handle; reopen publishing to inspect the result. Close anyway?'))return;onClose();}
 return <Dialog title="Review and publishing" onClose={close}><div className="history-dialog">
  <p>Publishing shares an approved revision with existing readers. Editors keep working on the draft. It creates no public link and grants no access.</p>
  {error&&<p role="alert" className="form-error">{error}</p>}{notice&&<p role="status">{notice}</p>}{busy&&<p role="status">Saving…</p>}
  {uncertain&&<button disabled={busy} onClick={()=>void send({})}>Retry confirmation</button>}
  {!state&&!error&&<p role="status">Loading publishing state…</p>}
  {state&&<><p>Draft version {state.sourceVersion}. {state.publicationId?'An approved revision is published.':'No approved revision is published.'}</p>
   {state.publicationId&&<button disabled={busy||uncertain} onClick={()=>{setPublished(null);void requestJson<NonNullable<Awaited<ReturnType<typeof publishedDocument>>>>(`/api/v1/pages/${encodeURIComponent(pageId)}/publication`).then(setPublished).catch(e=>setError(e.message));}}>Preview published revision</button>}
   {published&&<section aria-label="Published revision preview"><h3>{published.title} · Published version {published.version}</h3><RichEditor key={published.publicationId} document={published.document} editable={false} onChange={ignore} pageId={pageId} preferenceKey={`published:${published.publicationId}`}/></section>}
   {state.canConfigure&&<fieldset disabled={busy||uncertain}><legend>Eligible reviewers</legend><p>Choose existing page editors. An author or submitter cannot approve their own revision.</p>{state.candidates.map(c=><label key={c.id} style={{display:'block'}}><input type="checkbox" checked={reviewers.includes(c.id)} onChange={e=>setReviewers(ids=>e.target.checked?[...ids,c.id]:ids.filter(id=>id!==c.id))}/>{c.name}</label>)}<label style={{display:'block'}}><input type="checkbox" checked={confirmation} onChange={e=>setConfirmation(e.target.checked)}/>I understand enabling publishing hides drafts from readers until approval and publication.</label><button disabled={!saved||!confirmation||!reviewers.length} onClick={()=>void send({action:'configure',reviewers})}>{state.version?'Save reviewer configuration':'Enable review and publishing'}</button></fieldset>}
   {state.version>0&&<button disabled={busy||uncertain||!saved} onClick={()=>void send({action:'submit',sourceVersion:state.sourceVersion})}>Submit saved draft for review</button>}
   <div className="history-versions" aria-label="Submitted revisions">{state.reviews.map(r=><button key={r.id} disabled={busy||uncertain} aria-pressed={r.id===selected} onClick={()=>{setSelected(r.id);setReason('');setConfirmation(false);}}><strong>Version {r.source_version} · {r.state}</strong><span>{new Date(r.submitted_at).toLocaleString()}</span></button>)}</div>
   {state.reviews.length===50&&<p>The latest 50 submissions are shown.</p>}
   {review&&<section aria-label="Submitted revision preview"><h3>{review.title} · Version {review.source_version}</h3><RichEditor key={review.id} document={review.document} editable={false} onChange={ignore} pageId={pageId} preferenceKey={`publication-review:${review.id}`}/><p>{review.manifest.length} accessible pinned references. Restricted sources are omitted.</p>{review.reason&&<p>Decision reason: {review.reason}</p>}
    <label>Decision or withdrawal reason<textarea maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)} disabled={busy||uncertain}/></label>
    {state.canReview&&review.state==='pending'&&review.submitted_by!==actorId&&<div><button disabled={busy||uncertain||!saved||!reason.trim()} onClick={()=>void send({action:'approve',reviewId:review.id,snapshotHash:review.snapshot_hash,reason})}>Approve this snapshot</button><button disabled={busy||uncertain||!saved||!reason.trim()} onClick={()=>void send({action:'reject',reviewId:review.id,snapshotHash:review.snapshot_hash,reason})}>Reject this snapshot</button></div>}
    {state.canPublish&&review.state==='approved'&&<><label style={{display:'block'}}><input type="checkbox" checked={confirmation} onChange={e=>setConfirmation(e.target.checked)}/>Publish this reviewed revision to existing readers, superseding the previous publication.</label><button disabled={busy||uncertain||!saved||!confirmation} onClick={()=>void send({action:'publish',reviewId:review.id,snapshotHash:review.snapshot_hash})}>Publish approved revision</button></>}
    <details><summary>Text alternative</summary><pre style={{whiteSpace:'pre-wrap'}}>{plainText(review.document)}</pre></details>
   </section>}
   {state.canPublish&&state.publicationId&&<section><label>Withdrawal reason<textarea maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)} disabled={busy||uncertain}/></label><button disabled={busy||uncertain||!saved||!reason.trim()} onClick={()=>void send({action:'withdraw',reason})}>Withdraw published revision</button><p>Withdrawal hides this page from ordinary readers until another approved revision is published. The draft and publication audit remain.</p></section>}
  </>}
 </div></Dialog>;
}
