'use client';
import {useEffect,useRef,useState} from 'react';
import {Dialog} from './editor/dialog';
import {pageStatisticsJob,readingTime,type StatisticsResult} from '../lib/page-statistics';
import styles from './page-statistics.module.css';
// The editor packager binds this to its emitted ESM module URL, alongside the worker entry.
declare const __HS_PAGE_STATISTICS_PACKAGE_BASE__:string;

export default function PageStatistics({document:body,supportedSchema,available=true}:{document:unknown;supportedSchema:boolean;available?:boolean}){
 const [open,setOpen]=useState(false),[result,setResult]=useState<{body:unknown;supportedSchema:boolean;value:StatisticsResult}|null>(null);
 const opener=useRef<HTMLButtonElement>(null);
 useEffect(()=>{
  if(!available){setOpen(false);setResult(null);return;}
  let alive=true,worker:Worker|undefined,timer:ReturnType<typeof setTimeout>;
  const finish=(value:StatisticsResult)=>{if(alive)setResult({body,supportedSchema,value});worker?.terminate();};
  const fallback=()=>{
   const job=pageStatisticsJob(body,supportedSchema);
   const advance=()=>{try{const until=performance.now()+4;let steps=0;while(alive&&performance.now()<until&&steps++<16){const next=job.next();if(next.done){finish(next.value);return;}}if(alive)timer=setTimeout(advance,0);}catch{finish({status:'unavailable',reason:'Statistics could not be calculated. Your document is unchanged.'});}};
   timer=setTimeout(advance,0);
  };
  timer=setTimeout(()=>{
   if(!supportedSchema){finish({status:'unavailable',reason:'Statistics are unavailable for this document version.'});return;}
   try{
    if(typeof Worker==='undefined'){fallback();return;}
    // Next emits a classic worker runtime; forcing module mode makes its runtime globals strict.
    worker=new Worker(new URL('./page-statistics-worker.js',__HS_PAGE_STATISTICS_PACKAGE_BASE__));
    worker.onmessage=(event:MessageEvent<StatisticsResult>)=>finish(event.data);
    worker.onerror=()=>{worker?.terminate();fallback();};
    worker.postMessage({document:body,supportedSchema});
   }catch{worker?.terminate();fallback();}
  },120);
  return()=>{alive=false;clearTimeout(timer);worker?.terminate();};
 },[body,supportedSchema,available]);
 // Never render a previous body's or permission context's result, even before effects clean up.
 const current=available&&result!==null&&result.body===body&&result.supportedSchema===supportedSchema?result.value:null;
 if(!available)return null;
 const counts=current?.status==='ready'?current.counts:null;
 const close=()=>{setOpen(false);};
 return <><button ref={opener} type="button" className={styles.launcher} aria-label="Page statistics" aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(true)}>{counts?`${counts.approximate?'≈ ':''}${counts.words.toLocaleString('en')} words`:current?.status==='unavailable'?'Statistics unavailable':'Counting words…'}</button>
 {open&&<Dialog title="Page statistics" onClose={close}><div className={styles.body}>
 <p>Current page body, including unsaved edits. Excludes the title, comments, attachments and linked pages.</p>
 {!current?<p role="status">Updating statistics…</p>:current.status==='unavailable'?<p role="status">{current.reason}</p>:<>
 {current.counts.approximate&&<p role="status">Approximate counts: Unicode segmentation is unavailable. Words use letter/number runs; characters use code points, so some languages and emoji may differ.</p>}
 <dl className={styles.counts}>
 <div><dt>Words</dt><dd>{current.counts.words.toLocaleString('en')}</dd></div>
 <div><dt>Characters including spaces</dt><dd>{current.counts.characters.toLocaleString('en')}</dd></div>
 <div><dt>Characters excluding whitespace</dt><dd>{current.counts.charactersWithoutWhitespace.toLocaleString('en')}</dd></div>
 <div><dt>Estimated reading time</dt><dd>{readingTime(current.counts.words)}</dd></div>
 </dl><p className={styles.note}>Reading estimate at 200 words per minute; times of one minute or more are rounded up. Unicode word boundaries use English locale rules with the browser’s language dictionaries. Character counts use graphemes; whitespace is removed before the second count.</p></>}
 </div></Dialog>}</>;
}
