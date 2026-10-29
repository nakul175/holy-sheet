// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useDocumentSession} from '../components/editor/use-document-session';
import type {DocumentPage} from './repository';
const recovery=vi.hoisted(()=>({store:vi.fn().mockResolvedValue(undefined),decrypt:vi.fn()}));
vi.mock('./access-monitor',()=>({monitorAccess:()=>()=>{}}));
vi.mock('./recovery-client',()=>({importDraftKey:async()=>({}),recoveryDrafts:async()=>[],storeDraft:recovery.store,discardDraft:async()=>{},decryptDraft:recovery.decrypt}));
const initial:DocumentPage={id:'qa-page',title:'Original title',role:'editor',version:1,schemaVersion:2,workspaceId:'qa',workspaceName:'QA',spaceId:'qa',spaceName:'QA',parentPageId:null,visibility:'private',updatedAt:'2026-10-29T00:00:00Z',blocks:[],document:{type:'doc',content:[{type:'paragraph',attrs:{id:'p'}}]}};
const body={type:'doc',content:[{type:'paragraph',attrs:{id:'p'},content:[{type:'text',text:'Durable collaborative words'}]}]};
let root:Root,host:HTMLElement,session:ReturnType<typeof useDocumentSession>,stored:DocumentPage,fetcher:ReturnType<typeof vi.fn>;
function Probe(){session=useDocumentSession('qa-page');return null;}
beforeEach(async()=>{
 vi.useFakeTimers();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);recovery.store.mockClear();stored=structuredClone(initial);
 fetcher=vi.fn(async(url:string,options?:RequestInit)=>{
  if(url.endsWith('/document'))return Response.json({page:stored,actorId:'qa-editor'});
  if(url.endsWith('/operations')){const input=JSON.parse(String(options?.body));stored={...stored,title:input.title,document:input.document,version:stored.version+1};return Response.json({page:stored,acknowledgedOperationId:input.operationId});}
  return Response.json({id:'qa-draft',key:'key',expiresAt:new Date(Date.now()+3600000).toISOString()});
 });vi.stubGlobal('fetch',fetcher);
 host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root.render(createElement(Probe)));
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.useRealTimers();vi.unstubAllGlobals();});

it('does not mark an unsaved title clean when a collaborative body acknowledgement arrives',async()=>{
 await act(async()=>{session.change({title:'Unsaved title'});session.acceptCollaborative(body,2,'saved');});
 expect(session.page?.title).toBe('Unsaved title');expect(session.page?.document).toEqual(body);
 expect(session.dirty()).toBe(true);expect(session.status).not.toBe('saved');
});
it('persists a normal title edit after collaborative editing has started',async()=>{
 stored={...stored,document:body,version:2};await act(async()=>session.acceptCollaborative(body,2,'saved'));
 await act(async()=>session.change({title:'Saved title'}));await act(async()=>session.save());
 expect(stored.title).toBe('Saved title');expect(stored.document).toEqual(body);
 expect(session.page?.title).toBe('Saved title');expect(session.dirty()).toBe(false);
});
it('retains a failed collaborative body in the encrypted recovery checkpoint',async()=>{
 await act(async()=>session.acceptCollaborative(body,2,'error'));
 expect(session.status).toBe('error');expect(session.dirty()).toBe(true);
 expect(recovery.store).toHaveBeenCalledWith(expect.objectContaining({id:expect.stringMatching(/^[a-f0-9-]{36}$/),key:{}}),'qa-editor','qa-page',expect.objectContaining({document:body,baseVersion:2,title:'Original title'}));
});
it('does not send a full document snapshot while collaborative body steps are unacknowledged',async()=>{
 await act(async()=>{session.acceptCollaborative(body,1,'saving');session.change({title:'Waiting title'});});
 await act(async()=>session.save());expect(stored.title).toBe('Original title');
 expect(fetcher.mock.calls.filter(([url])=>url.endsWith('/operations'))).toHaveLength(0);
 stored={...stored,document:body,version:2};await act(async()=>session.acceptCollaborative(body,2,'saved'));
 await act(async()=>session.save());expect(stored.title).toBe('Waiting title');expect(stored.document).toEqual(body);
});
it('does not erase a failed title save when an unrelated body acknowledgement arrives',async()=>{
 stored={...stored,document:body,version:2};await act(async()=>session.acceptCollaborative(body,2,'saved'));
 await act(async()=>session.change({title:'Retained title'}));fetcher.mockResolvedValueOnce(Response.json({error:'Title save unavailable',code:'unavailable'},{status:503}));
 await act(async()=>session.save());expect(session.status).toBe('error');
 await act(async()=>session.acceptCollaborative(body,2,'saved'));
 expect(session.status).toBe('error');expect(session.error).toBe('Title save unavailable');expect(session.dirty()).toBe(true);expect(session.page?.title).toBe('Retained title');
});
it('keeps a restored encrypted snapshot safe from late callbacks and rejoins only after its save is acknowledged',async()=>{
 stored={...stored,document:body,version:2};await act(async()=>session.acceptCollaborative(body,2,'saved'));
 const stale=session.acceptCollaborative,restored={type:'doc',content:[{type:'paragraph',attrs:{id:'restored'},content:[{type:'text',text:'Recovered encrypted words'}]}]};
 recovery.decrypt.mockResolvedValue({title:'Recovered title',document:restored,baseVersion:2});
 let finish!:(response:Response)=>void;fetcher.mockImplementation(async(url:string,options?:RequestInit)=>{
  if(url.endsWith('/operations')){const input=JSON.parse(String(options?.body));stored={...stored,...input,version:3};return new Promise<Response>(resolve=>{finish=resolve;});}
  return Response.json({key:'key'});
 });
 await act(async()=>session.restore({id:'encrypted-candidate',actorId:'qa-editor',pageId:'qa-page',iv:new Uint8Array(),ciphertext:new ArrayBuffer(0),expiresAt:new Date(Date.now()+3600000).toISOString(),updatedAt:new Date().toISOString()}));
 expect(session.snapshotPending).toBe(true);expect(session.page?.document).toEqual(restored);
 await act(async()=>stale(body,2,'saved'));expect(session.page?.document).toEqual(restored);expect(session.dirty()).toBe(true);
 await act(async()=>finish(Response.json({page:stored,acknowledgedOperationId:(stored as DocumentPage&{operationId:string}).operationId})));
 expect(session.snapshotPending).toBe(false);expect(session.collaborating).toBe(false);expect(session.page?.document).toEqual(restored);expect(session.status).toBe('saved');
 await act(async()=>stale(body,2,'saved'));expect(session.page?.document).toEqual(restored);
});
it('does not regress an acknowledged newer body or version when an older title-save response arrives',async()=>{
 stored={...stored,document:body,version:2};await act(async()=>session.acceptCollaborative(body,2,'saved'));
 await act(async()=>session.change({title:'Saved title'}));
 let finish!:(response:Response)=>void;let operationId='';
 fetcher.mockImplementationOnce(async(_url:string,options?:RequestInit)=>{operationId=JSON.parse(String(options?.body)).operationId;return new Promise<Response>(resolve=>{finish=resolve;});});
 let saving!:Promise<void>;await act(async()=>{saving=session.save();});
 const newer={type:'doc',content:[{type:'paragraph',attrs:{id:'p'},content:[{type:'text',text:'A later acknowledged body'}]}]};
 await act(async()=>session.acceptCollaborative(newer,4,'saved'));expect(session.status).toBe('saving');
 await act(async()=>{finish(Response.json({page:{...stored,title:'Saved title',version:3},acknowledgedOperationId:operationId}));await saving;});
 expect(session.page?.document).toEqual(newer);expect(session.page?.version).toBe(4);expect(session.page?.title).toBe('Saved title');
 expect(session.dirty()).toBe(false);expect(session.status).toBe('saved');
});
it('retains a newer unsaved title when an older title save is acknowledged',async()=>{
 stored={...stored,document:body,version:2};await act(async()=>session.acceptCollaborative(body,2,'saved'));
 await act(async()=>session.change({title:'First title'}));
 let finish!:(response:Response)=>void;let operationId='';
 fetcher.mockImplementationOnce(async(_url:string,options?:RequestInit)=>{operationId=JSON.parse(String(options?.body)).operationId;return new Promise<Response>(resolve=>{finish=resolve;});});
 let saving!:Promise<void>;await act(async()=>{saving=session.save();});
 await act(async()=>session.change({title:'Newer title'}));
 await act(async()=>{finish(Response.json({page:{...stored,title:'First title',version:3},acknowledgedOperationId:operationId}));await saving;});
 expect(session.page?.title).toBe('Newer title');expect(session.dirty()).toBe(true);expect(session.status).toBe('unsaved');
});
it('does not let recovery replace an in-flight metadata save',async()=>{
 stored={...stored,document:body,version:2};await act(async()=>session.acceptCollaborative(body,2,'saved'));
 await act(async()=>session.change({title:'Saving title'}));
 let finish!:(response:Response)=>void;let operationId='';
 fetcher.mockImplementationOnce(async(_url:string,options?:RequestInit)=>{operationId=JSON.parse(String(options?.body)).operationId;return new Promise<Response>(resolve=>{finish=resolve;});});
 let saving!:Promise<void>;await act(async()=>{saving=session.save();});
 await act(async()=>session.restore({id:'encrypted-candidate',actorId:'qa-editor',pageId:'qa-page',iv:new Uint8Array(),ciphertext:new ArrayBuffer(0),expiresAt:new Date(Date.now()+3600000).toISOString(),updatedAt:new Date().toISOString()}));
 expect(session.snapshotPending).toBe(false);expect(session.page?.title).toBe('Saving title');expect(session.recoveryError).toContain('Wait for the current save');
 await act(async()=>{finish(Response.json({page:{...stored,title:'Saving title',version:3},acknowledgedOperationId:operationId}));await saving;});
 expect(session.page?.title).toBe('Saving title');expect(session.status).toBe('saved');
});
