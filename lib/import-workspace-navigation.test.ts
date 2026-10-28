// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>{const push=vi.fn(),replace=vi.fn();return {push,replace,router:{push,replace},request:vi.fn()};});
vi.mock('next/navigation',()=>({useRouter:()=>mocks.router}));
vi.mock('../components/editor/use-document-session',async()=>({...await vi.importActual('../components/editor/use-document-session'),requestJson:mocks.request}));
vi.mock('../components/session-boundary',()=>({SignInLink:()=>null,SignOutButton:()=>null}));
vi.mock('../components/templates-dialog',()=>({default:()=>null}));
vi.mock('../components/import-dialog',()=>({default:({onOpen}:{onOpen:(id:string)=>void})=>createElement('button',{onClick:()=>onOpen('completed-import')},'Open completed import')}));
import WorkspaceHome from '../components/workspace-home';
it('protects an unrelated unsaved new-page title before opening a confirmed imported page',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});mocks.request.mockImplementation(async(url:string)=>url==='/api/pages'?{pages:[]}:url==='/api/workspaces'?{workspaces:[{id:'workspace',name:'Workspace'}]}:{spaces:[{id:'space',workspaceId:'workspace',name:'Product'}]});const host=document.createElement('div');document.body.append(host);const root=createRoot(host),confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 try{await act(async()=>root.render(createElement(WorkspaceHome)));const input=host.querySelector<HTMLInputElement>('input')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Unrelated unfinished page');input.dispatchEvent(new Event('input',{bubbles:true}));});const button=(label:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===label)!;await act(async()=>button('Import a document').click());await act(async()=>button('Open completed import').click());expect(confirm).toHaveBeenCalledWith('Leave this new-page form? Its title has not been saved.');expect(mocks.push).not.toHaveBeenCalled();expect(input.value).toBe('Unrelated unfinished page');confirm.mockReturnValue(true);await act(async()=>button('Open completed import').click());expect(mocks.push).toHaveBeenCalledExactlyOnceWith('/pages/completed-import');}
 finally{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.resetAllMocks();}
});
