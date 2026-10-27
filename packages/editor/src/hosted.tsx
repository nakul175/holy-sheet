'use client';
import {useEffect,useState} from 'react';
import type {HostedEditorProps,HostSession} from './contracts';
export type {HostedEditorProps,HostSessionProvider,HostSession} from './contracts';
export const editorProtocolVersion=1;
const origin='https://staging.holysheet.aplyd.org';
const validSubject=(s:unknown):s is string=>typeof s==='string'&&s.length>0&&s.length<=200&&!/[\u0000-\u0020\u007f]/.test(s);
export function HolySheetEditor({pageId,viewContext,sessionProvider}:HostedEditorProps){
  const [session,setSession]=useState<HostSession|null>(null),[retry,setRetry]=useState(0),[generation,setGeneration]=useState(0);
  useEffect(()=>{
    let cancelled=false,sequence=0,expectedSubject:string|undefined;const controllers=new Set<AbortController>();
    async function check(){
      const attempt=++sequence,controller=new AbortController();controllers.add(controller);
      const timer=setTimeout(()=>{controller.abort();if(!cancelled&&attempt===sequence)setSession({status:'unavailable'});},5000);
      try{
        const result=await sessionProvider.check({pageId,signal:controller.signal});
        if(cancelled||controller.signal.aborted||attempt!==sequence)return;
        if(result.status!=='ready'||result.origin!==origin||!validSubject(result.subject))setSession({status:result.status==='signin'?'signin':'unavailable'});
        else if(expectedSubject&&expectedSubject!==result.subject)setSession({status:'signin'});
        else{expectedSubject=result.subject;setSession(old=>old?.status==='ready'&&old.subject===result.subject&&old.origin===result.origin?old:result);}
      }catch{if(!cancelled&&attempt===sequence)setSession({status:'unavailable'});}
      finally{clearTimeout(timer);controllers.delete(controller);}
    }
    setSession(null);void check();
    const focus=()=>{void check();};window.addEventListener('focus',focus);
    const interval=setInterval(focus,60000);
    return()=>{cancelled=true;for(const c of controllers)c.abort();clearInterval(interval);window.removeEventListener('focus',focus);};
  },[pageId,viewContext,sessionProvider,retry]);
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(pageId)||viewContext!=='embedded')return <p role="alert">Document reference is invalid.</p>;
  if(!session)return <p role="status">Checking your document access…</p>;
  if(session.status!=='ready')return <section aria-live="polite"><p>{session.status==='signin'?'Sign in to your task again.':'Document access could not be checked.'}</p><button onClick={()=>setRetry(n=>n+1)}>Check again</button></section>;
  const documentUrl=`${session.origin}/pages/${pageId}`;
  return <section aria-label="Holy Sheet document">
    <a href={documentUrl} target="_blank" rel="noopener noreferrer">Open in Holy Sheet</a>
    <button onClick={()=>setGeneration(n=>n+1)}>Reload document</button>
    <iframe key={`${session.subject}:${pageId}:${generation}`} title="Holy Sheet document" referrerPolicy="no-referrer"
      src={`${session.origin}/embed/pages/${pageId}#hs-user=${encodeURIComponent(session.subject)}`}
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
      style={{width:'100%',height:'70vh',border:'1px solid var(--border)',marginTop:12}}/>
  </section>;
}
