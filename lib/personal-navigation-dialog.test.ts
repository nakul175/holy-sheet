// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../components/editor/use-document-session',()=>({requestJson:mocks.request}));
vi.mock('../components/editor/rich-editor',()=>({Dialog:({children}:{children:ReactNode})=>createElement('div',{role:'dialog'},children)}));
import PersonalPages from '../components/personal-navigation';
const empty={version:0,favourites:[],recents:[]};
let cleanup:()=>Promise<void>;
afterEach(async()=>{await cleanup?.();vi.resetAllMocks();});
async function mount(){Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const render=async(pageId:string)=>{await act(async()=>root.render(createElement(PersonalPages,{pageId,actorId:'actor',onOpen:vi.fn()})));};cleanup=async()=>{await act(async()=>root.unmount());host.remove();};await render('first');return {host,render,button:(text:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===text)!};}
it('retries the failed open write explicitly, rather than promising that a list GET will record it',async()=>{
 let writes=0;mocks.request.mockImplementation(async(_url,options)=>{if(options?.method==='POST'){if(++writes===1)throw Error('offline');return {version:0};}return empty;});
 const h=await mount();expect(h.host.textContent).toContain('This open was not confirmed');await act(async()=>h.button('My saved pages').click());expect(writes).toBe(1);await act(async()=>h.button('Retry adding this page to Recents').click());expect(writes).toBe(2);expect(h.host.textContent).not.toContain('This open was not confirmed');const posts=mocks.request.mock.calls.filter(([,o])=>o?.method==='POST');expect(posts.map(([,o])=>JSON.parse(o.body))).toEqual([{action:'opened',pageId:'first'},{action:'opened',pageId:'first'}]);
});
it('does not expose a late failed write or retry for a page already left',async()=>{
 let rejectFirst:(e:Error)=>void=()=>{};mocks.request.mockImplementation((_url,options)=>options?.method==='POST'&&JSON.parse(options.body).pageId==='first'?new Promise((_resolve,reject)=>{rejectFirst=reject;}):Promise.resolve(empty));
 const h=await mount();await h.render('second');await act(async()=>rejectFirst(Error('late offline')));expect(h.host.textContent).not.toContain('This open was not confirmed');expect(mocks.request.mock.calls.filter(([,o])=>o?.method==='POST')).toHaveLength(2);
});
it('clears pending retry on logout and ignores late failures',async()=>{
 let rejectOpen:(e:Error)=>void=()=>{};mocks.request.mockImplementation((_url,options)=>options?.method==='POST'?new Promise((_resolve,reject)=>{rejectOpen=reject;}):Promise.resolve(empty));
 const h=await mount();await act(async()=>window.dispatchEvent(new Event('holy-sheet:logout')));await act(async()=>rejectOpen(Error('late failure')));expect(h.host.textContent).not.toContain('Retry adding');expect(h.host.querySelector('button')!.disabled).toBe(true);
});
it('renders the full permitted path and sends a versioned keyboard reorder',async()=>{
 const data={version:7,favourites:[{id:'a',title:'Page A',workspaceId:'w',workspaceName:'Workspace',spaceId:'s',spaceName:'Space',ancestorTitles:['Root']},{id:'b',title:'Page B',workspaceId:'w',workspaceName:'Workspace',spaceId:'s',spaceName:'Space',ancestorTitles:['Root','Child']}],recents:[]};
 mocks.request.mockImplementation(async(_url,options)=>options?.method==='POST'?{version:8}:data);const h=await mount();await act(async()=>h.button('My saved pages').click());expect(h.host.textContent).toContain('Workspace / Space / Root / Child');const up=h.host.querySelector<HTMLButtonElement>('[aria-label="Move Page B up"]')!;expect(up).not.toBeNull();await act(async()=>up.click());const bodies=mocks.request.mock.calls.filter(([,o])=>o?.method==='POST').map(([,o])=>JSON.parse(o.body));expect(bodies).toContainEqual({action:'reorder',pageId:'b',beforeId:'a',version:7});
});
it('requires clear confirmation and preserves the favourites list in the request model',async()=>{
 const data={version:4,favourites:[{id:'a',title:'Saved',workspaceId:'w',workspaceName:'Workspace',spaceId:'s',spaceName:'Space',ancestorTitles:[]}],recents:[{id:'b',title:'Recent',workspaceId:'w',workspaceName:'Workspace',spaceId:'s',spaceName:'Space',ancestorTitles:[]}]};mocks.request.mockImplementation(async(_url,options)=>options?.method==='POST'?{version:5}:data);const confirm=vi.spyOn(globalThis,'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);const h=await mount();await act(async()=>h.button('My saved pages').click());await act(async()=>h.button('Recents').click());await act(async()=>h.button('Clear all my Recents').click());expect(mocks.request.mock.calls.filter(([,o])=>o?.method==='POST'&&JSON.parse(o.body).action==='clear')).toHaveLength(0);await act(async()=>h.button('Clear all my Recents').click());expect(mocks.request.mock.calls.some(([,o])=>o?.method==='POST'&&JSON.parse(o.body).action==='clear'&&JSON.parse(o.body).version===4)).toBe(true);expect(data.favourites).toHaveLength(1);confirm.mockRestore();
});
