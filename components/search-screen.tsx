'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {SearchExperience} from './search-dialog';
import {requestJson} from './editor/use-document-session';
import type {SearchResult,Space} from '../lib/types';
import type {WorkspaceSummary} from '../lib/workspace-navigation';
export default function SearchScreen({initialWorkspaceId}:{initialWorkspaceId:string}){
 const router=useRouter();
 const [workspaces,setWorkspaces]=useState<WorkspaceSummary[]>([]),[workspaceId,setWorkspaceId]=useState(initialWorkspaceId),[spaces,setSpaces]=useState<Space[]>([]),[error,setError]=useState('');
 useEffect(()=>{let live=true;void Promise.all([requestJson<{workspaces:WorkspaceSummary[]}>('/api/workspaces'),requestJson<{spaces:Space[]}>('/api/spaces')]).then(([workspaceReply,spaceReply])=>{if(!live)return;setWorkspaces(workspaceReply.workspaces);setSpaces(spaceReply.spaces);setWorkspaceId(current=>current&&workspaceReply.workspaces.some(item=>item.id===current)?current:workspaceReply.workspaces[0]?.id??'');}).catch(()=>{if(live)setError('Search is temporarily unavailable.');});return()=>{live=false;};},[]);
 useEffect(()=>{const open=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!event.defaultPrevented){event.preventDefault();document.querySelector<HTMLInputElement>('input[aria-label="Search titles and content"]')?.focus();}};window.addEventListener('keydown',open);return()=>window.removeEventListener('keydown',open);},[]);
 const workspace=workspaces.find(item=>item.id===workspaceId);
 return <main className="hs-search-page"><a className="skip-link" href="#search-results">Skip to search results</a><p><a href="/">Holy Sheet</a></p><h1>Search</h1>{error&&<p role="alert">{error}</p>}{workspaces.length>1&&<label>Workspace<select aria-label="Workspace" value={workspaceId} onChange={event=>{setWorkspaceId(event.target.value);const next=new URLSearchParams(location.search);next.set('workspaceId',event.target.value);history.replaceState(null,'',`/search?${next}`);}}>{workspaces.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}{workspace&&<SearchExperience key={workspace.id} commandBar resultsId="search-results" spaces={spaces} workspaceId={workspace.id} workspaceName={workspace.name} onOpen={result=>{if(result.href)router.push(result.href);}} onOpenTab={result=>{if(result.href)window.open(result.href,'_blank','noopener,noreferrer');}} onJump={href=>router.push(href)} onCreated={href=>router.push(href)}/>}{!error&&!workspace&&<p role="status">Opening search…</p>}</main>;
}
