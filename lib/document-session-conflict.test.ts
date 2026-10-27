// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useDocumentSession} from '../components/editor/use-document-session';
import type {DocumentPage} from './repository';
const storage=vi.hoisted(()=>({discard:vi.fn()}));
vi.mock('./access-monitor',()=>({monitorAccess:()=>()=>{}}));
vi.mock('./recovery-client',()=>({importDraftKey:async()=>({}),recoveryDrafts:async()=>[],storeDraft:async()=>{},discardDraft:storage.discard,decryptDraft:vi.fn()}));
const initial:DocumentPage={id:'qa-page',title:'Original',role:'editor',version:1,schemaVersion:2,workspaceId:'qa',workspaceName:'QA',spaceId:'qa',spaceName:'QA',parentPageId:null,visibility:'private',updatedAt:'2026-10-27T00:00:00Z',blocks:[],document:{type:'doc',content:[{type:'paragraph',attrs:{id:'p'}}]}};
let root:Root,host:HTMLElement,session:ReturnType<typeof useDocumentSession>,remote:DocumentPage,actor:string,fetcher:ReturnType<typeof vi.fn>;
function Probe(){session=useDocumentSession('qa-page');return null;}
beforeEach(async()=>{
  vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);storage.discard.mockReset();
  remote=structuredClone(initial);actor='qa-editor';
  fetcher=vi.fn(async(url:string)=>Response.json(url.endsWith('/document')?{page:remote,actorId:actor}:{id:'qa-draft',key:'key',expiresAt:new Date(Date.now()+3600000).toISOString()}));vi.stubGlobal('fetch',fetcher);
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  await act(async()=>root.render(createElement(Probe)));
  await act(async()=>{session.change({title:'Local draft'});session.acceptExternal({...initial,title:'Second writer',version:2});});
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});
it('explicit discard reloads a third intervening save rather than marking the stale conflict snapshot Saved',async()=>{
  remote={...initial,title:'Third writer',version:3};await act(async()=>session.keepLatest());
  expect(session.page?.title).toBe('Third writer');expect(session.page?.version).toBe(3);expect(session.dirty()).toBe(false);expect(session.status).toBe('saved');
});
it('retains the local conflict and checkpoint if the fresh read is unavailable',async()=>{
  fetcher.mockResolvedValueOnce(Response.json({error:'Unavailable',code:'unavailable'},{status:503}));await act(async()=>session.keepLatest());
  expect(session.page?.title).toBe('Local draft');expect(session.dirty()).toBe(true);expect(session.status).toBe('conflict');expect(storage.discard).not.toHaveBeenCalled();
});
it('does not discard edits made while the fresh server read is pending',async()=>{
  let finish!:(response:Response)=>void;fetcher.mockImplementationOnce(()=>new Promise<Response>(resolve=>{finish=resolve;}));
  let action!:Promise<void>;await act(async()=>{action=session.keepLatest();});
  expect(finish).toBeTypeOf('function');
  await act(async()=>session.change({title:'Newer local draft'}));
  await act(async()=>{finish(Response.json({page:{...initial,title:'Third writer',version:3},actorId:actor}));await action;});
  expect(session.page?.title).toBe('Newer local draft');expect(session.dirty()).toBe(true);expect(storage.discard).not.toHaveBeenCalled();
});
it.each([401,404])('locks the old content without discarding its checkpoint if access changes (%s)',async status=>{
  fetcher.mockResolvedValueOnce(Response.json({error:'Not available',code:'not_found'},{status}));await act(async()=>session.keepLatest());
  expect(session.page).toBeNull();expect(storage.discard).not.toHaveBeenCalled();expect(session.authRequired).toBe(status===401);
});
it('does not switch the local draft to a different account during the fresh read',async()=>{
  actor='qa-other';await act(async()=>session.keepLatest());expect(session.page).toBeNull();expect(session.authRequired).toBe(true);expect(storage.discard).not.toHaveBeenCalled();
});
