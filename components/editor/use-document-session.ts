"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DocumentPage } from "../../lib/repository";
import { canEdit } from "../../lib/types";
import { ensureIds, mergeDocuments, stableStringify, type RichNode } from "../../lib/document";
import { decryptDraft, discardDraft, importDraftKey, recoveryDrafts, storeDraft, type DraftProtection, type RecoveryRecord } from "../../lib/recovery-client";

export class ApiError extends Error { constructor(message:string,public status:number,public code:string,public retryAfter=0){super(message);} }
export async function requestJson<T>(url:string,options?:RequestInit):Promise<T>{const r=await fetch(url,{cache:"no-store",...options});const data=await r.json();if(!r.ok)throw new ApiError(data.error??"Request failed",r.status,data.code,Number(r.headers.get("retry-after")??0));return data;}
const post=(body:unknown):RequestInit=>({method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
const signature=(title:string,document:RichNode)=>stableStringify([title,document]);
type SavePayload = {operationId:string;baseVersion:number;title:string;document:RichNode};
export type SaveStatus="loading"|"saved"|"saving"|"unsaved"|"offline"|"error"|"conflict"|"readonly";
export function useDocumentSession(pageId:string,onSaved?:()=>void){
  const [page,setPage]=useState<DocumentPage|null>(null),[status,setStatus]=useState<SaveStatus>("loading"),[error,setError]=useState(""),[recoveryError,setRecoveryError]=useState(""),[candidates,setCandidates]=useState<RecoveryRecord[]>([]),[latest,setLatest]=useState<DocumentPage|null>(null);
  const current=useRef<DocumentPage|null>(null),actor=useRef(""),protection=useRef<DraftProtection|null>(null),pending=useRef<SavePayload|null>(null),saving=useRef(false),dirty=useRef(false),generation=useRef(0),attempts=useRef(0),alive=useRef(true),saveTimer=useRef<ReturnType<typeof setTimeout>|null>(null),maxTimer=useRef<ReturnType<typeof setTimeout>|null>(null),retryTimer=useRef<ReturnType<typeof setTimeout>|null>(null),draftTimer=useRef<ReturnType<typeof setTimeout>|null>(null),saveFunction=useRef<()=>Promise<void>>(async()=>{});
  const blocked=useRef(false);
  const restoredFrom=useRef<string|null>(null);
  const setCurrent=(next:DocumentPage)=>{current.current=next;setPage(next);};
  const establish=useCallback(async(p:DocumentPage)=>{if(!canEdit(p.role))return;try{const id=crypto.randomUUID();const response=await requestJson<{id:string;key:string;expiresAt:string}>(`/api/v1/pages/${pageId}/drafts`,post({id}));protection.current={id,key:await importDraftKey(response.key),expiresAt:response.expiresAt};setRecoveryError("");}catch{setRecoveryError("Recovery unavailable — keep this tab open until your changes are saved.");}},[pageId]);
  useEffect(()=>{alive.current=true;let cancelled=false;void (async()=>{try{const d=await requestJson<{page:DocumentPage;actorId:string}>(`/api/v1/pages/${pageId}/document`);if(cancelled)return;actor.current=d.actorId;setCurrent(d.page);setStatus(!canEdit(d.page.role)?"readonly":"saved");await establish(d.page);try{const old=await recoveryDrafts(d.actorId,pageId);if(!cancelled)setCandidates(old);}catch{setRecoveryError("Recovery storage is unavailable in this browser.");}}catch(e){if(!cancelled){setError(e instanceof Error?e.message:"Page unavailable");setStatus("error");}}})();return()=>{cancelled=true;alive.current=false;protection.current=null;for(const timer of [saveTimer,maxTimer,retryTimer,draftTimer])if(timer.current)clearTimeout(timer.current);};},[pageId,establish]);

  const checkpoint=useCallback(async()=>{const p=current.current,k=protection.current;if(!p||!k||!dirty.current)return;try{if(Date.parse(k.expiresAt)<=Date.now())throw new Error('Recovery lease expired');await storeDraft(k,actor.current,pageId,{title:p.title,document:p.document,baseVersion:p.version});}catch{setRecoveryError("Recovery storage failed — your changes still need a confirmed save.");}},[pageId]);
  useEffect(()=>{let stopped=false;const renew=async()=>{const p=current.current,k=protection.current;if(!p||!k||!canEdit(p.role)||!dirty.current||!navigator.onLine)return;try{const ids=new Set<string>();const visit=(n:RichNode)=>{if((n.type==='image'||n.type==='file')&&typeof n.attrs?.attachmentId==='string')ids.add(n.attrs.attachmentId);n.content?.forEach(visit);};visit(p.document);const result=await requestJson<{expiresAt:string}>(`/api/v1/pages/${pageId}/drafts`,post({id:k.id,renew:true,attachmentIds:[...ids],baseVersion:p.version}));if(!stopped&&protection.current===k){k.expiresAt=result.expiresAt;await checkpoint();setRecoveryError('');}}catch{if(!stopped)setRecoveryError('Recovery protection could not be renewed. Keep this tab open until your changes are saved.');}};const timer=setInterval(()=>void renew(),60_000);window.addEventListener('online',renew);return()=>{stopped=true;clearInterval(timer);window.removeEventListener('online',renew);};},[pageId,checkpoint]);
  const save=useCallback(async()=>{
    const p=current.current;if(!p||!dirty.current||saving.current||blocked.current||!canEdit(p.role))return;
    if(!navigator.onLine){setStatus("offline");void checkpoint();return;}
    saving.current=true;setStatus("saving");const token=generation.current;
    const operation=pending.current??{operationId:crypto.randomUUID(),baseVersion:p.version,title:p.title,document:structuredClone(p.document)};pending.current=operation;
    let succeeded=false;
    try{
      const result=await requestJson<{page:DocumentPage;acknowledgedOperationId:string}>(`/api/v1/pages/${pageId}/operations`,post(operation));
      if(!alive.current)return;
      if(result.acknowledgedOperationId!==operation.operationId)throw new Error("Save acknowledgement mismatch");
      pending.current=null;attempts.current=0;succeeded=true;
      const now=current.current!;
      const unchanged=token===generation.current&&signature(now.title,now.document)===signature(operation.title,operation.document);
      if(unchanged){setCurrent(result.page);dirty.current=false;setStatus("saved");if(protection.current)await discardDraft(protection.current.id).catch(()=>{});if(restoredFrom.current){await discardDraft(restoredFrom.current).catch(()=>{});restoredFrom.current=null;}}
      else {
        const remoteChanged=signature(result.page.title,result.page.document)!==signature(operation.title,operation.document);
        const merged=remoteChanged?mergeDocuments(operation.document,result.page.document,now.document):now.document;
        const titleConflict=now.title!==operation.title&&result.page.title!==operation.title&&now.title!==result.page.title;
        if(!merged||titleConflict){blocked.current=true;setLatest(result.page);setStatus("conflict");}
        else{setCurrent({...now,document:merged,title:now.title===operation.title?result.page.title:now.title,version:result.page.version,updatedAt:result.page.updatedAt});setStatus("unsaved");}
      }
      setError("");onSaved?.();
    }catch(e){
      if(!alive.current)return;
      const failure=e instanceof ApiError?e:new ApiError("Could not confirm the save. Your draft is retained.",503,"network_error");setError(failure.message);void checkpoint();
      if(failure.status===409){blocked.current=true;setStatus("conflict");try{const d=await requestJson<{page:DocumentPage}>(`/api/v1/pages/${pageId}/document`);setLatest(d.page);}catch{setError("Access changed; reconnect and sign in to recover your draft.");}}
      else if([401,404].includes(failure.status)||(failure.status===403&&failure.code==='read_only')){protection.current=null;setStatus("readonly");if(failure.status!==403){setPage(null);current.current=null;}else if(current.current)setCurrent({...current.current,role:"viewer"});}
      else{setStatus(navigator.onLine?"error":"offline");if(failure.status>=500||failure.status===429){const delay=Math.max(failure.retryAfter*1000,Math.min(30_000,1000*2**attempts.current++));retryTimer.current=setTimeout(()=>void saveFunction.current(),delay+Math.random()*300);}else pending.current=null;}
    }finally{saving.current=false;if(succeeded&&alive.current&&dirty.current&&!pending.current&&!blocked.current)saveTimer.current=setTimeout(()=>void saveFunction.current(),750);}
  },[pageId,onSaved,checkpoint]);
  saveFunction.current=save;

  function change(patch:Partial<Pick<DocumentPage,"title"|"document">>){const p=current.current;if(!p||!canEdit(p.role))return;const next={...p,...patch};if(signature(next.title,next.document)===signature(p.title,p.document))return;setCurrent(next);generation.current++;dirty.current=true;setStatus(latest?"conflict":"unsaved");
    if(saveTimer.current)clearTimeout(saveTimer.current);if(draftTimer.current)clearTimeout(draftTimer.current);
    draftTimer.current=setTimeout(()=>void checkpoint(),900);
    if(!latest){saveTimer.current=setTimeout(()=>void saveFunction.current(),750);if(!maxTimer.current)maxTimer.current=setTimeout(()=>{maxTimer.current=null;void saveFunction.current();},5000);}
  }
  useEffect(()=>{const online=()=>{if(dirty.current&&!latest)void saveFunction.current();};const leave=(e:BeforeUnloadEvent)=>{if(dirty.current){void checkpoint();e.preventDefault();e.returnValue="";}};const hide=()=>{if(document.visibilityState==="hidden")void checkpoint();};const clear=()=>{protection.current=null;};window.addEventListener("online",online);window.addEventListener("beforeunload",leave);document.addEventListener("visibilitychange",hide);window.addEventListener("holy-sheet:logout",clear);return()=>{window.removeEventListener("online",online);window.removeEventListener("beforeunload",leave);document.removeEventListener("visibilitychange",hide);window.removeEventListener("holy-sheet:logout",clear);};},[checkpoint,latest]);

  async function restore(candidate:RecoveryRecord){try{const data=await requestJson<{key:string}>(`/api/v1/pages/${pageId}/drafts`,post({id:candidate.id,existingOnly:true}));const draft=await decryptDraft(candidate,await importDraftKey(data.key));if(!current.current)return;restoredFrom.current=candidate.id;setCurrent({...current.current,title:draft.title,document:draft.document,version:draft.baseVersion});generation.current++;dirty.current=true;pending.current=null;setCandidates([]);setStatus("unsaved");void saveFunction.current();}catch(e){setRecoveryError(e instanceof Error?e.message:"Draft cannot be unlocked");}}
  async function discard(candidate:RecoveryRecord){await discardDraft(candidate.id);setCandidates(c=>c.filter(x=>x.id!==candidate.id));}
  async function keepLatest(){if(!latest)return;dirty.current=false;pending.current=null;blocked.current=false;setCurrent(latest);setLatest(null);setStatus(!canEdit(latest.role)?"readonly":"saved");if(protection.current)await discardDraft(protection.current.id);}
  function keepBoth(){if(!latest||!current.current)return;const recovered=ensureIds(current.current.document,true);const heading:RichNode={type:"heading",attrs:{id:crypto.randomUUID(),level:2},content:[{type:"text",text:"Recovered draft"}]};setCurrent({...latest,document:{type:"doc",content:[...(latest.document.content??[]),heading,...(recovered.content??[])]}});generation.current++;pending.current=null;dirty.current=true;blocked.current=false;setLatest(null);setStatus("unsaved");void saveFunction.current();}
  function acceptExternal(next:DocumentPage){if(dirty.current||saving.current||pending.current){blocked.current=true;setLatest(next);setStatus('conflict');return;}setCurrent(next);setStatus(canEdit(next.role)?'saved':'readonly');setError('');onSaved?.();}
  return {page,status,error,recoveryError,candidates,latest,change,save,restore,discard,keepLatest,keepBoth,acceptExternal,dirty:()=>dirty.current,checkpoint,actorId:actor.current};
}
