// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../components/editor/use-document-session',async original=>({...await original(),requestJson:mocks.request}));
import {PageDialog} from '../components/editor/rich-editor';
let cleanup:()=>Promise<void>;
afterEach(async()=>{await cleanup?.();vi.restoreAllMocks();vi.resetAllMocks();});
async function mount(){Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement('div');document.body.append(host);const root=createRoot(host),select=vi.fn();cleanup=async()=>{await act(async()=>root.unmount());host.remove();};await act(async()=>root.render(createElement(PageDialog,{sourcePageId:'source',onClose:vi.fn(),onSelect:select})));return {host,select};}
it('lists only accessible same-workspace pages in stable keyboard order and filters them',async()=>{
 mocks.request.mockResolvedValue({pages:[{id:'other',title:'Other secret',workspaceId:'ws-2'},{id:'source',title:'Source',workspaceId:'ws-1'},{id:'z',title:'Zulu',workspaceId:'ws-1'},{id:'a',title:'Alpha',workspaceId:'ws-1'}]});const h=await mount(),buttons=Array.from(h.host.querySelectorAll<HTMLElement>('[role=listitem]'));expect(buttons.map(b=>b.textContent)).toEqual(['Alpha','Source','Zulu']);expect(h.host.textContent).not.toContain('Other secret');const search=h.host.querySelector('input')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(search,'zu');search.dispatchEvent(new Event('input',{bubbles:true}));});expect(Array.from(h.host.querySelectorAll<HTMLElement>('[role=listitem]')).map(b=>b.textContent)).toEqual(['Zulu']);await act(async()=>h.host.querySelector<HTMLButtonElement>('[role=listitem]')!.click());expect(h.select).toHaveBeenCalledWith('z');
});
it('clears inaccessible metadata on failure and exposes a truthful retry instruction',async()=>{
 mocks.request.mockRejectedValue(Error('offline'));const h=await mount();expect(h.host.querySelector('[role=alert]')?.textContent).toContain('Retry by reopening');expect(h.host.querySelectorAll('[role=listitem]')).toHaveLength(0);
});
