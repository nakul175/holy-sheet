'use client';
import { useEffect,useRef,useState,type ReactNode } from 'react';
import { safeSignInReturn } from '../lib/auth-paths';
const marker='hs-session-signout';
export function lockLocalSession(){window.dispatchEvent(new Event('holy-sheet:checkpoint'));window.dispatchEvent(new Event('holy-sheet:logout'));}
export function publishSessionLogout(){lockLocalSession();try{localStorage.setItem(marker,crypto.randomUUID());}catch{}}
export function signInHref(path?:string){return '/auth/sign-in?next='+encodeURIComponent(safeSignInReturn(path??(typeof window==='undefined'?'/':window.location.pathname)));}
export const signInNavigation={assign(href:string){window.location.assign(href);}};
export function continueToSignIn(path?:string){if(typeof window==='undefined'||window.self!==window.top)return;const href=signInHref(path);if(window.location.pathname+window.location.search===href)return;signInNavigation.assign(href);}
export function SignInLink({path='/',newWindow=false}:{path?:string;newWindow?:boolean}){return <a className="sign-in-link" href={signInHref(path)} target={newWindow?'_blank':undefined} rel={newWindow?'noopener noreferrer':undefined}>Sign in with Aplyd{newWindow?' ↗':''}</a>;}
export default function SessionBoundary({children}:{children:ReactNode}){
 const [locked,setLocked]=useState(false),active=useRef(true),identity=useRef<string|null>(null),departing=useRef(false);
 useEffect(()=>{
  active.current=true;let checking=false;
  const lock=()=>setLocked(true),storage=(event:StorageEvent)=>{if(event.key===marker&&event.newValue)lockLocalSession();};
  const identified=(event:Event)=>{const userId=(event as CustomEvent).detail?.userId;if(typeof userId!=='string')return;if(identity.current&&identity.current!==userId)lockLocalSession();identity.current=userId;};
  const check=async()=>{if(checking||document.visibilityState==='hidden'||departing.current)return;checking=true;let sendToSignIn=false;try{const response=await fetch('/auth/session',{cache:'no-store'});if(!active.current)return;if(response.status===401){if(identity.current)lockLocalSession();else if(window.self===window.top){departing.current=true;sendToSignIn=true;}}else if(response.ok){const data=await response.json();if(!active.current)return;if(typeof data.userId==='string'){if(identity.current&&identity.current!==data.userId)lockLocalSession();identity.current=data.userId;}}}catch{/* Existing offline editing remains available until authorization can be checked. */}finally{checking=false;}if(sendToSignIn&&active.current){try{continueToSignIn();}catch{departing.current=false;}}};
  const visible=()=>{if(document.visibilityState==='visible')void check();};
  window.addEventListener('holy-sheet:logout',lock);window.addEventListener('holy-sheet:identity',identified);window.addEventListener('storage',storage);window.addEventListener('focus',check);document.addEventListener('visibilitychange',visible);const timer=setInterval(()=>void check(),60_000);void check();
  return()=>{active.current=false;clearInterval(timer);window.removeEventListener('holy-sheet:logout',lock);window.removeEventListener('holy-sheet:identity',identified);window.removeEventListener('storage',storage);window.removeEventListener('focus',check);document.removeEventListener('visibilitychange',visible);};
 },[]);
 if(locked)return <main className="workspace-home"><div className="brand"><span>✦</span>Holy Sheet</div><section><h1>Your session is locked.</h1><p>Sign in again to check your access. Recovery is available only through your last completed encrypted checkpoint.</p><SignInLink path={typeof window==='undefined'?'/':window.location.pathname} newWindow={typeof window!=='undefined'&&window.self!==window.top}/></section></main>;
 return children;
}
export function SignOutButton({checkpoint}:{checkpoint?:()=>Promise<void>}){
 const [busy,setBusy]=useState(false),[error,setError]=useState('');
 async function signOut(){if(busy)return;setBusy(true);setError('');try{await checkpoint?.();const response=await fetch('/auth/sign-out',{method:'POST',headers:{Accept:'application/json'}}),result=await response.json();if(!response.ok){if(result.localSignedOut)publishSessionLogout();throw Error('Could not confirm suite sign-out. Your local session may already be ended.');}const target=new URL(result.redirect);if(target.protocol!=='https:')throw Error('Sign-out unavailable');publishSessionLogout();window.location.assign(target.href);}catch{setError('Could not confirm suite sign-out. Try again when connected.');}finally{setBusy(false);}}
 return <span className="session-controls"><button disabled={busy} onClick={()=>void signOut()}>{busy?'Signing out…':'Sign out'}</button>{error&&<small role="alert">{error}</small>}</span>;
}
