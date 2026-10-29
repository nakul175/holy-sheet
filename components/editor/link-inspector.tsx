'use client';

import { useEffect,useRef,useState } from 'react';
import { safeUrl } from '../../lib/document';
import { Dialog } from './dialog';
import styles from './link-inspector.module.css';

export type InspectedLink={anchor:HTMLAnchorElement;href:string};

export function inspectedTextLink(target:EventTarget|null){
  if(!(target instanceof Element))return null;
  const anchor=target.closest<HTMLAnchorElement>('a[href]');
  const textBlock=anchor?.closest('p,h1,h2,h3,h4,h5,h6');
  if(!anchor||!textBlock||!anchor.closest('.rich-prose')||anchor.matches('[download]')||anchor.closest('[data-hs-reference],[data-hs-file],.reference-block,.file-block,.contents-block'))return null;
  const href=anchor.getAttribute('href');
  return href?{anchor,href}:null;
}

export function openInspectedLink(href:string,open:(url:string,target:string,features?:string)=>Window|null=window.open.bind(window)){
  if(!safeUrl(href))return false;
  const sameContext=/^(?:mailto|tel):/i.test(href),target=sameContext?'_self':'_blank';
  const opened=open(href,target,sameContext?undefined:'noopener,noreferrer');
  if(opened&&!sameContext)try{opened.opener=null;}catch{}
  return true;
}

export function LinkInspector({link,onClose}:{link:InspectedLink;onClose:()=>void}){
  const [feedback,setFeedback]=useState<{kind:'status'|'alert';text:string}|null>(null),destination=useRef<HTMLInputElement>(null);
  const close=()=>{onClose();queueMicrotask(()=>{if(link.anchor.isConnected)link.anchor.focus({preventScroll:true});});};
  useEffect(()=>{
    const valid=()=>link.anchor.isConnected&&link.anchor.getAttribute('href')===link.href;
    if(!valid()){onClose();return;}
    const observer=new MutationObserver(()=>{if(!valid())onClose();});
    observer.observe(link.anchor.ownerDocument,{subtree:true,childList:true,attributes:true,attributeFilter:['href']});
    return()=>{observer.disconnect();queueMicrotask(()=>{if(link.anchor.isConnected)link.anchor.focus({preventScroll:true});});};
  },[link,onClose]);
  const copy=async()=>{
    try{if(!navigator.clipboard?.writeText)throw new Error('unavailable');await navigator.clipboard.writeText(link.href);setFeedback({kind:'status',text:'Destination copied.'});}
    catch{setFeedback({kind:'alert',text:'Clipboard unavailable. Select and copy the destination manually.'});queueMicrotask(()=>{destination.current?.focus();destination.current?.select();});}
  };
  const open=()=>{
    if(!link.anchor.isConnected||link.anchor.getAttribute('href')!==link.href||!openInspectedLink(link.href)){setFeedback({kind:'alert',text:'This destination is no longer safe to open.'});return;}
    setFeedback({kind:'status',text:'Destination opened.'});
  };
  return <Dialog title="Inspect link" onClose={close}><div className={styles.inspector}>
    <label className={styles.destination}>Destination<input ref={destination} aria-label="Link destination" readOnly value={link.href} onFocus={event=>event.currentTarget.select()}/></label>
    <div className={styles.actions}><button type="button" className={styles.primary} onClick={open}>Open</button><button type="button" onClick={copy}>Copy</button></div>
    {feedback&&<p className={styles.feedback} role={feedback.kind}>{feedback.text}</p>}
  </div></Dialog>;
}
