'use client';
import {useEffect,useState} from 'react';
import {embedContext} from '../../../lib/embed-context';
import type {SessionGateProps,SessionProvider,SessionResult} from './contracts';
export type {SessionProvider,SessionResult,ViewContext} from './contracts';

export function createHolySheetSessionProvider():SessionProvider {
  // Capture the initial restrictive hint once: editor heading links may later change the hash.
  let context:ReturnType<typeof embedContext>|undefined;
  return {async check({signal,viewContext}){
    context??=embedContext(location.hash,window.parent!==window);
    if(context.kind==='missing')return {status:'missing'};
    const response=await fetch('/auth/session',{cache:'no-store',signal});
    if(response.status===401)return {status:'signin'};
    if(!response.ok)return {status:'unavailable'};
    const identity=await response.json();
    if(identity.authenticated!==true||typeof identity.userId!=='string'||!identity.userId)return {status:'unavailable'};
    if(context.kind==='restricted'&&identity.userId!==context.userId)return {status:'mismatch'};
    return {status:'ready',subject:identity.userId};
  }};
}

export function SessionGate({pageId,viewContext,sessionProvider,children}:SessionGateProps){
  const [phase,setPhase]=useState<SessionResult['status']|'checking'>('checking'),[retry,setRetry]=useState(0);
  useEffect(()=>{
    let cancelled=false;setPhase('checking');
    const controller=new AbortController(),timer=setTimeout(()=>{controller.abort();if(!cancelled)setPhase('unavailable');},5000);
    void sessionProvider.check({pageId,viewContext,signal:controller.signal}).then(result=>{
      if(!cancelled&&!controller.signal.aborted)setPhase(result.status==='ready'&&(!result.subject||typeof result.subject!=='string')?'unavailable':result.status);
    }).catch(()=>{if(!cancelled)setPhase('unavailable');}).finally(()=>clearTimeout(timer));
    return()=>{cancelled=true;clearTimeout(timer);controller.abort();};
  },[pageId,viewContext,sessionProvider,retry]);
  if(phase==='ready')return children;
  return <main className="workspace-home"><section aria-live="polite">
    <h1>{phase==='checking'?'Checking your document access…':phase==='missing'?'Open this document from your task':phase==='unavailable'?'Document access could not be checked':'Use the same Aplyd account as your task'}</h1>
    {phase==='missing'?<p>Reopen the document from the Holy Sheet launcher in your task.</p>:phase!=='checking'&&<><p>{phase==='unavailable'?'Try again when connected.':'Sign in to Holy Sheet, then reload the document in your task.'}</p>{phase!=='unavailable'&&<a className="sign-in-link" href={'/auth/sign-in?next='+encodeURIComponent(`/pages/${pageId}`)} target={viewContext==='embedded'?'_blank':undefined} rel="noopener noreferrer">Sign in with Aplyd</a>}<button onClick={()=>setRetry(n=>n+1)}>Check again</button></>}
  </section></main>;
}
