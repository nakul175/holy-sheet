// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../components/editor/use-document-session',async()=>({...await vi.importActual('../components/editor/use-document-session'),requestJson:mocks.request}));
vi.mock('../components/editor/rich-editor',()=>({Dialog:({children}:{children:ReactNode})=>createElement('div',{role:'dialog'},children)}));
import WorkspaceAccessDialog from '../components/workspace-access-dialog';
import {ApiError} from '../components/editor/use-document-session';
it('requires a reviewed promotion, preserves the operation on uncertain failure and confirms only acknowledgement',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const member={id:'member',name:'QA Member',role:'member',active:true},state={id:'w',name:'QA Workspace',version:1,role:'admin',canManage:true,members:[member]},preview={version:1,before:member,after:{...member,role:'admin'},contentAccess:'all-workspace-content',preservesPageGrants:true,warning:'Administrators can read private pages.',digest:'a'.repeat(64)};
 mocks.request.mockResolvedValueOnce(state).mockResolvedValueOnce(preview).mockRejectedValueOnce(new ApiError('Temporarily unavailable',503,'unavailable')).mockResolvedValueOnce({appliedVersion:2,replayed:true}).mockResolvedValueOnce({...state,version:2,members:[preview.after]});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),button=(s:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===s)!;
 try{await act(async()=>root.render(createElement(WorkspaceAccessDialog,{workspaceId:'w',onClose:vi.fn()})));await act(async()=>button('Review promotion').click());expect(host.textContent).toContain('Before');expect(host.textContent).toContain('After');expect(mocks.request).toHaveBeenCalledTimes(2);await act(async()=>button('Confirm access change').click());expect(host.textContent).toContain('The result is unconfirmed');expect(button('Cancel').disabled).toBe(true);expect(host.textContent).not.toContain('change confirmed');await act(async()=>button('Retry confirmation').click());expect(JSON.parse(mocks.request.mock.calls[3][1].body)).toEqual(JSON.parse(mocks.request.mock.calls[2][1].body));expect(host.textContent).toContain('Workspace access change confirmed');}
 finally{await act(async()=>root.unmount());host.remove();vi.clearAllMocks();}
});
it('shows self inspection without offering administration to ordinary members',async()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});mocks.request.mockResolvedValueOnce({id:'w',name:'Workspace',version:1,role:'member',canManage:false,members:[{id:'self',name:'QA Self',role:'member',active:true}]});const host=document.createElement('div'),root=createRoot(host);document.body.append(host);try{await act(async()=>root.render(createElement(WorkspaceAccessDialog,{workspaceId:'w',onClose:vi.fn()})));expect(host.textContent).toContain('QA Self');expect(host.querySelectorAll('button')).toHaveLength(0);}finally{await act(async()=>root.unmount());host.remove();vi.clearAllMocks();}});
