'use client';
import { useEffect,useState,type ReactNode } from 'react';
import { embedContext } from '../lib/embed-context';
import { SignInLink } from './session-boundary';

export default function EmbedIdentityBoundary({pageId,children}:{pageId:string;children:ReactNode}){
  const [phase,setPhase]=useState<'checking'|'ready'|'missing'|'signin'|'mismatch'|'unavailable'>('checking'),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const context=embedContext(location.hash,window.parent!==window);let cancelled=false;
    if(context.kind==='standalone'){setPhase('ready');return;}
    if(context.kind==='missing'){setPhase('missing');return;}
    setPhase('checking');const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),5000);
    void(async()=>{try{
      const response=await fetch('/auth/session',{cache:'no-store',signal:controller.signal});
      if(cancelled)return;
      if(response.status===401){setPhase('signin');return;}
      if(!response.ok){setPhase('unavailable');return;}
      const identity=await response.json();if(cancelled)return;
      if(identity.authenticated!==true||typeof identity.userId!=='string'){setPhase('unavailable');return;}
      setPhase(identity.userId===context.userId?'ready':'mismatch');
    }catch{if(!cancelled)setPhase('unavailable');}finally{clearTimeout(timeout);}})();
    return()=>{cancelled=true;clearTimeout(timeout);controller.abort();};
  },[pageId,retry]);
  if(phase==='ready')return children;
  return <main className="workspace-home"><section aria-live="polite">
    <h1>{phase==='checking'?'Checking your document access…':phase==='missing'?'Open this document from your task':phase==='unavailable'?'Document access could not be checked':'Use the same Aplyd account as your task'}</h1>
    {phase==='missing'?<p>Reopen the document from the Holy Sheet launcher in your task.</p>:phase!=='checking'&&<><p>{phase==='unavailable'?'Try again when connected.':'Sign in to Holy Sheet, then reload the document in your task.'}</p>{phase!=='unavailable'&&<SignInLink path={`/pages/${pageId}`} newWindow/>}<button onClick={()=>setRetry(n=>n+1)}>Check again</button></>}
  </section></main>;
}
