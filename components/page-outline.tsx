'use client';
import {useEffect,useId,useMemo,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {observeOutline,jumpToOutline,type OutlineSnapshot} from './editor/page-outline';
import {restoreTemporarySections,type TemporarySection} from './editor/section-navigation';
import styles from './page-outline.module.css';
import {savedHeadingIds} from './editor/heading-links';
import {watchSearchBlockJump} from './editor/search-block-jump';
import {CopyHeadingLink,HeadingLinkDestination} from './heading-links';
// Collapsing a temporary section can shorten the page below the current viewport.
// Keep only the missing scroll room, then release it when the reader scrolls above it.
function retainScrollRoom(host:HTMLElement|null,top:number):()=>void{
 if(!host)return()=>{};
 const naturalMax=Math.max(0,document.documentElement.scrollHeight-window.innerHeight);
 const missing=Math.ceil(top-naturalMax);if(missing<=0)return()=>{};
 const style=getComputedStyle(host),extra=style.boxSizing==='border-box'?0:
  (['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'] as const).reduce((sum,key)=>sum+(parseFloat(style[key])||0),0);
 const original=host.style.minHeight,priority=host.style.getPropertyPriority('min-height');
 const reserved=Math.ceil(host.getBoundingClientRect().height+missing-extra)+'px';
 host.style.setProperty('min-height',reserved);
 const cleanup=()=>{window.removeEventListener('scroll',onScroll);window.removeEventListener('resize',cleanup);if(host.style.minHeight===reserved){if(original)host.style.setProperty('min-height',original,priority);else host.style.removeProperty('min-height');}};
 const onScroll=()=>{if(window.scrollY<=naturalMax)cleanup();};
 window.addEventListener('scroll',onScroll,{passive:true});window.addEventListener('resize',cleanup,{once:true});
 return cleanup;
}
function SearchBlockJump({host,scope,pageId,available}:{host:RefObject<HTMLElement|null>;scope:string;pageId:string;available:boolean}){
 useEffect(()=>{const node=host.current;if(!available||!node)return;return watchSearchBlockJump({host:node,scope,pageId});},[host,scope,pageId,available]);
 return null;
}
export default function PageOutline({documentHost,preferenceKey,available,pageId,savedDocument}:{documentHost:RefObject<HTMLElement|null>;preferenceKey:string;available:boolean;pageId?:string;savedDocument?:unknown}){
 const [open,setOpen]=useState(false),[snapshot,setSnapshot]=useState<OutlineSnapshot&{key:string}>({root:null,headings:[],key:''}),[selected,setSelected]=useState(''),[notice,setNotice]=useState('');
 const panel=useRef<HTMLElement>(null),opener=useRef<HTMLButtonElement>(null),temporary=useRef<TemporarySection[]>([]),selectedId=useRef('');const panelId=useId();
 const confirmed=useRef<ReadonlySet<string>>(new Set()),releaseScrollRoom=useRef<()=>void>(()=>{});
 useEffect(()=>()=>releaseScrollRoom.current(),[]);
 const saved=useMemo(()=>available&&savedDocument!==undefined?savedHeadingIds(savedDocument):null,[available,savedDocument]);
 if(!available)confirmed.current=new Set();else if(saved)confirmed.current=saved;
 function close(){const scroll={left:window.scrollX,top:window.scrollY};releaseScrollRoom.current();setOpen(false);const button=opener.current,details=button?.closest('details');if(button?.isConnected){if(details)details.querySelector('summary')?.focus({preventScroll:true});else button.focus({preventScroll:true});}temporary.current=restoreTemporarySections(temporary.current);releaseScrollRoom.current=retainScrollRoom(documentHost.current,scroll.top);window.scrollTo({...scroll,behavior:'instant'});setSnapshot({root:null,headings:[],key:''});selectedId.current='';setSelected('');setNotice('');}
 useEffect(()=>{
  if(!open)return;
  panel.current?.querySelector<HTMLElement>('button')?.focus();
  const host=documentHost.current;if(!available||!host){setSnapshot({root:null,headings:[],key:preferenceKey});selectedId.current='';setSelected('');setNotice('');return;}
  let listening:HTMLElement|null=null;
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!event.defaultPrevented&&!event.isComposing){event.preventDefault();event.stopPropagation();close();}};
  const stop=observeOutline(host,preferenceKey,next=>{if(listening!==next.root){listening?.removeEventListener('keydown',escape);listening=next.root;listening?.addEventListener('keydown',escape);}setSnapshot({...next,key:preferenceKey});if(!next.headings.some(h=>h.id===selectedId.current)){selectedId.current='';setSelected('');setNotice('');}});
  return()=>{stop();listening?.removeEventListener('keydown',escape);temporary.current=restoreTemporarySections(temporary.current);};
 // The parent keys this component on page/session/access identity, closing it synchronously on change.
 },[open,available,documentHost,preferenceKey]);
 const current=available&&snapshot.key===preferenceKey;
 const headings=current?snapshot.headings:[];
 return <>{pageId&&<HeadingLinkDestination host={documentHost} scope={preferenceKey} pageId={pageId} available={available} saved={confirmed.current}/>}{pageId&&<SearchBlockJump host={documentHost} scope={preferenceKey} pageId={pageId} available={available}/>}<button ref={opener} aria-expanded={open} aria-controls={open?panelId:undefined} onClick={()=>{if(open)close();else setOpen(true);}}>Page outline</button>{open&&createPortal(<aside ref={panel} id={panelId} className={styles.panel} role="dialog" aria-modal="false" aria-labelledby={panelId+'-title'} onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!event.nativeEvent.isComposing){event.preventDefault();event.stopPropagation();close();}}}>
  <header className={styles.header}><h2 id={panelId+'-title'}>Page outline</h2><button aria-label="Close page outline" onClick={close}>×</button></header>
  <p className={styles.hint}>Jump to a heading on this page.</p>
  {!current||!snapshot.root?<p role="status">Outline unavailable while this page or its access is being checked.</p>:!headings.length?<p role="status">No headings on this page.</p>:<nav aria-label="Current page headings" className={styles.navigation} onKeyDown={event=>{
   if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-outline-jump]'));const index=buttons.indexOf(event.target as HTMLButtonElement);if(index<0)return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,index+(event.key==='ArrowDown'?1:-1)));buttons[next]?.focus();
  }}><ol>{headings.map((heading,index)=><li key={heading.id} data-level={heading.level}><button data-outline-jump aria-label={`Heading ${heading.level}: ${heading.label}, ${index+1} of ${headings.length}`} aria-current={selected===heading.id?'location':undefined} onClick={()=>{const root=snapshot.root;if(root&&jumpToOutline(root,heading,preferenceKey,temporary.current)){selectedId.current=heading.id;setSelected(heading.id);setNotice(`At ${heading.label}`);}else setNotice('The outline changed. Choose a current heading again.');}}><span aria-hidden="true" className={styles.level}>H{heading.level}</span><span>{heading.label}</span></button>{pageId&&<CopyHeadingLink pageId={pageId} scope={preferenceKey} host={documentHost} heading={heading} saved={confirmed.current}/>}</li>)}</ol></nav>}
  <div role="status" className={styles.notice}>{current&&snapshot.root?notice:''}</div>
 </aside>,document.body)}</>;
}
