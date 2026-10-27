// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {useDocumentSession} from '../components/editor/use-document-session';
import {schemaVersion} from './document';
import type {DocumentPage} from './repository';
const mocks=vi.hoisted(()=>({receive:undefined as undefined|((value:any)=>void),unavailable:undefined as undefined|(()=>void)}));
vi.mock('./access-monitor',()=>({monitorAccess:vi.fn((_check,receive,unavailable)=>{mocks.receive=receive;mocks.unavailable=unavailable;return vi.fn();})}));
vi.mock('./recovery-client',()=>({importDraftKey:vi.fn().mockResolvedValue({}),recoveryDrafts:vi.fn().mockResolvedValue([]),storeDraft:vi.fn().mockResolvedValue(undefined),discardDraft:vi.fn().mockResolvedValue(undefined),decryptDraft:vi.fn()}));
const initial={id:'test',title:'Private document',role:'editor',version:1,schemaVersion,workspaceId:'w',workspaceName:'QA',spaceId:'s',spaceName:'QA',parentPageId:null,visibility:'private',updatedAt:new Date().toISOString(),blocks:[],document:{type:'doc',content:[{type:'paragraph',attrs:{id:'p'}}]}} as DocumentPage;
let root:Root,host:HTMLElement,session:ReturnType<typeof useDocumentSession>,remote:DocumentPage,fetchMock:ReturnType<typeof vi.fn>;
function Probe(){session=useDocumentSession('test');return null;}
const response=(data:unknown)=>({ok:true,json:async()=>data,headers:new Headers()});
async function flush(){await act(async()=>{await Promise.resolve();});}
beforeEach(async()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});remote=structuredClone(initial);fetchMock=vi.fn(async(url:string)=>response(url.endsWith('/document')?{page:remote,actorId:'user-a'}:{id:'draft',key:'key',expiresAt:new Date(Date.now()+100000).toISOString()}));vi.stubGlobal('fetch',fetchMock);host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>{root.render(createElement(Probe));});});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();vi.clearAllMocks();});
describe('permission changes in an already open editor',()=>{
 it('clears revoked content without requiring an edit and refuses stale history results',async()=>{await act(async()=>mocks.receive!({actorId:'user-a',role:null,signIn:false}));expect(session.page).toBeNull();expect(session.error).toContain('Access revoked');await act(async()=>{session.acceptExternal(initial);session.change({title:'revived'});});expect(session.page).toBeNull();});
 it('reloads as read-only on downgrade and refuses subsequent edits',async()=>{remote={...initial,role:'viewer'};await act(async()=>mocks.receive!({actorId:'user-a',role:'viewer'}));await flush();expect(session.page?.role).toBe('viewer');await act(async()=>session.change({title:'unauthorized'}));expect(session.page?.title).toBe(initial.title);});
 it('clears the old account document when the session identity changes',async()=>{await act(async()=>mocks.receive!({actorId:'user-b',role:'editor'}));expect(session.page).toBeNull();expect(session.authRequired).toBe(true);});
 it('pauses editing while access cannot be checked and resumes on confirmation',async()=>{await act(async()=>mocks.unavailable!());expect(session.accessUnverified).toBe(true);await act(async()=>session.change({title:'blocked'}));expect(session.page?.title).toBe(initial.title);await act(async()=>mocks.receive!({actorId:'user-a',role:'editor'}));expect(session.accessUnverified).toBe(false);await act(async()=>session.change({title:'permitted'}));expect(session.page?.title).toBe('permitted');});
 it('ignores a successful save response arriving after revocation',async()=>{let finish!:(v:any)=>void;fetchMock.mockImplementation(async(url:string)=>url.endsWith('/operations')?new Promise(r=>{finish=r;}):response({page:remote,actorId:'user-a'}));await act(async()=>session.change({title:'pending'}));let saving!:Promise<void>;await act(async()=>{saving=session.save();});await act(async()=>mocks.receive!({actorId:'user-a',role:null,signIn:false}));await act(async()=>{finish(response({page:{...initial,title:'pending'},acknowledgedOperationId:JSON.parse(fetchMock.mock.calls.find((c:any)=>c[0].endsWith('/operations'))![1].body).operationId}));await saving;});expect(session.page).toBeNull();expect(session.error).toContain('Access revoked');});
});
