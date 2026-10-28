// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({request:vi.fn(),router:{push:vi.fn(),replace:vi.fn()}}));
vi.mock('next/navigation',()=>({useRouter:()=>mocks.router}));
vi.mock('../components/editor/use-document-session',async()=>({...await vi.importActual('../components/editor/use-document-session'),requestJson:mocks.request}));
vi.mock('../components/editor/rich-editor',()=>({Dialog:({children}:{children:ReactNode})=>createElement('div',{role:'dialog'},children)}));
vi.mock('../components/session-boundary',()=>({SignOutButton:()=>null,SignInLink:()=>createElement('a',{},'Sign in')}));
import WorkspaceHome from '../components/workspace-home';
afterEach(()=>vi.clearAllMocks());
const workspaces=[{id:'w1',name:'Workspace One'},{id:'empty',name:'Empty Workspace'}],pages=[{id:'first',title:'First workspace page',workspaceId:'w1'}],spaces=[{id:'s1',name:'General',workspaceId:'w1'}];
async function mount(){Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(createElement(WorkspaceHome,{chooseWorkspace:true})));return {host,dispose:async()=>{await act(async()=>root.unmount());host.remove();}};}
function fixtures(){mocks.request.mockImplementation(async(url:string,options?:RequestInit)=>{if(url==='/api/workspaces')return {workspaces};if(url==='/api/pages'&&!options)return {pages};if(url==='/api/spaces'&&!options)return {spaces};if(url==='/api/v1/space-creations')return {space:{id:'new-space',workspaceId:'empty',name:'Launch'}};if(url==='/api/pages')return {page:{id:'first-empty-page'}};throw Error('Unexpected route '+url);});}
it('switches between accessible workspaces including an empty one without opening another workspace page',async()=>{fixtures();const v=await mount();try{expect(v.host.textContent).toContain('First workspace page');const selector=v.host.querySelector('select')!;await act(async()=>{selector.value='empty';selector.dispatchEvent(new Event('change',{bubbles:true}));});expect(v.host.textContent).not.toContain('First workspace page');expect(v.host.textContent).toContain('No accessible pages yet');expect(mocks.router.replace).not.toHaveBeenCalled();}finally{await v.dispose();}});
it('creates the first space and page with the selected empty workspace and entered title',async()=>{fixtures();const v=await mount();try{
 const selector=v.host.querySelector('select')!;await act(async()=>{selector.value='empty';selector.dispatchEvent(new Event('change',{bubbles:true}));});await act(async()=>Array.from(v.host.querySelectorAll('button')).find(b=>b.textContent==='Create page')!.click());
 const inputs=v.host.querySelectorAll('input');await act(async()=>{for(const [input,value] of [[inputs[0],'Launch brief'],[inputs[1],'Launch']] as const){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));}});
 await act(async()=>v.host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 const writes=mocks.request.mock.calls.filter(c=>c[1]?.method==='POST');expect(writes).toHaveLength(2);expect(JSON.parse(writes[0][1].body)).toMatchObject({name:'Launch',workspaceId:'empty'});expect(JSON.parse(writes[1][1].body)).toMatchObject({title:'Launch brief',spaceId:'new-space',parentPageId:null});expect(mocks.router.push).toHaveBeenCalledExactlyOnceWith('/pages/first-empty-page');
 }finally{await v.dispose();}});
