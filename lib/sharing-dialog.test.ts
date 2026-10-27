// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../components/editor/use-document-session',async()=>({...await vi.importActual('../components/editor/use-document-session'),requestJson:mocks.request}));
vi.mock('../components/editor/rich-editor',()=>({Dialog:({children}:{children:ReactNode})=>createElement('div',{role:'dialog'},children)}));
import SharingDialog from '../components/sharing-dialog';
import {ApiError} from '../components/editor/use-document-session';
it('keeps recipient, role and operation ID on uncertain failure and announces success only after acknowledgement',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const state={version:1,members:[{id:'qa',name:'QA member'}],direct:[],inherited:[]};mocks.request.mockResolvedValueOnce(state).mockRejectedValueOnce(new ApiError('Temporary failure',503,'unavailable')).mockResolvedValueOnce({state:{...state,version:2,direct:[{id:'qa',name:'QA member',role:'editor',active:true}]},effectiveRole:'editor'});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const button=(name:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===name)!;
 try{await act(async()=>root.render(createElement(SharingDialog,{pageId:'p',onClose:vi.fn()})));const selects=host.querySelectorAll('select');await act(async()=>{selects[0].value='qa';selects[0].dispatchEvent(new Event('change',{bubbles:true}));selects[1].value='editor';selects[1].dispatchEvent(new Event('change',{bubbles:true}));});await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));expect(host.textContent).toContain('grant editor access');await act(async()=>button('Confirm change').click());expect(host.textContent).toContain('Temporary failure');expect(host.textContent).not.toContain('Confirmed.');expect(selects[0].value).toBe('qa');expect(selects[1].value).toBe('editor');await act(async()=>button('Retry this change').click());const first=JSON.parse(mocks.request.mock.calls[1][1].body),second=JSON.parse(mocks.request.mock.calls[2][1].body);expect(second).toEqual(first);expect(host.textContent).toContain('Confirmed. QA member has editor access');expect(host.textContent).toContain('QA member · editor');}
 finally{await act(async()=>root.unmount());host.remove();vi.clearAllMocks();}
});
it('shows owner sharing history and clears stale events if a later permission check refuses it',async()=>{
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const state={version:1,members:[],direct:[],inherited:[]};mocks.request.mockResolvedValueOnce(state).mockResolvedValueOnce({events:[{id:'event',actorName:'QA owner',recipientName:'QA reader',beforeRole:'editor',afterRole:null,createdAt:'2026-10-27T08:00:00.000Z'}]}).mockRejectedValueOnce(new ApiError('Denied',403,'owner_required'));
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const history=()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='View sharing history')!;
 try{await act(async()=>root.render(createElement(SharingDialog,{pageId:'p',onClose:vi.fn()})));await act(async()=>history().click());expect(host.textContent).toContain('QA owner changed QA reader: editor → no direct access');expect(host.textContent).toContain('This page and its subpages');expect(host.querySelector('time')?.dateTime).toBe('2026-10-27T08:00:00.000Z');await act(async()=>history().click());expect(host.textContent).toContain('Sharing history could not be loaded');expect(host.textContent).not.toContain('QA owner');}
 finally{await act(async()=>root.unmount());host.remove();vi.clearAllMocks();}
});
