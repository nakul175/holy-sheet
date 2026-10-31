'use client';
import {useEffect,useId,useRef,useState} from 'react';
import {Dialog} from './editor/dialog';
import {requestJson} from './editor/use-document-session';
import {searchKinds,type SearchKind,type SearchResult,type Space} from '../lib/types';
import {parseQuery} from '../lib/search';
type Response={results:SearchResult[];nextCursor:string|null};
const labels:Record<SearchKind,string>={page:'Page',block:'Block',record:'Record',field:'Field',attachment:'Attachment'};
function Highlight({text,query}:{text:string;query:string}){
 const {terms,phrases}=parseQuery(query),needles=[...phrases,...terms].filter(Boolean).sort((a,b)=>b.length-a.length);
 if(!needles.length||!text)return <>{text}</>;
 const pattern=new RegExp('('+needles.map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')+')','giu');
 return <>{text.split(pattern).map((part,i)=>i%2?<mark key={i}>{part}</mark>:part)}</>;
}
export function SearchExperience({spaces,workspaceId,workspaceName,onOpen,onOpenPage,resultsId}:{spaces:Space[];workspaceId:string;workspaceName:string;onOpen:(result:SearchResult)=>void;onOpenPage?:()=>void;resultsId?:string}){
 const [query,setQuery]=useState(''),[spaceId,setSpaceId]=useState(''),[kinds,setKinds]=useState<SearchKind[]>([...searchKinds]),[collection,setCollection]=useState(''),[owner,setOwner]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[results,setResults]=useState<SearchResult[]>([]),[selected,setSelected]=useState(0),[cursor,setCursor]=useState<string|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0);
 const generation=useRef(0),request=useRef<AbortController|null>(null),buttons=useRef<(HTMLButtonElement|null)[]>([]),input=useRef<HTMLInputElement>(null),generatedId=useId(),listId=resultsId??generatedId;
 const chosen=searchKinds.filter(kind=>kinds.includes(kind));
 const fetchResults=async(next:string|null,version:number)=>{
  request.current?.abort();const abort=new AbortController();request.current=abort;setBusy(true);setError('');
  try{const p=new URLSearchParams({q:query,workspaceId,type:chosen.join(',')});if(spaceId)p.set('spaceId',spaceId);if(collection.trim())p.set('collection',collection.trim());if(owner.trim())p.set('owner',owner.trim());if(from)p.set('from',from);if(to)p.set('to',to);if(next)p.set('cursor',next);
   const data=await requestJson<Response>('/api/search?'+p,{signal:abort.signal});
   if(version!==generation.current||abort.signal.aborted)return;
   setResults(old=>next?[...old,...data.results.filter(item=>!old.some(existing=>existing.id===item.id))]:data.results);setCursor(data.nextCursor);
  }catch(reason){if(version===generation.current&&!abort.signal.aborted){
   const code=reason&&typeof reason==='object'&&'code' in reason?String(reason.code):'';
   const messages:Record<string,string>={search_too_broad:'Too many matches. Refine your query or choose a space.',search_rate_limited:'Search request limit reached. Retry after one minute.',search_snapshot_limit:'Too many active searches. Retry when an earlier search expires.',search_validation:'Review the search filters and try again.'};
   setError(messages[code]??'Search is temporarily unavailable. Retry to refresh results.');
  }}
  finally{if(version===generation.current&&!abort.signal.aborted)setBusy(false);}
 };
 useEffect(()=>{const version=++generation.current;request.current?.abort();setResults([]);setCursor(null);setSelected(0);setError('');setBusy(false);
  if(query.trim().length<2||!chosen.length||from&&to&&from>to)return;
  setBusy(true);const timer=setTimeout(()=>void fetchResults(null,version),160);
  return()=>{clearTimeout(timer);request.current?.abort();};
 // Filters and query own the request generation; pagination is explicit.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[query,spaceId,workspaceId,retry,collection,owner,from,to,kinds.join(',')]);
 const move=(index:number)=>{const next=Math.max(0,Math.min(results.length-1,index));setSelected(next);buttons.current[next]?.focus();};
 const open=(result:SearchResult)=>onOpen(result);
 return <>
  <p>Workspace: <strong>{workspaceName}</strong></p>
  <div className="hs-search-row"><input ref={input} role="combobox" aria-autocomplete="list" aria-expanded={results.length>0} aria-controls={listId} aria-activedescendant={results.length?`${listId}-${selected}`:undefined} aria-label="Search titles and content" maxLength={512} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='ArrowDown'&&results.length){e.preventDefault();move(0);}if(e.key==='ArrowUp'&&results.length){e.preventDefault();move(results.length-1);}if((e.key==='Home'||e.key==='End')&&results.length){e.preventDefault();move(e.key==='Home'?0:results.length-1);}if(e.key==='Enter'&&results[selected]){e.preventDefault();open(results[selected]);}}} placeholder="Search pages, records, and files…"/>
   <select aria-label="Filter by space" value={spaceId} onChange={e=>setSpaceId(e.target.value)}><option value="">All accessible spaces</option>{spaces.filter(s=>s.workspaceId===workspaceId).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select>
  </div>
  <div className="hs-search-filters">
   <fieldset><legend>Result types</legend><div className="hs-search-types" role="group" aria-label="Result types">{searchKinds.map(kind=><label key={kind}><input type="checkbox" checked={kinds.includes(kind)} onChange={e=>setKinds(current=>e.target.checked?[...current,kind]:current.filter(item=>item!==kind))}/>{labels[kind]}</label>)}</div></fieldset>
   <label>Collection<input aria-label="Filter by collection" maxLength={100} value={collection} onChange={e=>setCollection(e.target.value)} placeholder="All collections"/></label>
   <label>Owner<input aria-label="Filter by owner" maxLength={200} value={owner} onChange={e=>setOwner(e.target.value)} placeholder="Any owner"/></label>
   <label>Updated from<input aria-label="Updated from" type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
   <label>Updated to<input aria-label="Updated to" type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>
  </div>
  <p className="hs-search-help">All words must match. Use quotes for an exact phrase. Forbidden matches are omitted.</p>
  <div id={listId} className="results hs-search-results" role="listbox" aria-label="Search results" aria-busy={busy}>
   <p role="status" aria-live="polite">{!chosen.length?'Choose at least one result type':from&&to&&from>to?'Updated from must be on or before updated to':query.trim().length<2?'Enter at least two characters':busy?'Searching…':error?'':results.length?`${results.length} accessible results shown`:'No accessible results found'}</p>
   {error&&<div role="alert"><p>{error}</p><button onClick={()=>setRetry(v=>v+1)}>Retry search</button></div>}
   {!error&&results.map((result,i)=><button key={result.id} id={`${listId}-${i}`} role="option" aria-selected={i===selected} ref={el=>{buttons.current[i]=el;}} className={i===selected?'selected':''} onFocus={()=>setSelected(i)} onKeyDown={e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='Home'||e.key==='End'){e.preventDefault();move(e.key==='ArrowDown'?i+1:e.key==='ArrowUp'?i-1:e.key==='Home'?0:results.length-1);}if(e.key==='Enter'){e.preventDefault();open(result);}}} onClick={()=>open(result)}><span className="hs-search-badge">{labels[result.kind??'page']}</span><strong><Highlight text={result.title} query={query}/></strong><span>{result.path.filter(Boolean).join(' / ')}</span><p><Highlight text={result.preview||'Title match'} query={query}/></p><time dateTime={result.updatedAt}>Edited {new Date(result.updatedAt).toLocaleString()}</time></button>)}
   {!error&&cursor&&<button disabled={busy} onClick={()=>void fetchResults(cursor,generation.current)}>Load more</button>}
  </div>
  {onOpenPage&&<p><button type="button" onClick={onOpenPage}>Open search page</button></p>}
 </>;
}
export default function SearchDialog({spaces,workspaceId,workspaceName,onClose,onOpen,onOpenPage}:{spaces:Space[];workspaceId:string;workspaceName:string;onClose:()=>void;onOpen:(result:SearchResult)=>void;onOpenPage?:()=>void}){
 return <Dialog title="Search" onClose={onClose}><SearchExperience spaces={spaces} workspaceId={workspaceId} workspaceName={workspaceName} onOpen={onOpen} onOpenPage={onOpenPage}/></Dialog>;
}
