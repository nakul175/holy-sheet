'use client';
import {useEffect,useState,type ReactNode} from 'react';
import {usePathname,useRouter} from 'next/navigation';
import {requestJson} from './editor/use-document-session';
import type {Space} from '../lib/types';
import PageTree from './page-tree';
import UiIcon from './ui-icon';
import SearchDialog from './search-dialog';
import {SignOutButton} from './session-boundary';
import CreatePage from './create-page-dialog';
import TemplatesDialog from './templates-dialog';
import WorkspaceAccessDialog from './workspace-access-dialog';
import WorkspaceInvitationsDialog from './workspace-invitations-dialog';
import ExportPolicyDialog from './export-policy-dialog';

type Workspace={id:string;name:string};
export function WorkspaceTabs({workspaceId}:{workspaceId:string}){
 const path=usePathname()??'';
 return <nav className="laptop-tabs" aria-label="Workspace management">{[['people','Members'],['invitations','Invitations'],['handover','Handover']].map(([route,label])=><a key={route} href={`/workspaces/${encodeURIComponent(workspaceId)}/${route}`} aria-current={path.endsWith('/'+route)?'page':undefined}>{label}</a>)}</nav>;
}
export default function LaptopWorkspace({workspaceId,children}:{workspaceId:string;children:ReactNode}){
 const router=useRouter(),path=usePathname()??'';
 const [workspace,setWorkspace]=useState<Workspace|null>(null),[spaces,setSpaces]=useState<Space[]>([]),[error,setError]=useState(''),[collapsed,setCollapsed]=useState(false),[mobileOpen,setMobileOpen]=useState(false),[search,setSearch]=useState(false);
 useEffect(()=>{let live=true;Promise.all([requestJson<{workspaces:Workspace[]}>('/api/workspaces'),requestJson<{spaces:Space[]}>('/api/spaces')]).then(([w,s])=>{if(!live)return;const current=w.workspaces.find(w=>w.id===workspaceId);if(!current){setError('Workspace is restricted or unavailable.');return}setWorkspace(current);setSpaces(s.spaces.filter(s=>s.workspaceId===workspaceId));}).catch(()=>{if(live)setError('Workspace navigation could not be loaded. Reload to try again.');});return()=>{live=false}},[workspaceId]);
 const base=`/workspaces/${encodeURIComponent(workspaceId)}`;
 const section=path.split('/')[3]??'spaces';
 const label=({spaces:'Spaces',snippets:'Snippets',people:'People & access',invitations:'Invitations',handover:'Page handover',templates:'Templates',new:'New page'} as Record<string,string>)[section]??'Workspace';
 if(error)return <main className="laptop-error"><h1>Workspace unavailable</h1><p role="alert">{error}</p><a href="/workspaces">Choose workspace</a></main>;
 if(!workspace)return <main className="laptop-error" role="status">Opening workspace…</main>;
 return <div className={`laptop-workspace ${collapsed?'laptop-nav-collapsed':''} ${mobileOpen?'laptop-mobile-open':''}`}>
  <aside className="laptop-nav" aria-label="Workspace navigation"><div className="laptop-brand"><a href="/workspaces"><span className="laptop-mark">H<span>·</span></span><span><strong>{workspace.name}</strong><small>Holy Sheet</small></span></a><button aria-label="Collapse pages" onClick={()=>{setCollapsed(true);setMobileOpen(false)}}><UiIcon name="menu"/></button></div>
   <a className="laptop-create" href={`${base}/new`}><UiIcon name="plus"/>New page</a><button className="laptop-search" onClick={()=>setSearch(true)}><UiIcon name="search"/>Search</button>
   <nav aria-label="Pages"><a className="laptop-spaces" href={`${base}/spaces`}>Spaces</a>{spaces.map(space=><section key={space.id}><a className="laptop-space" href={`${base}/spaces/${encodeURIComponent(space.id)}`}><UiIcon name="folder"/>{space.name}</a><PageTree workspaceId={workspaceId} spaceId={space.id} spaceName={space.name} activeId="" onOpen={id=>router.push(`/pages/${encodeURIComponent(id)}`)}/></section>)}</nav>
   <nav className="laptop-nav-footer" aria-label="Workspace tools">{[['templates','Templates','grid'],['snippets','Snippets','document'],['people','People & access','users']].map(([route,text,icon])=><a key={route} href={`${base}/${route}`} aria-current={section===route||(route==='people'&&['invitations','handover'].includes(section))?'page':undefined}><UiIcon name={icon as 'grid'|'document'|'users'}/>{text}</a>)}<SignOutButton/></nav>
  </aside>
  <div className="laptop-workspace-body"><header className="laptop-header"><button aria-label="Open pages" onClick={()=>{setCollapsed(false);setMobileOpen(v=>!v)}}><UiIcon name="menu"/></button><a href={`${base}/spaces`}>{workspace.name}</a><span aria-hidden="true">›</span><span>{label}</span></header><div className="laptop-screen">{children}</div></div>
  {search&&<SearchDialog workspaceId={workspaceId} spaces={spaces} workspaceName={workspace.name} onClose={()=>setSearch(false)} onOpen={result=>{setSearch(false);router.push(result.href||`/pages/${encodeURIComponent(result.id)}`)}}/>}
 </div>;
}
export function LaptopWorkspaceScreen({workspaceId,screen}:{workspaceId:string;screen:'new'|'templates'|'people'|'invitations'}){
 const router=useRouter(),[spaces,setSpaces]=useState<Space[]|null>(null),[error,setError]=useState(''),[policy,setPolicy]=useState(false);
 const base=`/workspaces/${encodeURIComponent(workspaceId)}`;
 useEffect(()=>{let live=true;if(screen==='new'||screen==='templates')void requestJson<{spaces:Space[]}>('/api/spaces').then(d=>{if(live)setSpaces(d.spaces.filter(s=>s.workspaceId===workspaceId))}).catch(()=>{if(live)setError('Spaces could not be loaded. Reload to try again.')});return()=>{live=false}},[workspaceId,screen]);
 const close=()=>router.push(`${base}/spaces`);
 if(error)return <p role="alert">{error}</p>;
 return <>{(screen==='people'||screen==='invitations')&&<WorkspaceTabs workspaceId={workspaceId}/>}
 {screen==='people'&&<WorkspaceAccessDialog presentation="page" workspaceId={workspaceId} onClose={close} onExportPolicy={()=>setPolicy(true)}/>}
 {screen==='invitations'&&<WorkspaceInvitationsDialog presentation="page" workspaceId={workspaceId} onClose={close}/>}
 {(screen==='new'||screen==='templates')&&!spaces&&<p role="status">Loading spaces…</p>}
 {screen==='new'&&spaces&&<section className="laptop-create-screen"><h1>New page</h1><p className="laptop-subtitle">Start with a blank page or a template.</p><CreatePage presentation="inline" spaces={spaces} workspaceId={workspaceId} onClose={close} onTemplates={()=>router.push(`${base}/templates`)} onCreated={p=>router.push(`/pages/${encodeURIComponent(p.id)}`)}/></section>}
 {screen==='templates'&&spaces&&<TemplatesDialog presentation="page" workspaceId={workspaceId} initialSpaceId={spaces[0]?.id??''} spaces={spaces} onBlank={()=>router.push(`${base}/new`)} onClose={close} onCreated={id=>router.push(`/pages/${encodeURIComponent(id)}`)}/>}
 {policy&&<ExportPolicyDialog workspaceId={workspaceId} onClose={()=>setPolicy(false)}/>}
 </>;
}
