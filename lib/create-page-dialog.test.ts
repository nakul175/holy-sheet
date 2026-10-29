// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,it,expect,vi} from 'vitest';
import type {Page} from './types';
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../components/editor/use-document-session',async()=>({...await vi.importActual('../components/editor/use-document-session'),requestJson:mocks.request}));
vi.mock('../components/editor/rich-editor',()=>({Dialog:({children,onClose}:{children:ReactNode;onClose:()=>void})=>createElement('div',{role:'dialog'},createElement('button',{onClick:onClose},'Close dialog'),children)}));
import CreatePage from '../components/create-page-dialog';
import {ApiError} from '../components/editor/use-document-session';
afterEach(()=>vi.clearAllMocks());
const parent={id:'parent',workspaceId:'w',spaceId:'s',title:'Parent'} as Page;
async function mount(props:Partial<Parameters<typeof CreatePage>[0]>={}){
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),created=vi.fn();
 await act(async()=>root.render(createElement(CreatePage,{parent,workspaceId:'w',spaces:[{id:'s',workspaceId:'w',name:'General'}],onClose:vi.fn(),onCreated:created,onTemplates:vi.fn(),...props})));
 return {host,created,submit:()=>act(async()=>{host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));}),dispose:async()=>{await act(async()=>root.unmount());host.remove();}};
}
async function fill(input:HTMLInputElement,value:string){await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}));});}
it('retries the same page intent after a lost response without recreating its new space',async()=>{
 mocks.request.mockResolvedValueOnce({space:{id:'new-space',workspaceId:'w',name:'Launch'}}).mockRejectedValueOnce(new Error('Lost response')).mockResolvedValueOnce({page:{id:'created'}});
 const view=await mount();try{
  await fill(view.host.querySelectorAll('input')[0],'Launch brief');await fill(view.host.querySelectorAll('input')[1],'Launch');
  await view.submit();expect(view.created).not.toHaveBeenCalled();expect(view.host.textContent).toContain('Creation is unconfirmed');
  expect(view.host.querySelector('fieldset')!.disabled).toBe(true);await view.submit();
  expect(mocks.request.mock.calls.map(c=>c[0])).toEqual(['/api/v1/space-creations','/api/pages','/api/pages']);
  const first=JSON.parse(mocks.request.mock.calls[1][1].body);expect(first).toMatchObject({title:'Launch brief',spaceId:'new-space',parentPageId:null});expect(first.operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(mocks.request.mock.calls[2][1].body).toBe(mocks.request.mock.calls[1][1].body);expect(view.created).toHaveBeenCalledExactlyOnceWith({id:'created'});
 }finally{await view.dispose();}
});
it('allows title correction when space creation was rejected before a page request',async()=>{
 mocks.request.mockRejectedValueOnce(new ApiError('Space unavailable',403,'forbidden'));
 const view=await mount();try{await fill(view.host.querySelectorAll('input')[0],'Retained title');await fill(view.host.querySelectorAll('input')[1],'Launch');await view.submit();expect(view.host.querySelector('fieldset')!.disabled).toBe(false);expect(view.host.querySelector('input')!.value).toBe('Retained title');expect(view.host.textContent).toContain('Space unavailable');expect(mocks.request).toHaveBeenCalledTimes(1);}finally{await view.dispose();}
});
it('serializes same-tick submissions before React disables the submit button',async()=>{
 let resolve!:(value:unknown)=>void;mocks.request.mockReturnValueOnce(new Promise(r=>{resolve=r;}));const view=await mount();try{
  await act(async()=>{view.host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));view.host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});expect(mocks.request).toHaveBeenCalledTimes(1);
  await act(async()=>resolve({page:{id:'one-page'}}));expect(view.created).toHaveBeenCalledExactlyOnceWith({id:'one-page'});
 }finally{await view.dispose();}
});

it('replays the same space intent before creating the page when the space response was lost',async()=>{
 mocks.request.mockRejectedValueOnce(new Error('Space response lost')).mockResolvedValueOnce({space:{id:'replayed-space',workspaceId:'w',name:'Launch'}}).mockResolvedValueOnce({page:{id:'one-page'}});
 const view=await mount({parent:undefined,spaces:[]});try{
  await fill(view.host.querySelectorAll('input')[0],'First page');await fill(view.host.querySelectorAll('input')[1],'Launch');await view.submit();
  expect(view.host.querySelector('fieldset')!.disabled).toBe(true);expect(view.created).not.toHaveBeenCalled();await view.submit();
  expect(mocks.request.mock.calls.map(c=>c[0])).toEqual(['/api/v1/space-creations','/api/v1/space-creations','/api/pages']);expect(mocks.request.mock.calls[1][1].body).toBe(mocks.request.mock.calls[0][1].body);
  expect(JSON.parse(mocks.request.mock.calls[2][1].body)).toMatchObject({title:'First page',spaceId:'replayed-space',parentPageId:null});expect(view.created).toHaveBeenCalledExactlyOnceWith({id:'one-page'});
 }finally{await view.dispose();}
});
it('withholds destinations from another workspace in the page dialog',async()=>{
 const view=await mount({spaces:[{id:'s',workspaceId:'w',name:'General'},{id:'foreign',workspaceId:'other',name:'Foreign space'}]});try{expect(view.host.querySelectorAll('option')).toHaveLength(1);expect(view.host.textContent).not.toContain('Foreign space');}finally{await view.dispose();}
});

it('retains the draft and refuses a legacy fallback when the intent endpoint is unavailable after rollback',async()=>{
 mocks.request.mockRejectedValueOnce(new ApiError('Unavailable on this server',404,'not_found'));
 const view=await mount({parent:undefined,spaces:[]});try{await fill(view.host.querySelectorAll('input')[0],'Retained across rollback');await fill(view.host.querySelectorAll('input')[1],'Launch');await view.submit();expect(view.host.querySelector('input')!.value).toBe('Retained across rollback');expect(view.host.querySelector('fieldset')!.disabled).toBe(false);expect(mocks.request.mock.calls.map(c=>c[0])).toEqual(['/api/v1/space-creations']);expect(view.created).not.toHaveBeenCalled();}finally{await view.dispose();}
});

it('keeps an uncertain space operation through server rollback and restoration',async()=>{
 mocks.request.mockRejectedValueOnce(new Error('Committed response lost')).mockRejectedValueOnce(new ApiError('Capability unavailable',404,'not_found')).mockResolvedValueOnce({space:{id:'existing-space',workspaceId:'w',name:'Launch'}}).mockResolvedValueOnce({page:{id:'one-page'}});
 const view=await mount({parent:undefined,spaces:[]});try{await fill(view.host.querySelectorAll('input')[0],'Rollback retry');await fill(view.host.querySelectorAll('input')[1],'Launch');await view.submit();await view.submit();expect(view.host.querySelector('fieldset')!.disabled).toBe(true);expect(view.created).not.toHaveBeenCalled();await view.submit();expect(mocks.request.mock.calls.slice(0,3).map(c=>c[1].body)).toEqual(Array(3).fill(mocks.request.mock.calls[0][1].body));expect(view.created).toHaveBeenCalledExactlyOnceWith({id:'one-page'});}finally{await view.dispose();}
});
