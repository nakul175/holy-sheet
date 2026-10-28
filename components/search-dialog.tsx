'use client';
import {useEffect,useRef,useState} from 'react';
import {Dialog} from './editor/dialog';
import {requestJson} from './editor/use-document-session';
import type {SearchResult,Space} from '../lib/types';
import {parseQuery} from '../lib/search';
type Response={results:SearchResult[];nextCursor:string|null};
function Highlight({text,query}:{text:string;query:string}){
 const {terms,phrases}=parseQuery(query),needles=[...phrases,...terms].filter(Boolean).sort((a,b)=>b.length-a.length);
 if(!needles.length)return <>{text}</>;
 const pattern=new RegExp('('+needles.map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')','giu');
 return <>{text.split(pattern).map((part,i)=>i%2?<mark key={i}>{part}</mark>:part)}</>;
}
export default function SearchDialog({spaces,workspaceId,workspaceName,onClose,onOpen}:{spaces:Space[];workspaceId:string;workspaceName:string;onClose:()=>void;onOpen:(id:string)=>void}){
 const [query,setQuery]=useState(''),[spaceId,setSpaceId]=useState(''),[results,setResults]=useState<SearchResult[]>([]),[selected,setSelected]=useState(0),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const generation=useRef(0),request=useRef<AbortController|null>(null),buttons=useRef<(HTMLButtonElement|null)[]>([]);
 const fetchResults=async(next:string|null,version:number)=>{
  request.current?.abort();const abort=new AbortController();request.current=abort;setBusy(true);setError('');
  try{const p=new URLSearchParams({q:query,workspaceId});if(spaceId)p.set('spaceId',spaceId);if(next)p.set('cursor',next);
   const data=await requestJson<Response>('/api/search?'+p,{signal:abort.signal});
   if(version!==generation.current||abort.signal.aborted)return;
   setResults(old=>next?[...old,...data.results.filter(item=>!old.some(existing=>existing.id===item.id))]:data.results);setCursor(data.nextCursor);
  }catch(error){if(version===generation.current&&!abort.signal.aborted){
   const code=error&&typeof error==='object'&&'code' in error?String(error.code):'';
   const messages:Record<string,string>={search_too_broad:'Too many pages match. Refine your query or choose a space.',search_rate_limited:'Search request limit reached. Retry after one minute.',search_snapshot_limit:'Too many active searches. Retry when an earlier search expires.'};
   setError(messages[code]??'Search is temporarily unavailable. Retry to refresh results.');
  }}
  finally{if(version===generation.current&&!abort.signal.aborted)setBusy(false);}
 };
 useEffect(()=>{const version=++generation.current;request.current?.abort();setResults([]);setCursor(null);setSelected(0);setError('');setBusy(false);
  if(query.trim().length<2)return;
  setBusy(true);const timer=setTimeout(()=>void fetchResults(null,version),160);
  return()=>{clearTimeout(timer);request.current?.abort();};
 // Search scope owns its request generation; pagination is explicit.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[query,spaceId,workspaceId,retry]);
 const move=(delta:number)=>{const index=Math.max(0,Math.min(results.length-1,selected+delta));setSelected(index);buttons.current[index]?.focus();};
 return <Dialog title="Search your pages" onClose={onClose}>
  <p>Workspace: <strong>{workspaceName}</strong></p>
  <div className="hs-search-row"><input aria-label="Search titles and content" maxLength={512} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='ArrowDown'&&results.length){e.preventDefault();setSelected(0);buttons.current[0]?.focus();}if(e.key==='Enter'&&results[selected])onOpen(results[selected].id);}} placeholder="Search titles and content…"/>
   <select aria-label="Filter by space" value={spaceId} onChange={e=>setSpaceId(e.target.value)}><option value="">All accessible spaces</option>{spaces.filter(s=>s.workspaceId===workspaceId).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>
  </div>
  <p className="hs-search-help">All words must match. Use quotes for an exact phrase. Matches are highlighted.</p>
  <div className="results hs-search-results" aria-label="Search results" aria-busy={busy}>
   <p role="status" aria-live="polite">{query.trim().length<2?'Enter at least two characters':busy?'Searching…':error?'':results.length?`${results.length} accessible results shown`:'No accessible pages found'}</p>
   {error&&<div role="alert"><p>{error}</p><button onClick={()=>setRetry(v=>v+1)}>Retry search</button></div>}
   {!error&&results.map((r,i)=><button key={r.id} ref={el=>{buttons.current[i]=el;}} className={i===selected?'selected':''} onFocus={()=>setSelected(i)} onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();move(e.key==='ArrowDown'?1:-1);}}} onClick={()=>onOpen(r.id)}><strong><Highlight text={r.title} query={query}/></strong><span>{r.path.join(' / ')}</span><p><Highlight text={r.preview||'Title match'} query={query}/></p><time dateTime={r.updatedAt}>Edited {new Date(r.updatedAt).toLocaleString()}</time></button>)}
   {!error&&cursor&&<button disabled={busy} onClick={()=>void fetchResults(cursor,generation.current)}>Load more</button>}
  </div>
 </Dialog>;
}
