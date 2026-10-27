"use client";
import { useEffect,useRef,useState } from 'react';
import { canEdit,type PageRole } from '../../lib/types';
import { uploadRecoveryRecords } from '../../lib/recovery-client';
import { activeUploadRecoveries,type RecoveredUpload } from '../../lib/upload-recovery-types';
import { acknowledgeUploadRecovery,discardRecoveredUpload,resumeUploadRecovery,unlockUploadRecovery } from '../../lib/upload-recovery';
import { requestJson,ApiError } from './use-document-session';
import type { DocumentPage } from '../../lib/repository';

export default function PendingUploads({pageId,actorId,role,confirmedVersion,onResume}:{pageId:string;actorId:string;role:PageRole;confirmedVersion:number|null;onResume:(upload:RecoveredUpload)=>void}){
 const [entries,setEntries]=useState<RecoveredUpload[]>([]),[error,setError]=useState(''),[expired,setExpired]=useState(0),[busy,setBusy]=useState(false),[refresh,setRefresh]=useState(0);
 const generation=useRef(0),alive=useRef(true),currentRole=useRef(role),signedOut=useRef(false);currentRole.current=role;
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
 useEffect(()=>{const changed=(event:Event)=>{if((event as CustomEvent).detail?.pageId===pageId)setRefresh(n=>n+1);};const again=()=>{if(!signedOut.current)setRefresh(n=>n+1);};const logout=()=>{signedOut.current=true;generation.current++;setEntries([]);setExpired(0);setError('');};window.addEventListener('holy-sheet:logout',logout);window.addEventListener('holy-sheet:upload-recovery',changed);window.addEventListener('online',again);window.addEventListener('focus',again);return()=>{window.removeEventListener('holy-sheet:logout',logout);window.removeEventListener('holy-sheet:upload-recovery',changed);window.removeEventListener('online',again);window.removeEventListener('focus',again);};},[pageId]);
 useEffect(()=>{
  if(!actorId||signedOut.current)return;const token=++generation.current;setError('');
  void(async()=>{try{
   const records=await uploadRecoveryRecords(actorId,pageId),items:RecoveredUpload[]=[];let expiredCount=0,latest:DocumentPage|undefined;
   if(records.some(r=>!activeUploadRecoveries.has(r.id))&&confirmedVersion!==null)latest=(await requestJson<{page:DocumentPage}>(`/api/v1/pages/${pageId}/document`,{signal:AbortSignal.timeout(8000)})).page;
   for(const record of records){
    if(!alive.current||token!==generation.current)return;
    if(activeUploadRecoveries.has(record.id))continue;
    if(Date.parse(record.expiresAt)<=Date.now()){expiredCount++;continue;}
    try{if(latest&&await acknowledgeUploadRecovery(pageId,actorId,record.id,latest.document))continue;items.push(await unlockUploadRecovery(record));}
    catch(e){if(e instanceof ApiError&&[401,403,404].includes(e.status))throw e;if(alive.current&&token===generation.current)setError('Some upload recovery details could not be unlocked. Keep the original files; no attachment was restored.');}
   }
   if(alive.current&&token===generation.current){setEntries(items);setExpired(expiredCount);}
  }catch(e){if(alive.current&&token===generation.current){setEntries([]);setError(e instanceof Error?e.message:'Upload recovery is unavailable');}}})();
 },[pageId,actorId,confirmedVersion,refresh]);
 async function resume(id:string,newPlacement=false){if(busy)return;setBusy(true);setError('');try{const recovered=await resumeUploadRecovery(pageId,actorId,id);if(!alive.current||!canEdit(currentRole.current)){await recovered.release?.();return;}onResume({...recovered,newPlacement});}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Recovery could not be opened');}finally{if(alive.current)setBusy(false);}}
 async function discard(id:string){if(busy)return;setBusy(true);setError('');let recovered:RecoveredUpload|undefined;try{recovered=await resumeUploadRecovery(pageId,actorId,id);if(!alive.current)return;if(!confirm(`Discard the pending upload “${recovered.payload.name}” and its recovery details? The saved page stays intact.`))return;await discardRecoveredUpload(pageId,id,actorId,true);setRefresh(n=>n+1);}catch(e){if(alive.current)setError(e instanceof Error?e.message:'Discard could not be confirmed. The recovery record is retained.');}finally{await recovered?.release?.();if(alive.current)setBusy(false);}}
 const available=entries.filter(e=>!activeUploadRecoveries.has(e.recordId));
 if(!available.length&&!expired&&!error)return null;
 return <section className="pending-uploads" aria-label="Pending upload recovery"><h3>Pending uploads on this device</h3>{error&&<><p role="alert">{error}</p><button disabled={busy} onClick={()=>setRefresh(n=>n+1)}>Retry recovery</button></>}{expired>0&&<p role="status">{expired} upload recovery record{expired===1?' has':'s have'} expired. Reselect the original files; their bytes were not stored on this device.</p>}{available.map(upload=><div key={upload.recordId}><strong>{upload.payload.name}</strong><p>{upload.payload.phase==='ready'?'A verified upload may be available; access and file state will be checked again.':'Reselect the original file to retry. Upload details were recovered, not the original bytes.'} Recovery expires {new Date(upload.protection.expiresAt).toLocaleString()}.</p><button disabled={busy||!canEdit(role)} onClick={()=>void resume(upload.recordId)}>Review / resume upload</button><button disabled={busy||!canEdit(role)} onClick={()=>void resume(upload.recordId,true)}>Add after selected block</button><button disabled={busy} onClick={()=>void navigator.clipboard.writeText(`${upload.payload.name}\n${upload.payload.alt}\n${upload.payload.caption}`).catch(()=>setError('Clipboard unavailable. Select and copy the details.'))}>Copy my details</button><button disabled={busy} onClick={()=>void discard(upload.recordId)}>Discard recovery</button>{!canEdit(role)&&<small>Read-only access permits inspection of your own details, but uploading and attachment are disabled.</small>}</div>)}</section>;
}
