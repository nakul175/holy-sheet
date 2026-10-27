// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../components/editor/use-document-session',()=>({requestJson:mocks.request}));
vi.mock('../components/editor/rich-editor',()=>({Dialog:({children,onClose}:{children:ReactNode;onClose:()=>void})=>createElement('div',{role:'dialog'},createElement('button',{onClick:onClose},'Close'),children)}));
import Backlinks from '../components/backlinks';
const item=(title:string)=>({id:title,title,occurrences:1,spaceName:'Product'}),empty={items:[],nextCursor:null};
let cleanup:()=>Promise<void>;
afterEach(async()=>{await cleanup?.();vi.useRealTimers();vi.restoreAllMocks();vi.resetAllMocks();});
async function mount(){Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});vi.useFakeTimers();vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');const host=document.createElement('div');document.body.append(host);const root=createRoot(host);cleanup=async()=>{await act(async()=>root.unmount());host.remove();};await act(async()=>root.render(createElement(Backlinks,{pageId:'target',version:1,onOpen:vi.fn()})));const button=(text:string)=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent===text)!;await act(async()=>button('Backlinks').click());return {host,button};}
it('refreshes external saved references within four seconds without changing the open target version',async()=>{
 mocks.request.mockResolvedValueOnce(empty).mockResolvedValue({items:[item('New source')],nextCursor:null});const h=await mount();expect(h.host.textContent).not.toContain('New source');await act(async()=>vi.advanceTimersByTime(4000));expect(h.host.textContent).toContain('New source');expect(mocks.request).toHaveBeenCalledTimes(2);
});
it('refreshes the current cursor rather than silently jumping back to the first page',async()=>{
 mocks.request.mockResolvedValueOnce({items:[item('First')],nextCursor:'cursor-one'}).mockResolvedValue({items:[item('Second')],nextCursor:null});const h=await mount();await act(async()=>h.button('Next 20 pages').click());await act(async()=>vi.advanceTimersByTime(4000));expect(mocks.request.mock.calls[2][0]).toBe('/api/v1/pages/target/backlinks?after=cursor-one');expect(h.host.textContent).toContain('Second');expect(h.host.textContent).not.toContain('First');
});
it('clears previously visible metadata when a background authorization read fails, then permits retry',async()=>{
 mocks.request.mockResolvedValueOnce({items:[item('Restricted source title')],nextCursor:null}).mockRejectedValueOnce(Error('Page unavailable')).mockResolvedValue(empty);const h=await mount();await act(async()=>vi.advanceTimersByTime(4000));expect(h.host.textContent).not.toContain('Restricted source title');expect(h.host.textContent).toContain('Page unavailable');await act(async()=>h.button('Refresh from first page').click());expect(h.host.textContent).not.toContain('Page unavailable');
});
it('does not poll hidden dialogs, overlap slow reads, or repopulate a closed dialog from a late response',async()=>{
 let resolve:(value:{items:ReturnType<typeof item>[];nextCursor:string|null})=>void=()=>{};mocks.request.mockImplementation(()=>new Promise(r=>{resolve=r;}));const h=await mount();await act(async()=>vi.advanceTimersByTime(12000));expect(mocks.request).toHaveBeenCalledTimes(1);await act(async()=>h.button('Close').click());await act(async()=>resolve({items:[item('Late metadata')],nextCursor:null}));await act(async()=>vi.advanceTimersByTime(8000));expect(mocks.request).toHaveBeenCalledTimes(1);expect(h.host.textContent).not.toContain('Late metadata');
});
it('pauses in a background tab and refreshes immediately on becoming visible',async()=>{
 mocks.request.mockResolvedValue(empty);const h=await mount();vi.spyOn(document,'visibilityState','get').mockReturnValue('hidden');await act(async()=>vi.advanceTimersByTime(8000));expect(mocks.request).toHaveBeenCalledTimes(1);vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');await act(async()=>document.dispatchEvent(new Event('visibilitychange')));expect(mocks.request).toHaveBeenCalledTimes(2);await act(async()=>window.dispatchEvent(new Event('holy-sheet:logout')));await act(async()=>vi.advanceTimersByTime(8000));expect(mocks.request).toHaveBeenCalledTimes(2);expect(h.host.querySelector('[role=dialog]')).toBeNull();
});
