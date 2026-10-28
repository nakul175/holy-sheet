'use client';
import {useEffect,useLayoutEffect,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {currentLinkedHeading,headingLink,watchHeadingLink,type HeadingNavigationState} from './editor/heading-links';
import type {OutlineHeading} from './editor/page-outline';
import styles from './heading-links.module.css';

export function CopyHeadingLink({pageId,scope,host,heading,saved}:{pageId:string;scope:string;host:RefObject<HTMLElement|null>;heading:OutlineHeading;saved:ReadonlySet<string>}){
 const [notice,setNotice]=useState(''),[fallback,setFallback]=useState('');
 const active=useRef(true),attempt=useRef(0);
 useEffect(()=>{active.current=true;return()=>{active.current=false;attempt.current++;};},[]);
 async function copy(){
  const token=++attempt.current;setNotice('');setFallback('');
  if(!saved.has(heading.id)){setNotice('Save this heading before copying its link.');return;}
  const root=host.current,found=root&&currentLinkedHeading(root,scope,heading.id,saved);
  if(!found||found.heading.target!==heading.target){setNotice('Heading link unavailable. Choose a current heading.');return;}
  const link=headingLink(location.origin,pageId,heading.id);if(!link){setNotice('Heading link unavailable.');return;}
  try{await navigator.clipboard.writeText(link);if(active.current&&token===attempt.current)setNotice('Heading link copied. Recipients still need page permission.');}
  catch{if(active.current&&token===attempt.current){setFallback(link);setNotice('Clipboard unavailable. Select and copy this heading link.');}}
 }
 return <div className={styles.action}><button type="button" className={styles.copy} aria-label={`Copy heading link: ${heading.label}`} onClick={()=>void copy()}>Copy heading link</button>
  {fallback&&<label className={styles.fallback}>Heading link<input aria-label="Heading link" readOnly value={fallback}/></label>}
  {notice&&<span role="status" className={styles.notice}>{notice}</span>}
 </div>;
}

/** Focus is outside contenteditable, so opening a link never relocates the editor selection. */
export function HeadingLinkDestination({host,scope,pageId,available,saved}:{host:RefObject<HTMLElement|null>;scope:string;pageId:string;available:boolean;saved:ReadonlySet<string>}){
 const [state,setState]=useState<HeadingNavigationState>({kind:'idle'}),[retry,setRetry]=useState(0);
 const destination=useRef<HTMLDivElement>(null),confirmed=useRef(saved);confirmed.current=saved;
 const navigation=useRef<ReturnType<typeof watchHeadingLink>|null>(null);
 useEffect(()=>{
  if(!available||!host.current){setState({kind:'idle'});return;}
  const current=watchHeadingLink({host:host.current,scope,pageId,saved:()=>confirmed.current,publish:setState});navigation.current=current;
  return()=>{current.stop();if(navigation.current===current)navigation.current=null;};
 },[host,scope,pageId,available,retry]);
 useEffect(()=>{navigation.current?.refresh();},[saved]);
 useLayoutEffect(()=>{if(available&&state.kind==='ready')destination.current?.focus({preventScroll:true});},[state,available]);
 if(!available||state.kind==='idle')return null;
 return createPortal(<div className={styles.destination} ref={destination} tabIndex={-1} role="region" aria-label={state.kind==='ready'?`Linked heading: ${state.label}`:'Heading link destination'}>
  <span role="status">{state.kind==='ready'?`At heading: ${state.label}`:state.kind==='waiting'?'Finding linked heading…':'Heading unavailable on this page.'}</span>
  {state.kind==='unavailable'&&<button type="button" onClick={()=>setRetry(value=>value+1)}>Try heading link again</button>}
 </div>,document.body);
}
