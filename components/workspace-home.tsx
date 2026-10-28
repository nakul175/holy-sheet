'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import type {Page,Space} from '../lib/types';
import type {WorkspaceSummary} from '../lib/workspace-navigation';
import TemplatesDialog from './templates-dialog';
import ImportDialog from './import-dialog';
import ExportPolicyDialog from './export-policy-dialog';
import TrashDialog from './trash-dialog';
import WorkspaceAccessDialog from './workspace-access-dialog';
import CreatePage from './create-page-dialog';
import {SignInLink,SignOutButton,continueToSignIn} from './session-boundary';
import {ApiError,requestJson} from './editor/use-document-session';

export default function WorkspaceHome({chooseWorkspace=false}:{chooseWorkspace?:boolean}){
 const router=useRouter();
 const [workspaces,setWorkspaces]=useState<WorkspaceSummary[]>([]),[workspaceId,setWorkspaceId]=useState(''),[spaces,setSpaces]=useState<Space[]>([]),[pages,setPages]=useState<Page[]>([]);
 const [creationDirty,setCreationDirty]=useState(false);
 const [loading,setLoading]=useState(true),[error,setError]=useState(''),[needsSignIn,setNeedsSignIn]=useState(false);
 const [createOpen,setCreateOpen]=useState(false),[policyOpen,setPolicyOpen]=useState(false),[trashOpen,setTrashOpen]=useState(false),[accessOpen,setAccessOpen]=useState(false),[templatesOpen,setTemplatesOpen]=useState(false),[importOpen,setImportOpen]=useState(false);
 useEffect(()=>{let active=true;
  void Promise.all([requestJson<{pages:Page[]}>('/api/pages'),requestJson<{spaces:Space[]}>('/api/spaces'),requestJson<{workspaces:WorkspaceSummary[]}>('/api/workspaces')]).then(([a,b,c])=>{
   if(!active)return;
   if(!Array.isArray(a.pages)||!Array.isArray(b.spaces)||!Array.isArray(c.workspaces))throw new Error('Workspace navigation unavailable. Please reload.');
   if(!chooseWorkspace&&a.pages.length){router.replace(`/pages/${encodeURIComponent(a.pages[0].id)}`);return;}
   setWorkspaces(c.workspaces);setWorkspaceId(c.workspaces[0]?.id??'');setSpaces(b.spaces);setPages(a.pages);setLoading(false);
  }).catch(e=>{if(!active)return;if(e instanceof ApiError&&e.status===401&&window.self===window.top){continueToSignIn();return;}setError(e instanceof Error?e.message:'Workspace unavailable');setNeedsSignIn(e instanceof ApiError&&e.status===401);setLoading(false);});
  return()=>{active=false;};
 },[router,chooseWorkspace]);
 const availableSpaces=spaces.filter(s=>s.workspaceId===workspaceId),space=availableSpaces[0]?.id??'',workspacePages=pages.filter(p=>p.workspaceId===workspaceId);
 function open(id:string){if(creationDirty&&!confirm('Leave this new-page form? Its title has not been saved.'))return;router.push(`/pages/${encodeURIComponent(id)}`);}
 return <main className="workspace-home"><div className="brand"><span>✦</span>Holy Sheet</div>{!loading&&!needsSignIn&&<SignOutButton/>}<section><h1>{chooseWorkspace?'Choose your workspace':'A clear place for your next idea.'}</h1>
 {loading?<p role="status">Opening your workspace…</p>:!needsSignIn&&workspaces.length?<>
  <label>Workspace<select value={workspaceId} onChange={e=>{if(creationDirty&&!confirm('Leave this new-page form? Its title has not been saved.'))return;setCreationDirty(false);setWorkspaceId(e.target.value);}}>{workspaces.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
  <div className="actions">{chooseWorkspace&&<button onClick={()=>setCreateOpen(true)}>Create page</button>}{space&&<><button onClick={()=>setImportOpen(true)}>Import a document</button>{chooseWorkspace&&<button onClick={()=>setTemplatesOpen(true)}>From template</button>}</>}</div>
  {!chooseWorkspace&&<CreatePage key={workspaceId} presentation="inline" workspaceId={workspaceId} spaces={availableSpaces} onDirty={setCreationDirty} onClose={()=>{}} onTemplates={()=>setTemplatesOpen(true)} onCreated={p=>{setCreationDirty(false);router.push(`/pages/${encodeURIComponent(p.id)}`);}}/>}
  {workspacePages.length?<nav aria-label="Workspace pages"><ul>{workspacePages.map(p=><li key={p.id}><button onClick={()=>open(p.id)}>{p.title}</button></li>)}</ul></nav>:<p>No accessible pages yet. Create your first private page in this workspace.</p>}
  <div className="actions"><button onClick={()=>setTrashOpen(true)}>Trash</button><button onClick={()=>setAccessOpen(true)}>Workspace access</button></div>
 </>:!error&&<p>Your signed-in account needs access to a Holy Sheet workspace. Ask its owner to add you.</p>}
 {error&&<p role="alert">{error}</p>}{needsSignIn&&<SignInLink/>}</section>
 {createOpen&&workspaceId&&<CreatePage key={workspaceId} workspaceId={workspaceId} spaces={availableSpaces} onClose={()=>setCreateOpen(false)} onTemplates={()=>{setCreateOpen(false);setTemplatesOpen(true);}} onCreated={p=>{setCreationDirty(false);setCreateOpen(false);router.push(`/pages/${encodeURIComponent(p.id)}`);}}/>}
 {trashOpen&&workspaceId&&<TrashDialog workspaceId={workspaceId} spaces={availableSpaces} onClose={()=>setTrashOpen(false)} onRestored={id=>{setTrashOpen(false);open(id);}}/>}
 {accessOpen&&workspaceId&&<WorkspaceAccessDialog workspaceId={workspaceId} onClose={()=>setAccessOpen(false)} onExportPolicy={()=>{setAccessOpen(false);setPolicyOpen(true);}}/>}
 {policyOpen&&workspaceId&&<ExportPolicyDialog key={workspaceId} workspaceId={workspaceId} onClose={()=>setPolicyOpen(false)}/>}
 {importOpen&&space&&<ImportDialog spaces={availableSpaces} initialSpaceId={space} onClose={()=>setImportOpen(false)} onCreated={()=>{}} onOpen={open}/>}
 {templatesOpen&&space&&<TemplatesDialog workspaceId={workspaceId} initialSpaceId={space} spaces={availableSpaces} onClose={()=>setTemplatesOpen(false)} onCreated={id=>{setTemplatesOpen(false);open(id);}}/>}
 </main>;
}
