// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {useDocumentSession} from '../components/editor/use-document-session';
const storage=vi.hoisted(()=>({write:vi.fn()}));
vi.mock('./access-monitor',()=>({monitorAccess:()=>()=>{}}));
vi.mock('./recovery-client',()=>({importDraftKey:async()=>({}),recoveryDrafts:async()=>[],storeDraft:storage.write,discardDraft:async()=>{},decryptDraft:vi.fn()}));
it('does not clear storage failure when a server lease renews, and clears it only after a successful checkpoint',async()=>{
  vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  const page={id:'qa-page',title:'Original',role:'editor',version:1,schemaVersion:2,workspaceId:'qa',spaceId:'qa',document:{type:'doc',content:[{type:'paragraph',attrs:{id:'p'}}]}};
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
    if(url.endsWith('/operations'))return new Promise<Response>(()=>{});
    return Response.json(url.endsWith('/document')?{page,actorId:'qa-editor'}:{id:'qa-draft',key:'key',expiresAt:new Date(Date.now()+3600000).toISOString()});
  }));
  storage.write.mockRejectedValue(new Error('IndexedDB quota exceeded'));
  let session!:ReturnType<typeof useDocumentSession>;
  function Probe(){session=useDocumentSession('qa-page');return createElement('p',null,session.recoveryError);}
  const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
  try{
    await act(async()=>root.render(createElement(Probe)));
    await act(async()=>{session.change({title:'Unsaved recovery probe'});await session.checkpoint();});
    expect(host.textContent).toContain('Recovery storage failed');
    await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
    expect(host.textContent).toContain('Recovery storage failed');
    expect(session.dirty()).toBe(true);expect(session.page?.title).toBe('Unsaved recovery probe');
    storage.write.mockResolvedValue(undefined);
    await act(async()=>session.checkpoint());
    expect(host.textContent).toBe('');expect(session.dirty()).toBe(true);expect(session.status).not.toBe('saved');
  }finally{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();}
});
