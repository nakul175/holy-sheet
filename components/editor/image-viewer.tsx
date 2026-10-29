'use client';

import {useEffect,useState} from 'react';
import {NodeViewWrapper,type NodeViewProps} from '@tiptap/react';
import {Dialog} from './dialog';

export type ProtectedImageAttributes={attachmentId?:unknown;src?:unknown;alt?:unknown;caption?:unknown;width?:unknown};

export function permittedImageSource(attributes:ProtectedImageAttributes){
 const attachmentId=typeof attributes.attachmentId==='string'?attributes.attachmentId:'';
 const source=typeof attributes.src==='string'?attributes.src:'';
 return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(attachmentId)&&source===`/api/media/${attachmentId}`?source:null;
}

export function ProtectedImageView({node,selected}:NodeViewProps){
 const attributes=node.attrs as ProtectedImageAttributes,source=permittedImageSource(attributes);
 const alt=typeof attributes.alt==='string'&&attributes.alt.trim()?attributes.alt.trim():'Image';
 const caption=typeof attributes.caption==='string'?attributes.caption.trim():'';
 const width=typeof attributes.width==='number'&&Number.isFinite(attributes.width)?Math.max(1,Math.min(2000,attributes.width)):640;
 const [open,setOpen]=useState(false),[status,setStatus]=useState<'loading'|'ready'|'error'>('loading'),[attempt,setAttempt]=useState(0);
 const close=()=>setOpen(false);
 useEffect(()=>{if(!open)return;const logout=()=>setOpen(false);window.addEventListener('holy-sheet:logout',logout);return()=>window.removeEventListener('holy-sheet:logout',logout);},[open]);
 useEffect(()=>{if(open)setStatus('loading');},[open,attempt,source]);
 return <NodeViewWrapper as="figure" data-hs-image="" className={`protected-image${selected?' ProseMirror-selectednode':''}`} contentEditable={false}>
  {source?<img src={source} alt={alt} width={width}/>:<p role="img" aria-label={`${alt} unavailable`}>Image unavailable</p>}
  {caption&&<figcaption>{caption}</figcaption>}
  <button type="button" className="image-enlarge" aria-haspopup="dialog" aria-expanded={open} onMouseDown={event=>event.stopPropagation()} onClick={()=>setOpen(true)}>Enlarge image</button>
  {open&&<Dialog title="Enlarged image" onClose={close}><div className="image-viewer">
   {status==='loading'&&source&&<p role="status">Loading image…</p>}
   {source&&status!=='error'&&<img key={attempt} src={source} alt={alt} className={status==='ready'?'is-ready':''} onLoad={()=>setStatus('ready')} onError={()=>setStatus('error')}/>} 
   {(!source||status==='error')&&<div role="alert"><p>This image is unavailable.</p>{source&&<button type="button" onClick={()=>setAttempt(value=>value+1)}>Retry image</button>}</div>}
   <dl><dt>Alternative text</dt><dd>{alt}</dd>{caption&&<><dt>Caption</dt><dd>{caption}</dd></>}</dl>
  </div></Dialog>}
 </NodeViewWrapper>;
}
